/* Service Worker — Cirurgias HSM
   Mantém o app instalável e funcionando offline (a casca do app).
   IMPORTANTE: nunca guardamos em cache imagens de etiquetas nem dados de
   pacientes — apenas os arquivos estáticos do próprio aplicativo. As chamadas
   ao Apps Script (rede) nunca passam pelo cache.

   ESTRATÉGIA DE ATUALIZAÇÃO (evita o app "não atualizar" no celular):
   - HTML / JS / CSS (o que muda quando eu atualizo o app): busca sempre na
     REDE primeiro; só usa o que está guardado se estiver sem internet.
   - Ícones e manifest (raramente mudam): usa o que está guardado primeiro,
     mais rápido, e busca na rede só se não tiver nada guardado ainda. */

const CACHE = "cirurgias-hsm-v3";
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
  const url = new URL(req.url);

  // Só lidamos com GET de arquivos do próprio app.
  // Qualquer chamada a outras origens (ex.: Apps Script) vai direto à rede,
  // sem cache — garante dados sempre atuais e nenhum dado sensível salvo.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  const ehCascaDoApp =
    req.mode === "navigate" || /\.(html|js|css)$/i.test(url.pathname);

  if (ehCascaDoApp) {
    // Rede primeiro: assim que eu publicar uma atualização, o celular já
    // pega a versão nova no próximo uso (mesmo sem reinstalar o app).
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Ícones/manifest: cache primeiro (mudam raramente, carrega mais rápido).
  e.respondWith(
    caches.match(req).then((cacheado) => cacheado || fetch(req))
  );
});
