import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { confirmAttendanceWipe, enqueueAttendance, flushAttendance, readQueue, retryDelay } from './attendance-queue';

const storage = new Map<string, string>();
const navigatorStub = { onLine: false };
beforeEach(() => {
  vi.stubGlobal('navigator', navigatorStub);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  navigatorStub.onLine = false;
  vi.restoreAllMocks();
});

it('stores an offline operation and shows success only after a matching response', async () => {
  const userId = randomUUID();
  const item = await enqueueAttendance(userId, {
    action: 'CHECK_OUT', baseVersion: 7, sessionId: randomUUID(), checkOutAt: new Date().toISOString(),
  });
  expect(item.state).toBe('LOCAL');
  expect(item.operation.baseVersion).toBe(7);
  const send = vi.spyOn(api, 'post').mockImplementation(async (_path, body) => {
    expect((await readQueue(userId))[0].state).toBe('SENDING');
    expect(body).toEqual({ userId, operations: [item.operation] });
    return { results: [{ operationId: item.operation.operationId, originalStatus: 'APPLIED' }] } as never;
  });
  await flushAttendance(userId);
  expect(send).not.toHaveBeenCalled();
  navigatorStub.onLine = true;
  await flushAttendance(userId);
  expect((await readQueue(userId))[0].state).toBe('SYNCED');
});

it('keeps an operation pending after a network failure and backs off', async () => {
  const userId = randomUUID();
  await enqueueAttendance(userId, { action: 'CHECK_IN', employeeId: randomUUID(), checkInAt: new Date().toISOString() });
  navigatorStub.onLine = true;
  const send = vi.spyOn(api, 'post').mockRejectedValue(new TypeError('network'));
  await flushAttendance(userId);
  const [item] = await readQueue(userId);
  expect(item.state).toBe('PENDING');
  expect(item.attempts).toBe(1);
  expect(item.retryAt).toBeGreaterThan(Date.now());
  expect(retryDelay(100)).toBe(300_000);
  await flushAttendance(userId);
  expect(send).toHaveBeenCalledTimes(1);
});

it('stores conflicts for review and keeps queues isolated by account', async () => {
  const userId = randomUUID();
  const item = await enqueueAttendance(userId, { action: 'CHECK_OUT', baseVersion: 1, sessionId: randomUUID() });
  navigatorStub.onLine = true;
  vi.spyOn(api, 'post').mockResolvedValue({
    results: [{ operationId: item.operation.operationId, originalStatus: 'CONFLICT', conflictData: { baseVersion: 1, currentVersion: 2 } }],
  });
  await flushAttendance(userId);
  expect((await readQueue(userId))[0]).toMatchObject({ state: 'CONFLICT', conflictData: { currentVersion: 2 } });
  expect(await readQueue(randomUUID())).toEqual([]);
});

it('warns before wiping pending operations on logout', async () => {
  const userId = randomUUID();
  await enqueueAttendance(userId, { action: 'CHECK_IN', employeeId: randomUUID() });
  const confirm = vi.fn().mockReturnValue(false);
  Object.assign(window, { indexedDB, confirm });
  expect(await confirmAttendanceWipe(userId)).toBe(false);
  expect((await readQueue(userId)).length).toBe(1);
  confirm.mockReturnValue(true);
  expect(await confirmAttendanceWipe(userId)).toBe(true);
  expect(await readQueue(userId)).toEqual([]);
});

it('refuses financial writes while offline', async () => {
  const send = vi.spyOn(globalThis, 'fetch');
  await expect(api.post('/payments', {})).rejects.toMatchObject({ code: 'NETWORK' });
  await expect(api.post('/financial-transactions/record/reverse', {})).rejects.toMatchObject({ code: 'NETWORK' });
  await expect(api.post('/employees/record/pay-rates', {})).rejects.toMatchObject({ code: 'NETWORK' });
  expect(send).not.toHaveBeenCalled();
});
