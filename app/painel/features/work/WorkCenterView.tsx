"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, Building2, CalendarClock, CheckCircle2, Filter,
  Inbox, ListChecks, RefreshCw, Workflow,
} from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, PanelHeader } from "../shared";
import { ActionCenter } from "../action-center";
import type { ActionTarget } from "@/lib/action-center";
import { dueLabel, formatDateTime, normalizeWorkPayload, requestJson } from "./work.api";
import type { WorkItem, WorkPayload } from "./work.types";
import styles from "./work.module.css";

/**
 * Central de Trabalho (§3 a §12).
 *
 * Uma tela que responde **"o que está comigo hoje?"** sobre os objetos que já
 * existem. Ela não substitui Demandas nem nenhuma outra: é camada agregadora, e
 * cada item leva para a tela do módulo que o resolve (§9). Nada é editado aqui
 * — a Central que edita vira o quinto sistema de tarefas que a consolidação
 * inteira existe para não criar.
 *
 * ## O que o servidor decide, e o que a tela decide
 *
 * O servidor decide **tudo o que muda o conjunto**: escopo, filtros, ordenação,
 * agrupamento, contadores e página. A tela decide só a apresentação. Filtrar no
 * navegador exigiria baixar a fila inteira para esconder metade dela — e é
 * assim que uma lista de trabalho fica lenta justamente para quem tem mais
 * trabalho (§12, §50).
 *
 * ## Carregamento por seção (§58)
 *
 * Os contadores e a lista chegam na mesma resposta, mas a tela não some quando
 * a pessoa troca um filtro: o conteúdo anterior fica visível e apenas a faixa de
 * atualização se anuncia. Bloquear a tela inteira para recarregar uma lista é o
 * que faz cada clique parecer um recomeço.
 */

type Filters = {
  scope: "meu" | "equipe";
  sort: string;
  group: string;
  due: string;
  source: string;
  company: string;
  priority: string;
  status: string;
  origin: string;
};

const emptyFilters: Filters = {
  scope: "meu", sort: "urgency", group: "", due: "",
  source: "", company: "", priority: "", status: "", origin: "",
};

const PRIORITIES = [
  { key: "", label: "Qualquer prioridade" },
  { key: "urgent", label: "Urgente" },
  { key: "high", label: "Alta" },
  { key: "normal", label: "Normal" },
  { key: "low", label: "Baixa" },
];

function buildQuery(filters: Filters, cursor: string) {
  const search = new URLSearchParams();
  search.set("escopo", filters.scope === "equipe" ? "equipe" : "meu");
  if (filters.sort) search.set("ordem", filters.sort);
  if (filters.group) search.set("agrupar", filters.group);
  if (filters.due) search.set("prazo", filters.due);
  if (filters.source) search.set("fontes", filters.source);
  if (filters.company) search.set("empresa", filters.company);
  if (filters.priority) search.set("prioridade", filters.priority);
  if (filters.status) search.set("situacao", filters.status);
  if (filters.origin) search.set("origem", filters.origin);
  if (cursor) search.set("cursor", cursor);
  return search.toString();
}

export function WorkCenterView({ onOpenCompanyFilter, onNavigate, companyId }: {
  onOpenCompanyFilter?: (companyId: string) => void;
  /** Destino de cada pendência da central de ação. */
  onNavigate?: (target: ActionTarget) => void;
  /** Empresa do recorte do topo; vazio = todas as autorizadas. */
  companyId?: string;
}) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [payload, setPayload] = useState<WorkPayload | null>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  /** Depois da primeira carga, trocar filtro atualiza sem apagar a tela (§58). */
  const loadedOnce = useRef(false);

  const load = useCallback(async (next: Filters, quiet: boolean) => {
    const token = ++requestId.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const data = await requestJson<Record<string, unknown>>(`/api/work?${buildQuery(next, "")}`);
      // Resposta de um pedido antigo não pode sobrescrever o atual: quem troca
      // dois filtros rápido veria a lista do primeiro.
      if (token !== requestId.current) return;
      const normalized = normalizeWorkPayload(data);
      setPayload(normalized);
      setItems(normalized.items);
      setCursor(normalized.nextCursor);
      setError("");
    } catch (cause) {
      if (token !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o seu trabalho.");
    } finally {
      if (token === requestId.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  /* O carregamento é adiado para o quadro seguinte, e não disparado no corpo do
     efeito: assim a primeira pintura acontece antes da rede, e trocar dois
     filtros seguidos não empilha renderizações em cascata. É o mesmo padrão dos
     demais módulos do painel. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(filters, loadedOnce.current); loadedOnce.current = true; });
    return () => window.cancelAnimationFrame(frame);
  }, [filters, load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await requestJson<Record<string, unknown>>(`/api/work?${buildQuery(filters, cursor)}`);
      const normalized = normalizeWorkPayload(data);
      setItems((current) => [...current, ...normalized.items]);
      setCursor(normalized.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar mais itens.");
    } finally { setLoadingMore(false); }
  }, [cursor, filters, loadingMore]);

  const update = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  const companies = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) if (item.companyId && item.companyName) seen.set(item.companyId, item.companyName);
    return [...seen].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
  }, [items]);

  /* O agrupamento usa a contagem do servidor: agrupar só a página faria o
     rótulo dizer "3" onde existem 40, e a pessoa decidiria por um número que
     vale para a tela e não para o trabalho (§8). */
  const grouped = useMemo(() => {
    if (!filters.group || !payload) return null;
    const totals = new Map(payload.groups.map((group) => [group.key, group.total]));
    const buckets = new Map<string, WorkItem[]>();
    for (const item of items) {
      const key = groupKeyOf(item, filters.group);
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }
    return [...buckets].map(([key, list]) => ({ key, list, total: totals.get(key) ?? list.length }));
  }, [filters.group, items, payload]);

  const counts = payload?.counts;

  if (loading && !payload) return <LoadingState title="Reunindo o seu trabalho…" />;

  return <section className={styles.workspace} aria-busy={refreshing}>
    <PanelHeader
      eyebrow="CENTRAL DE TRABALHO"
      title="O que está comigo hoje"
      description="Demandas, aprovações, movimentações, entregas, pendências, triagem e falhas que exigem ação — em uma lista só. Cada item é resolvido na tela do módulo dono dele."
      action={<button type="button" className={styles.secondaryButton} onClick={() => void load(filters, true)} disabled={refreshing}>
        <RefreshCw aria-hidden="true" />{refreshing ? "Atualizando…" : "Atualizar"}
      </button>}
    />

    {error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null}

    {/* A central de ação mudou de tela.
        Ela morava na Visão geral, que a maquete refez com quatro blocos e sem
        ela. Aqui é o lugar certo: "o que está comigo hoje" e "o que precisa ser
        feito agora" são a mesma pergunta, e mantê-las em telas diferentes
        obrigava a pessoa a conferir as duas para saber se tinha acabado. */}
    {onNavigate ? <ActionCenter onNavigate={onNavigate} companyId={companyId ?? ""} /> : null}

    {counts ? <div className={styles.counters} role="group" aria-label="Resumo do seu trabalho">
      <Counter label="Comigo" value={counts.total} active={!filters.due && !filters.source} onClick={() => setFilters({ ...filters, due: "", source: "" })} />
      <Counter label="Vencidos" value={counts.overdue} tone="critical" active={filters.due === "overdue"} onClick={() => update("due", filters.due === "overdue" ? "" : "overdue")} />
      <Counter label="Hoje" value={counts.today} tone="warning" active={filters.due === "today"} onClick={() => update("due", filters.due === "today" ? "" : "today")} />
      <Counter label="Bloqueados" value={counts.blocked} tone="warning" active={filters.status === "blocked"} onClick={() => update("status", filters.status === "blocked" ? "" : "blocked")} />
      <Counter label="Aguardando aprovação" value={counts.awaitingApproval} active={filters.source === "approval"} onClick={() => update("source", filters.source === "approval" ? "" : "approval")} />
      <Counter label="Triagem" value={counts.triage} active={filters.source === "triage"} onClick={() => update("source", filters.source === "triage" ? "" : "triage")} />
      <Counter label="Falhas" value={counts.failures} tone="critical" active={filters.source === "integration_failure"} onClick={() => update("source", filters.source === "integration_failure" ? "" : "integration_failure")} />
    </div> : null}

    <div className={styles.filters}>
      <div className={styles.scopeToggle} role="group" aria-label="Escopo">
        <button type="button" aria-pressed={filters.scope === "meu"} onClick={() => update("scope", "meu")}>Meus itens</button>
        <button type="button" aria-pressed={filters.scope === "equipe"} onClick={() => update("scope", "equipe")}>Equipe</button>
      </div>

      <label>
        <span>Tipo</span>
        <select value={filters.source} onChange={(event) => update("source", event.target.value)}>
          <option value="">Todos os tipos</option>
          {(payload?.sources ?? []).map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
        </select>
      </label>

      <label>
        <span>Prazo</span>
        <select value={filters.due} onChange={(event) => update("due", event.target.value)}>
          {(payload?.options.dueWindows ?? []).map((window) => <option key={window.key} value={window.key}>{window.label}</option>)}
        </select>
      </label>

      <label>
        <span>Empresa</span>
        <select value={filters.company} onChange={(event) => {
          update("company", event.target.value);
          onOpenCompanyFilter?.(event.target.value);
        }}>
          <option value="">Todas as empresas</option>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select>
      </label>

      <label>
        <span>Prioridade</span>
        <select value={filters.priority} onChange={(event) => update("priority", event.target.value)}>
          {PRIORITIES.map((priority) => <option key={priority.key} value={priority.key}>{priority.label}</option>)}
        </select>
      </label>

      <label>
        <span>Ordenar por</span>
        <select value={filters.sort} onChange={(event) => update("sort", event.target.value)}>
          {(payload?.options.sorts ?? []).map((sort) => <option key={sort.key} value={sort.key}>{sort.label}</option>)}
        </select>
      </label>

      <label>
        <span>Agrupar</span>
        <select value={filters.group} onChange={(event) => update("group", event.target.value)}>
          {(payload?.options.groups ?? []).map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}
        </select>
      </label>

      <div className={styles.filterActions}>
        <button type="button" className={styles.ghostButton} onClick={() => setFilters(emptyFilters)}>
          <Filter aria-hidden="true" />Limpar filtros
        </button>
      </div>
    </div>

    {payload && payload.unavailable.length ? <p className={styles.agentDetail}>
      Fora do seu acesso: {payload.unavailable.map((source) => source.label).join(", ")}. Peça a quem administra o grupo se precisar delas.
    </p> : null}

    {items.length === 0
      ? <EmptyState
        icon={CheckCircle2}
        title="Nenhum item exige sua ação agora"
        text={filters.scope === "meu"
          ? "Nada está esperando por você. Troque para Equipe para ver o que está com o time."
          : "A equipe está sem itens em aberto com os filtros escolhidos."}
      />
      : grouped
        ? grouped.map((group) => <div key={group.key}>
          <h3 className={styles.groupHeading}>{group.key} <em>({group.total})</em></h3>
          <div className={styles.list}>{group.list.map((item) => <WorkRow key={item.id} item={item} />)}</div>
        </div>)
        : <div className={styles.list}>{items.map((item) => <WorkRow key={item.id} item={item} />)}</div>}

    {cursor ? <div className={styles.loadMore}>
      <button type="button" className={styles.secondaryButton} onClick={() => void loadMore()} disabled={loadingMore}>
        {loadingMore ? "Carregando…" : "Carregar mais"}
      </button>
    </div> : null}
  </section>;
}

function Counter({ label, value, tone, active, onClick }: {
  label: string; value: number; tone?: "critical" | "warning"; active: boolean; onClick: () => void;
}) {
  return <button type="button" className={styles.counter} data-tone={value > 0 ? tone : undefined}
    aria-pressed={active} onClick={onClick}>
    <strong>{value}</strong>
    <span>{label}</span>
  </button>;
}

const SOURCE_ICONS: Record<string, typeof ListChecks> = {
  card: ListChecks,
  approval: CheckCircle2,
  movement: ArrowRight,
  auxiliary: Inbox,
  pending_item: AlertTriangle,
  triage: Workflow,
  integration_failure: AlertTriangle,
};

function WorkRow({ item }: { item: WorkItem }) {
  const Icon = SOURCE_ICONS[item.sourceType] ?? ListChecks;
  return <article className={styles.item} data-tone={item.tone}>
    <span className={styles.rail} aria-hidden="true" />
    <div className={styles.itemBody}>
      <div className={styles.itemTop}>
        <Icon aria-hidden="true" />
        <span className={styles.itemTitle}>{item.title}</span>
        <span className={styles.badge} data-tone={item.tone === "neutral" ? undefined : item.tone}>{item.statusLabel}</span>
        {item.priority === "urgent" ? <span className={styles.badge} data-tone="critical">{item.priorityLabel}</span> : null}
      </div>
      <div className={styles.itemMeta}>
        <span><CalendarClock aria-hidden="true" /> {dueLabel(item.dueAt)}</span>
        {item.companyName ? <span><Building2 aria-hidden="true" /> {item.companyName}</span> : null}
        {item.processStep ? <span><Workflow aria-hidden="true" /> Etapa <strong>{item.processStep}</strong></span> : null}
        <span>Origem: {item.originLabel}</span>
        <span>Atualizado {formatDateTime(item.updatedAt)}</span>
      </div>
      {item.blockedReason ? <p className={styles.blocked}>
        <AlertTriangle aria-hidden="true" />{item.blockedReason}
      </p> : null}
    </div>
    <div className={styles.itemActions}>
      {/* Um link de verdade, e não um botão que navega: assim copiar, abrir em
          nova aba e o menu do navegador funcionam como em qualquer link (§10). */}
      <a className={styles.primaryButton} href={item.href}>
        Abrir<ArrowRight aria-hidden="true" />
      </a>
      <span className={styles.nextAction}>{item.nextAction}</span>
    </div>
  </article>;
}

/** A mesma chave que o servidor conta, para o rótulo do grupo bater com o total. */
function groupKeyOf(item: WorkItem, group: string) {
  switch (group) {
    case "source": return item.sourceType;
    case "process": return item.processId || "sem-processo";
    case "company": return item.companyName || "Sem empresa";
    case "status": return item.status;
    case "origin": return item.origin;
    case "due": {
      if (!item.dueAt) return "Sem prazo";
      const today = new Date().toISOString().slice(0, 10);
      const due = item.dueAt.slice(0, 10);
      if (due < today) return "Vencidos";
      if (due === today) return "Hoje";
      const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      return due <= week ? "Esta semana" : "Depois";
    }
    default: return "";
  }
}
