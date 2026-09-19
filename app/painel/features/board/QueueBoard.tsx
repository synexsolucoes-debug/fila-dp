"use client";

import type { Card } from "@/lib/fila-dp-types";
import { DemandCard } from "./DemandCard";
import { queueSections, type BoardContext } from "./board.model";
import styles from "./board.module.css";

export type QueueBoardProps = {
  cards: readonly Card[];
  context: BoardContext;
  stageNames: ReadonlyMap<string, string>;
  canEdit: boolean;
  now: Date;
  selection: ReadonlySet<string>;
  onOpen: (card: Card) => void;
  onToggleSelect: (cardId: string, selected: boolean) => void;
  onQuickAssign: (card: Card) => void;
  onQuickComment: (card: Card) => void;
  onQuickDue: (card: Card) => void;
};

/**
 * Minha fila: o mesmo conjunto de demandas, na ordem em que o dia acontece.
 *
 * Um filtro por responsável devolveria "suas 23 demandas" — e uma lista de 23
 * não diz por onde começar. Aqui a divisão é a decisão: o que já custou prazo,
 * o que ainda dá para salvar hoje, o que vem depois, e o que não depende de
 * você. As quatro seções aparecem sempre, inclusive vazias, porque "nada
 * atrasado" é uma resposta que a pessoa veio buscar.
 */
export function QueueBoard(props: QueueBoardProps) {
  const sections = queueSections(props.cards, props.context, props.now);
  return (
    <div className={styles.queue}>
      {sections.map((section) => (
        <section key={section.id} className={styles.queueSection} data-section={section.id}>
          <header>
            <strong>{section.label}</strong>
            <b>{section.cards.length}</b>
            <small>{section.hint}</small>
          </header>
          <div className={styles.queueCards}>
            {section.cards.map((card) => (
              <DemandCard
                key={card.id}
                card={card}
                stageName={props.stageNames.get(card.listId) ?? ""}
                selected={props.selection.has(card.id)}
                selectable={props.canEdit}
                draggable={false}
                now={props.now}
                onOpen={props.onOpen}
                onToggleSelect={props.onToggleSelect}
                onQuickAssign={props.canEdit ? props.onQuickAssign : undefined}
                onQuickComment={props.onQuickComment}
                onQuickDue={props.canEdit ? props.onQuickDue : undefined}
              />
            ))}
            {section.cards.length === 0 && (
              <p className={styles.columnEmpty}>
                {section.id === "overdue" ? "Nada atrasado por aqui." : "Nenhuma demanda nesta faixa."}
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
