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
    const search = get('search');
    const results = get('employee-results');
    let selected = '';
    const arrival = get('arrival');
    const departure = get('departure');
    const department = get('department');
    const zone = saved.timezone ?? 'Asia/Gaza';
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const localTime = value => value && (value.length === 16 ? value : formatter.format(new Date(value)).replace(' ', 'T'));
    const timeFields = get('time-fields');
    timeFields.addEventListener('toggle', () => {
      if (!timeFields.open) arrival.value = departure.value = '';
    });
    get('zone').textContent = 'الأوقات حسب توقيت النظام (' + zone + ')';
    department.add(new Option('القسم الافتراضي', ''));
    for (const item of saved.departments ?? []) department.add(new Option(item.name, item.id));
    let items = [];
    let busy = false;
    let reconnect = false;
    let checkingConnection = false;
    async function resumeOnline() {
      if (busy || checkingConnection || !navigator.onLine) return;
      checkingConnection = true;
      try {
        const response = await window.fetch('/api/health', { cache: 'no-store', signal: window.AbortSignal?.timeout?.(5000) });
        if (response.ok && !busy) location.replace('/attendance');
      } catch {
        // A browser can report connectivity before the server is reachable.
      } finally {
        checkingConnection = false;
      }
    }
    function shiftFor(id) {
      const pending = items.filter(item => ['LOCAL', 'PENDING', 'SENDING', 'SYNCED'].includes(item.state));
      const local = pending.find(({ operation, state }) =>
        state !== 'SYNCED' && operation.employeeId === id &&
        (operation.action === 'CHECK_IN' || (operation.action === 'MANUAL' && !operation.checkOutAt)) &&
        !pending.some(item => item.operation.sessionId === operation.operationId && item.operation.action === 'CHECK_OUT'));
      const existing = saved.open.find(item => item.employeeId === id);
      const shift = local ? { id: local.operation.operationId, version: 1, checkInAt: local.operation.checkInAt } : existing;
      if (shift && !pending.some(({ operation }) => operation.sessionId === shift.id && operation.action === 'CHECK_OUT')) return shift;
    }
    function buttons() {
      const shift = shiftFor(selected);
      get('in').hidden = !saved.checkIn;
      get('out').hidden = !saved.checkOut;
      get('manual').hidden = !saved.correct;
      get('department-field').hidden = !((saved.checkIn || saved.correct) && department.options.length > 1);
      get('arrival-field').hidden = !(saved.checkIn || saved.correct);
      get('departure-field').hidden = !(saved.checkOut || saved.correct);
      get('open-shift').textContent = shift ? 'وردية مفتوحة · ' + (localTime(shift.checkInAt)?.replace('T', ' ') ?? '') : '';
      get('in').disabled = busy || !selected || !!shift;
      get('out').disabled = busy || !selected || !shift || shift.onBreak;
      get('manual').disabled = busy || !selected;
    }
    function renderEmployees() {
      const query = search.value.trim().toLowerCase();
      results.replaceChildren();
      results.hidden = false;
      for (const employee of saved.employees) {
        const label = employee.fullName + ' · ' + employee.code;
        if (!label.toLowerCase().includes(query)) continue;
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          selected = employee.id;
          search.value = employee.fullName;
          results.hidden = true;
          buttons();
        });
        row.append(button);
        results.append(row);
      }
      if (!results.childElementCount) {
        const row = document.createElement('li');
        row.textContent = 'لا توجد نتائج';
        results.append(row);
      }
      buttons();
    }
    async function refresh() {
      items = await transaction('readonly', store => store.getAll());
      const labels = { LOCAL: 'محفوظ محليًا', PENDING: 'بانتظار المزامنة', SENDING: 'جارٍ الإرسال', CONFLICT: 'يوجد تعارض', FAILED: 'فشل الإرسال' };
      get('queue').replaceChildren(...items.filter(item => item.state !== 'SYNCED').map(item => {
        const li = document.createElement('li');
        const operation = item.operation;
        const labelsByAction = { CHECK_IN: 'حضور', CHECK_OUT: 'انصراف', MANUAL: 'وردية يدوية', CORRECTION: 'تعديل دوام' };
        const linked = items.find(entry => entry.operation.operationId === operation.sessionId)?.operation ??
          saved.open.find(shift => shift.id === operation.sessionId);
        const employee = saved.employees.find(entry => entry.id === (operation.employeeId ?? linked?.employeeId));
        const times = [operation.checkInAt, operation.checkOutAt].filter(Boolean).map(value => localTime(value).replace('T', ' '));
        li.textContent = [labelsByAction[operation.action], employee?.fullName, ...times, labels[item.state], item.message].filter(Boolean).join(' · ');
        if (['FAILED', 'CONFLICT'].includes(item.state)) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = 'إزالة من الطابور';
          remove.addEventListener('click', async () => {
            try {
              await transaction('readwrite', store => store.delete(operation.operationId));
              await refresh();
            } catch {
              say('تعذرت إزالة العملية.');
            }
          });
          li.append(' ', remove);
        }
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
          const id = selected;
          if (!saved.employees.some(employee => employee.id === id)) return;
          const shift = shiftFor(id);
          const now = new Date().toISOString();
          let fields;
          if (action === 'CHECK_IN' && saved.checkIn && !shift) {
            fields = { employeeId: id, checkInAt: (timeFields.open && arrival.value) || now, departmentId: department.value || undefined };
          }
          if (action === 'CHECK_OUT' && saved.checkOut && shift && !shift.onBreak) {
            fields = { sessionId: shift.id, baseVersion: shift.version, checkOutAt: (timeFields.open && departure.value) || now };
          }
          if (action === 'MANUAL' && saved.correct) {
            fields = { employeeId: id, checkInAt: arrival.value, checkOutAt: departure.value, departmentId: department.value || undefined };
          }
          if (!fields) {
            say('تغيّرت حالة الوردية. راجع الدوام وحاول مرة أخرى.');
            return;
          }
          if ((action !== 'CHECK_OUT' && !fields.checkInAt) || (action !== 'CHECK_IN' && !fields.checkOutAt)) {
            say('حدد التاريخ والوقت قبل الحفظ.');
            return;
          }
          const start = fields.checkInAt ?? shift?.checkInAt;
          const end = fields.checkOutAt;
          const invalidOrder = start && end && (start.length === 16 && end.length === 16
            ? end <= start
            : localTime(end) < localTime(start));
          if (invalidOrder) {
            say('وقت الانصراف لازم يكون بعد وقت الحضور.');
            return;
          }
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
        if (reconnect) void resumeOnline();
      }
    }
    get('notice').textContent = 'تُحفظ العمليات على هذا الجهاز وتُرسل عند عودة الاتصال.';
    get('record').hidden = false;
    search.addEventListener('focus', renderEmployees);
    search.addEventListener('input', () => { selected = ''; renderEmployees(); });
    get('in').addEventListener('click', () => void record('CHECK_IN'));
    get('out').addEventListener('click', () => void record('CHECK_OUT'));
    get('manual').addEventListener('click', () => void record('MANUAL'));
    window.addEventListener('online', () => { reconnect = true; void resumeOnline(); });
    window.setInterval(() => void resumeOnline(), 2500);
    await refresh();
  } catch {
    get('notice').textContent = 'تعذر فتح بيانات الدوام المحلية. افتح التطبيق عند عودة الاتصال.';
  }
})();
