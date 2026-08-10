"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertOctagon, CalendarClock, CircleDot, Download, LoaderCircle, LockKeyhole, Plus, RefreshCw, ShieldCheck, Timer,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { TimeDialog as TimeDialogView } from "./TimeDialogs";
import { duration, normalizeCompany, normalizeOverview, requestJson, type Row } from "./time.api";
import type { CompanyOption, TimeDialog, TimeOverview } from "./time.types";
import styles from "./time.module.css";

const statusLabels: Record<string, string> = {
  draft: "Rascunho", review: "Conferência", approved: "Aprovado", rejected: "Devolvido",
  exported: "Exportado", closed: "Fechado", open: "Aberta", pre_closing: "Pré-fechamento",
  processing: "Processando", post_closing: "Pós-fechamento", prepared: "Gerado", delivered: "Entregue", failed: "Falhou",
};
const targetLabels: Record<string, string> = { quantity: "Quantidade", reference: "Referência", index: "Índice" };
const unitLabels: Record<string, string> = { hours_decimal: "Horas decimais", hours_minutes: "HH:MM", minutes: "Minutos" };

const currentCompetence = () => new Date().toISOString().slice(0, 7);
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const competenceLabel = (value: string) => {
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1, 1));
};

export function TimeTrackingView({ role }: { role: WorkspaceRole }) {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [competence, setCompetence] = useState(currentCompetence);
  const [overview, setOverview] = useState<TimeOverview | null>(null);
  const [dialog, setDialog] = useState<TimeDialog>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const cycle = overview?.cycle ?? null;
  const permissions = overview?.permissions;
  const canManage = Boolean(permissions?.manage && cycle && cycle.status !== "closed");

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ companies?: Row[] }>("/api/companies");
      const next = (payload.companies ?? []).map(normalizeCompany).filter((item) => item.status === "active");
      setCompanies(next);
      setCompanyId((current) => (next.some((item) => item.id === current) ? current : next[0]?.id ?? ""));
      setError("");
      if (!next.length) setLoading(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar empresas.");
      setLoading(false);
    }
  }, []);

  const loadOverview = useCallback(async (selectedCompany: string, selectedCompetence: string, quiet = false) => {
    if (!selectedCompany) return;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const params = new URLSearchParams({ companyId: selectedCompany, competence: selectedCompetence });
      setOverview(normalizeOverview(await requestJson<Row>(`/api/time/overview?${params}`)));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar a conferência de ponto.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void loadCompanies()); return () => window.cancelAnimationFrame(frame); }, [loadCompanies]);
  useEffect(() => {
    if (!companyId) return;
    const frame = window.requestAnimationFrame(() => void loadOverview(companyId, competence));
    return () => window.cancelAnimationFrame(frame);
  }, [companyId, competence, loadOverview]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const competenceOptions = useMemo(() => {
    const known = (overview?.cycles ?? []).map((item) => item.competence);
    return [...new Set([competence, ...known])].sort().reverse();
  }, [competence, overview?.cycles]);

  const eventLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const item of overview?.catalog.hourEvents ?? []) labels[item.code] = item.label;
    return labels;
  }, [overview?.catalog.hourEvents]);

  const mappedCodes = useMemo(() => new Set(
    (overview?.mappings ?? [])
      .filter((item) => item.status === "active" && item.destination === overview?.destination)
      .map((item) => item.eventCode),
  ), [overview?.destination, overview?.mappings]);

  async function mutate(request: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await request();
      setToast(message);
      setError("");
      await loadOverview(companyId, competence, true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function transition(sheetId: string, status: string, reason?: string) {
    const labels: Record<string, string> = {
      review: "Folha enviada para conferência.", approved: "Ponto aprovado.",
      rejected: "Folha devolvida para correção.", closed: "Folha fechada.", draft: "Folha devolvida ao rascunho.",
    };
    await mutate(
      () => requestJson(`/api/time/sheets/${sheetId}/transition`, { method: "POST", body: JSON.stringify({ status, reason }) }),
      labels[status] ?? "Situação atualizada.",
    );
  }

  async function submitDialog(current: NonNullable<TimeDialog>, data: FormData) {
    if (current.kind === "entries") {
      const punches = JSON.parse(field(data, "punches") || "[]") as { in: string; out: string }[];
      const expected = field(data, "expectedMinutes");
      const ok = await mutate(() => requestJson(`/api/time/sheets/${current.sheetId}/entries`, {
        method: "POST",
        body: JSON.stringify({
          entries: [{
            entryDate: field(data, "entryDate"),
            dayType: field(data, "dayType"),
            expectedMinutes: expected === "" ? null : Number(expected),
            punches,
            justification: field(data, "justification"),
          }],
        }),
      }), "Marcação registrada e folha reapurada.");
      if (ok) setDialog(null);
      return;
    }
    if (current.kind === "mapping") {
      const ok = await mutate(() => requestJson("/api/time/mappings", {
        method: "POST",
        body: JSON.stringify({
          companyId,
          eventCode: field(data, "eventCode"),
          rubricCode: field(data, "rubricCode"),
          destination: field(data, "destination") || "folha",
          targetField: field(data, "targetField"),
          unit: field(data, "unit"),
          note: field(data, "note"),
        }),
      }), "Rubrica de destino configurada.");
      if (ok) setDialog(null);
      return;
    }
    if (current.kind === "inconsistency") {
      const ok = await mutate(() => requestJson(`/api/time/sheets/${current.sheetId}/inconsistencies`, {
        method: "POST",
        body: JSON.stringify({ inconsistencyId: current.inconsistencyId, status: field(data, "status"), note: field(data, "note") }),
      }), "Inconsistência tratada.");
      if (ok) setDialog(null);
      return;
    }
    const ok = await mutate(() => requestJson("/api/time/export", {
      method: "POST",
      body: JSON.stringify({ companyId, competenceId: cycle?.id, destination: field(data, "destination") || "folha" }),
    }), "Exportação gerada e folhas marcadas como exportadas.");
    if (ok) setDialog(null);
  }

  if (role === "guest") {
    return <section className={styles.workspace}><p className={styles.emptyState}>Seu perfil não tem acesso à conferência de ponto.</p></section>;
  }

  const summary = overview?.summary;
  const blockedEvents = (summary?.missingMappings ?? []);

  return (
    <section className={styles.workspace} aria-busy={loading}>
      <header className={styles.commandBar}>
        <div className={styles.commandSelectors}>
          <label>
            <span className={styles.eyebrow}>EMPRESA</span>
            <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} disabled={!companies.length}>
              {companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span className={styles.eyebrow}>COMPETÊNCIA</span>
            <select value={competence} onChange={(event) => setCompetence(event.target.value)}>
              {competenceOptions.map((item) => <option key={item} value={item}>{competenceLabel(item)}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.commandActions}>
          <button className={styles.secondaryButton} type="button" onClick={() => void loadOverview(companyId, competence, true)} disabled={refreshing || !companyId}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
          {permissions?.export && (
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => setDialog({ kind: "export" })}
              disabled={busy || !summary?.exportReady}
              title={summary?.exportReady ? "Exportar ponto aprovado" : "Exportação bloqueada: aprove folhas e configure as rubricas"}
            >
              <Download aria-hidden="true" /> Exportar para a folha
            </button>
          )}
        </div>
      </header>

      <div className={styles.moduleHeadline}>
        <span className={styles.moduleIcon} aria-hidden="true"><Timer /></span>
        <div>
          <span className={styles.eyebrow}>CONFERÊNCIA OPERACIONAL</span>
          <h2>Ponto</h2>
          <p>Importe as marcações, resolva as inconsistências, aprove e envie os eventos de hora para a folha.</p>
        </div>
        {cycle && (
          <span className={styles.cycleBadge} data-locked={cycle.status === "closed" ? "true" : "false"}>
            {cycle.status === "closed" ? <LockKeyhole aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
            Competência {statusLabels[cycle.status] ?? cycle.status}
          </span>
        )}
      </div>

      {overview?.boundary && (
        <p className={styles.privacyNotice}><ShieldCheck aria-hidden="true" /><span>{overview.boundary}</span></p>
      )}

      {error && <p className={styles.errorState} role="alert"><AlertOctagon aria-hidden="true" /> {error}</p>}
      {loading && <p className={styles.loadingState}><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando a conferência de ponto…</p>}

      {!loading && !companies.length && <p className={styles.emptyState}>Cadastre uma empresa para conferir ponto.</p>}

      {!loading && companies.length > 0 && !cycle && (
        <p className={styles.emptyState}>
          A competência {competenceLabel(competence)} ainda não foi aberta para esta empresa. Abra-a em Operação DP para conferir o ponto.
        </p>
      )}

      {!loading && overview && cycle && (
        <>
          <div className={styles.summaryGrid}>
            <article><span>Folhas de ponto</span><strong>{summary?.sheets ?? 0}</strong></article>
            <article><span>Aprovadas</span><strong>{summary?.approvedSheets ?? 0}</strong></article>
            <article data-alert={(summary?.openBlockingIssues ?? 0) > 0 ? "true" : "false"}>
              <span>Inconsistências bloqueantes</span><strong>{summary?.openBlockingIssues ?? 0}</strong>
            </article>
            <article><span>Avisos em aberto</span><strong>{summary?.openWarningIssues ?? 0}</strong></article>
            <article data-alert={blockedEvents.length > 0 ? "true" : "false"}>
              <span>Eventos sem rubrica</span><strong>{blockedEvents.length}</strong>
            </article>
          </div>

          {blockedEvents.length > 0 && (
            <p className={styles.warningState} role="status">
              <AlertOctagon aria-hidden="true" />
              <span>
                Exportação bloqueada: {blockedEvents.map((code) => eventLabels[code] ?? code).join(", ")} sem rubrica de destino
                configurada. Evento do tipo hora vai para índice, referência ou quantidade — nunca para valor.
              </span>
            </p>
          )}

          {overview.sheets.length === 0 ? (
            <p className={styles.emptyState}>
              Nenhuma folha de ponto nesta competência. Importe as marcações pela API de importação ou abra a folha de um colaborador.
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.tableCaption}>Folhas de ponto de {competenceLabel(competence)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Colaborador</th>
                    <th scope="col">Dias</th>
                    <th scope="col">Previsto</th>
                    <th scope="col">Trabalhado</th>
                    <th scope="col">Saldo</th>
                    <th scope="col">Bloqueios</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.sheets.map((sheet) => (
                    <tr key={sheet.id}>
                      <th scope="row">{sheet.employeeName}<small>{sheet.registrationNumber}</small></th>
                      <td>{sheet.entriesCount}</td>
                      <td>{duration(sheet.expectedMinutes)}</td>
                      <td>{duration(sheet.workedMinutes)}</td>
                      <td className={sheet.balanceMinutes < 0 ? styles.negative : styles.positive}>{duration(sheet.balanceMinutes)}</td>
                      <td>{sheet.blockingIssues > 0 ? <span className={styles.badge} data-tone="blocking">{sheet.blockingIssues}</span> : "—"}</td>
                      <td><span className={styles.badge} data-tone={sheet.status}>{statusLabels[sheet.status] ?? sheet.status}</span></td>
                      <td>
                        <div className={styles.rowActions}>
                          {canManage && sheet.status !== "exported" && sheet.status !== "closed" && (
                            <button type="button" onClick={() => setDialog({ kind: "entries", sheetId: sheet.id, employeeName: sheet.employeeName })} disabled={busy}>
                              <Plus aria-hidden="true" /> Marcação
                            </button>
                          )}
                          {canManage && sheet.status === "draft" && (
                            <button type="button" onClick={() => void transition(sheet.id, "review")} disabled={busy}>Enviar à conferência</button>
                          )}
                          {canManage && permissions?.approve && sheet.status === "review" && (
                            <>
                              <button type="button" onClick={() => void transition(sheet.id, "approved")} disabled={busy || sheet.blockingIssues > 0}>Aprovar</button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  const reason = window.prompt("Motivo da devolução (mínimo 5 caracteres):") ?? "";
                                  if (reason.trim().length >= 5) void transition(sheet.id, "rejected", reason.trim());
                                }}
                              >
                                Devolver
                              </button>
                            </>
                          )}
                          {canManage && sheet.status === "rejected" && (
                            <button type="button" onClick={() => void transition(sheet.id, "draft")} disabled={busy}>Voltar ao rascunho</button>
                          )}
                          {canManage && sheet.status === "exported" && (
                            <button type="button" onClick={() => void transition(sheet.id, "closed")} disabled={busy}>Fechar</button>
                          )}
                          {canManage && (sheet.status === "exported" || sheet.status === "closed") && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const reason = window.prompt("Justificativa da reabertura (mínimo 5 caracteres):") ?? "";
                                if (reason.trim().length >= 5) void transition(sheet.id, "review", reason.trim());
                              }}
                            >
                              Reabrir
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={styles.panelGrid}>
            <section className={styles.panel} aria-labelledby="time-events-title">
              <header className={styles.panelHeader}>
                <div><span className={styles.eyebrow}>EVENTOS DE HORA</span><h3 id="time-events-title">Apurado na competência</h3></div>
              </header>
              <div className={styles.panelBody}>
                {overview.events.length === 0 ? (
                  <p>Nenhum evento de hora apurado até agora.</p>
                ) : (
                  <ul className={styles.mappingList}>
                    {overview.events.map((event) => {
                      const missing = !mappedCodes.has(event.eventCode);
                      const mapping = overview.mappings.find((item) => item.eventCode === event.eventCode && item.destination === overview.destination);
                      return (
                        <li key={event.eventCode} data-missing={missing ? "true" : "false"}>
                          <span>
                            {eventLabels[event.eventCode] ?? event.eventCode}
                            <small>
                              {duration(event.minutes)} em {event.sheets} folha(s)
                              {mapping ? ` · rubrica ${mapping.rubricCode} → ${targetLabels[mapping.targetField] ?? mapping.targetField} (${unitLabels[mapping.unit] ?? mapping.unit})` : ""}
                            </small>
                          </span>
                          {missing
                            ? permissions?.manageMappings
                              ? <button type="button" className={styles.secondaryButton} onClick={() => setDialog({ kind: "mapping", eventCode: event.eventCode })} disabled={busy}>Configurar rubrica</button>
                              : <span className={styles.badge} data-tone="missing">Sem rubrica</span>
                            : <span className={styles.badge} data-tone="ok">Mapeado</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <section className={styles.panel} aria-labelledby="time-issues-title">
              <header className={styles.panelHeader}>
                <div><span className={styles.eyebrow}>CONFERÊNCIA</span><h3 id="time-issues-title">Inconsistências em aberto</h3></div>
              </header>
              <div className={styles.panelBody}>
                {overview.inconsistencies.filter((item) => item.status === "open").length === 0 ? (
                  <p>Nenhuma inconsistência em aberto nesta competência.</p>
                ) : (
                  <ul className={styles.mappingList}>
                    {overview.inconsistencies.filter((item) => item.status === "open").slice(0, 40).map((issue) => (
                      <li key={issue.id} data-missing={issue.severity === "blocking" ? "true" : "false"}>
                        <span>
                          {overview.catalog.inconsistencyLabels[issue.kind] ?? issue.kind}
                          <small>{issue.employeeName} · {issue.entryDate || "competência"} · {issue.detail}</small>
                        </span>
                        {canManage
                          ? <button type="button" className={styles.secondaryButton} onClick={() => setDialog({ kind: "inconsistency", sheetId: issue.sheetId, inconsistencyId: issue.id, detail: issue.detail })} disabled={busy}>Tratar</button>
                          : <span className={styles.badge} data-tone={issue.severity}>{issue.severity === "blocking" ? "Bloqueante" : "Aviso"}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className={styles.panel} aria-labelledby="time-exports-title">
              <header className={styles.panelHeader}>
                <div><span className={styles.eyebrow}>ENVIO PARA A FOLHA</span><h3 id="time-exports-title">Exportações da competência</h3></div>
                <CalendarClock aria-hidden="true" />
              </header>
              <div className={styles.panelBody}>
                {overview.exports.length === 0 ? (
                  <p>Nenhuma exportação gerada nesta competência.</p>
                ) : (
                  <ul className={styles.mappingList}>
                    {overview.exports.map((item) => (
                      <li key={item.id}>
                        <span>
                          {item.destination}
                          <small>{item.sheetsCount} folha(s) · {item.linesCount} linha(s) · verificação {item.checksum.slice(0, 12)}</small>
                        </span>
                        <span className={styles.badge} data-tone={item.status}>{statusLabels[item.status] ?? item.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {dialog && (
        <TimeDialogView
          dialog={dialog}
          busy={busy}
          hourEvents={overview?.catalog.hourEvents ?? []}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      )}
      {toast && <p className={styles.toast} role="status">{toast}</p>}
    </section>
  );
}
