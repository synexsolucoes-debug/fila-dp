"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  accidentBodyPartLabels, accidentBodyParts, accidentGenderLabels, accidentGenders,
  accidentShiftLabels, accidentShifts, accidentTypeLabels, accidentTypes,
} from "@/lib/work-accidents";
import { payloadFromDraft } from "./safety.api";
import type { AccidentDraft, SafetyCompanyOption } from "./safety.types";
import styles from "./safety.module.css";

/**
 * O formulário do lançamento.
 *
 * É a única porta de entrada do módulo: nada aqui vem de integração, e é por
 * isso que o formulário precisa ser curto. Nove campos alimentam os nove
 * recortes do dashboard; o resto — colaborador, CAT, descrição — é opcional e
 * fica agrupado embaixo, para que o lançamento do dia a dia caiba em uma tela
 * sem rolagem.
 *
 * O número da CAT só habilita quando a CAT foi emitida, e o mesmo par é
 * conferido no servidor: guardar protocolo de uma comunicação que ninguém
 * emitiu é registrar prova de um ato que não aconteceu.
 */
export function AccidentDialog({ draft: initial, companies, busy, error, onClose, onSubmit }: {
  draft: AccidentDraft;
  companies: SafetyCompanyOption[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (draft: AccidentDraft) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<AccidentDraft>(initial);
  const set = <Field extends keyof AccidentDraft>(field: Field, value: AccidentDraft[Field]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(draft);
  }

  const preview = payloadFromDraft(draft);

  return <div className={styles.drawerOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="accident-dialog-title">
      <form onSubmit={handleSubmit}>
        <header className={styles.drawerHeader}>
          <div>
            <span className={styles.eyebrow}>{draft.id ? "CORRIGIR LANÇAMENTO" : "NOVO LANÇAMENTO"}</span>
            <h2 id="accident-dialog-title">{draft.id ? "Corrigir acidente" : "Registrar acidente"}</h2>
            <p>O período do dashboard é a data do fato, não a data em que o lançamento foi feito.</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>

        <div className={styles.drawerBody}>
          {error && <div role="alert" className={styles.noticeBar} data-tone="danger">
            <AlertTriangle aria-hidden="true" /><span><strong>Não foi possível concluir</strong>{error}</span>
          </div>}

          <div className={styles.formGrid}>
            <label>Empresa
              <select value={draft.companyId} onChange={(event) => set("companyId", event.target.value)} required>
                <option value="">Selecione</option>
                {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
            <label>Data do acidente
              <input type="date" value={draft.occurredOn} onChange={(event) => set("occurredOn", event.target.value)} required />
            </label>
            <label>Tipo
              <select value={draft.accidentType} onChange={(event) => set("accidentType", event.target.value as AccidentDraft["accidentType"])}>
                {accidentTypes.map((type) => <option key={type} value={type}>{accidentTypeLabels[type]}</option>)}
              </select>
            </label>
            <label>Parte do corpo atingida
              <select value={draft.bodyPart} onChange={(event) => set("bodyPart", event.target.value as AccidentDraft["bodyPart"])}>
                {accidentBodyParts.map((part) => <option key={part} value={part}>{accidentBodyPartLabels[part]}</option>)}
              </select>
            </label>
            <label>Setor
              <input value={draft.sector} onChange={(event) => set("sector", event.target.value)}
                placeholder="Operacional, Administrativo…" maxLength={120} />
            </label>
            <label>Turno
              <select value={draft.workShift} onChange={(event) => set("workShift", event.target.value as AccidentDraft["workShift"])}>
                {accidentShifts.map((shift) => <option key={shift} value={shift}>{accidentShiftLabels[shift]}</option>)}
              </select>
            </label>
            <label>Gênero
              <select value={draft.gender} onChange={(event) => set("gender", event.target.value as AccidentDraft["gender"])}>
                {accidentGenders.map((gender) => <option key={gender} value={gender}>{accidentGenderLabels[gender]}</option>)}
              </select>
            </label>
            <label>Dias afastados
              <input type="number" min={0} max={3650} step={1} value={draft.leaveDays}
                onChange={(event) => set("leaveDays", event.target.value)} />
            </label>
            <label>Despesa (R$)
              <input type="number" min={0} step="0.01" value={draft.expenseAmount}
                onChange={(event) => set("expenseAmount", event.target.value)} />
            </label>
          </div>

          <div className={styles.formGrid}>
            <label>Colaborador (opcional)
              <input value={draft.employeeLabel} onChange={(event) => set("employeeLabel", event.target.value)}
                placeholder="Nome ou matrícula" maxLength={160} />
            </label>
            <label className={styles.checkboxField}>
              <input type="checkbox" checked={draft.catIssued}
                onChange={(event) => set("catIssued", event.target.checked)} />
              CAT emitida
            </label>
            <label>Nº da CAT
              <input value={draft.catNumber} onChange={(event) => set("catNumber", event.target.value)}
                disabled={!draft.catIssued} maxLength={60}
                placeholder={draft.catIssued ? "Protocolo" : "Marque “CAT emitida” para informar"} />
            </label>
          </div>

          <label className={styles.formField}>Descrição do acidente (opcional)
            <textarea value={draft.description} onChange={(event) => set("description", event.target.value)}
              maxLength={2000} placeholder="O que aconteceu, onde e o que foi feito depois." />
          </label>

          <p className={styles.formHint}>
            Este lançamento entra no período de {preview.occurredOn ? preview.occurredOn.split("-").reverse().join("/") : "—"}
            {preview.leaveDays > 0 ? ` e soma ${preview.leaveDays} dia(s) de afastamento.` : " e não soma dias de afastamento."}
          </p>
        </div>

        <footer className={styles.drawerFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? "Gravando…" : draft.id ? "Salvar correção" : "Registrar acidente"}
          </button>
        </footer>
      </form>
    </aside>
  </div>;
}
