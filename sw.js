/* Service worker NOVA WAWA: hanya untuk notifikasi push (tidak menyimpan cache, supaya aplikasi selalu terbaru). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || "NOVA WAWA", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || "nova",
    renotify: true,
    data: { url: d.url || "/dashboard.html" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/dashboard.html";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.indexOf("dashboard.html") !== -1 && "focus" in c) { c.postMessage({ type: "open", url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
