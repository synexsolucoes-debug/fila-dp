"use client";

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowRight, type LucideIcon } from "lucide-react";
import styles from "./motion.module.css";

/**
 * Abstrações de movimento do Vinculato (§22).
 *
 * A §22 pede duas coisas ao mesmo tempo: reutilizar a biblioteca que já existe
 * e não somar uma segunda para resolver o mesmo problema. O projeto não tinha
 * nenhuma — o movimento eram `@keyframes` soltos em `dashboard-modern.css`,
 * reescritos por tela. Somar Framer Motion a um app Next em RSC custaria ~34 kB
 * de JavaScript no cliente e obrigaria cada componente animado a virar client
 * component, para fazer o que uma animação CSS já faz de graça no compositor.
 *
 * Então a biblioteca é esta: os `@keyframes` continuam no CSS, e o que mora
 * aqui é só o que o CSS não sabe fazer sozinho — manter um elemento montado
 * enquanto ele sai, medir a aba ativa para o indicador deslizar até ela,
 * numerar os degraus da cascata, prender o foco dentro de um diálogo.
 *
 * Toda duração vem de token. Nenhum componente daqui escreve um número de
 * milissegundos que não esteja em `dashboard-modern.css`.
 */

/* -------------------------------------------------------------------------- */
/* Base                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Espelho em JavaScript da consulta que o CSS já faz.
 *
 * O CSS desliga as animações sozinho, mas as saídas animadas dependem de um
 * temporizador: sem isto, quem pede menos movimento veria o diálogo continuar
 * na tela por 250ms depois de fechar, parado, porque a animação que deveria
 * ocupar esse tempo não roda. O temporizador precisa saber da preferência.
 */
const reducedMotionQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

function subscribeToReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = reducedMotionQuery();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion() {
  // `useSyncExternalStore` e não `useState` + efeito: a preferência é estado
  // que mora fora do React, e lê-la num efeito significaria renderizar uma vez
  // com o valor errado antes de corrigir. O terceiro argumento é o instantâneo
  // do servidor, onde `matchMedia` não existe.
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => (typeof window.matchMedia === "function" ? reducedMotionQuery().matches : false),
    () => false,
  );
}

/** Durações em milissegundos, espelhando os tokens `--motion-*`. */
const DURATION = { fast: 150, micro: 180, dropdown: 200, modal: 250, drawer: 300, page: 300 } as const;

/**
 * Mantém o elemento montado enquanto ele sai.
 *
 * Sem isto, `{open && <Modal/>}` desmonta no clique e não há o que animar: a
 * §15 pede saída tão suave quanto a entrada, e uma janela que some no quadro
 * seguinte é o "modal aparecendo seco" ao contrário.
 */
export function useExitTransition(open: boolean, duration: number) {
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);

  // Abrir é imediato e acontece no próprio render: passar por um efeito
  // custaria um quadro com a janela ainda ausente, e a animação de entrada
  // começaria atrasada. É o ajuste de estado durante o render que o React
  // documenta para derivar de props — não um efeito em cascata.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    // O `setState` mora dentro do temporizador, não no corpo do efeito: é a
    // saída que precisa esperar a animação terminar.
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : duration);
    return () => clearTimeout(timer);
  }, [duration, mounted, open, reduced]);

  return { mounted, state: mounted && !open ? "closing" as const : "open" as const };
}

/* -------------------------------------------------------------------------- */
/* Entrada                                                                     */
/* -------------------------------------------------------------------------- */

type FadeProps = {
  children: ReactNode;
  /** Atraso, para encadear com o que já entrou. */
  delay?: number;
  /** `up` desloca alguns pixels antes de assentar; `none` só esmaece. */
  direction?: "up" | "none";
  className?: string;
  style?: CSSProperties;
};

export function FadeIn({ children, delay = 0, direction = "up", className, style }: FadeProps) {
  return (
    <div
      className={`${direction === "up" ? styles.fadeInUp : styles.fadeIn}${className ? ` ${className}` : ""}`}
      style={{ ...style, "--motion-delay": `${delay}ms` } as CSSProperties}
    >{children}</div>
  );
}

/**
 * Cascata (§12): cabeçalho, indicadores, filtros e tabela entrando em ordem.
 *
 * O contêiner não anima nada — ele só numera os filhos. O degrau é curto de
 * propósito: a §12 pede o efeito discreto, e 45ms × 8 fecha a cascata inteira
 * em 360ms, dentro do teto da §11.
 */
export function StaggerContainer({ children, step = 45, className, style }: {
  children: ReactNode; step?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <div className={className} style={{ ...style, "--stagger-step": `${step}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

export function StaggerItem({ children, index, className, style }: {
  children: ReactNode; index: number; className?: string; style?: CSSProperties;
}) {
  return (
    <div
      className={`${styles.staggerItem}${className ? ` ${className}` : ""}`}
      style={{ ...style, "--stagger-index": index } as CSSProperties}
    >{children}</div>
  );
}

/**
 * Troca de módulo (§11, §24).
 *
 * `key` remonta o bloco a cada destino, o que reinicia a animação de entrada —
 * sem ela a transição rodaria só na primeira vez. É deliberadamente a mesma
 * animação curta para toda troca interna: a assinatura da marca (§23) acontece
 * uma vez, na entrada do sistema, e repeti-la a cada clique no menu seria o
 * que a §24 proíbe.
 */
export function PageTransition({ transitionKey, children, className }: {
  transitionKey: string; children: ReactNode; className?: string;
}) {
  return (
    <div key={transitionKey} className={`${styles.pageTransition}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cartão (§9)                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * O cartão do §9, com os cinco estados que ele descreve: borda em repouso,
 * elevação no hover, borda em destaque, fundo reagindo e a seta andando.
 *
 * Vira `<button>` quando há `onClick` e `<div>` quando não há — um cartão sem
 * ação que responde ao hover promete um clique que não existe.
 */
export function MotionCard({ icon: Icon, title, description, meta, onClick, disabled, arrow = true, className, children, style }: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  arrow?: boolean;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const body = <>
    {Icon ? <span className={styles.motionCardIcon} aria-hidden="true"><Icon /></span> : null}
    <strong>{title}</strong>
    {description ? <p>{description}</p> : null}
    {children}
    {meta || arrow ? <span className={styles.motionCardFoot}>
      {meta}
      {arrow && onClick ? <ArrowRight className={styles.motionCardArrow} aria-hidden="true" /> : null}
    </span> : null}
  </>;

  const shared = `${styles.motionCard}${className ? ` ${className}` : ""}`;
  if (!onClick) return <div className={shared} style={style}>{body}</div>;
  return (
    <button type="button" className={shared} style={style} data-interactive={disabled ? "false" : "true"}
      onClick={onClick} disabled={disabled}>{body}</button>
  );
}

/* -------------------------------------------------------------------------- */
/* Janela e gaveta (§15, §16)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Prende o foco dentro do contêiner e o devolve a quem o tinha ao fechar.
 *
 * Sem a devolução, fechar um diálogo joga o foco no `<body>` e quem navega por
 * teclado recomeça a tela do zero. Sem a prisão, o Tab passeia pela página
 * atrás da janela, que é a mesma falha por outro caminho.
 */
export function useDialogFocus(active: boolean, onClose: () => void, busy = false) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;
    const focusables = () => [...(container?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((node) => node.offsetParent !== null || node === document.activeElement);

    // `preventScroll` porque o diálogo acabou de abrir centralizado: dar foco
    // ao primeiro controle fazia o navegador rolar o conteúdo do diálogo para
    // trazê-lo à vista, e numa tela de 768px isso abria a janela já com o
    // próprio título cortado no topo.
    focusables()[0]?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      // Esc não escapa no meio de uma ação já enviada: fechar aqui deixaria a
      // pessoa sem saber se a exclusão que ela pediu chegou a acontecer.
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [active, busy, onClose]);

  return ref;
}

/**
 * Leva o diálogo para fora da árvore da tela, direto no `<body>`.
 *
 * `position: fixed` é relativo à viewport — exceto quando algum ancestral tem
 * `transform`, `filter` ou `perspective`, e aí passa a ser relativo a ele. A
 * transição de módulo anima `transform`, e um ancestral animado é suficiente:
 * a janela abria deslocada e o cabeçalho do painel passava por cima dela.
 *
 * Trocar o `fill-mode` para `backwards` resolveu aquele caso específico, mas
 * a regra continua valendo para qualquer `transform` que apareça depois — um
 * cartão com `hover` elevado no caminho, um `will-change` novo. O portal tira
 * a classe inteira de defeito do caminho em vez de consertar a instância.
 *
 * `null` até montar: no servidor não há `document`, e um portal renderizado na
 * primeira passagem quebraria a hidratação.
 */
/** Nunca notifica: o que muda entre servidor e cliente é o instantâneo, não o
 *  valor ao longo do tempo. É o padrão do React para "já hidratei". */
const neverChanges = () => () => {};

export function DialogPortal({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(neverChanges, () => true, () => false);
  if (!hydrated) return null;
  /* A casca, e não o `<body>`.
   *
   * Levar para o `<body>` resolveria o bloco de contenção, mas custaria o
   * tema: os tokens `--ui-*` são declarados em `.dashboard-shell`, e fora dela
   * `background: var(--ui-surface-elevated)` fica inválido no valor computado.
   * O diálogo abria sem fundo e sem véu, com a tela aparecendo através dele —
   * medido, não suposto.
   *
   * A casca serve porque ela não tem `transform`, `filter` nem `perspective`:
   * o `position: fixed` volta a ser relativo à viewport, que era o problema
   * original. E o `overflow: hidden` dela não recorta o diálogo justamente
   * porque ela não é o bloco de contenção dele. */
  const alvo = document.querySelector("main.dashboard-shell") ?? document.body;
  return createPortal(children, alvo);
}

export function AnimatedModal({ open, onClose, label, width, stickyFooter, children, className }: {
  open: boolean;
  onClose: () => void;
  /** Rótulo acessível: `aria-modal` sem nome deixa o diálogo anônimo. */
  label: string;
  width?: number;
  /** Prende cabeçalho e rodapé, deixando só o miolo rolar. Para formulários
   *  que crescem — sem isto o botão de confirmar nasce abaixo da dobra. */
  stickyFooter?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { mounted, state } = useExitTransition(open, DURATION.modal);
  const ref = useDialogFocus(mounted && state === "open", onClose);
  if (!mounted) return null;
  return (
    <DialogPortal>
      <div className={styles.backdrop} data-state={state} onMouseDown={onClose}>
        <div ref={ref} role="dialog" aria-modal="true" aria-label={label} data-state={state}
          className={`${styles.modal}${stickyFooter ? ` ${styles.modalStickyFooter}` : ""}${className ? ` ${className}` : ""}`}
          style={width ? { "--modal-width": `${width}px` } as CSSProperties : undefined}
          onMouseDown={(event) => event.stopPropagation()}>
          {children}
        </div>
      </div>
    </DialogPortal>
  );
}

export function AnimatedDrawer({ open, onClose, label, side = "right", width, children, className }: {
  open: boolean;
  onClose: () => void;
  label: string;
  side?: "left" | "right";
  width?: number;
  children: ReactNode;
  className?: string;
}) {
  const { mounted, state } = useExitTransition(open, DURATION.drawer);
  const ref = useDialogFocus(mounted && state === "open", onClose);
  if (!mounted) return null;
  return (
    <DialogPortal>
      <div className={styles.drawerBackdrop} data-side={side} data-state={state} onMouseDown={onClose}>
        <div ref={ref} role="dialog" aria-modal="true" aria-label={label} data-state={state}
          className={`${styles.drawer}${className ? ` ${className}` : ""}`}
          style={width ? { "--drawer-width": `${width}px` } as CSSProperties : undefined}
          onMouseDown={(event) => event.stopPropagation()}>
          {children}
        </div>
      </div>
    </DialogPortal>
  );
}

/* -------------------------------------------------------------------------- */
/* Abas (§17)                                                                  */
/* -------------------------------------------------------------------------- */

export type AnimatedTab<T extends string> = { id: T; label: string; icon?: LucideIcon; badge?: number };

/**
 * Abas com indicador deslizante (§17).
 *
 * A medição usa `useLayoutEffect` porque o indicador precisa estar no lugar
 * certo *antes* do primeiro quadro pintado; com `useEffect` ele apareceria na
 * esquerda e correria até a aba ativa toda vez que a tela montasse.
 *
 * As setas do teclado percorrem as abas, como o padrão ARIA de `tablist` pede:
 * sem isso o Tab entra em cada aba uma a uma e sair da barra num painel de dez
 * abas custa dez toques.
 */
export function AnimatedTabs<T extends string>({ tabs, active, onChange, label, className }: {
  tabs: readonly AnimatedTab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ offset: number; top: number; width: number; height: number } | null>(null);
  const id = useId();

  // A linha também é medida: a barra quebra quando os destinos não cabem numa
  // linha só, e um indicador que só soubesse a coluna marcaria o vazio acima
  // da aba escolhida.
  const measure = useCallback(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !current) return;
    setIndicator({
      offset: current.offsetLeft, top: current.offsetTop,
      width: current.offsetWidth, height: current.offsetHeight,
    });
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, active, tabs]);

  useEffect(() => {
    // A largura das abas muda quando a janela muda — e o indicador precisa
    // acompanhar, senão ele fica marcando o lugar de onde a aba estava.
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const style = useMemo(() => ({
    "--tab-offset": `${indicator?.offset ?? 0}px`,
    "--tab-top": `${indicator?.top ?? 0}px`,
    "--tab-width": `${indicator?.width ?? 0}px`,
    "--tab-height": `${indicator?.height ?? 0}px`,
  } as CSSProperties), [indicator]);

  function onKeyDown(event: ReactKeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    onChange(next.id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${next.id}`)}`)?.focus();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown}
      className={`${styles.tabs}${className ? ` ${className}` : ""}`}>
      <span className={styles.tabsIndicator} data-ready={indicator ? "true" : "false"} style={style} aria-hidden="true" />
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.id} id={`${id}-${tab.id}`} type="button" role="tab" className={styles.tab}
            aria-selected={tab.id === active} tabIndex={tab.id === active ? 0 : -1}
            onClick={() => onChange(tab.id)}>
            {Icon ? <Icon aria-hidden="true" /> : null}
            {tab.label}
            {tab.badge ? <b>{tab.badge}</b> : null}
          </button>
        );
      })}
    </div>
  );
}
