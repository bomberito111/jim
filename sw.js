// Service Worker for HYPER LIFE - Background Timer Notifications
// Uses absolute timestamps so timers survive SW sleep/restart

const CACHE = 'jim-sw-v3';
const DB_NAME = 'jim-timers';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      checkMissedTimers()
    ])
  );
});

// In-memory timer handles (for when SW is alive)
let timerHandles = {};

// Persistent timer store using SW global scope + IndexedDB fallback
let pendingTimers = {}; // { id: { fireAt, title, body } }

// ─── Save timers to IndexedDB for persistence across SW restarts ───
function saveTimers() {
  try {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('timers', { keyPath: 'id' });
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('timers', 'readwrite');
      const store = tx.objectStore('timers');
      store.clear();
      Object.entries(pendingTimers).forEach(([id, t]) => {
        store.put({ id, fireAt: t.fireAt, title: t.title, body: t.body });
      });
    };
  } catch(err) { /* IndexedDB not available */ }
}

// ─── Load timers from IndexedDB ───
function loadTimers() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('timers', { keyPath: 'id' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('timers', 'readonly');
        const store = tx.objectStore('timers');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const timers = {};
          (getAll.result || []).forEach(t => { timers[t.id] = t; });
          resolve(timers);
        };
        getAll.onerror = () => resolve({});
      };
      req.onerror = () => resolve({});
    } catch(e) { resolve({}); }
  });
}

// ─── Check if any timers fired while SW was dead ───
async function checkMissedTimers() {
  const saved = await loadTimers();
  const now = Date.now();
  for (const [id, t] of Object.entries(saved)) {
    if (t.fireAt <= now) {
      // Timer already expired - fire notification now
      await self.registration.showNotification(t.title || '⏱ HYPER LIFE', {
        body: t.body || '¡Descanso terminado! A por la siguiente serie.',
        icon: '/jim/icon.png',
        badge: '/jim/icon.png',
        tag: id,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300]
      });
      delete saved[id];
    } else {
      // Re-schedule for remaining time
      pendingTimers[id] = t;
      scheduleInMemory(id, t.fireAt - now, t.title, t.body);
    }
  }
  // Clean up fired timers in DB
  saveTimers();
}

// ─── Schedule notification using setTimeout (in-memory) ───
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
    // Notify all clients that timer fired
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'TIMER_FIRED', id }));
  }, Math.max(delay, 100));
}

// ─── Message handler ───
self.addEventListener('message', async e => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_TIMER') {
    const { id, delay, title, body } = data;
    const fireAt = Date.now() + (delay || 0);
    // Cancel existing
    if (timerHandles[id]) clearTimeout(timerHandles[id]);
    // Store with absolute timestamp
    pendingTimers[id] = { id, fireAt, title, body };
    saveTimers();
    // Schedule in memory
    scheduleInMemory(id, delay, title, body);
  }

  if (data.type === 'CANCEL_TIMER') {
    const { id } = data;
    if (id) {
      if (timerHandles[id]) clearTimeout(timerHandles[id]);
      delete timerHandles[id];
      delete pendingTimers[id];
    } else {
      // Cancel all
      Object.values(timerHandles).forEach(h => clearTimeout(h));
      timerHandles = {};
      pendingTimers = {};
    }
    saveTimers();
  }

  if (data.type === 'GET_TIMER_STATUS') {
    const { id } = data;
    const t = pendingTimers[id];
    e.source?.postMessage({
      type: 'TIMER_STATUS',
      id,
      fireAt: t ? t.fireAt : null,
      remaining: t ? Math.max(0, t.fireAt - Date.now()) : null
    });
  }
});

// ─── Notification click → open/focus the app ───
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const jimClient = clients.find(c => c.url.includes('/jim'));
      if (jimClient) return jimClient.focus();
      return self.clients.openWindow('/jim/');
    })
  );
});
