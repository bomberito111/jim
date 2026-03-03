// Service Worker for JIM app - background notifications

const CACHE = 'jim-sw-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Store pending timers: { id, scheduledAt, delay, title, body }
let pendingTimers = {};

self.addEventListener('message', e => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_TIMER') {
    const { id, delay, title, body } = data;
    // Clear existing timer with same id
    if (pendingTimers[id]) {
      clearTimeout(pendingTimers[id].handle);
    }
    const handle = setTimeout(() => {
      self.registration.showNotification(title || 'JIM - Temporizador', {
        body: body || 'Se acabo el tiempo!',
        icon: '/jim/icon.png',
        badge: '/jim/icon.png',
        tag: id || 'jim-timer',
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200]
      });
      delete pendingTimers[id];
    }, delay);
    pendingTimers[id] = { handle };
  }

  if (data.type === 'CANCEL_TIMER') {
    const { id } = data;
    if (id && pendingTimers[id]) {
      clearTimeout(pendingTimers[id].handle);
      delete pendingTimers[id];
    } else {
      // Cancel all
      Object.values(pendingTimers).forEach(t => clearTimeout(t.handle));
      pendingTimers = {};
    }
  }
});

// Handle notification click - open the app
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
