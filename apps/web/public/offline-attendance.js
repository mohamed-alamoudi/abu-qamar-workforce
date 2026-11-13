/* The static fallback uses the same IndexedDB queue and operation format as the online attendance page. */
(async () => {
  const get = id => document.getElementById(id);
  const say = message => { get('result').textContent = message; };
  try {
    const saved = JSON.parse(localStorage.getItem('aq-offline-attendance') ?? 'null');
    if (!saved || Date.now() - saved.preparedAt > 7 * 86_400_000) {
      get('notice').textContent = 'افتح صفحة الدوام بحساب مخوّل أثناء الاتصال أولًا لتجهيز هذا الجهاز.';
      return;
    }

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('aq-attendance-' + saved.userId, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'operation.operationId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = (mode, action) => new Promise((resolve, reject) => {
      const tx = db.transaction('operations', mode);
      const request = action(tx.objectStore('operations'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
    const select = get('employee');
    let items = [];
    let busy = false;
    let reconnect = false;
    function shiftFor(id) {
      const pending = items.filter(item => ['LOCAL', 'PENDING', 'SENDING', 'SYNCED'].includes(item.state));
      const local = pending.filter(item => item.state !== 'SYNCED').findLast(({ operation }) =>
        operation.employeeId === id && operation.action === 'CHECK_IN');
      const existing = saved.open.find(item => item.employeeId === id);
      const shift = local ? { id: local.operation.operationId, version: 1 } : existing;
      if (shift && !pending.some(({ operation }) => operation.sessionId === shift.id && operation.action === 'CHECK_OUT')) return shift;
    }
    function buttons() {
      const shift = shiftFor(select.value);
      get('in').hidden = !saved.checkIn;
      get('out').hidden = !saved.checkOut;
      get('in').disabled = busy || !select.value || !!shift;
      get('out').disabled = busy || !select.value || !shift || shift.onBreak;
    }
    function renderEmployees() {
      const selected = select.value;
      const query = get('search').value.trim().toLowerCase();
      select.replaceChildren(new Option('اختر الموظف', ''));
      for (const employee of saved.employees) {
        const label = employee.fullName + ' · ' + employee.code;
        if (label.toLowerCase().includes(query)) select.add(new Option(label, employee.id));
      }
      select.value = selected;
      buttons();
    }
    async function refresh() {
      items = await transaction('readonly', store => store.getAll());
      const labels = { LOCAL: 'محفوظ محليًا', PENDING: 'بانتظار المزامنة', SENDING: 'جارٍ الإرسال', CONFLICT: 'يوجد تعارض', FAILED: 'فشل الإرسال' };
      get('queue').replaceChildren(...items.filter(item => item.state !== 'SYNCED').map(item => {
        const li = document.createElement('li');
        const label = item.operation.action === 'CHECK_IN' ? 'حضور' : item.operation.action === 'CHECK_OUT' ? 'انصراف' : 'تعديل دوام';
        li.textContent = label + ' · ' + labels[item.state] + (item.message ? ' · ' + item.message : '');
        return li;
      }));
      buttons();
    }
    async function record(action) {
      if (busy) return;
      busy = true;
      buttons();
      try {
        const save = async () => {
          items = await transaction('readonly', store => store.getAll());
          const id = select.value;
          if (!saved.employees.some(employee => employee.id === id)) return;
          const shift = shiftFor(id);
          const now = new Date().toISOString();
          let fields;
          if (action === 'CHECK_IN' && saved.checkIn && !shift) fields = { employeeId: id, checkInAt: now };
          if (action === 'CHECK_OUT' && saved.checkOut && shift && !shift.onBreak) fields = { sessionId: shift.id, baseVersion: shift.version, checkOutAt: now };
          if (!fields) return;
          const deviceId = localStorage.getItem('aq-device-id') ?? crypto.randomUUID();
          localStorage.setItem('aq-device-id', deviceId);
          const operation = { ...fields, action, deviceId, operationId: crypto.randomUUID(), createdAt: now };
          await transaction('readwrite', store => store.put({ operation, state: 'LOCAL', attempts: 0, retryAt: 0 }));
          say('محفوظ محليًا · بانتظار تأكيد الخادم');
        };
        if (navigator.locks) await navigator.locks.request('aq-attendance-' + saved.userId, save);
        else await save();
        await refresh();
      } catch {
        say('تعذر حفظ عملية الدوام على الجهاز. حاول مرة أخرى.');
      } finally {
        busy = false;
        buttons();
        if (reconnect && navigator.onLine) location.replace('/attendance');
      }
    }
    get('notice').textContent = 'تُحفظ العمليات على هذا الجهاز وتُرسل عند عودة الاتصال.';
    get('record').hidden = false;
    get('search').addEventListener('input', renderEmployees);
    select.addEventListener('change', buttons);
    get('in').addEventListener('click', () => void record('CHECK_IN'));
    get('out').addEventListener('click', () => void record('CHECK_OUT'));
    window.addEventListener('online', () => { reconnect = true; if (!busy) location.replace('/attendance'); });
    renderEmployees();
    await refresh();
  } catch {
    get('notice').textContent = 'تعذر فتح بيانات الدوام المحلية. افتح التطبيق عند عودة الاتصال.';
  }
})();
