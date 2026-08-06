/* Live Max PWA — Service Worker v1.19 (Web Push) */
const CACHE = "livemax-v1.19";
const ASSETS = ["./styles.css", "./manifest.json", "./icons/icon192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isAppShell =
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/sw.js");
  if (e.request.method !== "GET") return;
  if (isAppShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});

/** Notificação push (app fechado / segundo plano) */
self.addEventListener("push", (event) => {
  let data = { title: "Live Max", body: "Nova atualização", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = Object.assign(data, parsed);
    }
  } catch (_) {
    try {
      data.body = event.data ? event.data.text() : data.body;
    } catch (__) {}
  }
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      var appOpen = list.some(function (c) {
        return c.visibilityState === "visible" || c.focused;
      });
      // App aberto na tela → não mostra notificação do sistema (o app já dá toast 1x)
      if (appOpen) {
        list.forEach(function (c) {
          try {
            c.postMessage({
              type: "LM_PUSH_SALE",
              title: data.title,
              body: data.body,
            });
          } catch (_) {}
        });
        return;
      }
      return self.registration.showNotification(data.title || "Live Max", {
        body: data.body || "",
        icon: "./icons/icon192.png",
        badge: "./icons/icon192.png",
        tag: data.tag || "livemax-sale",
        renotify: true,
        silent: false,
        requireInteraction: false,
        data: { url: data.url || "./" },
        vibrate: [200, 100, 200, 100, 300],
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url && "focus" in c) {
          c.focus();
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
