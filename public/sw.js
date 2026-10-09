/*
 * Service worker do aplicativo de campo.
 *
 * A estratégia é deliberadamente estreita, e a razão é de produto: este
 * aplicativo movimenta estoque e grava termo assinado. Entregar dado de estoque
 * vindo de cache seria pior do que não abrir — a pessoa veria doze unidades
 * disponíveis onde há zero, entregaria, e a recusa só apareceria depois, longe
 * do colaborador que já assinou.
 *
 * Por isso:
 *
 *  - a CASCA (HTML, JS, CSS, ícones) é guardada, para o aplicativo abrir sem
 *    rede e mostrar a fila pendente;
 *  - nenhuma resposta de /api/ é guardada ou servida de cache, nunca. Sem rede,
 *    a requisição falha e quem chamou decide — e quem chama é a fila, que
 *    enfileira a operação com a chave de idempotência;
 *  - a navegação tenta a rede primeiro e cai para a casca guardada, de modo que
 *    abrir o ícone no modo avião mostre o aplicativo em vez da tela de erro do
 *    navegador.
 *
 * O registro usa escopo `/campo` (ver `app/campo/ServiceWorker.tsx`), então as
 * únicas páginas controladas são as do aplicativo de campo. É o que mantém a
 * reserva de navegação honesta: ela devolve a casca de `/campo` porque só
 * páginas de `/campo` passam por aqui.
 */

const VERSION = "vinculato-campo-v1";
const SHELL = `${VERSION}-shell`;

// A casca mínima. O restante entra sob demanda, pelo próprio uso.
const SHELL_URLS = ["/campo", "/icon.png", "/apple-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // `reload` ignora o cache HTTP: instalar uma versão nova do service worker
    // guardando a casca antiga é como não atualizar nada.
    await Promise.allSettled(SHELL_URLS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

/** Mensagem da página para trocar de versão sem esperar o próximo carregamento. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Dado operacional nunca sai do cache. Ver o comentário do topo: estoque
  // vencido é pior do que estoque ausente.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match("/campo")) ?? Response.error();
      }
    })());
    return;
  }

  // Estático versionado pelo Next: o cache responde na hora e a rede repõe em
  // segundo plano, então a segunda abertura não espera a rede.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }).catch(() => cached ?? Response.error());
    return cached ?? network;
  })());
});
