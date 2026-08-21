"use client";

import { FormEvent, useState } from "react";
import { CheckCircle2, FileText, LoaderCircle, Upload, X } from "lucide-react";
import type { Company, WorkspaceSnapshot } from "@/lib/fila-dp-types";

type Preview = {
  model: string;
  modelLabel: string;
  totalPages: number;
  companyName: string;
  taxId: string;
  period: string;
  headcount: number;
  admissions: number;
  terminations: number;
  leavesCount: number;
  grossPayroll: number;
  totalDeductions: number;
  netPay: number;
  employerCharges: number;
  payrollCost: number;
  warnings: string[];
};

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const periodLabel = (value: string) => value ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : "—";

async function previewFile(file: File, companyId: string) {
  const body = new FormData();
  body.set("file", file); body.set("companyId", companyId); body.set("action", "preview");
  const response = await fetch("/api/hr-metrics/import/pdf", { method: "POST", body });
  const payload = await response.json().catch(() => ({})) as { preview?: Preview; error?: string; targetCompanyName?: string };
  if (!response.ok || !payload.preview) throw new Error(payload.error || "Não foi possível analisar o PDF.");
  return { preview: payload.preview, targetCompanyName: payload.targetCompanyName ?? "" };
}

export function PayrollImportDialog({ companies, importing, onClose, onImport, onImported }: {
  companies: Company[];
  importing: boolean;
  onClose: () => void;
  onImport: (body: FormData) => Promise<WorkspaceSnapshot | null>;
  onImported: (period: string) => void;
}) {
  const [companyId, setCompanyId] = useState(companies.find((company) => company.status === "active")?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ preview: Preview; targetCompanyName: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!file || !companyId) return;
    setAnalyzing(true); setError("");
    try { setResult(await previewFile(file, companyId)); }
    catch (cause) { setResult(null); setError(cause instanceof Error ? cause.message : "PDF inválido."); }
    finally { setAnalyzing(false); }
  }

  async function importData() {
    if (!file || !companyId || !result) return;
    const body = new FormData();
    body.set("file", file); body.set("companyId", companyId); body.set("action", "import");
    const snapshot = await onImport(body);
    if (snapshot) onImported(result.preview.period);
  }

  return <div className="payroll-import-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !analyzing && !importing) onClose(); }}>
    <section className="payroll-import-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-import-title">
      <header><div><span>LEITURA AUTOMÁTICA</span><h2 id="payroll-import-title">Importar extrato da folha</h2><p>O sistema identifica o modelo, confere o CNPJ e mostra os valores antes de atualizar os painéis.</p></div><button type="button" onClick={onClose} disabled={analyzing || importing} aria-label="Fechar"><X /></button></header>
      <form className="payroll-import-setup" onSubmit={analyze}>
        <label><span>Empresa de destino</span><select value={companyId} onChange={(event) => { setCompanyId(event.target.value); setResult(null); }} required>{companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label className="payroll-file-picker"><span>Extrato analítico em PDF</span><input type="file" accept="application/pdf,.pdf" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); setError(""); }} required /><div><FileText /><span><strong>{file?.name || "Selecionar PDF da folha"}</strong><small>{file ? `${(file.size / 1024).toFixed(0)} KB` : "Resumo Pessoal+ ou Extrato Mensal Domínio"}</small></span><Upload /></div></label>
        <button className="secondary-button" disabled={!file || !companyId || analyzing || importing}>{analyzing ? <LoaderCircle className="spin" /> : <FileText />} Analisar extrato</button>
        {error && <p className="payroll-import-error">{error}</p>}
      </form>
      {result && <div className="payroll-import-preview">
        <div className="payroll-import-identification"><CheckCircle2 /><div><strong>{result.preview.modelLabel}</strong><span>{result.preview.companyName} · CNPJ {result.preview.taxId} · competência {periodLabel(result.preview.period)} · {result.preview.totalPages} página(s)</span></div><b>{result.targetCompanyName}</b></div>
        <div className="payroll-import-kpis"><article><span>Pessoas identificadas</span><strong>{result.preview.headcount}</strong><small>{result.preview.admissions} admissões · {result.preview.terminations} desligamentos</small></article><article><span>Proventos brutos</span><strong>{money(result.preview.grossPayroll)}</strong><small>Valor oficial do documento</small></article><article><span>Descontos</span><strong>{money(result.preview.totalDeductions)}</strong><small>Líquido {money(result.preview.netPay)}</small></article><article><span>Custo monitorado</span><strong>{money(result.preview.payrollCost)}</strong><small>Inclui {money(result.preview.employerCharges)} de encargos encontrados</small></article></div>
        <div className="payroll-import-notice"><strong>Pronto para atualizar o painel</strong><span>Os valores são copiados do PDF; o Vinculato não recalcula impostos ou encargos.</span>{result.preview.warnings.map((warning) => <small key={warning}>{warning}</small>)}</div>
      </div>}
      <footer><span>{result ? "A importação substitui os indicadores desta empresa e competência." : "Nenhum dado é gravado durante a análise."}</span><button type="button" className="secondary-button" onClick={onClose} disabled={analyzing || importing}>Cancelar</button><button type="button" className="primary-button" onClick={() => void importData()} disabled={!result || analyzing || importing}>{importing ? <LoaderCircle className="spin" /> : <Upload />} Atualizar painéis</button></footer>
    </section>
  </div>;
}
