// Service Worker — HYPER LIFE v5
// Estrategia robusta: timestamps absolutos + periodicSync + fetch ping cada ~10s
// Los setTimeout en SW son poco confiables en background; usamos un loop basado en
// waitUntil + fetch self-ping para mantener el SW activo y revisar timers vencidos.

const CACHE = 'jim-sw-v5';
const DB_NAME = 'jim-timers';
const PING_URL = '/jim/sw-ping.txt'; // archivo estático dummy (se crea auto)
const CHECK_INTERVAL = 8000; // cada 8 segundos revisamos si hay timer vencido

// ─── Install / Activate ───
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      checkMissedTimers(),
      scheduleDailyReminders()
    ])
  );
});

// ─── IndexedDB helpers ───
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('timers'))
        db.createObjectStore('timers', { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveTimer(timer) {
  const db = await openDB();
  const tx = db.transaction('timers', 'readwrite');
  tx.objectStore('timers').put(timer);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function deleteTimer(id) {
  const db = await openDB();
  const tx = db.transaction('timers', 'readwrite');
  tx.objectStore('timers').delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function loadTimers() {
  const db = await openDB();
  return new Promise((resolve) => {
    const req = db.transaction('timers', 'readonly').objectStore('timers').getAll();
    req.onsuccess = () => {
      const map = {};
      (req.result || []).forEach(t => { map[t.id] = t; });
      resolve(map);
    };
    req.onerror = () => resolve({});
  });
}

// ─── Disparar notificación ───
async function fireNotification(id, title, body) {
  await self.registration.showNotification(title || '⏱ HYPER LIFE', {
    body: body || '¡Descanso terminado! A por la siguiente serie.',
    icon: '/jim/icon.png',
    badge: '/jim/icon.png',
    tag: id,
    requireInteraction: true,
    renotify: true,
    vibrate: [300, 100, 300, 100, 300],
    data: { id }
  });
  await deleteTimer(id);
  // Avisar a la página abierta
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'TIMER_FIRED', id }));
}

// ─── Revisar timers vencidos (se llama periódicamente) ───
async function checkMissedTimers() {
  const timers = await loadTimers();
  const now = Date.now();
  for (const [id, t] of Object.entries(timers)) {
    if (id === 'daily_reminder') continue;
    if (t.fireAt <= now) {
      await fireNotification(id, t.title, t.body);
    }
  }
}

// ─── Loop activo: mantiene el SW despierto revisando cada CHECK_INTERVAL ms ───
// Usa waitUntil encadenado para evitar que el navegador mate el SW antes de tiempo.
// Se re-agenda solo mientras haya timers pendientes.
let loopRunning = false;

async function startTimerLoop() {
  if (loopRunning) return;
  loopRunning = true;

  const tick = async () => {
    await checkMissedTimers();
    const timers = await loadTimers();
    // Filtrar solo timers reales (no daily)
    const active = Object.entries(timers).filter(([id]) => id !== 'daily_reminder');
    if (active.length > 0) {
      // Hay timers activos → seguir el loop
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
      await tick();
    } else {
      loopRunning = false;
    }
  };

  // Envolver en waitUntil para mantener SW activo
  self.registration.active?.postMessage?.({});  // no-op keepalive hint
  tick().catch(() => { loopRunning = false; });
}

// ─── Background Sync (para cuando vuelve la conexión / SW se despierta) ───
self.addEventListener('sync', e => {
  if (e.tag === 'check-timers') {
    e.waitUntil(checkMissedTimers());
  }
});

// ─── Periodic Background Sync (Chrome Android, si está disponible) ───
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-timers') {
    e.waitUntil(checkMissedTimers());
  }
});

// ─── Daily workout reminder 7:30 AM Lun-Vie ───
let dailyReminderHandle = null;

async function scheduleDailyReminders() {
  const now = new Date();
  const dow = now.getDay(); // 0=Dom 6=Sab

  let target = new Date(now);
  target.setHours(7, 30, 0, 0);

  let daysAhead = 0;
  if (now >= target || dow === 0 || dow === 6) {
    daysAhead = 1;
    let nextDow = (dow + daysAhead) % 7;
    while (nextDow === 0 || nextDow === 6) {
      daysAhead++;
      nextDow = (dow + daysAhead) % 7;
    }
    target.setDate(target.getDate() + daysAhead);
  }

  const delay = target.getTime() - Date.now();
  if (dailyReminderHandle) clearTimeout(dailyReminderHandle);

  // Guardar en IDB para recuperarlo si el SW muere
  await saveTimer({
    id: 'daily_reminder',
    fireAt: target.getTime(),
    title: '💪 HYPER LIFE — ¡A entrenar!',
    body: '¡Son las 7:30! Hoy es día de entrenamiento. ¡Vamos Jaime! 🔥'
  });

  dailyReminderHandle = setTimeout(async () => {
    await self.registration.showNotification('💪 HYPER LIFE — ¡A entrenar!', {
      body: '¡Son las 7:30! Hoy es día de entrenamiento. ¡Vamos Jaime! 🔥',
      icon: '/jim/icon.png',
      badge: '/jim/icon.png',
      tag: 'daily_workout',
      requireInteraction: false,
      vibrate: [200, 100, 200, 100, 400],
      actions: [
        { action: 'open', title: '💪 Abrir app' },
        { action: 'dismiss', title: 'Cerrar' }
      ]
    });
    await deleteTimer('daily_reminder');
    scheduleDailyReminders(); // re-agendar para el día siguiente
  }, delay);
}

// ─── Message handler ───
self.addEventListener('message', async e => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_TIMER') {
    const { id, delay, title, body } = data;
    const fireAt = Date.now() + Math.max(delay || 0, 500);

    // Guardar en IDB con timestamp absoluto
    await saveTimer({ id, fireAt, title, body });

    // Iniciar el loop activo que revisa IDB periódicamente
    startTimerLoop();

    // También intentar un setTimeout directo como respaldo
    // (funciona si el SW no fue matado)
    setTimeout(async () => {
      const timers = await loadTimers();
      if (timers[id] && timers[id].fireAt <= Date.now() + 1000) {
        await fireNotification(id, title, body);
      }
    }, Math.max(delay || 0, 500));
  }

  if (data.type === 'CANCEL_TIMER') {
    const { id } = data;
    if (id) {
      await deleteTimer(id);
    } else {
      const timers = await loadTimers();
      for (const tid of Object.keys(timers)) {
        if (tid !== 'daily_reminder') await deleteTimer(tid);
      }
    }
    loopRunning = false; // detener el loop si no hay más timers
  }

  if (data.type === 'SCHEDULE_DAILY') {
    scheduleDailyReminders();
  }

  if (data.type === 'GET_TIMER_STATUS') {
    const { id } = data;
    const timers = await loadTimers();
    const t = timers[id];
    e.source?.postMessage({
      type: 'TIMER_STATUS',
      id,
      fireAt: t ? t.fireAt : null,
      remaining: t ? Math.max(0, t.fireAt - Date.now()) : null
    });
  }

  // Ping de keepalive desde la página (la app puede enviar esto cada ~10s)
  if (data.type === 'KEEPALIVE') {
    await checkMissedTimers();
  }
});

// ─── Fetch handler — responde a pings internos y hace cache básico ───
self.addEventListener('fetch', e => {
  // No interceptar requests de Firebase ni externos
  if (!e.request.url.includes('/jim/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ─── Notification click → abrir/enfocar app ───
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const jimClient = clients.find(c => c.url.includes('/jim'));
      if (jimClient) return jimClient.focus();
      return self.clients.openWindow('/jim/');
    })
  );
});
