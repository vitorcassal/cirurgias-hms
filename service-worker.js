/* Service Worker — Cirurgias HSM
   Mantém o app instalável e funcionando offline (a casca do app).
   IMPORTANTE: nunca guardamos em cache imagens de etiquetas nem dados de
   pacientes — apenas os arquivos estáticos do próprio aplicativo. As chamadas
   ao Apps Script (rede) nunca passam pelo cache. */

const CACHE = "cirurgias-hsm-v1";
const ARQUIVOS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Só lidamos com GET de arquivos do próprio app.
  // Qualquer chamada a outras origens (ex.: Apps Script) vai direto à rede,
  // sem cache — garante dados sempre atuais e nenhum dado sensível salvo.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  e.respondWith(
    caches.match(req).then((cacheado) => cacheado || fetch(req))
  );
});
