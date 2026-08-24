"use client";

import { AlertOctagon, LoaderCircle, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { DialogPortal, useDialogFocus, useExitTransition } from "./motion";
import { statusTone, type PanelTone } from "./status-tone";
import motion from "./motion.module.css";
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

/**
 * Esqueleto de página (§51).
 *
 * `LoadingState` continua valendo para uma faixa dentro de uma tela já
 * desenhada — uma aba que recarrega, um painel lateral. Para a tela inteira
 * ele diz apenas "algo está acontecendo": o rodopio não tem forma, e a chegada
 * do dado salta o layout inteiro de uma vez.
 *
 * O esqueleto diz a forma do que vem. Quem já conhece a tela reconhece o
 * destino antes de o dado chegar, e o espaço já está reservado quando ele
 * chega. `role="status"` com `aria-busy` porque a espera precisa ser anunciada
 * — sem isso, quem usa leitor de tela ouve silêncio entre o clique e os dados.
 */
export function PageSkeleton({ label, rows = 3, metrics = 4 }: {
  /** O que está sendo carregado. Anunciado ao leitor de tela. */
  label: string;
  /** Linhas da lista/tabela esperada. */
  rows?: number;
  /** Indicadores da fila superior; `0` para telas que não têm. */
  metrics?: number;
}) {
  const bar = (size: string, index: number) =>
    <span key={`${size}-${index}`} className={styles.skeletonBar} data-size={size}
      style={{ "--skeleton-index": index } as CSSProperties} />;

  return <div className={styles.pageSkeleton} role="status" aria-busy="true" aria-live="polite">
    <span className={styles.srOnly}>{label}</span>
    <div className={styles.skeletonBlock} aria-hidden="true">
      {bar("title", 0)}
      {bar("line", 1)}
    </div>
    {metrics > 0 && <div className={styles.skeletonRow} aria-hidden="true">
      {Array.from({ length: metrics }, (_, index) =>
        <div key={index} className={styles.skeletonBlock}>{bar("tall", index)}</div>)}
    </div>}
    <div className={styles.skeletonBlock} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => bar("row", index))}
    </div>
  </div>;
}

/**
 * Confirmação de ação destrutiva (§53).
 *
 * O que o diálogo precisa dizer não é "tem certeza?" — é o que vai acontecer:
 * "esta operação irá retirar 2 unidades do estoque disponível". A `consequence`
 * é obrigatória por isso; um diálogo sem ela devolve a pergunta a quem já
 * clicou e não acrescenta informação nenhuma para decidir.
 *
 * `role="alertdialog"` e não `dialog`: é a função que o ARIA reserva para uma
 * interrupção que exige resposta, e o leitor de tela anuncia a descrição
 * sozinho ao receber o foco.
 */
export function ConfirmDialog({ open, title, consequence, confirmLabel, busy, onCancel, onConfirm, eyebrow = "CONFIRMAÇÃO NECESSÁRIA" }: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  eyebrow?: string;
}) {
  const { mounted, state } = useExitTransition(open, 250);
  const ref = useDialogFocus(mounted && state === "open", onCancel, busy);
  if (!mounted) return null;
  return (
    <DialogPortal>
    <div className={motion.backdrop} data-state={state} onMouseDown={busy ? undefined : onCancel}>
      <div ref={ref} className={styles.confirmDialog} data-state={state}
        role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-consequence"
        onMouseDown={(event) => event.stopPropagation()}>
        <header><span>{eyebrow}</span><h2 id="confirm-title">{title}</h2></header>
        <div className={styles.confirmBody}>
          <TriangleAlert aria-hidden="true" />
          <p id="confirm-consequence">{consequence}</p>
        </div>
        <footer>
          <button type="button" className={styles.confirmCancel} onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="button" className={styles.confirmAction} onClick={onConfirm} disabled={busy}>
            {busy ? "Confirmando…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
    </DialogPortal>
  );
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
