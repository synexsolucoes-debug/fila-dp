"use client";

import { useEffect } from "react";

/**
 * Registro do service worker.
 *
 * Fica numa ilha de cliente própria, montada só em `/campo`, e o escopo é
 * `/campo` — não a raiz. A diferença não é cosmética: no escopo raiz este
 * service worker passaria a controlar o painel e o site público, e a reserva de
 * navegação sem rede devolveria a casca do aplicativo de campo a quem pediu o
 * painel. Um script servido da raiz pode registrar escopo mais estreito sem
 * cabeçalho nenhum, e as páginas de `/campo` continuam levando consigo os
 * arquivos estáticos do Next — o escopo decide quais páginas o service worker
 * controla, não quais endereços ele pode guardar.
 *
 * O escopo do manifesto continua `/`, de propósito: sair e entrar de novo
 * atravessa `/login`, e com escopo estreito no manifesto isso abriria uma aba
 * do navegador no meio do turno.
 *
 * O registro é adiado para depois do carregamento: concorrer com a primeira
 * pintura atrasaria a tela que a pessoa está esperando, pelo benefício da
 * segunda abertura.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/campo" }).catch(() => {
        // Sem service worker o aplicativo continua inteiro — só perde o
        // funcionamento sem rede. Não vale incomodar quem está em campo com um
        // aviso sobre isso.
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
