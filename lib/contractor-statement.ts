import type { StatementDocument, StatementProvider } from "./contractor-statement-pdf.ts";

/**
 * Da consulta plana para o documento.
 *
 * O extrato sai do banco como uma lista de rubricas, uma linha por lançamento,
 * repetindo os dados do prestador em cada uma — que é a forma certa para o CSV
 * e a errada para o PDF, onde o prestador é um bloco com cabeçalho, rubricas e
 * fecho. Este módulo faz a travessia.
 *
 * Ele fica separado do desenho de propósito: agrupar e somar é o que pode estar
 * errado de um jeito que importa, e testar isso não deveria exigir abrir um
 * PDF. O desenho recebe números prontos.
 */

const complementLabels: Record<string, string> = {
  none: "sem complemento configurado",
  caju_saldo_livre: "Caju Saldo Livre",
  other_benefit_card: "outro cartão de benefício",
  manual_transfer: "transferência",
};

const limitSourceLabels: Record<string, string> = {
  none: "Sem limite",
  workspace: "Grupo",
  company: "Empresa",
  contract: "Contrato",
  provider: "Prestador",
};

const invoiceStatusLabels: Record<string, string> = {
  pending: "Pendente", received: "Recebida", validated: "Conferida",
  divergent: "Divergente", not_required: "Não se aplica", canceled: "Cancelada",
};

const closingStatusLabels: Record<string, string> = {
  open: "Aberto", review: "Conferência", approval: "Aprovação", approved: "Aprovado",
  invoice_pending: "Aguardando nota", ready_to_pay: "Pronto para pagar",
  paid: "Pago", closed: "Fechado", reopened: "Reaberto",
};

const originLabels: Record<string, string> = {
  manual: "LANÇADO",
  fixed_item: "FIXO",
  import: "IMPORTADO",
  integration: "INTEGRAÇÃO",
  contrato: "CONTRATO",
};

const number = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/** 11.222.333/0001-81 a partir dos dígitos; devolve o original quando não é CNPJ. */
export function formatTaxId(value: string) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5");
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/u, "$1.$2.$3-$4");
  return value || "Não informado";
}

/** "agosto de 2026" — o mesmo rótulo que a tela usa. */
export function competenceLabel(competence: string) {
  const [year, month] = competence.split("-");
  if (!year || !month) return competence;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" })
    .format(new Date(Number(year), Number(month) - 1, 1));
}

/** "01/08/2026 a 31/08/2026" — o período que a competência cobre. */
export function competencePeriod(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  if (!year || !month) return competence;
  const last = new Date(year, month, 0).getDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(1)}/${pad(month)}/${year} a ${pad(last)}/${pad(month)}/${year}`;
}

export function buildStatement(
  rows: ReadonlyArray<Record<string, unknown>>,
  context: { competence: string; empresa: string; cnpjEmpresa: string; emitidoPor: string },
): StatementDocument {
  const porPrestador = new Map<string, StatementProvider>();

  for (const row of rows) {
    /* A chave é o par código + CNPJ, não o nome: dois prestadores com a mesma
       razão social em empresas diferentes do grupo existem, e agrupar pelo nome
       somaria a apuração dos dois num bloco só. */
    const chave = `${text(row.codigo)}|${text(row.cnpj)}`;
    let prestador = porPrestador.get(chave);
    if (!prestador) {
      prestador = {
        codigo: text(row.codigo),
        nome: text(row.prestador),
        cnpj: formatTaxId(text(row.cnpj)),
        contrato: text(row.contrato),
        funcao: text(row.funcao),
        valorContrato: number(row.valor_contrato),
        linhas: [],
        totalProventos: 0,
        totalDescontos: 0,
        totalApurado: number(row.total_apurado),
        valorNotaFiscal: number(row.nf_esperada),
        complemento: number(row.complemento),
        formaComplemento: complementLabels[text(row.forma_complemento)] ?? text(row.forma_complemento),
        limiteNotaFiscal: row.limite_nf === null || row.limite_nf === undefined ? null : number(row.limite_nf),
        origemLimite: limitSourceLabels[text(row.origem_limite)] ?? text(row.origem_limite),
        statusNotaFiscal: invoiceStatusLabels[text(row.status_nf)] ?? text(row.status_nf),
        statusFechamento: closingStatusLabels[text(row.status_fechamento)] ?? text(row.status_fechamento),
      };
      porPrestador.set(chave, prestador);
    }

    const cancelado = text(row.situacao) === "canceled";
    // Lançamento cancelado permanece na origem e na auditoria, mas não
    // pertence ao documento entregue para conferência.
    if (cancelado) continue;
    const valor = number(row.valor);
    const provento = text(row.tipo) === "PROVENTO";
    const quantidade = number(row.quantidade);
    prestador.linhas.push({
      // A origem do lançamento, em português. `fixed_item` é identificador de
      // coluna: numa folha entregue para conferência ele é ruído que faz o
      // leitor parar para decifrar.
      rubrica: text(row.rubrica) === "Valor contratual" ? "CONTRATO" : originLabels[text(row.origem)] ?? text(row.origem).toUpperCase(),
      descricao: text(row.rubrica),
      // Quantidade só aparece quando diz alguma coisa: "1,0000" em toda linha
      // é ruído que empurra o olho para longe do valor.
      referencia: quantidade && quantidade !== 1 ? quantidade.toFixed(2).replace(".", ",") : "",
      proventos: provento ? valor : 0,
      descontos: provento ? 0 : valor,
      cancelado,
    });

    if (provento) prestador.totalProventos += valor;
    else prestador.totalDescontos += valor;
  }

  const agora = new Date();
  return {
    empresa: context.empresa,
    cnpjEmpresa: context.cnpjEmpresa ? formatTaxId(context.cnpjEmpresa) : "Todas as empresas autorizadas",
    competencia: context.competence,
    competenciaLabel: competenceLabel(context.competence),
    periodo: competencePeriod(context.competence),
    emitidoEm: new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(agora),
    emitidoPor: context.emitidoPor,
    prestadores: [...porPrestador.values()],
  };
}
