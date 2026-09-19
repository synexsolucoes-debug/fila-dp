"use client";

import { CalendarClock, Clock3, ListChecks, MessageSquarePlus, Paperclip, UserPlus } from "lucide-react";
import type { DragEvent } from "react";
import type { Card } from "@/lib/fila-dp-types";
import { DEMAND_NEXT_ACTION_FALLBACK, demandNextAction } from "@/lib/demand-dashboard";
import { attentionRank, demandReference, dueBadge, responsibleName, slaReading } from "./board.model";
import styles from "./board.module.css";

/** Iniciais para o avatar; duas no máximo, porque três viram uma sopa de letras. */
export function initialsOf(value: string): string {
  const partes = value.trim().split(/\s+/u).filter(Boolean);
  if (partes.length === 0) return "?";
  const primeira = partes[0][0] ?? "";
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] ?? "" : "";
  return `${primeira}${ultima}`.toUpperCase();
}

export type DemandCardProps = {
  card: Card;
  /** Nome da etapa em que a demanda está — o "status" que o cartão exibe. */
  stageName: string;
  selected: boolean;
  selectable: boolean;
  draggable: boolean;
  now: Date;
  onOpen: (card: Card) => void;
  onToggleSelect: (cardId: string, selected: boolean) => void;
  onDragStart?: (cardId: string) => void;
  onDragEnd?: () => void;
  onQuickAssign?: (card: Card) => void;
  onQuickComment?: (card: Card) => void;
  onQuickDue?: (card: Card) => void;
};

/**
 * O cartão da demanda.
 *
 * A hierarquia é fixa e curta — protocolo, processo, título, colaborador e
 * empresa, prazo, etapa, checklist — porque o quadro é lido de relance, linha
 * após linha, e um cartão que às vezes mostra uma coisa e às vezes outra obriga
 * a reler cada um deles. O que não cabe nessa lista não entra no cartão: entra
 * na gaveta, que abre em um clique e não custa a saída da tela.
 *
 * As ações rápidas só aparecem no hover e no foco de teclado. Ícones fixos em
 * cada cartão somariam quatro elementos por demanda num quadro de sessenta, e o
 * que eles acrescentam — poupar a abertura da gaveta — não paga esse ruído.
 * Ficarem escondidas do teclado, por outro lado, seria torná-las inexistentes
 * para quem não usa mouse; por isso `:focus-within` também as revela.
 */
export function DemandCard(props: DemandCardProps) {
  const { card, now } = props;
  const dono = responsibleName(card);
  const feitas = card.checklist.filter((item) => item.completed).length;
  const sla = slaReading(card, now);
  const atencao = attentionRank(card, now);
  const colaborador = card.customValues.matricula ?? "";
  const derivado = demandNextAction(card);
  const proximoPasso = card.nextStep || (derivado === DEMAND_NEXT_ACTION_FALLBACK ? "" : derivado);

  const arrastar = (event: DragEvent<HTMLElement>) => {
    if (!props.draggable) return;
    /* `text/plain` com o id: sem dado no evento, o navegador cancela o arrasto
       em parte dos ambientes, e o cartão "não sai do lugar" sem nenhum erro. */
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
    props.onDragStart?.(card.id);
  };

  return (
    <article
      className={styles.card}
      data-sla={card.slaStatus}
      data-priority={card.priority}
      data-attention={atencao <= 1 ? "high" : undefined}
      data-selected={props.selected || undefined}
      draggable={props.draggable}
      onDragStart={arrastar}
      onDragEnd={() => props.onDragEnd?.()}
    >
      {props.selectable && (
        <label className={styles.cardSelect}>
          <input
            type="checkbox"
            checked={props.selected}
            onChange={(event) => props.onToggleSelect(card.id, event.target.checked)}
            aria-label={`Selecionar ${card.title}`}
          />
        </label>
      )}

      <div className={styles.cardTop}>
        {demandReference(card) && <span className={styles.reference}>{demandReference(card)}</span>}
        <span className={styles.process}>{card.processType}</span>
        {(card.priority === "urgent" || card.priority === "high") && (
          <span className={styles.priority} data-level={card.priority}>
            {card.priority === "urgent" ? "Urgente" : "Alta"}
          </span>
        )}
      </div>

      {/* O botão é o título, e não o cartão inteiro. Com o cartão inteiro sendo
          botão, a caixa de seleção e as ações rápidas ficariam dentro dele —
          controle dentro de controle, que o leitor de tela anuncia como um
          amontoado e o teclado percorre na ordem errada. */}
      <button type="button" className={styles.cardTitle} onClick={() => props.onOpen(card)}>
        {card.title}
      </button>

      <p className={styles.cardWho}>
        {colaborador && <span className={styles.employee}>{colaborador}</span>}
        <span className={styles.company}>{card.company || "Sem empresa informada"}</span>
      </p>

      <div className={styles.cardBottom}>
        <span
          className={styles.due}
          data-sla={card.slaStatus}
          title={`Prazo interno: ${sla.deadline}\nTempo restante: ${sla.remaining}\nSLA: ${sla.state}`}
        >
          <Clock3 aria-hidden="true" />
          {dueBadge(card, now)}
        </span>
        <span className={styles.stage}>{props.stageName}</span>
        {card.checklist.length > 0 && (
          <span className={styles.checklist} title="Itens do checklist concluídos">
            <ListChecks aria-hidden="true" />{feitas}/{card.checklist.length}
          </span>
        )}
        {card.attachments.length > 0 && (
          <span className={styles.meta} title="Anexos"><Paperclip aria-hidden="true" />{card.attachments.length}</span>
        )}
        {!dono && <span className={styles.orphan}>Sem responsável</span>}
      </div>

      {/* O próximo passo escrito vence o derivado.
          Quando ninguém escreveu um, o cartão ainda assim diz o que fazer,
          usando o que a demanda já tem: o item pendente do checklist ou o
          motivo pelo qual o SLA está parado. O texto de reserva fica de fora —
          "conferir os detalhes" repetido em sessenta cartões é uma linha de
          ruído por cartão, e o cartão já tem título, empresa, prazo e etapa. */}
      {proximoPasso && (
        <p className={styles.nextStep} title="Próximo passo" data-derived={card.nextStep ? undefined : "true"}>
          {proximoPasso}
        </p>
      )}

      {(props.onQuickAssign || props.onQuickComment || props.onQuickDue) && (
        <div className={styles.quickActions}>
          {props.onQuickAssign && (
            <button type="button" onClick={() => props.onQuickAssign?.(card)} title="Alterar responsável" aria-label={`Alterar responsável de ${card.title}`}>
              <UserPlus aria-hidden="true" />
            </button>
          )}
          {props.onQuickDue && (
            <button type="button" onClick={() => props.onQuickDue?.(card)} title="Alterar prazo" aria-label={`Alterar prazo de ${card.title}`}>
              <CalendarClock aria-hidden="true" />
            </button>
          )}
          {props.onQuickComment && (
            <button type="button" onClick={() => props.onQuickComment?.(card)} title="Adicionar nota" aria-label={`Adicionar nota em ${card.title}`}>
              <MessageSquarePlus aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}
