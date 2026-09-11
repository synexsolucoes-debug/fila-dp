"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, CalendarClock, CalendarDays, Download, HardHat, LayoutDashboard, ListPlus,
  Moon, Pencil, Plus, RefreshCw, Sun, SunMedium, Trash2, TriangleAlert, Users, Wallet,
} from "lucide-react";
import {
  accidentBodyPartLabels, accidentShiftLabels, accidentTypeLabels,
  monthAbbreviations, monthLabels, summarizeAccidents,
  type AccidentShift, type WorkAccidentRecord,
} from "@/lib/work-accidents";
import {
  AnimatedTabs, ConfirmDialog, EmptyState, ErrorBanner, PageSkeleton, PanelHeader,
  type AnimatedTab,
} from "../shared";
import { AccidentDialog } from "./AccidentDialog";
import { BodyMap } from "./BodyMap";
import { DonutRing, MonthSeries, SectorBars } from "./SafetyCharts";
import {
  currency, dateLabel, draftFromRecord, emptyDraft, normalizeOverview,
  payloadFromDraft, requestJson, shortCurrency, type Row,
} from "./safety.api";
import type { AccidentDraft, SafetyOverview, SafetyTab } from "./safety.types";
import styles from "./safety.module.css";

/**
 * Dashboard de Acidente de Trabalho.
 *
 * A tela responde uma pergunta por vez, na ordem em que o SESMT a faz: quantos
 * acidentes houve no período, quanto isso custou em dias e em dinheiro, quem se
 * acidentou, onde no corpo, em que setor e em que mês. Cada painel é a mesma
 * base vista de um ângulo — trocar o mês move todos juntos, porque todos saem
 * da mesma função de apuração.
 *
 * O filtro de período fica no topo e não some ao rolar a página: um número sem
 * o recorte a que pertence é o jeito mais rápido de alguém levar "21 acidentes"
 * para uma reunião sem saber de qual ano ele é.
 *
 * Quem alimenta é a própria equipe de segurança. Não há origem automática, e a
 * aba de lançamentos existe para isso — registrar, corrigir e conferir o que
 * sustenta cada gráfico.
 */
const tabs: Array<AnimatedTab<SafetyTab>> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "records", label: "Lançamentos", icon: ListPlus },
];

const shiftIcons: Record<AccidentShift, typeof Sun> = {
  morning: SunMedium,
  afternoon: Sun,
  night: Moon,
};

export function WorkAccidentDashboardView() {
  const [overview, setOverview] = useState<SafetyOverview | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [tab, setTab] = useState<SafetyTab>("dashboard");
  const [years, setYears] = useState<number[]>([]);
  const [months, setMonths] = useState<number[]>([]);
  const [records, setRecords] = useState<WorkAccidentRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [draft, setDraft] = useState<AccidentDraft | null>(null);
  const [removing, setRemoving] = useState<WorkAccidentRecord | null>(null);

  const permissions = overview?.permissions;

  const loadRecords = useCallback(async (selectedCompany: string, selectedYears: number[]) => {
    const params = new URLSearchParams();
    if (selectedCompany) params.set("companyId", selectedCompany);
    for (const year of selectedYears) params.append("year", String(year));
    const payload = await requestJson<{ accidents: WorkAccidentRecord[]; truncated: boolean }>(
      `/api/safety/accidents?${params}`);
    setRecords(payload.accidents ?? []);
    setTruncated(Boolean(payload.truncated));
  }, []);

  const reload = useCallback(async (selectedCompany: string) => {
    const payload = normalizeOverview(await requestJson<Row>(
      `/api/safety/overview${selectedCompany ? `?companyId=${encodeURIComponent(selectedCompany)}` : ""}`));
    setOverview(payload);
    /* O ano mais recente é o recorte de abertura. Abrir em "todos" faria a
       primeira leitura misturar anos e mostrar uma série de doze meses somando
       exercícios diferentes — o número que mais engana neste dashboard. */
    const initial = payload.years.length ? [payload.years[0]] : [];
    setYears(initial);
    await loadRecords(selectedCompany, initial);
    return payload;
  }, [loadRecords]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        await reload("");
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "Não foi possível abrir o dashboard.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [reload]);

  const refreshRecords = useCallback(async (selectedCompany: string, selectedYears: number[]) => {
    try {
      setListLoading(true);
      setError("");
      await loadRecords(selectedCompany, selectedYears);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os acidentes.");
    } finally {
      setListLoading(false);
    }
  }, [loadRecords]);

  function changeCompany(next: string) {
    setCompanyId(next);
    void (async () => {
      try {
        setListLoading(true);
        setError("");
        await reload(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Não foi possível trocar a empresa.");
      } finally {
        setListLoading(false);
      }
    })();
  }

  function toggleYear(year: number) {
    const next = years.includes(year) ? years.filter((item) => item !== year) : [...years, year].sort();
    setYears(next);
    void refreshRecords(companyId, next);
  }

  function toggleMonth(month: number) {
    setMonths((current) => current.includes(month) ? current.filter((item) => item !== month) : [...current, month].sort((left, right) => left - right));
  }

  const dashboard = useMemo(() => summarizeAccidents(records, { years, months }), [records, years, months]);

  const scoped = useMemo(
    () => records.filter((record) => {
      const month = Number(record.occurredOn.slice(5, 7));
      return !months.length || months.includes(month);
    }),
    [records, months],
  );

  const periodLabel = useMemo(() => {
    const yearPart = years.length ? years.join(", ") : "todos os anos";
    if (!months.length) return `${yearPart} · ano inteiro`;
    return `${yearPart} · ${months.map((month) => monthLabels[month - 1]).join(", ")}`;
  }, [years, months]);

  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    if (companyId) params.set("companyId", companyId);
    if (years.length === 1) params.set("year", String(years[0]));
    const query = params.toString();
    return `/api/safety/export${query ? `?${query}` : ""}`;
  }, [companyId, years]);

  async function submitDraft(next: AccidentDraft) {
    try {
      setBusy(true);
      setDialogError("");
      const body = JSON.stringify(payloadFromDraft(next));
      if (next.id) await requestJson(`/api/safety/accidents/${next.id}`, { method: "PATCH", body });
      else await requestJson("/api/safety/accidents", { method: "POST", body });
      setDraft(null);
      await reload(companyId);
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "Não foi possível gravar o acidente.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemoval() {
    if (!removing) return;
    try {
      setBusy(true);
      await requestJson(`/api/safety/accidents/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      await reload(companyId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir o acidente.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageSkeleton label="Carregando o dashboard de acidentes de trabalho" metrics={5} rows={4} />;

  const genderShare = (key: string) => dashboard.byGender.find((item) => item.key === key)?.share ?? 0;
  const shiftTotal = (key: AccidentShift) => dashboard.byShift.find((item) => item.key === key)?.total ?? 0;
  const canManage = permissions?.manage ?? false;

  return <section className={styles.workspace}>
    <PanelHeader
      eyebrow="SEGURANÇA DO TRABALHO"
      title="Dashboard de Acidente de Trabalho"
      description="Acidentes, dias afastados e despesas do período, alimentados pela própria equipe do SESMT."
      action={<div className={styles.headerActions}>
        <button type="button" className={styles.secondaryButton}
          onClick={() => void refreshRecords(companyId, years)} disabled={listLoading}>
          <RefreshCw aria-hidden="true" /> Atualizar
        </button>
        {permissions?.export && <a className={styles.secondaryButton} href={exportHref}>
          <Download aria-hidden="true" /> Exportar
        </a>}
        {canManage && <button type="button" className={styles.primaryButton}
          onClick={() => { setDialogError(""); setDraft(emptyDraft(companyId || overview?.companies[0]?.id || "")); }}>
          <Plus aria-hidden="true" /> Registrar acidente
        </button>}
      </div>}
    />

    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

    <div className={styles.filterBar}>
      <label className={styles.selectField}>
        <span>Empresa</span>
        <select value={companyId} onChange={(event) => changeCompany(event.target.value)}>
          <option value="">Todas as empresas que eu enxergo</option>
          {overview?.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select>
      </label>

      <div className={styles.chipGroup} role="group" aria-label="Ano">
        <span className={styles.chipLabel}>ANO</span>
        {overview?.years.length
          ? overview.years.map((year) => <button key={year} type="button" className={styles.chip}
            data-selected={years.includes(year)} aria-pressed={years.includes(year)}
            onClick={() => toggleYear(year)}>{year}</button>)
          : <span className={styles.chipEmpty}>sem lançamentos</span>}
      </div>

      <div className={styles.chipGroup} role="group" aria-label="Mês">
        <span className={styles.chipLabel}>MÊS</span>
        {monthAbbreviations.map((label, index) => <button key={label} type="button" className={styles.chip}
          data-selected={months.includes(index + 1)} aria-pressed={months.includes(index + 1)}
          onClick={() => toggleMonth(index + 1)}>{label}</button>)}
        {months.length > 0 && <button type="button" className={styles.chipReset} onClick={() => setMonths([])}>
          Ano inteiro
        </button>}
      </div>
    </div>

    <AnimatedTabs label="Áreas do dashboard de acidentes" tabs={tabs} active={tab} onChange={setTab} />

    {truncated && <div className={styles.noticeBar} data-tone="warning" role="status">
      <TriangleAlert aria-hidden="true" />
      <span><strong>Recorte grande demais</strong>
        Há mais acidentes do que uma consulta devolve. Selecione um ano ou uma empresa para conferir os números.</span>
    </div>}

    {tab === "dashboard" && (dashboard.totals.accidents === 0
      ? <EmptyState icon={HardHat} title="Nenhum acidente no período"
        text={`Não há acidente lançado em ${periodLabel}. Registre o primeiro para o dashboard começar a responder.`}
        action={canManage
          ? <button type="button" className={styles.primaryButton}
            onClick={() => { setDialogError(""); setDraft(emptyDraft(companyId || overview?.companies[0]?.id || "")); }}>
            <Plus aria-hidden="true" /> Registrar acidente
          </button>
          : undefined} />
      : <>
        <div className={styles.summaryRow}>
          <article className={styles.summaryCard}>
            <span className={styles.cardIcon}><HardHat aria-hidden="true" /></span>
            <div><small>Total de acidentes</small><strong>{dashboard.totals.accidents}</strong>
              <p>{dashboard.totals.withLeave} com afastamento · {dashboard.totals.catIssued} com CAT</p></div>
          </article>
          <article className={styles.summaryCard}>
            <span className={styles.cardIcon}><CalendarClock aria-hidden="true" /></span>
            <div><small>Total dias afastados</small><strong>{dashboard.totals.leaveDays}</strong>
              <p>{periodLabel}</p></div>
          </article>
          <article className={styles.summaryCard}>
            <span className={styles.cardIcon}><Wallet aria-hidden="true" /></span>
            <div><small>Total despesas</small><strong>{shortCurrency(dashboard.totals.expenses)}</strong>
              <p>{currency(dashboard.totals.expenses)}</p></div>
          </article>
          <article className={styles.summaryCard}>
            <span className={styles.cardIcon}><Users aria-hidden="true" /></span>
            <div><small>Gênero</small>
              <strong className={styles.genderSplit}>
                <span>{genderShare("female")}%<i>F</i></span>
                <span>{genderShare("male")}%<i>M</i></span>
              </strong>
              <p>{genderShare("not_informed") > 0 ? `${genderShare("not_informed")}% sem gênero informado` : "Todos informados"}</p></div>
          </article>
          <article className={styles.summaryCard}>
            <span className={styles.cardIcon}><Activity aria-hidden="true" /></span>
            <div><small>Turno</small>
              <strong className={styles.shiftSplit}>
                {(["morning", "afternoon", "night"] as AccidentShift[]).map((shift) => {
                  const Icon = shiftIcons[shift];
                  return <span key={shift} title={accidentShiftLabels[shift]}>
                    <Icon aria-hidden="true" />{shiftTotal(shift)}
                  </span>;
                })}
              </strong>
              <p>Manhã · Tarde · Noite</p></div>
          </article>
        </div>

        <div className={styles.chartsGrid}>
          <article className={styles.panel} data-area="types">
            <header><strong>Total de acidentes por tipo</strong><span>{periodLabel}</span></header>
            <ul className={styles.typeList}>
              {dashboard.byType.map((item) => <li key={item.key}>
                <div><b>{item.total}</b><span>{accidentTypeLabels[item.key as keyof typeof accidentTypeLabels] ?? item.label}</span></div>
                <DonutRing share={item.share} label={item.label} />
              </li>)}
            </ul>
          </article>

          <article className={styles.panel} data-area="body">
            <header><strong>Parte do corpo atingido</strong><span>{dashboard.totals.accidents} acidente(s)</span></header>
            <BodyMap items={dashboard.byBodyPart} />
          </article>

          <article className={styles.panel} data-area="series">
            <header><strong>Total de acidentes no período</strong><span>{years.length ? years.join(", ") : "todos os anos"}</span></header>
            <MonthSeries points={dashboard.byMonth} />
          </article>

          <article className={styles.panel} data-area="sectors">
            <header><strong>Total de acidentes por setor</strong><span>maior para menor</span></header>
            {dashboard.bySector.length
              ? <SectorBars items={dashboard.bySector} />
              : <EmptyState icon={CalendarDays} size="compact" title="Sem setor informado"
                text="Informe o setor no lançamento para comparar as áreas da empresa." />}
          </article>
        </div>
      </>)}

    {tab === "records" && <div className={styles.tableWrap}>
      {scoped.length === 0
        ? <EmptyState icon={ListPlus} title="Nenhum lançamento no período"
          text={`Não há acidente lançado em ${periodLabel}.`} />
        : <table className={styles.table}>
          <caption className={styles.srOnly}>Acidentes lançados em {periodLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Data</th><th scope="col">Empresa</th><th scope="col">Tipo</th>
              <th scope="col">Parte do corpo</th><th scope="col">Setor</th><th scope="col">Turno</th>
              <th scope="col">Colaborador</th>
              <th scope="col" className={styles.numeric}>Dias</th>
              <th scope="col" className={styles.numeric}>Despesa</th>
              <th scope="col">CAT</th>
              {(canManage || permissions?.remove) && <th scope="col"><span className={styles.srOnly}>Ações</span></th>}
            </tr>
          </thead>
          <tbody>
            {scoped.map((record) => <tr key={record.id}>
              <td>{dateLabel(record.occurredOn)}</td>
              <td>{record.companyName}</td>
              <td>{accidentTypeLabels[record.accidentType]}</td>
              <td>{accidentBodyPartLabels[record.bodyPart]}</td>
              <td>{record.sector || "—"}</td>
              <td>{accidentShiftLabels[record.shift]}</td>
              <td>{record.employeeLabel || "—"}</td>
              <td className={styles.numeric}>{record.leaveDays}</td>
              <td className={styles.numeric}>{currency(record.expenseAmount)}</td>
              <td>{record.catIssued ? record.catNumber || "Emitida" : "—"}</td>
              {(canManage || permissions?.remove) && <td className={styles.rowActions}>
                {canManage && <button type="button" className={styles.iconButton} aria-label="Corrigir lançamento"
                  onClick={() => { setDialogError(""); setDraft(draftFromRecord(record)); }}>
                  <Pencil aria-hidden="true" />
                </button>}
                {permissions?.remove && <button type="button" className={styles.iconButton} aria-label="Excluir lançamento"
                  onClick={() => setRemoving(record)}>
                  <Trash2 aria-hidden="true" />
                </button>}
              </td>}
            </tr>)}
          </tbody>
        </table>}
    </div>}

    {draft && <AccidentDialog draft={draft} companies={overview?.companies ?? []} busy={busy} error={dialogError}
      onClose={() => setDraft(null)} onSubmit={submitDraft} />}

    <ConfirmDialog open={Boolean(removing)} title="Excluir este acidente?"
      consequence={removing
        ? `O acidente de ${dateLabel(removing.occurredOn)} sai do dashboard e dos totais do período. O registro fica na trilha de auditoria, mas o número não volta sozinho.`
        : ""}
      confirmLabel="Excluir acidente" busy={busy}
      onCancel={() => setRemoving(null)} onConfirm={() => void confirmRemoval()} />
  </section>;
}
