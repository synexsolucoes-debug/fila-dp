"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Calculator, CircleDot, Coins, Download, FileText, LoaderCircle, LockKeyhole,
  Plus, RefreshCw, RotateCcw, ShieldCheck, Stethoscope, WalletCards,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { contractorComponentLabels as componentLabels } from "@/lib/payments";
import { PaymentDialog as PaymentDialogView } from "./PaymentDialogs";
import { ContractorPaymentDetail } from "./ContractorPaymentDetail";
import { ContractorDocumentsDialog } from "./ContractorDocumentsDialog";
import { ContractorSectionView, contractorActionsFor } from "./ContractorSections";
import { ContractorEntryDialog, type EntrySubmission } from "./ContractorEntryDialog";
import { AnimatedModal } from "../shared";
import { contractorSection, type ContractorSectionId } from "./contractor-sections";
import {
  normalizeCompany, normalizeContractorOverview, normalizeContractorPaymentDetail,
  normalizePsychologyOverview, requestJson, type Row,
} from "./payments.api";
import type {
  CompanyOption, Contractor, ContractorOverview, ContractorPaymentDetail as ContractorPaymentDetailData,
  EmployeeOption, PaymentDialog, PaymentModule, PsychologyOverview,
} from "./payments.types";
import { ErrorBanner } from "../shared";
import styles from "./payments.module.css";

const moduleConfig: Record<PaymentModule, { title: string; eyebrow: string; description: string; icon: typeof Stethoscope }> = {
  psychology: {
    title: "Pagamento de Psicólogos",
    eyebrow: "CONTROLE FINANCEIRO",
    description: "Quantas consultas válidas cada psicólogo realizou na competência e quanto devemos pagar.",
    icon: Stethoscope,
  },
  contractors: {
    title: "Pagamentos PJ",
    eyebrow: "CONTROLE DE PAGAMENTO",
    description: "Quanto o prestador tem a receber, quanto deve emitir de nota e quanto vai para o meio complementar.",
    icon: WalletCards,
  },
};

/* Um mapa para dois vocabulários: o do fechamento de um prestador e o da
   competência inteira. Faltavam os três estados intermediários da competência
   — `pre_closing`, `processing`, `post_closing` — e o selo do cabeçalho os
   imprimia crus: "Competência processing", em inglês, no meio da tela. */
const statusLabels: Record<string, string> = {
  open: "Aberto", review: "Conferência", approval: "Aprovação", approved: "Aprovado", scheduled: "Programado",
  pre_closing: "Em pré-fechamento", processing: "Em apuração", post_closing: "Em pós-fechamento",
  invoice_pending: "Aguardando nota", ready_to_pay: "Pronto para pagar", paid: "Pago", closed: "Fechado", reopened: "Reaberto",
  pending: "Pendente", not_required: "Não se aplica", received: "Recebida", validated: "Conferida", divergent: "Divergente",
  reconciled: "Conciliado", sent: "Enviado", processed: "Processado", error: "Erro", canceled: "Cancelado",
};
const limitSourceLabels: Record<string, string> = {
  none: "Sem limite configurado", workspace: "Workspace", company: "Empresa", contract: "Contrato", provider: "Prestador",
};
const complementLabels: Record<string, string> = {
  none: "Não configurado", caju_saldo_livre: "Caju Saldo Livre", other_benefit_card: "Outro cartão", manual_transfer: "Transferência",
};

const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
const currentCompetence = () => new Date().toISOString().slice(0, 7);
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const numeric = (form: FormData, name: string) => {
  const raw = field(form, name);
  return raw === "" ? null : Number(raw);
};
const competenceLabel = (value: string) => {
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1, 1));
};

export function PaymentsView({ role, module, section = "contractorPayments", focus }: {
  role: WorkspaceRole;
  module: PaymentModule;
  /** Qual dos oito destinos do PJ desenhar (§74). Ignorado por Psicologia, que
   *  continua sendo um módulo de tela única. */
  section?: ContractorSectionId;
  focus?: { companyId: string; competence: string; closingId: string } | null;
}) {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState(() => focus?.companyId ?? "");
  const [competence, setCompetence] = useState(() => focus?.competence ?? currentCompetence());
  const [psychology, setPsychology] = useState<PsychologyOverview | null>(null);
  const [contractors, setContractors] = useState<ContractorOverview | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [dialog, setDialog] = useState<PaymentDialog>(null);
  /* O lançamento PJ tem janela própria: ela decide sozinha para qual rota vai,
     e o formulário genérico não saberia disso. */
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryError, setEntryError] = useState("");
  const [entryNature, setEntryNature] = useState<"mensal" | "fixo" | "determinado">("mensal");
  /* A empresa emitente do arquivo de avisos. Ela é escolhida na hora e não
     herdada do seletor do topo: é a empresa para quem todos os prestadores vão
     emitir a nota daquele mês, entra no texto de cada mensagem, e confirmar
     qual é antes de gerar evita mandar a nota para o CNPJ errado. */
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeCompany, setNoticeCompany] = useState("");
  const [paymentDetail, setPaymentDetail] = useState<ContractorPaymentDetailData | null>(null);
  const [documentsContractor, setDocumentsContractor] = useState<Pick<Contractor, "id" | "legalName" | "contractReference"> | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const config = moduleConfig[module];
  const permissions = module === "psychology" ? psychology?.permissions : contractors?.permissions;
  const cycle = module === "psychology" ? psychology?.cycle ?? null : contractors?.cycle ?? null;
  const cycles = useMemo(
    () => (module === "psychology" ? psychology?.cycles : contractors?.cycles) ?? [],
    [contractors?.cycles, module, psychology?.cycles],
  );
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
      const params = new URLSearchParams({ module, companyId: selectedCompany, competence: selectedCompetence });
      const payload = await requestJson<Row>(`/api/payments/overview?${params}`);
      if (module === "psychology") setPsychology(normalizePsychologyOverview(payload));
      else setContractors(normalizeContractorOverview(payload));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar o módulo de pagamento.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [module]);

  const loadEmployees = useCallback(async (selectedCompany: string) => {
    if (!selectedCompany || module !== "psychology") return;
    try {
      const params = new URLSearchParams({ companyId: selectedCompany, status: "active", limit: "100" });
      const payload = await requestJson<{ employees?: Row[] }>(`/api/employees?${params}`);
      setEmployees((payload.employees ?? []).map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.full_name ?? row.fullName ?? ""),
        registrationNumber: String(row.registration_number ?? row.registrationNumber ?? ""),
      })));
    } catch {
      setEmployees([]);
    }
  }, [module]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void loadCompanies()); return () => window.cancelAnimationFrame(frame); }, [loadCompanies]);
  useEffect(() => {
    if (!companyId) return;
    const frame = window.requestAnimationFrame(() => { void loadOverview(companyId, competence); void loadEmployees(companyId); });
    return () => window.cancelAnimationFrame(frame);
  }, [companyId, competence, loadEmployees, loadOverview]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 3800); return () => window.clearTimeout(timer); }, [toast]);

  const competenceOptions = useMemo(() => {
    const known = cycles.map((item) => item.competence);
    return known.includes(competence) ? known : [competence, ...known];
  }, [competence, cycles]);

  async function mutate<T>(url: string, init: RequestInit, success: string): Promise<T | null> {
    setBusy(true);
    try {
      const result = await requestJson<T>(url, init);
      setError("");
      setToast(success);
      await loadOverview(companyId, competence, true);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Envia o lançamento PJ.
   *
   * A natureza decide a rota, e não um parâmetro dentro de uma rota só:
   * mensal é um componente da competência, fixo e determinado são o mesmo
   * lançamento recorrente com e sem competência final. São tabelas diferentes
   * porque são coisas diferentes — uma pertence a um mês, a outra ao contrato.
   */
  async function submitEntry(entry: EntrySubmission) {
    setEntryError("");
    const lote = entry.entries.length > 1;
    const comum = {
      componentType: entry.componentType, description: entry.description,
      settlementTarget: entry.settlementTarget, entries: entry.entries,
    };
    const alvo = entry.nature === "mensal"
      ? { url: "/api/payments/contractors/components", body: { ...comum, competenceId: cycle?.id } }
      : {
        url: "/api/payments/contractors/fixed-items",
        body: { ...comum, effectiveFrom: competence, effectiveTo: entry.nature === "determinado" ? entry.effectiveTo : "" },
      };
    setBusy(true);
    try {
      await requestJson(alvo.url, { method: "POST", body: JSON.stringify(alvo.body) });
      setEntryOpen(false);
      setToast(lote ? `${entry.entries.length} lançamentos registrados.` : "Lançamento registrado.");
      await loadOverview(companyId, competence, true);
    } catch (cause) {
      // O erro fica na janela, não no topo da tela: quem acabou de preencher
      // trinta valores não pode perder o formulário para ler o motivo.
      setEntryError(cause instanceof Error ? cause.message : "Não foi possível registrar o lançamento.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Apura a competência inteira, ou um prestador só quando o nome vem junto.
   *
   * O resultado deixou de ser um "pronto" fixo. A apuração pode terminar com
   * prestadores para trás — contrato encerrado, competência já apurada por
   * outra empresa, um valor que o banco recusou — e antes esses ficavam
   * invisíveis: a resposta trazia o motivo de cada um e a tela dizia
   * "Apuração atualizada" do mesmo jeito. Quem conferia só descobria a falta
   * ao procurar o prestador na tabela e não achar.
   */
  async function recalculate(providerId?: string) {
    const path = module === "psychology" ? "/api/payments/psychology/closings" : "/api/payments/contractors/closings";
    const body: Record<string, unknown> = { companyId, competenceId: cycle?.id };
    if (providerId) body[module === "psychology" ? "psychologistId" : "contractorId"] = providerId;
    const result = await mutate<{
      closings?: Row[]; apuradosCount?: number; blockedCount?: number; removedCount?: number;
    }>(path, { method: "POST", body: JSON.stringify(body) }, "Apuração atualizada.");
    if (!result || module === "psychology") return;

    const pendentes = (result.closings ?? []).filter((row) => !row.removed && !row.id && row.blockedReason);
    const apurados = Number(result.apuradosCount ?? 0);
    if (pendentes.length === 0) {
      setToast(providerId
        ? "Prestador apurado."
        : `Competência apurada: ${apurados} prestador(es).`);
      return;
    }
    /* O motivo do primeiro fica no aviso, e não só a contagem: com um
       prestador para trás, "1 ficou de fora" manda a pessoa caçar qual. */
    const primeiro = pendentes[0];
    const restantes = pendentes.length - 1;
    setToast(`${apurados} apurado(s). ${String(primeiro.contractorName ?? "Um prestador")}: ${String(primeiro.blockedReason)}${restantes > 0 ? ` (e mais ${restantes})` : ""}.`);
  }

  const openContractorDetail = useCallback(async (closingId: string) => {
    setDetailLoadingId(closingId);
    try {
      const payload = await requestJson<Row>(`/api/payments/contractors/closings/${closingId}`);
      setPaymentDetail(normalizeContractorPaymentDetail(payload));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o detalhamento do prestador.");
    } finally {
      setDetailLoadingId("");
    }
  }, []);

  useEffect(() => {
    if (module !== "contractors" || !focus) return;
    const frame = window.requestAnimationFrame(() => void openContractorDetail(focus.closingId));
    return () => window.cancelAnimationFrame(frame);
  }, [focus, module, openContractorDetail]);

  async function updateContractorComponent(
    componentId: string,
    closingId: string,
    input: { amount: string; description: string; settlementTarget: string },
  ) {
    const result = await mutate<{ component: Row }>(`/api/payments/contractors/components/${componentId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }, "Lançamento atualizado e pagamento reapurado.");
    if (!result) return false;
    await openContractorDetail(closingId);
    return true;
  }

  async function cancelContractorComponent(componentId: string, closingId: string, reason: string) {
    const result = await mutate<{ component: Row }>(`/api/payments/contractors/components/${componentId}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }, "Lançamento cancelado e pagamento reapurado.");
    if (!result) return false;
    await openContractorDetail(closingId);
    return true;
  }

  async function deleteContractorClosing(closingId: string, reason: string) {
    const result = await mutate<{ closing: { id: string; excluded: boolean } }>(
      `/api/payments/contractors/closings/${closingId}`,
      { method: "DELETE", body: JSON.stringify({ reason }) },
      "Pagamento excluído da competência.",
    );
    if (!result) return false;
    setPaymentDetail(null);
    return true;
  }

  async function transition(closingId: string, status: string, reason?: string) {
    const path = module === "psychology"
      ? `/api/payments/psychology/closings/${closingId}/transition`
      : `/api/payments/contractors/closings/${closingId}/transition`;
    await mutate(path, { method: "POST", body: JSON.stringify({ status, reason }) }, `Fechamento atualizado para ${statusLabels[status] ?? status}.`);
  }

  async function approveContractors(closingIds: string[]) {
    return Boolean(await mutate<{ approvedCount: number }>("/api/payments/contractors/closings/approve", {
      method: "POST",
      body: JSON.stringify({ closingIds }),
    }, `${closingIds.length === 1 ? "Prestador aprovado" : `${closingIds.length} prestadores aprovados`}.`));
  }

  async function issueContractorStatements() {
    if (!cycle) return;
    setBusy(true);
    try {
      const response = await fetch("/api/payments/contractors/statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, competenceId: cycle.id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(payload.message || payload.error || "Não foi possível emitir os recibos de pagamento.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `recibos-pj-${competence}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError("");
      setToast("Recibos emitidos. Os pagamentos abertos entraram em conferência.");
      await loadOverview(companyId, competence, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível emitir os recibos de pagamento.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadContractorReceipt(closingId: string, receiptCompanyId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/payments/contractors/closings/${closingId}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: receiptCompanyId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(payload.message || payload.error || "Não foi possível gerar o recibo de pagamento.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `recibo-pagamento-pj-${paymentDetail?.closing.competence ?? competence}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError("");
      setToast(`Recibo de ${paymentDetail?.provider.legalName ?? "prestador"} gerado.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar o recibo de pagamento.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDialog(active: NonNullable<PaymentDialog>, form: FormData) {
    const payout = {
      pixKey: field(form, "pixKey"), bankCode: field(form, "bankCode"),
      bankBranch: field(form, "bankBranch"), bankAccount: field(form, "bankAccount"),
    };
    const hasPayout = Object.values(payout).some(Boolean);

    if (active.kind === "psychologist") {
      const result = await mutate("/api/payments/psychologists", {
        method: "POST",
        body: JSON.stringify({
          legalName: field(form, "legalName"), taxId: field(form, "taxId"), email: field(form, "email"), phone: field(form, "phone"),
          defaultSessionAmount: numeric(form, "defaultSessionAmount") ?? 0,
          administrativeNotes: field(form, "administrativeNotes"),
          ...(hasPayout ? { payout } : {}),
        }),
      }, "Psicólogo cadastrado.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "session") {
      const result = await mutate("/api/payments/psychology/sessions", {
        method: "POST",
        body: JSON.stringify({
          companyId, competenceId: cycle?.id, psychologistId: field(form, "psychologistId"), employeeId: field(form, "employeeId"),
          sessionDate: field(form, "sessionDate"), quantity: numeric(form, "quantity") ?? 1,
          unitAmount: numeric(form, "unitAmount"), administrativeNote: field(form, "administrativeNote"),
        }),
      }, "Consulta lançada para pagamento.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "adjustment") {
      const result = await mutate(`/api/payments/psychology/closings/${active.closing.id}/adjustments`, {
        method: "POST",
        body: JSON.stringify({ kind: field(form, "kind"), amount: numeric(form, "amount") ?? 0, reason: field(form, "reason") }),
      }, "Ajuste registrado.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "psychology-payment") {
      const result = await mutate(`/api/payments/psychology/closings/${active.closing.id}/payment`, {
        method: "POST",
        body: JSON.stringify({
          amount: numeric(form, "amount"), method: field(form, "method"), status: field(form, "status"),
          scheduledDate: field(form, "scheduledDate"), paidDate: field(form, "paidDate"),
          invoiceNumber: field(form, "invoiceNumber"), invoiceAmount: numeric(form, "invoiceAmount") ?? 0,
          invoiceIssueDate: field(form, "invoiceIssueDate"), receiptReference: field(form, "receiptReference"),
        }),
      }, "Pagamento registrado.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "contractor") {
      const result = await mutate("/api/payments/contractors", {
        method: "POST",
        body: JSON.stringify({
          companyId, legalName: field(form, "legalName"), taxId: field(form, "taxId"),
          contractReference: field(form, "contractReference"), roleTitle: field(form, "roleTitle"),
          contractStart: field(form, "contractStart"), contractEnd: field(form, "contractEnd"),
          baseAmount: numeric(form, "baseAmount") ?? 0, invoiceLimitOverride: numeric(form, "invoiceLimitOverride"),
          complementMethod: field(form, "complementMethod"), complementExternalId: field(form, "complementExternalId"),
          ...(hasPayout ? { payout } : {}),
        }),
      }, "Prestador PJ cadastrado.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "component") {
      const result = await mutate("/api/payments/contractors/components", {
        method: "POST",
        body: JSON.stringify({
          contractorId: field(form, "contractorId"), competenceId: cycle?.id, componentType: field(form, "componentType"),
          amount: numeric(form, "amount") ?? 0, description: field(form, "description"), documentReference: field(form, "documentReference"),
        }),
      }, "Componente lançado na competência.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "fixed-item") {
      const providerId = field(form, "providerId");
      const result = await mutate("/api/payments/contractors/fixed-items", {
        method: "POST",
        body: JSON.stringify({
          providerId, componentType: field(form, "componentType"), description: field(form, "description"),
          amount: numeric(form, "amount") ?? 0, effectiveFrom: field(form, "effectiveFrom"),
          effectiveTo: field(form, "effectiveTo") || null, note: field(form, "note"),
        }),
      }, "Lançamento fixo cadastrado.");
      if (result) {
        setDialog(null);
        await recalculate(providerId);
      }
      return;
    }

    if (active.kind === "invoice") {
      const result = await mutate(`/api/payments/contractors/closings/${active.closing.id}/invoice`, {
        method: "POST",
        body: form,
      }, "Nota fiscal registrada.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "complement") {
      const result = await mutate(`/api/payments/contractors/closings/${active.closing.id}/caju`, {
        method: "POST",
        body: JSON.stringify({
          status: field(form, "status"), batchReference: field(form, "batchReference"),
          externalId: field(form, "externalId"), paidAmount: numeric(form, "paidAmount"), error: field(form, "error"),
        }),
      }, "Complemento atualizado.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "limit") {
      const result = await mutate("/api/payments/contractors/limits", {
        method: "POST",
        body: JSON.stringify({
          scope: field(form, "scope"), companyId, providerId: field(form, "providerId"),
          contractReference: field(form, "contractReference"), amount: numeric(form, "amount") ?? 0,
          effectiveFrom: field(form, "effectiveFrom"), note: field(form, "note"),
        }),
      }, "Política de limite publicada.");
      if (result) setDialog(null);
      return;
    }

    if (active.kind === "reopen") {
      await transition(active.closingId, "reopened", field(form, "reason"));
      setDialog(null);
    }
  }

  /** O arquivo de avisos usa a empresa escolhida na janela, não a do topo — e
   *  ali ela é a emitente, não um recorte: saem todos os prestadores do grupo. */
  const noticeUrl = (company: string) => {
    const params = new URLSearchParams({ report: "contractor-invoice-notice", competence, format: "txt", companyId: company });
    return `/api/payments/reports?${params}`;
  };

  const reportUrl = (report: string, format: "csv" | "pdf" = "csv") => {
    const params = new URLSearchParams({ report, competence, format });
    if (companyId) params.set("companyId", companyId);
    return `/api/payments/reports?${params}`;
  };

  if (role === "guest") {
    return <section className={styles.workspace} data-module={module}><p className={styles.noteLine}>Seu perfil não tem acesso ao controle de pagamentos.</p></section>;
  }

  /* O cabeçalho e as ações passam a falar do destino, não do módulo inteiro
     (§55, §70). Numa tela de limites de nota, "Crédito/desconto" não é ruído
     inocente: é uma ação sem o que fazer ali competindo com a que tem. */
  const destination = module === "contractors" ? contractorSection(section) : undefined;
  const actions = module === "contractors"
    ? contractorActionsFor(section)
    : { provider: false, limit: false, component: false, recalculate: true };
  const headline = destination
    ? { eyebrow: "PAGAMENTO PJ", title: destination.label, description: destination.description }
    : config;
  const Icon = destination?.icon ?? config.icon;

  return (
    <section className={styles.workspace} data-module={module} aria-busy={loading}>
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
          {canManage && actions.recalculate && (
            <button className={styles.secondaryButton} type="button" onClick={() => void recalculate()} disabled={busy || !cycle}>
              <Calculator aria-hidden="true" /> Apurar competência
            </button>
          )}
          {canManage && module === "psychology" && (
            <>
              <button className={styles.secondaryButton} type="button" onClick={() => setDialog({ kind: "psychologist" })}>
                <Plus aria-hidden="true" /> Psicólogo
              </button>
              <button className={styles.primaryButton} type="button" onClick={() => setDialog({ kind: "session", psychologists: psychology?.psychologists ?? [], employees })}>
                <Plus aria-hidden="true" /> Lançar consulta
              </button>
            </>
          )}
          {canManage && module === "contractors" && (
            <>
              {permissions?.manageLimits && actions.limit && (
                <button className={styles.secondaryButton} type="button" onClick={() => setDialog({ kind: "limit", contractors: contractors?.contractors ?? [] })}>
                  <ShieldCheck aria-hidden="true" /> Limite da nota
                </button>
              )}
              {actions.provider && (
                <button className={styles.primaryButton} type="button" onClick={() => setDialog({ kind: "contractor" })}>
                  <Plus aria-hidden="true" /> Prestador
                </button>
              )}
              {actions.component && (
                <button className={styles.primaryButton} type="button" onClick={() => { setEntryError(""); setEntryNature("mensal"); setEntryOpen(true); }}>
                  <Plus aria-hidden="true" /> Novo lançamento
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <div className={styles.moduleHeadline}>
        <span className={styles.moduleIcon} aria-hidden="true"><Icon /></span>
        <div>
          <span className={styles.eyebrow}>{headline.eyebrow}</span>
          <h2>{headline.title}</h2>
          <p>{headline.description}</p>
        </div>
        {cycle && (
          <span className={styles.cycleBadge} data-locked={cycle.status === "closed" ? "true" : "false"}>
            {cycle.status === "closed" ? <LockKeyhole aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
            Competência {statusLabels[cycle.status] ?? cycle.status}
          </span>
        )}
      </div>

      {module === "psychology" && psychology?.privacyBoundary && (
        <p className={styles.privacyNotice}><ShieldCheck aria-hidden="true" /><span>{psychology.privacyBoundary}</span></p>
      )}

      {error && <ErrorBanner message={error} />}
      {loading && <p className={styles.loadingLine}><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando dados da competência…</p>}

      {!loading && !companies.length && (
        <p className={styles.noteLine}>Cadastre uma empresa para controlar pagamentos.</p>
      )}

      {!loading && companies.length > 0 && !cycle && (
        <p className={styles.noteLine}>
          A competência {competenceLabel(competence)} ainda não foi aberta para esta empresa. Abra-a em Operação DP para lançar pagamentos.
        </p>
      )}

      {!loading && module === "contractors" && contractors && cycle && (
        <ContractorSectionView
          section={section}
          overview={contractors}
          cycle={cycle}
          companyId={companyId}
          competence={competence}
          competenceLabel={competenceLabel}
          money={money}
          statusLabels={statusLabels}
          limitSourceLabels={limitSourceLabels}
          complementLabels={complementLabels}
          componentLabels={componentLabels}
          permissions={permissions}
          busy={busy}
          detailLoadingId={detailLoadingId}
          reportUrl={reportUrl}
          onDialog={setDialog}
          onOpenDetail={(closingId) => void openContractorDetail(closingId)}
          onRecalculate={(providerId) => void recalculate(providerId)}
          onTransition={(closingId, status) => void transition(closingId, status)}
          onCompetence={setCompetence}
          onIssueStatements={() => void issueContractorStatements()}
          onApproveClosings={(closingIds) => void approveContractors(closingIds)}
          onOpenDocuments={(providerId) => {
            const provider = contractors.contractors.find((item) => item.id === providerId);
            if (provider) setDocumentsContractor(provider);
          }}
          onNewEntry={(nature) => { setEntryError(""); setEntryNature(nature); setEntryOpen(true); }}
          onInvoiceNotice={() => { setNoticeCompany(companyId); setNoticeOpen(true); }}
        />
      )}

      {!loading && module === "psychology" && psychology && cycle && (
        <>
          {psychology.unassignedSessions.length > 0 && (
            <p className={styles.warningState}>
              <Coins aria-hidden="true" />
              Há consultas lançadas sem apuração nesta competência. Use <b>Apurar competência</b> para gerar os fechamentos.
            </p>
          )}

          {psychology.closings.length === 0 ? (
            <p className={styles.noteLine}>
              Nenhum fechamento apurado. Lance as consultas realizadas e use <b>Apurar competência</b> para saber quanto pagar a cada psicólogo.
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.tableCaption}>Pagamento de psicólogos em {competenceLabel(competence)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Psicólogo</th>
                    <th scope="col">Consultas</th>
                    <th scope="col">Colaboradores</th>
                    <th scope="col">Bruto</th>
                    <th scope="col">Ajustes</th>
                    <th scope="col">A pagar</th>
                    <th scope="col">Pagamento</th>
                    <th scope="col">Nota</th>
                    <th scope="col">Fechamento</th>
                    <th scope="col">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {psychology.closings.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.psychologistName}<small>{row.calcVersion}</small></th>
                      <td>{row.sessionsCount}</td>
                      <td>{row.employeesCount}</td>
                      <td>{money(row.grossAmount)}</td>
                      <td className={row.adjustmentsAmount < 0 ? styles.negative : undefined}>{money(row.adjustmentsAmount)}</td>
                      <td><strong>{money(row.netAmount)}</strong></td>
                      <td>
                        <span className={styles.badge} data-tone={row.paymentStatus || "pending"}>{statusLabels[row.paymentStatus] ?? "Sem registro"}</span>
                        {row.paymentAmount > 0 && <small>{money(row.paymentAmount)}</small>}
                      </td>
                      <td><span className={styles.badge} data-tone={row.invoiceStatus || "not_required"}>{statusLabels[row.invoiceStatus] ?? "—"}</span></td>
                      <td><span className={styles.badge} data-tone={row.status}>{statusLabels[row.status] ?? row.status}</span></td>
                      <td className={styles.rowActions}>
                        {permissions?.manage && row.status !== "closed" && row.status !== "paid" && (
                          <>
                            <button type="button" onClick={() => setDialog({ kind: "adjustment", closing: row })} disabled={busy}>Ajustar</button>
                            <button type="button" onClick={() => setDialog({ kind: "psychology-payment", closing: row })} disabled={busy}>Pagamento</button>
                            <button type="button" onClick={() => void recalculate(row.providerId)} disabled={busy}>Reapurar</button>
                            <button type="button" onClick={() => void transition(row.id, nextPsychologyStatus(row.status))} disabled={busy}>
                              {statusLabels[nextPsychologyStatus(row.status)] ?? "Avançar"} <ArrowRight aria-hidden="true" />
                            </button>
                          </>
                        )}
                        {permissions?.close && row.status === "paid" && (
                          <button type="button" onClick={() => void transition(row.id, "closed")} disabled={busy}>Fechar</button>
                        )}
                        {permissions?.reopen && (row.status === "closed" || row.status === "paid") && (
                          <button type="button" onClick={() => setDialog({ kind: "reopen", closingId: row.id, module })} disabled={busy}>
                            <RotateCcw aria-hidden="true" /> Reabrir
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <footer className={styles.reportBar}>
            <a className={styles.secondaryButton} href={reportUrl("psychology-by-psychologist")}><Download aria-hidden="true" /> Pagamentos por psicólogo (CSV)</a>
            <a className={styles.secondaryButton} href={reportUrl("psychology-by-employee")}><FileText aria-hidden="true" /> Consultas por colaborador (CSV)</a>
          </footer>
        </>
      )}

      {toast && <p className={styles.toast} role="status">{toast}</p>}
      {paymentDetail ? (
        <ContractorPaymentDetail
          detail={paymentDetail}
          busy={busy}
          onClose={() => setPaymentDetail(null)}
          onUpdateComponent={(componentId, input) => updateContractorComponent(componentId, paymentDetail.closing.id, input)}
          onCancelComponent={(componentId, reason) => cancelContractorComponent(componentId, paymentDetail.closing.id, reason)}
          onDeleteClosing={(reason) => deleteContractorClosing(paymentDetail.closing.id, reason)}
          receiptCompanies={companies}
          defaultReceiptCompanyId={companyId}
          onDownloadReceipt={(receiptCompanyId) => downloadContractorReceipt(paymentDetail.closing.id, receiptCompanyId)}
        />
      ) : null}
      {dialog && <PaymentDialogView dialog={dialog} busy={busy} onClose={() => setDialog(null)} onSubmit={submitDialog} />}
      {documentsContractor ? (
        <ContractorDocumentsDialog
          providerId={documentsContractor.id}
          providerName={documentsContractor.legalName}
          contractReference={documentsContractor.contractReference}
          onClose={() => setDocumentsContractor(null)}
        />
      ) : null}
      {module === "contractors" && (
        <AnimatedModal open={noticeOpen} onClose={() => setNoticeOpen(false)}
          label="Gerar avisos de nota fiscal" width={460} stickyFooter className={styles.paymentTokens}>
          <div className={styles.modalForm}>
            <header className={styles.dialogHeader}>
              <div>
                <span className={styles.eyebrow}>PAGAMENTO PJ</span>
                <h2>Gerar avisos de NF</h2>
                <p className={styles.dialogSummary}>
                  Sai um arquivo de texto com uma mensagem por prestador do grupo, com o valor que cada um tem
                  a emitir em {competenceLabel(competence)}. As mensagens ficam na mesma ordem da tabela.
                </p>
              </div>
            </header>
            <div className={styles.dialogBody}>
              <label>Empresa emitente
                <select value={noticeCompany} onChange={(event) => setNoticeCompany(event.target.value)}>
                  <option value="" disabled>Selecione</option>
                  {companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <p className={styles.noteLine}>
                É para esta empresa que todos vão emitir a nota. O nome dela entra em cada mensagem.
              </p>
            </div>
            <footer className={styles.dialogFooter}>
              <button type="button" className={styles.secondaryButton} onClick={() => setNoticeOpen(false)}>Cancelar</button>
              <a className={styles.primaryButton} aria-disabled={!noticeCompany}
                href={noticeCompany ? noticeUrl(noticeCompany) : undefined}
                onClick={() => { if (noticeCompany) setNoticeOpen(false); }}>
                Gerar arquivo
              </a>
            </footer>
          </div>
        </AnimatedModal>
      )}
      {module === "contractors" && (
        <ContractorEntryDialog
          open={entryOpen}
          contractors={contractors?.contractors ?? []}
          competence={competence}
          competenceLabel={competenceLabel(competence)}
          initialNature={entryNature}
          busy={busy}
          error={entryError}
          onClose={() => setEntryOpen(false)}
          onSubmit={(entry) => void submitEntry(entry)}
        />
      )}
    </section>
  );
}

function nextPsychologyStatus(status: string) {
  const flow: Record<string, string> = {
    open: "review", review: "approval", approval: "scheduled", scheduled: "paid", reopened: "review",
  };
  return flow[status] ?? "review";
}
