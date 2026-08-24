"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Inbox, RefreshCw, ShieldQuestion, UserRoundCog,
} from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState, PanelHeader } from "../shared";
import { formatDateTime, normalizeTriagePayload, requestJson } from "./work.api";
import type { TriageItem, TriagePayload } from "./work.types";
import styles from "./work.module.css";

/**
 * Central de Triagem (§13 a §19).
 *
 * A tela existe para **resolver a incerteza**, e não para aprovar em série. O
 * pior desfecho possível é alguém confirmar um vínculo por eliminação porque a
 * tela não explicou o que estava em dúvida — por isso cada item abre com o
 * motivo da incerteza e o que resolve, antes de qualquer botão.
 *
 * ## Nada é resolvido aqui dentro
 *
 * Confirmar chama a rota de domínio dona do item (§17): a proposta de agente vai
 * para `/api/agents/proposals/:id/resolve`, que reavalia versão, etapa, destino
 * autorizado, checklist, evidência, responsável, aprovador e concorrência do
 * zero; a sugestão do Teams vai para `/api/integrations/movements/:id`, que
 * aplica as regras de movimentação. A triagem não tem atalho, e é isso que
 * impede a automação de contornar a regra de negócio.
 *
 * ## Dado pessoal
 *
 * O payload chega do servidor já redigido. A tela não tem versão crua para
 * mostrar — o que ela não recebe, ela não pode vazar.
 */

type Situation = "pendentes" | "resolvidos";

export function TriageView({ initialItemId = "" }: { initialItemId?: string }) {
  const [situation, setSituation] = useState<Situation>("pendentes");
  const [origin, setOrigin] = useState("");
  const [mine, setMine] = useState(false);
  const [payload, setPayload] = useState<TriagePayload | null>(null);
  const [items, setItems] = useState<TriageItem[]>([]);
  const [cursor, setCursor] = useState("");
  const [selectedId, setSelectedId] = useState(initialItemId);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const search = new URLSearchParams({ situacao: situation });
      if (origin) search.set("origem", origin);
      if (mine) search.set("escopo", "meus");
      const data = await requestJson<Record<string, unknown>>(`/api/triage?${search}`);
      const normalized = normalizeTriagePayload(data);
      setPayload(normalized);
      setItems(normalized.items);
      setCursor(normalized.nextCursor);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a triagem.");
    } finally { setLoading(false); }
  }, [mine, origin, situation]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const search = new URLSearchParams({ situacao: situation, cursor });
      if (origin) search.set("origem", origin);
      if (mine) search.set("escopo", "meus");
      const data = await requestJson<Record<string, unknown>>(`/api/triage?${search}`);
      const normalized = normalizeTriagePayload(data);
      setItems((current) => [...current, ...normalized.items]);
      setCursor(normalized.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar mais itens.");
    } finally { setBusy(false); }
  }, [cursor, mine, origin, situation]);

  const selected = useMemo(
    () => items.find((item) => item.sourceId === selectedId || item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  /**
   * Resolver: sempre pela rota do módulo dono (§17).
   *
   * O `note` acompanha a decisão para a auditoria registrar o porquê, e não só
   * o quê — "rejeitado" sem motivo é uma linha de histórico que não ajuda
   * ninguém seis meses depois.
   */
  const resolve = useCallback(async (item: TriageItem, action: "apply" | "reject" | "discard") => {
    setBusy(true);
    try {
      if (item.source === "agent_proposal") {
        await requestJson(`/api/agents/proposals/${encodeURIComponent(item.sourceId)}/resolve`, {
          method: "POST", body: JSON.stringify({ action, note }),
        });
      } else {
        /* A sugestão do Teams tem vocabulário próprio — `confirm`/`reject` — e é
           ele que a rota dela entende. Traduzir aqui é mais honesto do que
           uniformizar o nome e quebrar a rota que já existe. */
        await requestJson(`/api/integrations/movements/${encodeURIComponent(item.sourceId)}`, {
          method: "POST", body: JSON.stringify({ action: action === "apply" ? "confirm" : "reject", note }),
        });
      }
      setToast(action === "apply"
        ? "Confirmado. O item seguiu pelo fluxo do módulo, com as regras dele."
        : "Registrado. A decisão ficou na auditoria com o seu nome.");
      setNote("");
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar a decisão.");
    } finally { setBusy(false); }
  }, [load, note]);

  if (loading && !payload) return <LoadingState title="Reunindo o que precisa de conferência…" />;

  const counts = payload?.counts;
  const canResolve = payload?.permissions.resolve ?? false;

  return <section className={styles.workspace} aria-busy={busy}>
    <PanelHeader
      eyebrow="CENTRAL DE TRIAGEM"
      title="O que o sistema não teve certeza"
      description="Entradas que a automação não conseguiu classificar sozinha. Aqui se resolve a dúvida — a ação continua acontecendo pelo fluxo do módulo, com as regras dele."
      action={<button type="button" className={styles.secondaryButton} onClick={() => void load(true)} disabled={busy}>
        <RefreshCw aria-hidden="true" />Atualizar
      </button>}
    />

    {error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null}
    {toast ? <p className={styles.agentDetail} role="status">{toast}</p> : null}

    {counts ? <div className={styles.counters} role="group" aria-label="Resumo da triagem">
      <Counter label="Sem identificação" value={counts.pendingTriage} tone="critical" />
      <Counter label="Aguardando confirmação" value={counts.suggested} tone="warning" />
      <Counter label="Encaminhados para mim" value={counts.mine} />
      <Counter label="Do Teams" value={counts.movements} />
    </div> : null}

    <div className={styles.filters}>
      <div className={styles.scopeToggle} role="group" aria-label="Situação">
        <button type="button" aria-pressed={situation === "pendentes"} onClick={() => setSituation("pendentes")}>Em aberto</button>
        <button type="button" aria-pressed={situation === "resolvidos"} onClick={() => setSituation("resolvidos")}>Resolvidos</button>
      </div>
      <label>
        <span>Origem</span>
        <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
          <option value="">Todas as origens</option>
          <option value="tangerino">Tangerino</option>
          <option value="solides">Sólides</option>
          <option value="sankhya_browser">Sankhya</option>
          <option value="teams">Microsoft Teams</option>
        </select>
      </label>
      <div className={styles.filterActions}>
        <button type="button" className={styles.ghostButton} aria-pressed={mine} onClick={() => setMine((current) => !current)}>
          <UserRoundCog aria-hidden="true" />{mine ? "Vendo os meus" : "Só os encaminhados para mim"}
        </button>
      </div>
    </div>

    {items.length === 0
      ? <EmptyState
        icon={CheckCircle2}
        title="Nenhuma entrada aguardando classificação"
        text="Quando um agente não conseguir identificar de quem é uma entrada, ela aparece aqui com o motivo da dúvida."
      />
      : <div className={styles.triageGrid}>
        <div className={styles.list}>
          {items.map((item) => <button key={item.id} type="button" className={styles.triageCard}
            aria-pressed={selected?.id === item.id} onClick={() => { setSelectedId(item.sourceId); setNote(""); }}>
            <header>
              <ShieldQuestion aria-hidden="true" />
              <h3>{item.title}</h3>
              <span className={styles.badge}>{item.originLabel}</span>
              <span className={styles.badge} data-tone={item.confidence.tone}>
                Confiança {item.confidence.label}
              </span>
            </header>
            <div className={styles.uncertainty}>
              <strong>{item.uncertainty.title}</strong>
              <span>{item.uncertainty.action}</span>
            </div>
            <p className={styles.agentDetail}>{item.proposal} · recebido {formatDateTime(item.createdAt)}</p>
          </button>)}

          {cursor ? <div className={styles.loadMore}>
            <button type="button" className={styles.secondaryButton} onClick={() => void loadMore()} disabled={busy}>
              Carregar mais
            </button>
          </div> : null}
        </div>

        {selected ? <aside className={styles.detail} aria-label={`Detalhe de ${selected.title}`}>
          <h3>{selected.title}</h3>
          <p className={styles.agentDetail}>{selected.uncertainty.title}</p>

          <div className={styles.uncertainty}>
            <strong>Confiança {selected.confidence.label} ({selected.confidence.percent}%)</strong>
            <span>{selected.confidence.detail}</span>
          </div>

          <dl className={styles.fieldList}>
            {selected.likely.employeeName || selected.likely.employeeId ? <div>
              <dt>Colaborador provável</dt>
              <dd>{selected.likely.employeeName || selected.likely.employeeId}</dd>
            </div> : null}
            {selected.likely.companyName ? <div>
              <dt>Empresa</dt><dd>{selected.likely.companyName}</dd>
            </div> : null}
            {selected.likely.processStep ? <div>
              <dt>Etapa</dt><dd>{selected.likely.processStep}</dd>
            </div> : null}
            {selected.fields.map((field) => <div key={`${field.label}:${field.value}`}>
              <dt>{field.label}</dt><dd>{field.value}</dd>
            </div>)}
          </dl>

          {selected.evidenceIds.length ? <p className={styles.agentDetail}>
            Evidência: {selected.evidenceIds.map((evidence) => evidence.startsWith("http")
              ? <a key={evidence} href={evidence} rel="noreferrer noopener" target="_blank">abrir origem</a>
              : <span key={evidence}>{evidence} </span>)}
          </p> : null}

          {selected.resolution ? <div className={styles.history}>
            <strong>Histórico</strong>
            <span>Decidido por {selected.resolution.decidedBy || "—"} em {formatDateTime(selected.resolution.decidedAt)}.</span>
            <span>Decisão: {selected.resolution.decision}.</span>
            {selected.resolution.note ? <span>Nota: {selected.resolution.note}</span> : null}
            {selected.resolution.resultId ? <span>Resultado: {selected.resolution.resultType} {selected.resolution.resultId}</span> : null}
            {selected.resolution.failure ? <span>Falha: {selected.resolution.failure}</span> : null}
          </div> : null}

          {canResolve && !selected.resolution ? <>
            <label className={styles.noteField}>
              <span>Nota da decisão (fica na auditoria)</span>
              <textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)}
                placeholder="Por que você está confirmando ou recusando?" />
            </label>
            <div className={styles.detailActions}>
              <button type="button" className={styles.primaryButton} disabled={busy}
                onClick={() => void resolve(selected, "apply")}>
                <ClipboardCheck aria-hidden="true" />Confirmar
              </button>
              <button type="button" className={styles.secondaryButton} disabled={busy}
                onClick={() => void resolve(selected, "reject")}>
                Recusar
              </button>
              {selected.source === "agent_proposal" ? <button type="button" className={styles.ghostButton} disabled={busy}
                onClick={() => void resolve(selected, "discard")}>
                Descartar
              </button> : null}
              <a className={styles.ghostButton} href={selected.resolveHref}>
                Abrir origem<ArrowRight aria-hidden="true" />
              </a>
            </div>
            <p className={styles.agentDetail}>
              Confirmar não aplica nada por atalho: o item segue pela rota do módulo, que reavalia as regras do zero.
            </p>
          </> : null}

          {!canResolve ? <p className={styles.agentDetail}>
            <AlertTriangle aria-hidden="true" /> Você pode acompanhar a triagem, mas não resolvê-la. Peça a permissão de conciliação a quem administra o grupo.
          </p> : null}
        </aside> : <EmptyState icon={Inbox} title="Escolha um item" text="Selecione uma entrada à esquerda para ver o que ficou em dúvida." size="compact" />}
      </div>}
  </section>;
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: "critical" | "warning" }) {
  return <div className={styles.counter} data-tone={value > 0 ? tone : undefined}>
    <strong>{value}</strong>
    <span>{label}</span>
  </div>;
}
