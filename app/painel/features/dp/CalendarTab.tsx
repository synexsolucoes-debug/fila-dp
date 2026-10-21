"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Wand2 } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { brDate, dpRequest, errorText, weekdayShort } from "./dp.api";
import styles from "./dp.module.css";

type CalendarPayload = {
  competence: string;
  days: string[];
  rows: Array<{ templateId: string; name: string; frequency: "monthly" | "weekly"; days: string[]; dueDays: string[] }>;
  load: Array<{ day: string; count: number }>;
  peakThreshold: number;
  generated: Array<{ day: string; total: number; done: number }>;
};

/** Calendário: linha do tempo do mês, dias × rotinas, com os dias de pico destacados. */
export function CalendarTab({ canManage }: { canManage: boolean }) {
  const [competence, setCompetence] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<CalendarPayload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await dpRequest<CalendarPayload>(`/api/dp/calendar?competencia=${competence}`)); setError(""); }
    catch (cause) { setError(errorText(cause, "Não foi possível carregar o calendário.")); }
  }, [competence]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function generate() {
    setBusy(true);
    try {
      const result = await dpRequest<{ created: number; existing: number; skipped: string[] }>("/api/dp/recurring/generate", {
        method: "POST", body: JSON.stringify({ competencia: competence }),
      });
      setNotice(result.skipped.length ? result.skipped.join(" ") : `${result.created} demanda(s) criada(s); ${result.existing} já existia(m).`);
      await load();
    } catch (cause) { setError(errorText(cause, "Não foi possível gerar as rotinas.")); }
    finally { setBusy(false); }
  }

  const peakDays = data ? data.load.filter((item) => item.count >= data.peakThreshold).map((item) => item.day) : [];
  return <section className={styles.card} aria-label="Calendário do mês">
    <header className={styles.cardHeader}>
      <div><h3>Calendário do mês</h3><p>Janela de cada rotina (claro) e o prazo (escuro). Dias com {data?.peakThreshold ?? 5} ou mais frentes ficam em destaque.</p></div>
      <div className={styles.toolbar}>
        <label>Competência<input type="month" value={competence} onChange={(event) => setCompetence(event.target.value)} /></label>
        {canManage && <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void generate()}><Wand2 aria-hidden="true" /> Gerar demandas da competência</button>}
      </div>
    </header>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!data ? <LoadingState title="Carregando o calendário" size="compact" />
      : !data.rows.length ? <EmptyState icon={CalendarDays} size="compact" title="Nenhuma rotina ativa" text="Cadastre as rotinas fixas na aba Rotinas e regras (ou pela semente do grupo)." />
        : <>
          {peakDays.length > 0 && <p className={styles.hint}>Dias de pico: {peakDays.map(brDate).join(", ")}.</p>}
          <div className={styles.tableWrap}><table className={styles.timeline}>
            <caption className="sr-only">Rotinas por dia da competência {competence}</caption>
            <thead>
              <tr>
                <th className={styles.activity} scope="col">Rotina</th>
                {data.days.map((day) => {
                  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
                  return <th key={day} scope="col" data-weekend={weekday === 0 || weekday === 6} title={`${weekdayShort[weekday]} ${brDate(day)}`}>{Number(day.slice(8))}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => <tr key={row.templateId}>
                <td className={styles.activity}>{row.name}{row.frequency === "weekly" ? " (semanal)" : ""}</td>
                {data.days.map((day) => <td key={day} data-on={row.days.includes(day)} data-due={row.dueDays.includes(day)}
                  aria-label={row.dueDays.includes(day) ? `${row.name}: prazo` : row.days.includes(day) ? `${row.name}: em andamento` : undefined} />)}
              </tr>)}
              <tr>
                <td className={styles.activity}><strong>Frentes no dia</strong></td>
                {data.load.map((item) => <td key={item.day} data-peak={item.count >= data.peakThreshold}>{item.count || ""}</td>)}
              </tr>
              <tr>
                <td className={styles.activity}>Demandas geradas (concluídas)</td>
                {data.days.map((day) => {
                  const generated = data.generated.find((item) => item.day === day);
                  return <td key={day}>{generated ? `${generated.done}/${generated.total}` : ""}</td>;
                })}
              </tr>
            </tbody>
          </table></div>
        </>}
  </section>;
}
