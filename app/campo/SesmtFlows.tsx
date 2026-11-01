"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRightLeft, CalendarClock, Check, PackagePlus, RefreshCw, Search, Sparkles, Trash2, XCircle,
} from "lucide-react";
import { epiDisposalReasonLabels, type EpiDisposalReason } from "@/lib/epi";
import type { EpiEmployeeCompliance } from "@/lib/epi-compliance";
import type { Row } from "@/app/painel/features/epi/epi.api";
import type { EpiProduct } from "@/app/painel/features/epi/epi.types";
import { availableAt, Chosen, ProductPicker, searchProducts, Stepper } from "./FieldPickers";
import { dateLabel, requestJson, submitOperation, today } from "./field.api";
import {
  actionableStatuses, awaitingDisposals, countByStatus, disposalStockEffect, dueDateLabel, dueEntries, dueStatusLabels,
  matchesTerm, pendingSanitization, type ActionableStatus, type DisposalItem, type DueEntry, type SanitizationItem,
} from "./sesmt.logic";
import styles from "./field.module.css";

/**
 * Telas do SESMT no Vinculato Campo.
 *
 * As quatro ações originais (entregar, devolver, dano, consultar) são do
 * almoxarifado: alguém na frente do colaborador. Estas três são do técnico de
 * segurança andando pela unidade — quem está vencido, o que tem no estoque
 * daqui, o que está parado na higienização e no descarte. Nenhuma tem regra
 * nova: todas leem e gravam pelas mesmas rotas do painel, e o servidor confere
 * cada permissão de novo.
 */

const statusTone: Record<ActionableStatus, "danger" | "warning" | "info"> = {
  missing: "danger",
  expired: "danger",
  overdue: "warning",
  due_soon: "info",
};

/* -------------------------------------------------------------------------- */
/* Vencimentos e trocas                                                       */
/* -------------------------------------------------------------------------- */

type DashboardPayload = {
  employees?: EpiEmployeeCompliance[];
  shortages?: Array<{ productId: string; productName: string; missing: number; available: number; shortage: number }>;
  summary?: { activeEmployees?: number; unconfiguredEmployees?: number; compliantEmployees?: number };
};

/** Quantos cartões desenhar de uma vez. Uma empresa de 2.000 pessoas não cabe numa rolagem de celular. */
const PAGE = 60;

export function DueFlow({ companyId, canDeliver, onDeliver }: {
  companyId: string; canDeliver: boolean; onDeliver: (entry: DueEntry) => void;
}) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [filter, setFilter] = useState<ActionableStatus | "all">("all");
  const [term, setTerm] = useState("");
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await requestJson<DashboardPayload>(`/api/epi/dashboard?${new URLSearchParams({ companyId })}`));
      setProblem("");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível carregar os vencimentos.");
    } finally { setLoading(false); }
  }, [companyId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  const entries = useMemo(() => dueEntries(data?.employees ?? []), [data]);
  const counts = useMemo(() => countByStatus(entries), [entries]);
  const visible = useMemo(
    () => entries.filter((entry) => (filter === "all" || entry.status === filter) && matchesTerm(entry, term)),
    [entries, filter, term],
  );
  const now = today();

  if (loading && !data) return <div className={styles.screen}><p className={styles.hint} role="status">Calculando vencimentos…</p></div>;

  return <div className={styles.screen}>
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.summaryRow}>
      <article data-tone="danger"><small>Sem EPI</small><strong>{counts.missing}</strong></article>
      <article data-tone="danger"><small>Vencidos</small><strong>{counts.expired}</strong></article>
      <article data-tone="warning"><small>Trocas</small><strong>{counts.overdue + counts.due_soon}</strong></article>
    </div>

    {(data?.shortages?.length ?? 0) > 0 && <div className={styles.consequence} data-tone="warning">
      <strong>Estoque não cobre as pendências</strong>
      <ul>
        {data?.shortages?.slice(0, 5).map((item) => <li key={item.productId} data-alert="true">
          {item.productName}: faltam {item.shortage} (precisa de {item.missing}, há {item.available})
        </li>)}
      </ul>
    </div>}

    <div className={styles.chipRow} role="radiogroup" aria-label="Filtrar pendências">
      <button type="button" role="radio" aria-checked={filter === "all"} className={filter === "all" ? styles.chipActive : styles.chip}
        onClick={() => { setFilter("all"); setShown(PAGE); }}>Todas · {entries.length}</button>
      {actionableStatuses.map((status) => <button key={status} type="button" role="radio" aria-checked={filter === status}
        className={filter === status ? styles.chipActive : styles.chip}
        onClick={() => { setFilter(status); setShown(PAGE); }}>{dueStatusLabels[status]} · {counts[status]}</button>)}
    </div>

    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => { setTerm(event.target.value); setShown(PAGE); }}
        placeholder="Filtrar por nome, matrícula ou EPI" autoComplete="off" enterKeyHint="search" aria-label="Filtrar pendências" />
      <button type="button" className={styles.secondaryButton} onClick={() => void load()} disabled={loading} aria-label="Atualizar">
        <RefreshCw aria-hidden="true" className={loading ? styles.spin : undefined} />
      </button>
    </div>

    {!entries.length && !problem && <div className={styles.emptyState}>
      <Check aria-hidden="true" />
      <strong>Nenhuma pendência nesta empresa</strong>
      <p>{data?.summary?.unconfiguredEmployees
        ? `${data.summary.unconfiguredEmployees} colaborador(es) ainda não têm EPI obrigatório definido para o cargo. As regras são cadastradas no painel, em Controle de EPI.`
        : "Todos os colaboradores ativos estão com o EPI obrigatório em dia."}</p>
    </div>}

    {entries.length > 0 && !visible.length && <p className={styles.hint}>Nada com esse filtro.</p>}

    <ul className={styles.pickList}>
      {visible.slice(0, shown).map((entry) => <li key={entry.key}>
        <button type="button" onClick={() => onDeliver(entry)} disabled={!canDeliver}
          aria-label={`${entry.employeeName}, ${entry.productName}: ${dueStatusLabels[entry.status]}. ${canDeliver ? "Abrir entrega" : ""}`}>
          <CalendarClock aria-hidden="true" />
          <span>
            <strong>{entry.employeeName}</strong>
            <small>{entry.productName}{entry.caNumber ? ` · CA ${entry.caNumber}` : ""}</small>
            <small>{entry.registrationNumber}{entry.positionName ? ` · ${entry.positionName}` : ""}</small>
          </span>
          <span className={styles.statusPill} data-tone={statusTone[entry.status]}>
            <b>{dueStatusLabels[entry.status]}</b>
            <small>{dueDateLabel(entry, now)}</small>
          </span>
        </button>
      </li>)}
    </ul>

    {visible.length > shown && <button type="button" className={styles.secondaryButton} onClick={() => setShown((value) => value + PAGE)}>
      Mostrar mais {Math.min(PAGE, visible.length - shown)} de {visible.length - shown}
    </button>}

    {canDeliver && entries.length > 0 && <p className={styles.hint}>
      Toque numa pendência para abrir a entrega já com o colaborador, o EPI e o motivo certo (troca periódica ou substituição por vencimento).
    </p>}
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Estoque                                                                    */
/* -------------------------------------------------------------------------- */

type StockLocation = { id: string; name: string; code: string };
type StockMode = "list" | "entry" | "transfer";

export function StockFlow({ locationId, locations, canAdjust, onDone }: {
  locationId: string; locations: StockLocation[]; canAdjust: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<StockMode>("list");
  const location = locations.find((item) => item.id === locationId);

  if (mode === "entry") return <StockEntry locationId={locationId} locationName={location?.name ?? ""} onDone={onDone} onCancel={() => setMode("list")} />;
  if (mode === "transfer") return <StockTransfer locationId={locationId} locations={locations} onDone={onDone} onCancel={() => setMode("list")} />;
  return <StockList locationId={locationId} locationName={location?.name ?? ""} canAdjust={canAdjust} onMode={setMode} />;
}

function StockList({ locationId, locationName, canAdjust, onMode }: {
  locationId: string; locationName: string; canAdjust: boolean; onMode: (mode: StockMode) => void;
}) {
  const [term, setTerm] = useState("");
  const [products, setProducts] = useState<EpiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [onlyHere, setOnlyHere] = useState(false);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      setProducts(await searchProducts(query, 200));
      setProblem("");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível carregar o estoque.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load("")); return () => window.cancelAnimationFrame(frame); }, [load]);

  const list = onlyHere ? products.filter((item) => availableAt(item, locationId) > 0) : products;
  const now = today();
  const unitsHere = products.reduce((sum, item) => sum + availableAt(item, locationId), 0);
  const zeroHere = products.filter((item) => availableAt(item, locationId) <= 0).length;

  return <div className={styles.screen}>
    <div className={styles.summaryRow}>
      <article><small>Unidades aqui</small><strong>{unitsHere}</strong></article>
      <article><small>EPIs</small><strong>{products.length}</strong></article>
      <article data-tone={zeroHere ? "warning" : undefined}><small>Zerados aqui</small><strong>{zeroHere}</strong></article>
    </div>

    <div className={styles.inlineActions}>
      <button type="button" className={styles.primaryButton} onClick={() => onMode("entry")} disabled={!canAdjust}>
        <PackagePlus aria-hidden="true" /> Entrada
      </button>
      <button type="button" className={styles.secondaryButton} onClick={() => onMode("transfer")} disabled={!canAdjust}>
        <ArrowRightLeft aria-hidden="true" /> Transferir
      </button>
    </div>
    {!canAdjust && <p className={styles.hint}>Entrada e transferência pedem a permissão <code>epi.stock.adjust</code>. A consulta continua liberada.</p>}

    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(term); } }}
        placeholder="Nome, código interno ou CA" autoComplete="off" enterKeyHint="search" aria-label="Buscar EPI no estoque" />
      <button type="button" className={styles.secondaryButton} onClick={() => void load(term)} disabled={loading} aria-label="Procurar no estoque">
        <Search aria-hidden="true" />
      </button>
    </div>
    <div className={styles.chipRow} role="radiogroup" aria-label="Recorte do estoque">
      <button type="button" role="radio" aria-checked={!onlyHere} className={!onlyHere ? styles.chipActive : styles.chip} onClick={() => setOnlyHere(false)}>Todos</button>
      <button type="button" role="radio" aria-checked={onlyHere} className={onlyHere ? styles.chipActive : styles.chip} onClick={() => setOnlyHere(true)}>Com saldo em {locationName || "este local"}</button>
    </div>

    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}
    {loading && <p className={styles.hint} role="status">Carregando…</p>}

    <ul className={styles.plainList}>
      {list.map((product) => {
        const here = availableAt(product, locationId);
        const others = product.stockLocations.filter((place) => place.id !== locationId && place.quantity > 0);
        const caExpired = Boolean(product.caExpiresOn) && product.caExpiresOn < now;
        return <li key={product.id}>
          <div className={styles.rowBetween}>
            <strong>{product.name}</strong>
            <span className={styles.qty} data-tone={here > 0 ? undefined : "warning"}>{here}</span>
          </div>
          <small>CA {product.caNumber || "—"} · {product.size || "—"}{product.internalCode ? ` · ${product.internalCode}` : ""}</small>
          {product.caExpiresOn && <small className={caExpired ? styles.queueError : undefined}>
            CA {caExpired ? "vencido em" : "válido até"} {dateLabel(product.caExpiresOn)}
          </small>}
          {others.length > 0 && <small>Outros locais: {others.map((place) => `${place.name} ${place.quantity}`).join(" · ")}</small>}
        </li>;
      })}
    </ul>
    {!loading && !list.length && !problem && <p className={styles.hint}>Nenhum EPI neste recorte.</p>}
  </div>;
}

function StockEntry({ locationId, locationName, onDone, onCancel }: {
  locationId: string; locationName: string; onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!product) return <div className={styles.screen}>
    <ProductPicker locationId={locationId} onPick={setProduct} allowEmpty title={`Entrada em ${locationName || "este local"}: qual EPI?`} />
    <div className={styles.actionBar}><button type="button" className={styles.secondaryButton} onClick={onCancel}>Voltar ao estoque</button></div>
  </div>;

  async function submit() {
    if (!product) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "stock_entry",
        label: `Entrada · ${product.name} · ${quantity} un.`,
        payload: {
          productId: product.id, stockLocationId: locationId, quantity, movementDate: today(),
          reason: "stock_replenishment", notes,
        },
      });
      await onDone(result.status === "queued"
        ? "Sem rede: entrada guardada no aparelho e será enviada sozinha."
        : `Entrada de ${quantity} un. registrada em ${locationName || "este local"}.`);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a entrada.");
    } finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />
    <section className={styles.step}>
      <h2>Quantidade recebida</h2>
      <Stepper value={quantity} onChange={setQuantity} max={9999} />
      <label className={styles.field}>
        <span>Ou digite</span>
        <input type="number" inputMode="numeric" min={1} max={9999} value={quantity}
          onChange={(event) => setQuantity(Math.min(9999, Math.max(1, Math.trunc(Number(event.target.value) || 1))))} />
      </label>
      <p className={styles.hint}>Hoje há {availableAt(product, locationId)} neste local. Depois da entrada: {availableAt(product, locationId) + quantity}.</p>
    </section>
    <label className={styles.field}>
      <span>Observação</span>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Nota fiscal, fornecedor… (opcional)" />
    </label>
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}
    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy}>
        {busy ? "Gravando…" : "Confirmar entrada"}
      </button>
    </div>
  </div>;
}

function StockTransfer({ locationId, locations, onDone, onCancel }: {
  locationId: string; locations: StockLocation[]; onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const targets = locations.filter((item) => item.id !== locationId);
  const source = locations.find((item) => item.id === locationId);
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!targets.length) return <div className={styles.screen}>
    <div className={styles.emptyState}>
      <ArrowRightLeft aria-hidden="true" />
      <strong>Só existe um local de estoque</strong>
      <p>Transferir precisa de um segundo local. Crie no painel, em Controle de EPI → Locais de estoque.</p>
      <button type="button" className={styles.secondaryButton} onClick={onCancel}>Voltar ao estoque</button>
    </div>
  </div>;

  if (!product) return <div className={styles.screen}>
    <ProductPicker locationId={locationId} onPick={(picked) => { setProduct(picked); setQuantity(1); }}
      title={`Sai de ${source?.name || "este local"}: qual EPI?`} />
    <div className={styles.actionBar}><button type="button" className={styles.secondaryButton} onClick={onCancel}>Voltar ao estoque</button></div>
  </div>;

  const here = availableAt(product, locationId);
  const target = targets.find((item) => item.id === targetId);

  async function submit() {
    if (!product || !targetId) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "stock_transfer",
        label: `Transferência · ${product.name} · ${quantity} un. → ${target?.name ?? ""}`,
        payload: {
          productId: product.id, sourceStockLocationId: locationId, targetStockLocationId: targetId,
          quantity, movementDate: today(), notes,
        },
      });
      await onDone(result.status === "queued"
        ? "Sem rede: transferência guardada no aparelho e será enviada sozinha."
        : `${quantity} un. transferida(s) para ${target?.name ?? "o destino"}.`);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível transferir.");
    } finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />
    <label className={styles.field}>
      <span>Para qual local</span>
      <select className={styles.select} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
        {targets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.code ? ` · ${item.code}` : ""}</option>)}
      </select>
    </label>
    <section className={styles.step}>
      <h2>Quantidade</h2>
      <Stepper value={quantity} onChange={setQuantity} max={here} />
      <p className={styles.hint}>{here} disponível(is) em {source?.name || "este local"}.</p>
    </section>
    <label className={styles.field}>
      <span>Observação</span>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Opcional" />
    </label>
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}
    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy || here <= 0}>
        {busy ? "Gravando…" : "Confirmar transferência"}
      </button>
    </div>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Higienização e descarte                                                    */
/* -------------------------------------------------------------------------- */

const originLabels: Record<DisposalItem["origin"], string> = {
  manual: "Aberto a partir do estoque",
  return: "Veio de devolução",
  damage: "Veio de registro de dano",
};

export function CareFlow({ companyId, canSanitize, canDispose, online, onToast }: {
  companyId: string; canSanitize: boolean; canDispose: boolean; online: boolean;
  onToast: (message: string) => void;
}) {
  const [tab, setTab] = useState<"sanitize" | "dispose">(canSanitize || !canDispose ? "sanitize" : "dispose");
  const [sanitizing, setSanitizing] = useState<SanitizationItem[]>([]);
  const [disposals, setDisposals] = useState<DisposalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [selected, setSelected] = useState<{ kind: "sanitize"; item: SanitizationItem } | { kind: "dispose"; item: DisposalItem } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [returns, disposalPayload] = await Promise.all([
        requestJson<{ returns?: Row[] }>(`/api/epi/returns?${new URLSearchParams({ companyId, sanitizing: "true", limit: "200" })}`),
        requestJson<{ disposals?: Row[] }>(`/api/epi/disposals?${new URLSearchParams({ companyId, status: "awaiting_disposal", limit: "200" })}`),
      ]);
      setSanitizing(pendingSanitization(returns.returns ?? []));
      setDisposals(awaitingDisposals(disposalPayload.disposals ?? []));
      setProblem("");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível carregar higienização e descarte.");
    } finally { setLoading(false); }
  }, [companyId]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load]);

  async function finished(message: string) {
    setSelected(null);
    onToast(message);
    await load();
  }

  if (selected?.kind === "sanitize") {
    return <SanitizationDecision item={selected.item} online={online} allowed={canSanitize}
      onDone={finished} onCancel={() => setSelected(null)} />;
  }
  if (selected?.kind === "dispose") {
    return <DisposalDecision item={selected.item} online={online} allowed={canDispose}
      onDone={finished} onCancel={() => setSelected(null)} />;
  }

  return <div className={styles.screen}>
    <div className={styles.chipRow} role="tablist" aria-label="Higienização e descarte">
      <button type="button" role="tab" aria-selected={tab === "sanitize"} className={tab === "sanitize" ? styles.chipActive : styles.chip}
        onClick={() => setTab("sanitize")}><Sparkles aria-hidden="true" /> Higienização · {sanitizing.length}</button>
      <button type="button" role="tab" aria-selected={tab === "dispose"} className={tab === "dispose" ? styles.chipActive : styles.chip}
        onClick={() => setTab("dispose")}><Trash2 aria-hidden="true" /> Descarte · {disposals.length}</button>
      <button type="button" className={styles.chip} onClick={() => void load()} disabled={loading} aria-label="Atualizar">
        <RefreshCw aria-hidden="true" className={loading ? styles.spin : undefined} />
      </button>
    </div>

    {!online && <p className={styles.hint} role="status">
      Sem rede, dá para ver a lista carregada, mas não decidir. Higienização e descarte são decisões sobre um registro do servidor e não ficam na fila.
    </p>}
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}
    {loading && <p className={styles.hint} role="status">Carregando…</p>}

    {tab === "sanitize" && <>
      {!loading && !sanitizing.length && <div className={styles.emptyState}>
        <Check aria-hidden="true" /><strong>Nada aguardando higienização</strong>
        <p>Devoluções marcadas como “pendente de higienização” aparecem aqui.</p>
      </div>}
      <ul className={styles.pickList}>
        {sanitizing.map((item) => <li key={item.id}>
          <button type="button" onClick={() => setSelected({ kind: "sanitize", item })}>
            <Sparkles aria-hidden="true" />
            <span>
              <strong>{item.epiName}</strong>
              <small>{item.quantity} un. · devolvido por {item.employeeName || "—"} em {dateLabel(item.returnedOn)}</small>
            </span>
            <span className={styles.statusPill} data-tone={item.status === "in_progress" ? "info" : "warning"}>
              <b>{item.status === "in_progress" ? "Em andamento" : "Aguardando"}</b>
            </span>
          </button>
        </li>)}
      </ul>
    </>}

    {tab === "dispose" && <>
      {!loading && !disposals.length && <div className={styles.emptyState}>
        <Check aria-hidden="true" /><strong>Nada aguardando descarte</strong>
        <p>Devoluções inutilizadas e danos com decisão de descarte caem aqui para confirmação.</p>
      </div>}
      <ul className={styles.pickList}>
        {disposals.map((item) => <li key={item.id}>
          <button type="button" onClick={() => setSelected({ kind: "dispose", item })}>
            <Trash2 aria-hidden="true" />
            <span>
              <strong>{item.epiName}</strong>
              <small>{item.quantity} un. · {epiDisposalReasonLabels[item.reason as EpiDisposalReason] ?? item.reason}</small>
              <small>{item.employeeName ? `${item.employeeName} · ` : ""}{dateLabel(item.disposalDate)}</small>
            </span>
          </button>
        </li>)}
      </ul>
    </>}
  </div>;
}

function SanitizationDecision({ item, online, allowed, onDone, onCancel }: {
  item: SanitizationItem; online: boolean; allowed: boolean;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function act(action: "start" | "complete" | "reject") {
    if (action !== "start" && !result.trim()) { setProblem("Escreva o resultado — é o registro do que foi feito com o equipamento."); return; }
    if (action === "reject" && !window.confirm("Reprovar a higienização? O EPI não volta ao estoque.")) return;
    setBusy(true); setProblem("");
    try {
      await requestJson(`/api/epi/returns/${encodeURIComponent(item.id)}/sanitization`, {
        method: "POST", body: JSON.stringify({ action, result }),
      });
      await onDone(action === "start" ? "Higienização iniciada."
        : action === "complete" ? `Higienizado: ${item.quantity} un. voltaram ao estoque.`
          : "Higienização reprovada. O EPI não voltou ao estoque.");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a higienização.");
    } finally { setBusy(false); }
  }

  const blocked = busy || !online || !allowed;

  return <div className={styles.screen}>
    <Chosen label="EPI devolvido" value={`${item.epiName} · ${item.quantity} un.`} onClear={onCancel} />
    <p className={styles.hint}>Devolvido por {item.employeeName || "—"} em {dateLabel(item.returnedOn)}. Situação: {item.status === "in_progress" ? "em andamento" : "aguardando"}.</p>

    <label className={styles.field}>
      <span>Resultado</span>
      <textarea value={result} onChange={(event) => setResult(event.target.value)} rows={3}
        placeholder="Ex.: lavado e inspecionado, sem avaria. Obrigatório para concluir ou reprovar." />
    </label>

    <div className={styles.consequence}>
      <strong>O que cada decisão faz</strong>
      <ul>
        <li><b>Concluir</b>: {item.quantity} un. voltam ao estoque do local da devolução.</li>
        <li data-alert="true"><b>Reprovar</b>: não volta ao estoque. Se for para descartar, abra o descarte no painel.</li>
      </ul>
    </div>

    {!allowed && <p className={styles.hint}>Sem a permissão <code>epi.return</code> para tratar higienização.</p>}
    {!online && <p className={styles.hint}>Sem rede. Volte a ter sinal para decidir.</p>}
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.actionBar}>
      {item.status === "awaiting" && <button type="button" className={styles.secondaryButton} onClick={() => void act("start")} disabled={blocked}>Iniciar</button>}
      <button type="button" className={styles.secondaryButton} onClick={() => void act("reject")} disabled={blocked}>
        <XCircle aria-hidden="true" /> Reprovar
      </button>
      <button type="button" className={styles.primaryButton} onClick={() => void act("complete")} disabled={blocked}>
        {busy ? "Gravando…" : "Concluir"}
      </button>
    </div>
  </div>;
}

function DisposalDecision({ item, online, allowed, onDone, onCancel }: {
  item: DisposalItem; online: boolean; allowed: boolean;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function act(action: "confirm" | "cancel" | "reevaluate") {
    if (action !== "confirm" && !notes.trim()) { setProblem("Escreva o motivo — cancelar ou reavaliar sem motivo deixa o histórico sem explicação."); return; }
    // Confirmar é definitivo: o banco recusa qualquer alteração depois. A
    // pergunta existe para isso, não por cerimônia.
    if (action === "confirm" && !window.confirm(`Confirmar o descarte de ${item.quantity} un. de ${item.epiName}? Não dá para desfazer.`)) return;
    setBusy(true); setProblem("");
    try {
      await requestJson(`/api/epi/disposals/${encodeURIComponent(item.id)}`, {
        method: "POST", body: JSON.stringify({ action, notes }),
      });
      await onDone(action === "confirm" ? "Descarte confirmado." : action === "cancel" ? "Descarte cancelado." : "Descarte enviado para reavaliação.");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a decisão.");
    } finally { setBusy(false); }
  }

  const blocked = busy || !online || !allowed;

  return <div className={styles.screen}>
    <Chosen label="Descarte" value={`${item.epiName} · ${item.quantity} un.`} onClear={onCancel} />
    <ul className={styles.plainList}>
      <li><small>Motivo</small><strong>{epiDisposalReasonLabels[item.reason as EpiDisposalReason] ?? item.reason}</strong></li>
      <li><small>Origem</small><strong>{originLabels[item.origin]}</strong></li>
      {item.employeeName && <li><small>Colaborador</small><strong>{item.employeeName}</strong></li>}
      {item.caNumber && <li><small>CA</small><strong>{item.caNumber}</strong></li>}
    </ul>

    <div className={styles.consequence}>
      <strong>Ao confirmar</strong>
      <ul>
        <li data-alert="true">É definitivo: o EPI não volta ao estoque e o registro não pode ser alterado.</li>
        <li>{disposalStockEffect(item.origin, item.quantity)}</li>
      </ul>
    </div>

    <label className={styles.field}>
      <span>Observação / motivo</span>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2}
        placeholder="Opcional para confirmar; obrigatório para cancelar ou reavaliar." />
    </label>

    {!allowed && <p className={styles.hint}>Sem a permissão <code>epi.dispose</code> para decidir descarte.</p>}
    {!online && <p className={styles.hint}>Sem rede. Volte a ter sinal para decidir.</p>}
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={() => void act("reevaluate")} disabled={blocked}>Reavaliar</button>
      <button type="button" className={styles.secondaryButton} onClick={() => void act("cancel")} disabled={blocked}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void act("confirm")} disabled={blocked}>
        <Trash2 aria-hidden="true" /> {busy ? "Gravando…" : "Confirmar"}
      </button>
    </div>
  </div>;
}
