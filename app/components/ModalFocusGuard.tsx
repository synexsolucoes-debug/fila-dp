"use client";

import { useEffect } from "react";

/**
 * Guarda de foco para todo diálogo modal do produto.
 *
 * O produto tem dezenas de janelas e gavetas, cada uma com a própria conta de
 * foco — e a gaveta de demanda não tinha nenhuma. Medido no navegador: no 28º
 * Tab o foco saía da gaveta (`aria-modal="true"`) para o `<body>`, e ao fechar
 * com Esc caía num indicador da página em vez de voltar ao botão que a abriu.
 *
 * Esta guarda vale para qualquer `[aria-modal="true"]` aberto, sem que cada
 * janela precise lembrar:
 *
 * 1. **Tab preso** no diálogo do topo. A lista de focáveis é calculada na hora
 *    da tecla, por visibilidade real (`getClientRects`), e não por
 *    `offsetParent` — que trata como invisível o que está dentro de um pai
 *    `position: fixed` e fazia o "último" calculado não ser o último de fato.
 * 2. **Foco devolvido** a quem abriu, quando o diálogo sai da tela — desde que
 *    esse elemento ainda exista e esteja visível.
 *
 * Os diálogos que já cuidam do próprio foco continuam funcionando: a guarda
 * age primeiro (fase de captura na janela), e quem vem depois encontra o foco
 * já num lugar válido.
 */

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const TABBABLE = [
  "a[href]", "area[href]", "button:not([disabled])", "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])", "textarea:not([disabled])", "summary", "iframe", "audio[controls]", "video[controls]",
  "[contenteditable]:not([contenteditable=\"false\"])", "[tabindex]",
].join(", ");

function visible(element: Element) {
  return element.getClientRects().length > 0 && !element.closest("[inert]");
}

export function tabbables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter((element) => element.tabIndex >= 0 && visible(element));
}

function openModals(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)].filter(visible);
}

export function ModalFocusGuard() {
  useEffect(() => {
    type Entry = { modal: HTMLElement; trigger: HTMLElement | null };
    let stack: Entry[] = [];
    // Histórico curto: a janela costuma dar foco ao próprio primeiro campo antes
    // de a guarda registrá-la, então "o último focado" já estaria dentro dela.
    let history: HTMLElement[] = document.activeElement instanceof HTMLElement ? [document.activeElement] : [];
    let frame = 0;

    const top = () => stack.at(-1)?.modal ?? null;

    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      history = [...history.filter((element) => element !== event.target), event.target].slice(-12);
    };

    const sync = () => {
      frame = 0;
      const current = openModals();
      const closed = stack.filter((entry) => !current.includes(entry.modal));
      stack = stack.filter((entry) => current.includes(entry.modal));
      for (const modal of current) {
        if (stack.some((entry) => entry.modal === modal)) continue;
        // Quem tinha o foco antes de a janela aparecer é quem a abriu.
        const trigger = [...history].reverse()
          .find((element) => element.isConnected && !modal.contains(element) && element !== document.body) ?? null;
        stack.push({ modal, trigger });
      }
      // Devolve ao gatilho do diálogo fechado mais recente, se o foco ficou
      // perdido ou preso num lugar que não é ele.
      const restore = closed.at(-1)?.trigger;
      if (!restore || !restore.isConnected || !visible(restore)) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || !active.isConnected;
      const stillInsideOpenModal = active instanceof HTMLElement && top()?.contains(active);
      if (stillInsideOpenModal && !top()?.contains(restore)) return;
      if (lost || active !== restore) restore.focus({ preventScroll: true });
    };

    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(sync); };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const modal = top();
      if (!modal) return;
      const items = tabbables(modal);
      const active = document.activeElement as HTMLElement | null;
      if (items.length === 0) {
        event.preventDefault();
        if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");
        modal.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = active !== null && modal.contains(active);
      if (event.shiftKey && (!inside || active === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || active === last)) { event.preventDefault(); first.focus(); }
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-modal", "role", "hidden", "open", "inert"],
    });
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
