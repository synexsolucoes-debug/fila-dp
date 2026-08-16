"use client";

import { AlertOctagon, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { statusTone, type PanelTone } from "./status-tone";
import styles from "./panel-ui.module.css";

/**
 * Componentes de painel (§16).
 *
 * Cabeçalho, estado vazio, carregamento, aviso de erro e selo de status
 * existiam duplicados nos oito módulos do painel — cada cópia com uma medida,
 * uma cor e, no caso do aviso de erro, uma decisão diferente sobre anunciar-se
 * ao leitor de tela. Este arquivo é a definição única.
 *
 * O vocabulário de status é compartilhado de propósito: "aprovado" precisa ter
 * a mesma cor em Benefícios, em Operações e em Cadastros, ou quem opera os três
 * aprende três significados para o mesmo verde.
 */

export function PanelHeader({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description: string; action?: ReactNode;
}) {
  // A ação vai dentro de um invólucro próprio porque em tela estreita o
  // cabeçalho empilha e o botão precisa ocupar a largura. Cada módulo resolvia
  // isso com um seletor para a *sua* classe de botão (`.panelHeader >
  // .primaryButton`); daqui não dá para nomear a classe de quem chama.
  return <header className={styles.panelHeader}>
    <div><span className={styles.eyebrow}>{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>
    {action ? <div className={styles.headerAction}>{action}</div> : null}
  </header>;
}

/** `compact` para colunas estreitas — barra lateral, cartão —, onde a altura
 *  cheia empurraria o resto da tela para fora da dobra. */
export type PanelStateSize = "page" | "compact";

export function EmptyState({ icon: Icon, title, text, action, size }: {
  icon: LucideIcon; title: string; text: string; action?: ReactNode; size?: PanelStateSize;
}) {
  return <div className={styles.emptyState} data-size={size}>
    <span><Icon aria-hidden="true" /></span>
    <strong>{title}</strong>
    <p>{text}</p>
    {action ? <div className={styles.action}>{action}</div> : null}
  </div>;
}

export function LoadingState({ title, text = "Isso leva só um instante.", size }: {
  title: string; text?: string; size?: PanelStateSize;
}) {
  // `role="status"` com `aria-live="polite"` porque a espera precisa ser
  // anunciada: sem isso, quem usa leitor de tela ouve silêncio entre o clique e
  // a chegada dos dados e não sabe se a ação foi registrada.
  return <div className={styles.loadingState} data-size={size} role="status" aria-live="polite">
    <LoaderCircle className={styles.spin} aria-hidden="true" />
    <strong>{title}</strong>
    <span>{text}</span>
  </div>;
}

export function ErrorBanner({ title, message, onDismiss }: {
  title?: string; message: string; onDismiss?: () => void;
}) {
  // `role="alert"` é obrigatório aqui, não opcional: duas das dez cópias
  // anteriores não o tinham, e o erro que elas mostravam nunca era anunciado.
  return <div className={styles.errorBanner} role="alert">
    <AlertOctagon aria-hidden="true" />
    <span>{title ? <strong>{title}</strong> : null}{message}</span>
    {onDismiss ? <button type="button" onClick={onDismiss} aria-label="Fechar aviso"><X aria-hidden="true" /></button> : null}
  </div>;
}

export function StatusPill({ status, label, tone }: { status: string; label: string; tone?: PanelTone }) {
  // `data-panel-ui` é o gancho de posicionamento para quem contém o selo. A
  // classe vem de um CSS Module e é remapeada na compilação, então um seletor
  // como `.pendingLedger article > .statusPill` escrito noutro módulo deixaria
  // de casar — silenciosamente, levando junto a arrumação em telas estreitas.
  return <span className={styles.statusPill} data-panel-ui="pill" data-tone={tone ?? statusTone(status)}>
    <i aria-hidden="true" />{label}
  </span>;
}
