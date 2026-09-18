"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { BoardList, WorkspaceMember } from "@/lib/fila-dp-types";
import styles from "./board.module.css";

export type BulkAction =
  | { action: "assign"; assigneeIds: string[] }
  | { action: "priority"; priority: string }
  | { action: "due"; dueAt: string }
  | { action: "move"; toListId: string };

/**
 * A barra que aparece quando há demandas selecionadas.
 *
 * A segunda-feira do DP é uma pilha que chegou no fim de semana, e distribuí-la
 * uma a uma custa três cliques por demanda. Aqui é um gesto só.
 *
 * Cada controle dispara **uma** ação e zera a seleção. Um formulário que
 * juntasse responsável, prazo e prioridade num "aplicar" abriria a porta para a
 * ação que falha pela metade — e desfazer a metade que passou seria trabalho
 * manual de quem mandou.
 */
export function BulkBar({ count, members, lists, busy, onRun, onClear }: {
  count: number;
  members: readonly WorkspaceMember[];
  lists: readonly BoardList[];
  busy: boolean;
  onRun: (action: BulkAction) => void;
  onClear: () => void;
}) {
  const [dueAt, setDueAt] = useState("");
  const operacionais = members.filter((member) => member.role === "admin" || member.role === "member");

  return (
    <div className={styles.bulkBar} role="region" aria-label="Ações para as demandas selecionadas">
      <strong>{count} {count === 1 ? "demanda selecionada" : "demandas selecionadas"}</strong>

      <label>
        <span>Atribuir</span>
        <select
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            onRun({ action: "assign", assigneeIds: value === "none" ? [] : [value] });
          }}
        >
          <option value="">Escolher…</option>
          <option value="none">Sem responsável</option>
          {operacionais.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
        </select>
      </label>

      <label>
        <span>Prioridade</span>
        <select
          value=""
          disabled={busy}
          onChange={(event) => { if (event.target.value) onRun({ action: "priority", priority: event.target.value }); }}
        >
          <option value="">Escolher…</option>
          <option value="urgent">Urgente</option>
          <option value="high">Alta</option>
          <option value="normal">Normal</option>
          <option value="low">Baixa</option>
        </select>
      </label>

      <label>
        <span>Prazo</span>
        <input
          type="datetime-local"
          value={dueAt}
          disabled={busy}
          onChange={(event) => setDueAt(event.target.value)}
          aria-label="Novo prazo das demandas selecionadas"
        />
        <button type="button" disabled={busy || !dueAt} onClick={() => onRun({ action: "due", dueAt })}>Aplicar</button>
      </label>

      <label>
        <span>Mover</span>
        <select
          value=""
          disabled={busy}
          onChange={(event) => { if (event.target.value) onRun({ action: "move", toListId: event.target.value }); }}
        >
          <option value="">Escolher…</option>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
      </label>

      <button type="button" className={styles.bulkClear} onClick={onClear} aria-label="Limpar seleção">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
