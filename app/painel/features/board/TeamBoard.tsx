"use client";

import { useState } from "react";
import { Inbox, UserRound } from "lucide-react";
import type { Card, WorkspaceMember } from "@/lib/fila-dp-types";
import { DemandCard, initialsOf } from "./DemandCard";
import { loadLabel, loadTone, responsibleColumns, sortDemands, type DemandSort } from "./board.model";
import styles from "./board.module.css";

export type TeamBoardProps = {
  cards: readonly Card[];
  members: readonly WorkspaceMember[];
  stageNames: ReadonlyMap<string, string>;
  sort: DemandSort;
  canEdit: boolean;
  now: Date;
  selection: ReadonlySet<string>;
  filtered: boolean;
  onOpen: (card: Card) => void;
  onToggleSelect: (cardId: string, selected: boolean) => void;
  /** Atribuir por arrasto. `userId` vazio devolve a demanda para a fila comum. */
  onAssign: (cardId: string, userId: string, name: string) => void;
  onQuickAssign: (card: Card) => void;
  onQuickComment: (card: Card) => void;
  onQuickDue: (card: Card) => void;
};

/**
 * O quadro por responsável — o modo principal da Operação DP.
 *
 * O quadro por etapa responde "em que pé está o trabalho". Essa é uma pergunta
 * legítima e continua tendo o seu modo. Mas não é a pergunta que abre o dia de
 * um departamento pessoal: a primeira coisa que o gestor precisa ver é a pilha
 * que ainda não tem dono e quem já não dá conta do que tem. Por isso a coluna é
 * a pessoa, e a etapa vira uma etiqueta dentro do cartão.
 *
 * O arrasto muda o responsável, e não a etapa. É a única ação de arrasto neste
 * modo justamente para que ela não seja ambígua: em um quadro cujas colunas são
 * pessoas, soltar um cartão numa coluna só pode querer dizer uma coisa.
 */
export function TeamBoard(props: TeamBoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const columns = responsibleColumns(props.cards, props.members);

  if (columns.length === 0) {
    return <p className={styles.boardEmpty}>
      {props.filtered
        ? "Nenhuma demanda no recorte atual. Ajuste os filtros para ver o restante da operação."
        : "Nenhuma demanda em aberto. Quando chegar uma solicitação, ela aparece aqui."}
    </p>;
  }

  return (
    <div className={styles.columns} role="list" aria-label="Demandas por responsável">
      {columns.map((column) => {
        const semDono = column.key === "";
        const tone = loadTone(column.load);
        const alvo = `responsavel:${column.key}`;
        return (
          <section
            key={alvo}
            role="listitem"
            className={styles.column}
            data-unassigned={semDono || undefined}
            data-drop={over === alvo || undefined}
            data-dragging={dragging !== null || undefined}
            onDragOver={(event) => {
              if (!props.canEdit || !dragging) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOver(alvo);
            }}
            /* Sem a guarda de `relatedTarget`, passar por cima de um cartão
               filho dispara `dragleave` na coluna e o realce pisca. */
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setOver((atual) => (atual === alvo ? null : atual));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const cardId = dragging ?? event.dataTransfer.getData("text/plain");
              setDragging(null);
              setOver(null);
              if (!props.canEdit || !cardId) return;
              props.onAssign(cardId, column.userId, semDono ? "" : column.name);
            }}
          >
            <header className={styles.columnHead}>
              <span className={styles.avatar} data-empty={semDono || undefined} aria-hidden="true">
                {semDono ? <Inbox /> : initialsOf(column.name)}
              </span>
              <span className={styles.columnWho}>
                <strong>{column.name}</strong>
                <small>{semDono ? "Fila comum" : column.role || "Sem departamento"}</small>
              </span>
              <b className={styles.columnCount}>{column.open}</b>
            </header>

            {semDono ? (
              <p className={styles.columnHint}>
                {column.open === 0
                  ? "Nada para distribuir."
                  : `${column.open} ${column.open === 1 ? "solicitação" : "solicitações"} para distribuir`}
                {column.overdue > 0 && <em> · {column.overdue} {column.overdue === 1 ? "atrasada" : "atrasadas"}</em>}
              </p>
            ) : (
              <div className={styles.columnLoad}>
                {/* A barra é comparativa e o texto diz o mesmo que ela: cor e
                    comprimento sozinhos não informam quem não distingue as duas
                    coisas (§39). */}
                <span className={styles.loadBar} data-tone={tone} aria-hidden="true">
                  <i style={{ width: `${Math.round(column.load * 100)}%` }} />
                </span>
                <small>
                  {column.completed}/{column.open + column.completed} concluídas · {loadLabel[tone]}
                  {column.overdue > 0 && <em> · {column.overdue} {column.overdue === 1 ? "atrasada" : "atrasadas"}</em>}
                </small>
              </div>
            )}

            <div className={styles.columnCards}>
              {sortDemands(column.cards, props.sort).map((card) => (
                <DemandCard
                  key={card.id}
                  card={card}
                  stageName={props.stageNames.get(card.listId) ?? ""}
                  selected={props.selection.has(card.id)}
                  selectable={props.canEdit}
                  draggable={props.canEdit}
                  now={props.now}
                  onOpen={props.onOpen}
                  onToggleSelect={props.onToggleSelect}
                  onDragStart={setDragging}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  onQuickAssign={props.canEdit ? props.onQuickAssign : undefined}
                  onQuickComment={props.onQuickComment}
                  onQuickDue={props.canEdit ? props.onQuickDue : undefined}
                />
              ))}
              {column.cards.length === 0 && (
                <p className={styles.columnEmpty}>
                  {semDono ? "Tudo distribuído." : "Nenhuma demanda atribuída."}
                </p>
              )}
              {column.cards.length > 0 && column.open === 0 && (
                <p className={styles.columnEmpty}>Todas as demandas deste responsável foram concluídas.</p>
              )}
            </div>
          </section>
        );
      })}
      {/* Um alvo para devolver a demanda à fila comum sem precisar rolar até a
          primeira coluna. Só existe durante o arrasto, e só quando há alguém
          para devolver — fora disso seria uma caixa vazia permanente. */}
      {props.canEdit && dragging && (
        <div
          className={styles.unassignTarget}
          data-drop={over === "devolver" || undefined}
          onDragOver={(event) => { event.preventDefault(); setOver("devolver"); }}
          onDragLeave={() => setOver((atual) => (atual === "devolver" ? null : atual))}
          onDrop={(event) => {
            event.preventDefault();
            const cardId = dragging ?? event.dataTransfer.getData("text/plain");
            setDragging(null);
            setOver(null);
            if (cardId) props.onAssign(cardId, "", "");
          }}
        >
          <UserRound aria-hidden="true" />
          Devolver para a fila comum
        </div>
      )}
    </div>
  );
}
