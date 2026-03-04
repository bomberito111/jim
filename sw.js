// Service Worker for HYPER LIFE v4 — Background Timer + Daily Reminders
// Timestamps absolute para que el timer survive background/kill

const CACHE = 'jim-sw-v4';
const DB_NAME = 'jim-timers';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      checkMissedTimers(),
      scheduleDailyReminders()
    ])
  );
});

// In-memory timer handles
let timerHandles = {};
let pendingTimers = {};
let dailyReminderHandle = null;

// ─── IndexedDB helpers ───
function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('timers')) db.createObjectStore('timers', { keyPath: 'id' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    } catch(e) { reject(e); }
  });
}

async function saveTimers() {
  try {
    const db = await openDB();
    const tx = db.transaction('timers', 'readwrite');
    const store = tx.objectStore('timers');
    store.clear();
    Object.entries(pendingTimers).forEach(([id, t]) => store.put({ id, fireAt: t.fireAt, title: t.title, body: t.body }));
  } catch(e) {}
}

async function loadTimers() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('timers', 'readonly');
      const store = tx.objectStore('timers');
      const req = store.getAll();
      req.onsuccess = () => {
        const map = {};
        (req.result || []).forEach(t => { map[t.id] = t; });
        resolve(map);
      };
      req.onerror = () => resolve({});
    });
  } catch(e) { return {}; }
}

// ─── Schedule in-memory notification ───
function scheduleInMemory(id, delay, title, body) {
  if (timerHandles[id]) clearTimeout(timerHandles[id]);
  timerHandles[id] = setTimeout(async () => {
    await self.registration.showNotification(title || '⏱ HYPER LIFE', {
      body: body || '¡Descanso terminado! A por la siguiente serie.',
      icon: '/jim/icon.png',
      badge: '/jim/icon.png',
      tag: id,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300]
    });
    delete pendingTimers[id];
    delete timerHandles[id];
    saveTimers();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'TIMER_FIRED', id }));
  }, Math.max(delay, 100));
}

// ─── Check missed timers on SW wake ───
async function checkMissedTimers() {
  const saved = await loadTimers();
  const now = Date.now();
  for (const [id, t] of Object.entries(saved)) {
    if (id === 'daily_reminder') continue; // handled separately
    if (t.fireAt <= now) {
      await self.registration.showNotification(t.title || '⏱ HYPER LIFE', {
        body: t.body || '¡Descanso terminado! A por la siguiente serie.',
        icon: '/jim/icon.png',
        badge: '/jim/icon.png',
        tag: id,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300]
      });
    } else {
      pendingTimers[id] = t;
      scheduleInMemory(id, t.fireAt - now, t.title, t.body);
    }
  }
  saveTimers();
}

// ─── Daily workout reminder 7:30 AM Mon-Fri ───
async function scheduleDailyReminders() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun 6=Sat
  
  // Get next valid weekday at 07:30
  let target = new Date(now);
  target.setHours(7, 30, 0, 0);
  
  // If already past 7:30 today or it's weekend, advance to next weekday
  let daysAhead = 0;
  if (now >= target || dow === 0 || dow === 6) {
    daysAhead = 1;
    // Skip weekends
    let nextDow = (dow + daysAhead) % 7;
    while (nextDow === 0 || nextDow === 6) { daysAhead++; nextDow = (dow + daysAhead) % 7; }
    target.setDate(target.getDate() + daysAhead);
  }
  
  const delay = target.getTime() - Date.now();
  if (dailyReminderHandle) clearTimeout(dailyReminderHandle);
  
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
    // Schedule next one
    scheduleDailyReminders();
  }, delay);
}

// ─── Message handler ───
self.addEventListener('message', async e => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_TIMER') {
    const { id, delay, title, body } = data;
    const fireAt = Date.now() + (delay || 0);
    if (timerHandles[id]) clearTimeout(timerHandles[id]);
    pendingTimers[id] = { id, fireAt, title, body };
    saveTimers();
    scheduleInMemory(id, delay, title, body);
  }

  if (data.type === 'CANCEL_TIMER') {
    const { id } = data;
    if (id) {
      if (timerHandles[id]) clearTimeout(timerHandles[id]);
      delete timerHandles[id];
      delete pendingTimers[id];
    } else {
      Object.values(timerHandles).forEach(h => clearTimeout(h));
      timerHandles = {};
      pendingTimers = {};
    }
    saveTimers();
  }

  if (data.type === 'SCHEDULE_DAILY') {
    scheduleDailyReminders();
  }

  if (data.type === 'GET_TIMER_STATUS') {
    const { id } = data;
    const t = pendingTimers[id];
    e.source?.postMessage({
      type: 'TIMER_STATUS', id,
      fireAt: t ? t.fireAt : null,
      remaining: t ? Math.max(0, t.fireAt - Date.now()) : null
    });
  }
});

// ─── Notification click → open/focus app ───
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
