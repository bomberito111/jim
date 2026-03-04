// Service Worker — HYPER LIFE v6
// SOLUCIÓN DEFINITIVA AL TIMER EN BACKGROUND:
// En lugar de setTimeout (que muere cuando el SW es killed),
// guardamos el timestamp ABSOLUTO en IndexedDB y usamos un
// loop basado en waitUntil + fetch self-ping para mantenernos vivos.

const CACHE = 'jim-sw-v6';
const DB_NAME = 'jim-timers';

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

// ─── Estado en memoria ───
let pendingTimers = {};   // { id: { id, fireAt, title, body } }
let loopRunning = false;
let dailyTimeout = null;

// ══════════════════════════════════════════════
// IndexedDB helpers
// ══════════════════════════════════════════════
function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('timers'))
          db.createObjectStore('timers', { keyPath: 'id' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    } catch(e) { reject(e); }
  });
}

async function dbSave(record) {
  try {
    const db = await openDB();
    const tx = db.transaction('timers', 'readwrite');
    tx.objectStore('timers').put(record);
    return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  } catch(e) {}
}

async function dbDelete(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('timers', 'readwrite');
    tx.objectStore('timers').delete(id);
    return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  } catch(e) {}
}

async function dbGetAll() {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const tx = db.transaction('timers', 'readonly');
      const req = tx.objectStore('timers').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch(e) { return []; }
}

async function dbClear() {
  try {
    const db = await openDB();
    const tx = db.transaction('timers', 'readwrite');
    tx.objectStore('timers').clear();
  } catch(e) {}
}

// ══════════════════════════════════════════════
// Mostrar notificación
// ══════════════════════════════════════════════
async function fireNotification(id, title, body) {
  await self.registration.showNotification(title || '⏱ HYPER LIFE', {
    body: body || '¡Descanso terminado! A por la siguiente serie.',
    icon: '/jim/icon.png',
    badge: '/jim/icon.png',
    tag: id,
    requireInteraction: true,
    renotify: true,
    vibrate: [300, 100, 300, 100, 300]
  });
  // Notificar a la app
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'TIMER_FIRED', id }));
}

// ══════════════════════════════════════════════
// Loop principal — revisa timers cada ~1s
// Se mantiene vivo usando waitUntil + fetch-ping
// ══════════════════════════════════════════════
function hasPendingTimers() {
  return Object.keys(pendingTimers).some(k => k !== 'daily_reminder');
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  runLoop();
}

function runLoop() {
  if (!hasPendingTimers()) {
    loopRunning = false;
    return;
  }
  // waitUntil mantiene el SW despierto mientras hay trabajo
  const workPromise = new Promise(async resolve => {
    await sleep(1000);
    const now = Date.now();
    const fired = [];
    for (const [id, t] of Object.entries(pendingTimers)) {
      if (id === 'daily_reminder') continue;
      if (t.fireAt <= now) {
        fired.push(t);
      }
    }
    for (const t of fired) {
      delete pendingTimers[t.id];
      await dbDelete(t.id);
      await fireNotification(t.id, t.title, t.body);
    }
    resolve();
  });

  // Usar fetch-ping como keepalive (truco conocido para Chrome Android)
  const keepAlive = fetch('/jim/sw-ping.txt', { cache: 'no-store' }).catch(() => {});

  self.registration.active && self.registration.active.postMessage && null; // noop

  // Encadenar: cuando termina workPromise, llamar al siguiente ciclo
  workPromise.then(() => {
    if (hasPendingTimers()) {
      runLoop();
    } else {
      loopRunning = false;
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════
// Recuperar timers perdidos al despertar el SW
// ══════════════════════════════════════════════
async function checkMissedTimers() {
  const saved = await dbGetAll();
  const now = Date.now();
  for (const t of saved) {
    if (t.id === 'daily_reminder') continue;
    if (t.fireAt <= now) {
      // Sonó mientras el SW estaba muerto
      await fireNotification(t.id, t.title, t.body);
      await dbDelete(t.id);
    } else {
      // Aún no ha sonado — restaurar en memoria y arrancar loop
      pendingTimers[t.id] = t;
    }
  }
  if (hasPendingTimers()) startLoop();
}

// ══════════════════════════════════════════════
// Recordatorio diario 7:30 AM Lun-Vie
// ══════════════════════════════════════════════
function scheduleDailyReminders() {
  if (dailyTimeout) { clearTimeout(dailyTimeout); dailyTimeout = null; }
  const now = new Date();
  const dow = now.getDay();
  let target = new Date(now);
  target.setHours(7, 30, 0, 0);
  let daysAhead = 0;
  if (now >= target || dow === 0 || dow === 6) {
    daysAhead = 1;
    let nd = (dow + daysAhead) % 7;
    while (nd === 0 || nd === 6) { daysAhead++; nd = (dow + daysAhead) % 7; }
    target.setDate(target.getDate() + daysAhead);
  }
  const delay = target.getTime() - Date.now();
  // Guardar en IDB para sobrevivir restart
  dbSave({ id: 'daily_reminder', fireAt: target.getTime(), title: '💪 HYPER LIFE — ¡A entrenar!', body: '¡Son las 7:30! Hoy es día de entrenamiento. ¡Vamos Jaime! 🔥' });
  dailyTimeout = setTimeout(async () => {
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
    await dbDelete('daily_reminder');
    scheduleDailyReminders(); // Programar el siguiente
  }, delay);
}

// ══════════════════════════════════════════════
// Manejador de mensajes desde la app
// ══════════════════════════════════════════════
self.addEventListener('message', async e => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_TIMER') {
    const { id, delay, title, body } = data;
    const fireAt = Date.now() + Math.max(delay || 0, 100);
    const record = { id, fireAt, title, body };
    pendingTimers[id] = record;
    await dbSave(record);
    startLoop(); // Arranca/continúa el loop
    if (e.source) e.source.postMessage({ type: 'TIMER_SCHEDULED', id, fireAt });
  }

  if (data.type === 'CANCEL_TIMER') {
    const { id } = data;
    if (id) {
      delete pendingTimers[id];
      await dbDelete(id);
    } else {
      // Cancelar todos los timers de descanso (no el daily)
      for (const k of Object.keys(pendingTimers)) {
        if (k !== 'daily_reminder') {
          delete pendingTimers[k];
          await dbDelete(k);
        }
      }
    }
  }

  if (data.type === 'KEEPALIVE') {
    // Ping desde la app para mantener el SW activo
    if (hasPendingTimers() && !loopRunning) startLoop();
  }

  if (data.type === 'GET_TIMER_STATUS') {
    const { id } = data;
    const t = pendingTimers[id];
    if (e.source) e.source.postMessage({
      type: 'TIMER_STATUS',
      id,
      fireAt: t ? t.fireAt : null,
      remaining: t ? Math.max(0, t.fireAt - Date.now()) : null
    });
  }

  if (data.type === 'SCHEDULE_DAILY') {
    scheduleDailyReminders();
  }
});

// ══════════════════════════════════════════════
// Background Sync — SW despertado por el sistema
// ══════════════════════════════════════════════
self.addEventListener('sync', e => {
  if (e.tag === 'check-timers') {
    e.waitUntil(checkMissedTimers());
  }
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-timers') {
    e.waitUntil(checkMissedTimers());
  }
});

// ══════════════════════════════════════════════
// Clic en notificación → abrir/enfocar la app
// ══════════════════════════════════════════════
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

// ══════════════════════════════════════════════
// Fetch — servir cache + crear sw-ping.txt
// ══════════════════════════════════════════════
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Responder al ping de keepalive
  if (url.pathname === '/jim/sw-ping.txt') {
    e.respondWith(new Response('ok', { headers: { 'Content-Type': 'text/plain' } }));
    return;
  }
  // Para el resto, red primero (sin cache agresiva)
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
