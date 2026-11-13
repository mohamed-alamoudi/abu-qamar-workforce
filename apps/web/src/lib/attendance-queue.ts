import { api, ApiError } from './api';

export type QueueState = 'LOCAL' | 'PENDING' | 'SENDING' | 'SYNCED' | 'CONFLICT' | 'FAILED';

export interface AttendanceInput {
  action: 'CHECK_IN' | 'CHECK_OUT' | 'MANUAL' | 'CORRECTION';
  employeeId?: string;
  sessionId?: string;
  departmentId?: string;
  baseVersion?: number;
  checkInAt?: string;
  checkOutAt?: string;
  reason?: string;
}

interface Operation extends AttendanceInput {
  operationId: string;
  createdAt: string;
  deviceId: string;
}

export interface QueueItem {
  operation: Operation;
  state: QueueState;
  attempts: number;
  retryAt: number;
  message?: string;
  conflictData?: { baseVersion?: number; currentVersion?: number };
}

interface Result {
  operationId: string;
  originalStatus: 'APPLIED' | 'CONFLICT' | 'REJECTED';
  message?: string;
  conflictData?: QueueItem['conflictData'];
}

export const QUEUE_CHANGED = 'aq-attendance-queue';
export const ATTENDANCE_SYNCED = 'aq-attendance-synced';
const retiringUsers = new Set<string>();

function open(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('aq-attendance-' + userId, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'operation.operationId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(userId: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open(userId);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('operations', mode);
      const request = run(tx.objectStore('operations'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function readQueue(userId: string): Promise<QueueItem[]> {
  return transaction(userId, 'readonly', (store) => store.getAll());
}

export async function dismissAttendance(userId: string, operationId: string): Promise<void> {
  await lock(userId, async () => {
    const item = await transaction<QueueItem | undefined>(userId, 'readonly', store => store.get(operationId));
    if (item && ['FAILED', 'CONFLICT', 'SYNCED'].includes(item.state)) {
      await transaction(userId, 'readwrite', store => store.delete(operationId));
      window.dispatchEvent(new Event(QUEUE_CHANGED));
    }
  });
}

async function write(userId: string, item: QueueItem) {
  await transaction(userId, 'readwrite', (store) => store.put(item));
  window.dispatchEvent(new Event(QUEUE_CHANGED));
}

export async function enqueueAttendance(userId: string, input: AttendanceInput): Promise<QueueItem> {
  if (retiringUsers.has(userId)) throw new Error('الجلسة قيد الإغلاق');
  const deviceId = localStorage.getItem('aq-device-id') ?? crypto.randomUUID();
  localStorage.setItem('aq-device-id', deviceId);
  const item: QueueItem = {
    operation: { ...input, operationId: crypto.randomUUID(), createdAt: new Date().toISOString(), deviceId },
    state: navigator.onLine ? 'PENDING' : 'LOCAL',
    attempts: 0,
    retryAt: 0,
  };
  await write(userId, item);
  return item;
}

export function retryDelay(attempt: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9));
}

async function lock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  // يمنع تبويبين من إرسال العنصر نفسه أو الكتابة مجددًا بعد مسح الطابور.
  if (navigator.locks) return navigator.locks.request('aq-attendance-' + userId, work);
  return work();
}

export async function flushAttendance(userId: string): Promise<void> {
  if (!navigator.onLine || retiringUsers.has(userId)) return;
  await lock(userId, async () => {
    if (retiringUsers.has(userId)) return;
    const items = (await readQueue(userId))
      .filter(({ state }) => ['LOCAL', 'PENDING', 'SENDING'].includes(state))
      .sort((a, b) => a.operation.createdAt.localeCompare(b.operation.createdAt));
    const waiting = items.findIndex(item => item.retryAt > Date.now());
    const batch = items.slice(0, waiting < 0 ? 25 : Math.min(25, waiting));
    if (!batch.length) return;
    for (const item of batch) await write(userId, { ...item, state: 'SENDING' });

    try {
      const { results } = await api.post<{ results: Result[] }>('/sync/attendance', {
        userId,
        operations: batch.map(({ operation }) => operation),
      });
      for (const item of batch) {
        const result = results.find(({ operationId }) => operationId === item.operation.operationId);
        if (!result) {
          await write(userId, { ...item, state: 'PENDING', retryAt: Date.now() + retryDelay(item.attempts + 1), attempts: item.attempts + 1 });
          continue;
        }
        const state = result.originalStatus === 'APPLIED' ? 'SYNCED' : result.originalStatus === 'CONFLICT' ? 'CONFLICT' : 'FAILED';
        await write(userId, { ...item, state, message: result.message, conflictData: result.conflictData });
        if (state === 'SYNCED') window.dispatchEvent(new Event(ATTENDANCE_SYNCED));
      }
    } catch (error) {
      if (retiringUsers.has(userId)) return;
      const retry = !(error instanceof ApiError) || [0, 401, 429].includes(error.status) || error.status >= 500;
      for (const item of batch) {
        await write(userId, {
          ...item,
          state: retry ? 'PENDING' : 'FAILED',
          attempts: item.attempts + 1,
          retryAt: Date.now() + retryDelay(item.attempts + 1),
          message: error instanceof ApiError ? error.message : 'تعذر إرسال العملية',
        });
      }
    }
  });
}

export async function confirmAttendanceWipe(userId: string): Promise<boolean> {
  if (!('indexedDB' in window)) return true;
  const items = await readQueue(userId);
  const unresolved = items.filter(({ state }) => state !== 'SYNCED').length;
  if (unresolved && !window.confirm(`سيحذف تسجيل الخروج ${unresolved} عملية دوام لم تُسوَّ بعد من هذا الجهاز. هل تريد المتابعة؟`)) return false;
  retiringUsers.add(userId);
  try {
    await lock(userId, () => transaction(userId, 'readwrite', (store) => store.clear()));
    window.dispatchEvent(new Event(QUEUE_CHANGED));
  } finally {
    retiringUsers.delete(userId);
  }
  return true;
}
