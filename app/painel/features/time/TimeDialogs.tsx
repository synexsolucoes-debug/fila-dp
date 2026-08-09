"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HourEventCatalogItem, TimeDialog } from "./time.types";
import styles from "./time.module.css";

type Props = {
  dialog: NonNullable<TimeDialog>;
  busy: boolean;
  hourEvents: HourEventCatalogItem[];
  onClose: () => void;
  onSubmit: (dialog: NonNullable<TimeDialog>, data: FormData) => Promise<void>;
};

const titles: Record<NonNullable<TimeDialog>["kind"], string> = {
  entries: "Marcações do dia",
  mapping: "Rubrica de destino do evento de hora",
  inconsistency: "Tratar inconsistência",
  export: "Exportar ponto para a folha",
};

const dayTypes = [
  ["regular", "Dia útil"],
  ["rest", "Descanso"],
  ["holiday", "Feriado"],
  ["vacation", "Férias"],
  ["leave", "Licença"],
  ["absence", "Falta"],
] as const;

const units = [
  ["hours_decimal", "Horas decimais (1,5)"],
  ["hours_minutes", "Horas e minutos (01:30)"],
  ["minutes", "Minutos (90)"],
] as const;

export function TimeDialog({ dialog, busy, hourEvents, onClose, onSubmit }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  const [punches, setPunches] = useState([{ in: "", out: "" }]);

  useEffect(() => { busyRef.current = busy; closeRef.current = onClose; }, [busy, onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const selector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(selector) ?? []).filter((item) => item.getClientRects().length > 0);
    const timer = window.setTimeout(() => (panelRef.current?.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea") ?? focusables()[0])?.focus(), 30);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); panelRef.current?.focus(); return; }
      const first = items[0];
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (dialog.kind === "entries") {
      data.set("punches", JSON.stringify(punches.filter((punch) => punch.in).map((punch) => ({ in: punch.in, out: punch.out }))));
    }
    await onSubmit(dialog, data);
  }

  const manualEvents = hourEvents.filter((event) => !event.computed);

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={styles.dialog} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="time-dialog-title" tabIndex={-1}>
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>CONFERÊNCIA DE PONTO</span>
            <h2 id="time-dialog-title">{titles[dialog.kind]}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar janela"><X aria-hidden="true" /></button>
        </header>
        <form onSubmit={submit}>
          <div className={styles.dialogBody}>
            {dialog.kind === "entries" && (
              <>
                <p className={styles.dialogSummary}>{dialog.employeeName}</p>
                <div className={styles.fieldRow}>
                  <label>Data<input name="entryDate" type="date" required /></label>
                  <label>Tipo do dia
                    <select name="dayType" defaultValue="regular">
                      {dayTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>Jornada prevista (minutos)<input name="expectedMinutes" type="number" min={0} max={1440} step={1} defaultValue={480} /></label>
                </div>
                <fieldset className={styles.punchGrid}>
                  <legend className={styles.eyebrow}>MARCAÇÕES</legend>
                  {punches.map((punch, index) => (
                    <div className={styles.punchRow} key={`punch-${index}`}>
                      <label>Entrada
                        <input type="time" value={punch.in} onChange={(event) => setPunches((current) => current.map((item, position) => position === index ? { ...item, in: event.target.value } : item))} />
                      </label>
                      <label>Saída
                        <input type="time" value={punch.out} onChange={(event) => setPunches((current) => current.map((item, position) => position === index ? { ...item, out: event.target.value } : item))} />
                      </label>
                      <button type="button" onClick={() => setPunches((current) => current.length > 1 ? current.filter((_, position) => position !== index) : current)} aria-label={`Remover marcação ${index + 1}`}>Remover</button>
                    </div>
                  ))}
                  <button type="button" className={styles.secondaryButton} onClick={() => setPunches((current) => current.length < 12 ? [...current, { in: "", out: "" }] : current)}>
                    Adicionar par de marcação
                  </button>
                </fieldset>
                <label>Justificativa (obrigatória quando houver hora extra)<textarea name="justification" maxLength={500} /></label>
                <p className={styles.hint}>
                  As horas trabalhadas são apuradas a partir das marcações. O Fila DP confere horas; a conversão em dinheiro é da folha.
                </p>
              </>
            )}

            {dialog.kind === "mapping" && (
              <>
                <input type="hidden" name="eventCode" value={dialog.eventCode} />
                <p className={styles.dialogSummary}>
                  {hourEvents.find((event) => event.code === dialog.eventCode)?.label ?? dialog.eventCode}
                </p>
                <div className={styles.fieldRow}>
                  <label>Código da rubrica no destino<input name="rubricCode" maxLength={60} required /></label>
                  <label>Destino<input name="destination" maxLength={60} defaultValue="folha" /></label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Campo de destino
                    <select name="targetField" defaultValue="quantity">
                      <option value="quantity">Quantidade</option>
                      <option value="reference">Referência</option>
                      <option value="index">Índice</option>
                    </select>
                  </label>
                  <label>Unidade da quantidade
                    <select name="unit" defaultValue="hours_decimal">
                      {units.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                </div>
                <label>Observação<input name="note" maxLength={240} /></label>
                <p className={styles.hint}>
                  Evento do tipo hora vai para índice, referência ou quantidade — nunca para valor. Por isso não existe
                  a opção &quot;valor&quot; nesta lista.
                </p>
              </>
            )}

            {dialog.kind === "inconsistency" && (
              <>
                <p className={styles.dialogSummary}>{dialog.detail}</p>
                <label>Decisão
                  <select name="status" defaultValue="resolved">
                    <option value="resolved">Corrigido</option>
                    <option value="waived">Está correto assim</option>
                  </select>
                </label>
                <label>Nota da conferência<textarea name="note" minLength={5} maxLength={500} required /></label>
                <p className={styles.hint}>A nota fica registrada com seu nome e a data — é ela que sustenta a aprovação do ponto.</p>
              </>
            )}

            {dialog.kind === "export" && (
              <>
                <label>Destino<input name="destination" maxLength={60} defaultValue="folha" /></label>
                <p className={styles.hint}>
                  A exportação inclui apenas folhas aprovadas e é bloqueada se algum evento apurado estiver sem rubrica
                  configurada. As folhas exportadas ficam congeladas e só voltam a ser editáveis com justificativa.
                </p>
              </>
            )}

            {dialog.kind === "entries" && manualEvents.length > 0 && (
              <p className={styles.hint}>
                Eventos manuais disponíveis nesta folha: {manualEvents.map((event) => event.label).join(", ")}.
              </p>
            )}
          </div>
          <footer className={styles.dialogFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>Cancelar</button>
            <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? "Salvando…" : "Confirmar"}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
