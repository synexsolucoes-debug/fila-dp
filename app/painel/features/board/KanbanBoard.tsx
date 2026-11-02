"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Archive, CheckSquare, ChevronsLeftRight, Clock3, Hourglass, MessageCircle, MoreHorizontal,
  Paperclip, Pencil, Plus, X,
} from "lucide-react";
import type { BoardList, Card } from "@/lib/fila-dp-types";
import { initialsOf } from "@/lib/initials";
import { demandReference, dueBadge, responsibleName, staleDays } from "./board.model";
import styles from "./kanban.module.css";

/** Para onde a demanda vai: a coluna e, dentro dela, entre quais vizinhos. */
export type KanbanDrop = { cardId: string; toListId: string; beforeCardId?: string; afterCardId?: string };

export type KanbanBoardProps = {
  lists: readonly BoardList[];
  /** As demandas de cada coluna, já filtradas e ordenadas. */
  cardsByList: ReadonlyMap<string, readonly Card[]>;
  /** Chave da raia, quando o quadro está agrupado; separa os alvos de arrasto. */
  laneKey: string;
  canEdit: boolean;
  /** Só a ordem do quadro aceita soltar entre duas demandas. Ordenado por prazo, soltar vai para o fim. */
  reorderable: boolean;
  /** O "Adicionar demanda" dentro da coluna. Desligado nas raias. */
  composer: boolean;
  density: "comfortable" | "compact";
  filtered: boolean;
  now: Date;
  processTypes: readonly string[];
  archiveDays: number;
  archivedTotal: number;
  onOpen: (card: Card) => void;
  onMove: (drop: KanbanDrop) => void;
  onQuickCreate: (input: { listId: string; title: string; processType: string }) => Promise<boolean>;
  onOpenFullForm: (input: { listId: string; title: string; processType: string }) => void;
  onOpenArchive: () => void;
  onManageColumns?: () => void;
  /** Linhas extras do cartão (etapa do processo, fluxo entre áreas), desenhadas pelo painel. */
  renderCardDetail?: (card: Card) => ReactNode;
};

const COLLAPSED_KEY = "vinculato.kanban.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(value: ReadonlySet<string>) {
  try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value])); } catch { /* preferência local, opcional */ }
}

/**
 * O quadro por etapa, no desenho do Trello.
 *
 * O que veio do Trello é a forma de trabalhar, não o cartão genérico
 * (§17 de docs/engenharia-reversa-trello.md):
 *
 *  - **Coluna de largura fixa e rolagem lateral.** Esticar três colunas na
 *    largura da tela fazia cada cartão ocupar meia tela; com largura fixa o
 *    quadro mostra mais demandas e cresce para o lado quando há mais etapas.
 *  - **Cartão curto.** Etiquetas no topo, título, quem e onde, e uma linha de
 *    selos (prazo, checklist, comentários, anexos, parada) com os responsáveis
 *    à direita. O resto está a um clique, na gaveta.
 *  - **Adicionar na própria coluna.** Digitar o título e apertar Enter cria a
 *    demanda ali; "Mais detalhes" abre o formulário completo com o título já
 *    preenchido. O tipo de processo vem junto, porque demanda sem tipo não tem
 *    SLA nem relatório.
 *  - **Soltar onde se quer.** O arrasto mostra a linha de destino e grava a
 *    posição entre os vizinhos; reordenar na mesma coluna não conta como mover.
 *  - **Recolher coluna**, guardado só neste navegador.
 */
export function KanbanBoard(props: KanbanBoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<{ listId: string; index: number } | null>(null);
  // O quadro só monta no navegador, depois do snapshot: ler a preferência aqui não diverge do servidor.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readCollapsed()));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [composerFor, setComposerFor] = useState<string | null>(null);

  /* O cartão arrastado fica escondido enquanto voa; se o arrasto terminar fora
     de qualquer coluna, o `dragend` do documento devolve o quadro ao normal. */
  useEffect(() => {
    if (!dragging) return;
    const reset = () => { setDragging(null); setTarget(null); };
    document.addEventListener("dragend", reset);
    return () => document.removeEventListener("dragend", reset);
  }, [dragging]);

  const toggleCollapsed = (listId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(listId)) next.delete(listId); else next.add(listId);
      writeCollapsed(next);
      return next;
    });
    setMenuFor(null);
  };

  const ordered = [...props.lists].sort((a, b) => a.position - b.position);

  /** Índice de destino pela altura do ponteiro: acima do meio do cartão, entra antes dele. */
  const dropIndex = (event: DragEvent<HTMLElement>, container: HTMLElement) => {
    const items = [...container.querySelectorAll<HTMLElement>("[data-card-id]")]
      .filter((element) => element.dataset.cardId !== dragging);
    for (let index = 0; index < items.length; index += 1) {
      const box = items[index].getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) return index;
    }
    return items.length;
  };

  const finishDrop = (list: BoardList) => {
    const cardId = dragging;
    const index = target?.listId === list.id ? target.index : null;
    setDragging(null);
    setTarget(null);
    if (!props.canEdit || !cardId) return;
    const rest = (props.cardsByList.get(list.id) ?? []).filter((card) => card.id !== cardId);
    const original = props.lists.flatMap((item) => props.cardsByList.get(item.id) ?? []).find((card) => card.id === cardId);
    if (!props.reorderable || index === null) {
      if (original?.listId !== list.id) props.onMove({ cardId, toListId: list.id });
      return;
    }
    const beforeCardId = rest[index - 1]?.id;
    const afterCardId = rest[index]?.id;
    // Solto no mesmo lugar: nada a gravar.
    const current = props.cardsByList.get(list.id) ?? [];
    const at = current.findIndex((card) => card.id === cardId);
    if (at >= 0 && current[at - 1]?.id === beforeCardId && current[at + 1]?.id === afterCardId) return;
    props.onMove({ cardId, toListId: list.id, beforeCardId, afterCardId });
  };

  /** Teclado: Alt+←/→ troca de coluna, Alt+↑/↓ sobe e desce dentro dela. */
  const moveByKeyboard = (event: KeyboardEvent<HTMLElement>, card: Card) => {
    if (!props.canEdit || !event.altKey) return;
    const listIndex = ordered.findIndex((list) => list.id === card.listId);
    const cards = props.cardsByList.get(card.listId) ?? [];
    const at = cards.findIndex((item) => item.id === card.id);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = ordered[listIndex + (event.key === "ArrowLeft" ? -1 : 1)];
      if (next) props.onMove({ cardId: card.id, toListId: next.id });
    } else if (props.reorderable && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (event.key === "ArrowUp" && at > 0) {
        props.onMove({ cardId: card.id, toListId: card.listId, beforeCardId: cards[at - 2]?.id, afterCardId: cards[at - 1].id });
      } else if (event.key === "ArrowDown" && at >= 0 && at < cards.length - 1) {
        props.onMove({ cardId: card.id, toListId: card.listId, beforeCardId: cards[at + 1].id, afterCardId: cards[at + 2]?.id });
      }
    }
  };

  return (
    <div className={styles.board} data-density={props.density} data-dragging={dragging ? "" : undefined}>
      {ordered.map((list) => {
        const cards = props.cardsByList.get(list.id) ?? [];
        const isDone = list.kind === "done" || list.slaBehavior === "completed";
        const alvo = target?.listId === list.id ? target.index : null;
        const visiveis = cards.filter((card) => card.id !== dragging);

        if (collapsed.has(list.id)) {
          return (
            <section key={`${props.laneKey}:${list.id}`} className={styles.collapsed} aria-label={`${list.name}, coluna recolhida`}>
              <button type="button" onClick={() => toggleCollapsed(list.id)} title={`Expandir ${list.name}`}>
                <ChevronsLeftRight aria-hidden="true" />
                <span>{list.name}</span>
                <b>{cards.length}</b>
              </button>
            </section>
          );
        }

        return (
          <section
            key={`${props.laneKey}:${list.id}`}
            className={styles.column}
            data-kind={list.kind}
            data-drop={alvo !== null || undefined}
            aria-label={`${list.name}, ${cards.length} ${cards.length === 1 ? "demanda" : "demandas"}`}
          >
            <header className={styles.columnHeader}>
              <i className={styles.kindDot} data-kind={list.kind} data-sla={list.slaBehavior} aria-hidden="true" />
              <h3>{list.name}</h3>
              <b className={styles.count}>{cards.length}</b>
              <div className={styles.menuWrap}>
                <button type="button" className={styles.iconButton} aria-label={`Opções da coluna ${list.name}`}
                  aria-expanded={menuFor === list.id} aria-haspopup="menu"
                  onClick={() => setMenuFor((current) => (current === list.id ? null : list.id))}>
                  <MoreHorizontal aria-hidden="true" />
                </button>
                {menuFor === list.id && (
                  <ColumnMenu
                    title={list.name}
                    onClose={() => setMenuFor(null)}
                    items={[
                      ...(props.canEdit && props.composer ? [{ label: "Adicionar demanda", icon: <Plus aria-hidden="true" />, run: () => { setComposerFor(list.id); setMenuFor(null); } }] : []),
                      { label: "Recolher coluna", icon: <ChevronsLeftRight aria-hidden="true" />, run: () => toggleCollapsed(list.id) },
                      ...(isDone ? [{ label: `Ver arquivo (${props.archivedTotal})`, icon: <Archive aria-hidden="true" />, run: () => { setMenuFor(null); props.onOpenArchive(); } }] : []),
                      ...(props.onManageColumns ? [{ label: "Configurar colunas", icon: <Pencil aria-hidden="true" />, run: () => { setMenuFor(null); props.onManageColumns?.(); } }] : []),
                    ]}
                  />
                )}
              </div>
            </header>

            {/* A coluna de concluídas diz para onde as demandas vão: sem isto, a
                demanda que some depois de alguns dias parece ter sido apagada. */}
            {isDone && <p className={styles.archiveNote}>
              {props.archiveDays > 0
                ? <>Vão para o Arquivo após {props.archiveDays} {props.archiveDays === 1 ? "dia" : "dias"}.</>
                : <>Ficam aqui até serem arquivadas.</>}
              {" "}<button type="button" onClick={props.onOpenArchive}>Ver arquivo ({props.archivedTotal})</button>
            </p>}

            <div
              className={styles.cards}
              onDragOver={(event) => {
                if (!props.canEdit || !dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const index = dropIndex(event, event.currentTarget);
                setTarget((current) => (current?.listId === list.id && current.index === index ? current : { listId: list.id, index }));
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setTarget((current) => (current?.listId === list.id ? null : current));
                }
              }}
              onDrop={(event) => { event.preventDefault(); finishDrop(list); }}
            >
              {cards.map((card) => {
                const index = visiveis.indexOf(card);
                return (
                <div key={card.id} className={styles.slot} data-hidden={card.id === dragging || undefined}>
                  {alvo === index && index >= 0 && props.reorderable && <span className={styles.dropLine} aria-hidden="true" />}
                  <KanbanCard
                    card={card}
                    now={props.now}
                    canEdit={props.canEdit}
                    onOpen={props.onOpen}
                    onKeyDown={(event) => moveByKeyboard(event, card)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", card.id);
                      event.dataTransfer.effectAllowed = "move";
                      // Deixa o navegador tirar a "foto" do cartão antes de escondê-lo.
                      window.setTimeout(() => setDragging(card.id), 0);
                    }}
                    onDragEnd={() => { setDragging(null); setTarget(null); }}
                    detail={props.renderCardDetail?.(card)}
                  />
                </div>
                );
              })}
              {alvo !== null && (alvo >= visiveis.length || !props.reorderable) && <span className={styles.dropLine} aria-hidden="true" />}

              {cards.length === 0 && dragging === null && composerFor !== list.id && <p className={styles.empty}>
                {props.filtered ? "Nenhuma demanda desta etapa no recorte atual." : "Nada nesta etapa por enquanto."}
              </p>}
            </div>

            {props.canEdit && props.composer && (composerFor === list.id
              ? <Composer
                  listName={list.name}
                  processTypes={props.processTypes}
                  onCancel={() => setComposerFor(null)}
                  onSubmit={(input) => props.onQuickCreate({ ...input, listId: list.id })}
                  onMore={(input) => { setComposerFor(null); props.onOpenFullForm({ ...input, listId: list.id }); }}
                />
              : <button type="button" className={styles.addCard} onClick={() => setComposerFor(list.id)}>
                  <Plus aria-hidden="true" /> Adicionar demanda
                </button>)}
          </section>
        );
      })}

      {props.onManageColumns && (
        <button type="button" className={styles.addColumn} onClick={props.onManageColumns}>
          <Plus aria-hidden="true" /> Adicionar coluna
        </button>
      )}
    </div>
  );
}

function KanbanCard(props: {
  card: Card;
  now: Date;
  canEdit: boolean;
  detail?: ReactNode;
  onOpen: (card: Card) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const { card, now } = props;
  const feitas = card.checklist.filter((item) => item.completed).length;
  const parada = staleDays(card, now);
  const dono = responsibleName(card);
  const pessoas = card.assignees.length > 0 ? card.assignees : dono ? [{ userId: dono, name: dono, email: "" }] : [];
  const referencia = demandReference(card);
  const colaborador = card.customValues.matricula ?? "";

  return (
    <article
      className={styles.card}
      data-card-id={card.id}
      data-sla={card.slaStatus}
      data-priority={card.priority}
      draggable={props.canEdit}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onKeyDown={props.onKeyDown}
    >
      <div className={styles.labels}>
        <span className={styles.process}>{card.processType}</span>
        {(card.priority === "urgent" || card.priority === "high") && (
          <span className={styles.priority} data-level={card.priority}>{card.priority === "urgent" ? "Urgente" : "Alta"}</span>
        )}
        {card.labels.slice(0, 3).map((label) => (
          <span key={label.id} className={styles.label} style={{ color: label.color, backgroundColor: `${label.color}1f` }}>{label.name}</span>
        ))}
        {card.labels.length > 3 && <span className={styles.labelMore} title={card.labels.slice(3).map((label) => label.name).join(", ")}>+{card.labels.length - 3}</span>}
      </div>

      {/* O título é o botão. Com o cartão inteiro sendo botão, as ações dentro
          dele virariam controle dentro de controle. */}
      <button type="button" className={styles.title} onClick={() => props.onOpen(card)}
        aria-keyshortcuts={props.canEdit ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined}
        title={props.canEdit ? "Alt + setas move a demanda" : undefined}>
        {card.title}
      </button>

      <p className={styles.who}>
        {referencia && <span className={styles.reference}>{referencia}</span>}
        {colaborador && <span>{colaborador}</span>}
        <span className={styles.company} title={card.company || undefined}>{card.company || "Sem empresa"}</span>
      </p>

      {props.detail && <div className={styles.detail}>{props.detail}</div>}

      <div className={styles.badges}>
        <span className={styles.due} data-sla={card.slaStatus} data-empty={!card.dueAt || undefined}
          title={card.dueAt ? `Prazo: ${new Date(card.dueAt).toLocaleString("pt-BR")}` : "Sem prazo definido"}>
          <Clock3 aria-hidden="true" />{dueBadge(card, now)}
        </span>
        {parada !== null && <span className={styles.stale} title="Sem nenhuma alteração desde então">
          <Hourglass aria-hidden="true" />Parada há {parada} dias
        </span>}
        {card.checklist.length > 0 && <span className={styles.badge} data-done={feitas === card.checklist.length || undefined} title="Checklist">
          <CheckSquare aria-hidden="true" />{feitas}/{card.checklist.length}
        </span>}
        {card.comments.length > 0 && <span className={styles.badge} title="Comentários"><MessageCircle aria-hidden="true" />{card.comments.length}</span>}
        {card.attachments.length > 0 && <span className={styles.badge} title="Anexos"><Paperclip aria-hidden="true" />{card.attachments.length}</span>}

        <span className={styles.people}>
          {pessoas.length === 0
            ? <span className={styles.orphan}>Sem responsável</span>
            : <>
                {pessoas.slice(0, 3).map((pessoa) => (
                  <span key={pessoa.userId} className={styles.avatar} title={pessoa.name}>{initialsOf(pessoa.name)}</span>
                ))}
                {pessoas.length > 3 && <span className={styles.avatar} data-more="">+{pessoas.length - 3}</span>}
              </>}
        </span>
      </div>

      {/* O lápis do Trello: abre a demanda sem precisar mirar no título. */}
      <button type="button" className={styles.edit} onClick={() => props.onOpen(card)} aria-label={`Editar ${card.title}`} tabIndex={-1}>
        <Pencil aria-hidden="true" />
      </button>
    </article>
  );
}

function Composer(props: {
  listName: string;
  processTypes: readonly string[];
  onSubmit: (input: { title: string; processType: string }) => Promise<boolean>;
  onMore: (input: { title: string; processType: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [processType, setProcessType] = useState("OUTROS");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLFormElement>(null);

  useEffect(() => { field.current?.focus(); }, []);

  const submit = async () => {
    const clean = title.trim();
    if (!clean || saving) return;
    setSaving(true);
    const ok = await props.onSubmit({ title: clean, processType });
    setSaving(false);
    // Como no Trello, o campo continua aberto para a próxima demanda.
    if (ok) { setTitle(""); field.current?.focus(); }
  };

  return (
    <form
      ref={root}
      className={styles.composer}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onBlur={(event) => {
        if (!title.trim() && !root.current?.contains(event.relatedTarget as Node | null)) props.onCancel();
      }}
    >
      <textarea
        ref={field}
        value={title}
        rows={2}
        maxLength={180}
        placeholder="Título da demanda"
        aria-label={`Título da nova demanda em ${props.listName}`}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
        }}
      />
      <label className={styles.composerProcess}>
        <span>Processo</span>
        <select value={processType} onChange={(event) => setProcessType(event.target.value)}>
          {props.processTypes.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <div className={styles.composerActions}>
        <button type="submit" className={styles.composerSubmit} disabled={!title.trim() || saving}>
          {saving ? "Adicionando…" : "Adicionar"}
        </button>
        <button type="button" className={styles.iconButton} onClick={props.onCancel} aria-label="Cancelar">
          <X aria-hidden="true" />
        </button>
        <button type="button" className={styles.composerMore} onClick={() => props.onMore({ title: title.trim(), processType })}>
          Mais detalhes
        </button>
      </div>
    </form>
  );
}

function ColumnMenu(props: {
  title: string;
  items: Array<{ label: string; icon: ReactNode; run: () => void }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  useEffect(() => { onClose.current = props.onClose; });

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button[role='menuitem']")?.focus();
    const close = (event: MouseEvent) => {
      // O clique no próprio botão "⋯" já alterna o menu; fechar aqui o reabriria.
      const trigger = ref.current?.parentElement;
      if (!trigger?.contains(event.target as Node)) onClose.current();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} className={styles.menu} role="menu" aria-label={`Opções da coluna ${props.title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
      <strong>{props.title}</strong>
      {props.items.map((item) => (
        <button key={item.label} type="button" role="menuitem" onClick={item.run}>{item.icon}{item.label}</button>
      ))}
    </div>
  );
}
