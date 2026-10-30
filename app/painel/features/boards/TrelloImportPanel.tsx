"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileJson, LoaderCircle, Upload } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { readTrelloExport, TrelloImportError, type SlaBehavior, type TrelloBoardExport, type TrelloImportMapping, type TrelloImportPlan } from "@/lib/trello-import";
import styles from "./trello-import.module.css";

/**
 * Importar quadro do Trello (`lib/trello-import.ts`).
 *
 * O arquivo é lido aqui, no navegador, e só o recorte que o importador usa vai
 * ao servidor — o JSON cru de um quadro grande passa do limite de corpo da
 * função. Nada é gravado até "Importar quadro"; a prévia mostra o mesmo plano
 * que a gravação grava.
 */

type PreviewResponse = {
  board: {
    name: string;
    cards: number;
    comments: number;
    lists: Array<{ id: string; name: string; closed: boolean; cards: number }>;
    labels: Array<{ id: string; name: string; color: string | null; cards: number }>;
    members: Array<{ id: string; name: string }>;
  };
  companies: Array<{ id: string; name: string }>;
  members: Array<{ userId: string; name: string }>;
  suggestions: { members: Record<string, string>; labelCompany: Record<string, string> };
  plan: TrelloImportPlan | null;
  planError: string;
  /** Este quadro do Trello já entrou antes — importar de novo cria outra cópia. */
  alreadyImportedAt: string | null;
  error?: string;
};

const BEHAVIOR_LABEL: Record<SlaBehavior, string> = {
  running: "Em andamento (SLA corre)",
  paused: "Aguardando (SLA pausa)",
  completed: "Concluída (SLA encerra)",
};

/** Palpite pelo nome da lista; quem importa confere e troca. */
function guessBehavior(name: string): SlaBehavior {
  const value = name.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
  if (/conclu|finaliz|encerr|feito|pronto|entregue|done/u.test(value)) return "completed";
  if (/aguard|pendent|espera|bloque|waiting|terceiro/u.test(value)) return "paused";
  return "running";
}

const MAX_FILE_BYTES = 60 * 1024 * 1024;

async function postPreview(board: TrelloBoardExport, mapping?: TrelloImportMapping) {
  const response = await fetch("/api/boards/import/trello", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "preview", board, mapping }),
  });
  const payload = await response.json().catch(() => ({})) as PreviewResponse;
  if (!response.ok) throw new Error(payload.error || "Não foi possível ler o quadro do Trello.");
  return payload;
}

export function TrelloImportPanel({ busy, processTypes, onImport }: {
  busy: boolean;
  processTypes: readonly string[];
  onImport: (body: string) => Promise<WorkspaceSnapshot | null>;
}) {
  const [fileName, setFileName] = useState("");
  const [board, setBoard] = useState<TrelloBoardExport | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<TrelloImportMapping | null>(null);
  const [plan, setPlan] = useState<TrelloImportPlan | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const usedLabels = useMemo(() => preview?.board.labels.filter((label) => label.cards > 0) ?? [], [preview]);

  function reset() {
    setBoard(null); setPreview(null); setMapping(null); setPlan(null); setError(""); setDone("");
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    reset();
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError("Arquivo grande demais. Arquive no Trello os cartões antigos e exporte de novo."); return; }
    setWorking(true);
    try {
      const parsed = readTrelloExport(JSON.parse(await file.text()));
      const response = await postPreview(parsed);
      const listBehavior = Object.fromEntries(response.board.lists.map((list) => [list.id, guessBehavior(list.name)]));
      setBoard(parsed);
      setPreview(response);
      setMapping({
        boardName: response.board.name,
        defaultCompanyId: response.companies[0]?.id ?? "",
        labelCompany: response.suggestions.labelCompany,
        defaultProcessType: "OUTROS",
        labelProcessType: {},
        listBehavior,
        members: response.suggestions.members,
        includeArchived: false,
      });
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "O arquivo não é um JSON válido."
        : cause instanceof TrelloImportError || cause instanceof Error ? cause.message : "Não foi possível ler o arquivo.");
    } finally { setWorking(false); }
  }

  function update(change: Partial<TrelloImportMapping>) {
    setMapping((current) => current ? { ...current, ...change } : current);
    setPlan(null); setDone("");
  }

  function setEntry(key: "labelCompany" | "labelProcessType" | "members", id: string, value: string) {
    if (!mapping) return;
    const next = { ...mapping[key] };
    if (value) next[id] = value; else delete next[id];
    update({ [key]: next });
  }

  async function review() {
    if (!board || !mapping) return;
    setWorking(true); setError("");
    try {
      const response = await postPreview(board, mapping);
      if (response.planError) { setPlan(null); setError(response.planError); return; }
      setPlan(response.plan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível montar a prévia."); }
    finally { setWorking(false); }
  }

  async function commit() {
    if (!board || !mapping || !plan) return;
    const summary = plan.summary;
    const snapshot = await onImport(JSON.stringify({ mode: "commit", board, mapping }));
    if (snapshot) {
      reset();
      setFileName("");
      setDone(`Quadro "${mapping.boardName}" importado: ${summary.cards} demanda(s), ${summary.checklistItems} item(ns) e ${summary.comments} comentário(s).`);
    }
  }

  const disabled = busy || working;

  return <section className={styles.panel} aria-labelledby="trello-import-title">
    <header className={styles.header}>
      <div>
        <h3 id="trello-import-title" className={styles.title}>Importar quadro do Trello</h3>
        <p className={styles.lead}>No Trello: Menu do quadro → Imprimir, exportar e compartilhar → Exportar como JSON. O arquivo é lido aqui; nada é gravado antes de você conferir a prévia.</p>
      </div>
    </header>

    <label className={styles.file}>
      <span>Arquivo JSON do quadro</span>
      <input type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event)} disabled={disabled} />
      <div><FileJson aria-hidden="true" /><strong>{fileName || "Selecionar arquivo exportado do Trello"}</strong>{working && <LoaderCircle className="spin" aria-hidden="true" />}</div>
    </label>

    {error && <p className={styles.error} role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
    {done && <p className={styles.done} role="status"><CheckCircle2 aria-hidden="true" />{done}</p>}

    {preview && mapping && <>
      {preview.alreadyImportedAt && <p className={styles.error} role="alert"><AlertTriangle aria-hidden="true" />Este quadro do Trello já foi importado em {new Date(preview.alreadyImportedAt).toLocaleDateString("pt-BR")}. Importar de novo cria um segundo quadro com as mesmas demandas.</p>}
      <p className={styles.found}>{preview.board.cards} cartão(ões) em {preview.board.lists.length} lista(s), {preview.board.labels.length} etiqueta(s), {preview.board.members.length} membro(s) e {preview.board.comments} comentário(s) no arquivo.</p>

      <div className={styles.grid}>
        <label><span>Nome do quadro no Vinculato</span><input value={mapping.boardName} maxLength={80} onChange={(event) => update({ boardName: event.target.value })} /></label>
        <label><span>Empresa padrão</span>
          <select value={mapping.defaultCompanyId} onChange={(event) => update({ defaultCompanyId: event.target.value })} required>
            {!preview.companies.length && <option value="">Cadastre uma empresa antes</option>}
            {preview.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label><span>Tipo de processo padrão</span>
          <select value={mapping.defaultProcessType} onChange={(event) => update({ defaultProcessType: event.target.value })}>
            {processTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label className={styles.check}><input type="checkbox" checked={mapping.includeArchived} onChange={(event) => update({ includeArchived: event.target.checked })} /><span>Trazer também cartões e listas arquivados (entram arquivados)</span></label>
      </div>

      <h4 className={styles.subtitle}>Listas → colunas</h4>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th scope="col">Lista no Trello</th><th scope="col">Cartões</th><th scope="col">Coluna no Vinculato</th></tr></thead>
        <tbody>{preview.board.lists.filter((list) => mapping.includeArchived || !list.closed).map((list) => <tr key={list.id}>
          <th scope="row">{list.name}{list.closed && <small> · arquivada</small>}</th>
          <td className={styles.num}>{list.cards}</td>
          <td><select aria-label={`SLA da coluna ${list.name}`} value={mapping.listBehavior[list.id] ?? "running"}
            onChange={(event) => update({ listBehavior: { ...mapping.listBehavior, [list.id]: event.target.value as SlaBehavior } })}>
            {(Object.keys(BEHAVIOR_LABEL) as SlaBehavior[]).map((behavior) => <option key={behavior} value={behavior}>{BEHAVIOR_LABEL[behavior]}</option>)}
          </select></td>
        </tr>)}</tbody>
      </table></div>

      {usedLabels.length > 0 && <>
        <h4 className={styles.subtitle}>Etiquetas</h4>
        <p className={styles.hint}>Etiqueta ligada a uma empresa define a empresa da demanda e não vira etiqueta. Etiqueta ligada a um tipo de processo define o processo.</p>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">Etiqueta</th><th scope="col">Cartões</th><th scope="col">Empresa</th><th scope="col">Tipo de processo</th></tr></thead>
          <tbody>{usedLabels.map((label) => <tr key={label.id}>
            <th scope="row">{label.name || `sem nome (${label.color ?? "sem cor"})`}</th>
            <td className={styles.num}>{label.cards}</td>
            <td><select aria-label={`Empresa da etiqueta ${label.name}`} value={mapping.labelCompany[label.id] ?? ""} onChange={(event) => setEntry("labelCompany", label.id, event.target.value)}>
              <option value="">— etiqueta comum —</option>
              {preview.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select></td>
            <td><select aria-label={`Processo da etiqueta ${label.name}`} value={mapping.labelProcessType[label.id] ?? ""} onChange={(event) => setEntry("labelProcessType", label.id, event.target.value)}>
              <option value="">— padrão —</option>
              {processTypes.map((type) => <option key={type}>{type}</option>)}
            </select></td>
          </tr>)}</tbody>
        </table></div>
      </>}

      {preview.board.members.length > 0 && <>
        <h4 className={styles.subtitle}>Membros → responsáveis</h4>
        <p className={styles.hint}>O arquivo do Trello não traz e-mail. Só nomes completos iguais vêm sugeridos; confira cada um.</p>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">Membro no Trello</th><th scope="col">Pessoa no Vinculato</th></tr></thead>
          <tbody>{preview.board.members.map((member) => <tr key={member.id}>
            <th scope="row">{member.name}</th>
            <td><select aria-label={`Pessoa para ${member.name}`} value={mapping.members[member.id] ?? ""} onChange={(event) => setEntry("members", member.id, event.target.value)}>
              <option value="">— não atribuir —</option>
              {preview.members.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
            </select></td>
          </tr>)}</tbody>
        </table></div>
      </>}

      <div className={styles.actions}>
        <button type="button" className="secondary-button" onClick={() => void review()} disabled={disabled || !mapping.defaultCompanyId}>
          {working ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileJson aria-hidden="true" />} Ver prévia
        </button>
        <button type="button" className="primary-button" onClick={() => void commit()} disabled={disabled || !plan}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />} Importar quadro
        </button>
      </div>

      {plan && <div className={styles.plan}>
        <div className={styles.summary}>
          <article><small>Demandas</small><strong>{plan.summary.cards}</strong><span>{plan.summary.archivedCards} arquivada(s){plan.summary.skippedArchived ? ` · ${plan.summary.skippedArchived} fora` : ""}</span></article>
          <article><small>Colunas</small><strong>{plan.lists.length}</strong><span>{plan.lists.map((list) => list.name).join(" → ")}</span></article>
          <article><small>Itens de checklist</small><strong>{plan.summary.checklistItems}</strong><span>{plan.labels.length} etiqueta(s)</span></article>
          <article><small>Comentários</small><strong>{plan.summary.comments}</strong><span>{plan.summary.attachmentsAsLinks} anexo(s) como link</span></article>
        </div>
        {plan.warnings.length > 0 && <ul className={styles.warnings}>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        <p className={styles.hint}>As demandas entram sem disparar automações nem notificações: são histórico, não trabalho novo chegando. Demanda aberta sem responsável recebe quem responde pela empresa na carteira do DP, como na criação manual.</p>
      </div>}
    </>}
  </section>;
}
