import { competenceLabel, competencePeriod, formatTaxId, invoiceStatusLabels } from "./contractor-statement.ts";
import type { InvoiceSummaryDocument, InvoiceSummaryGroup } from "./contractor-invoice-summary-pdf.ts";

/**
 * Da consulta plana para a relação de líquidos em nota fiscal.
 *
 * A consulta devolve uma linha por fechamento, com o valor que aquele
 * prestador tem a emitir. O documento precisa da mesma lista agrupada por
 * empresa, com subtotal de cada uma e o total do grupo — e é essa soma que
 * pode estar errada de um jeito que importa.
 *
 * Por isso somar fica aqui, separado do desenho: conferir que o total bate com
 * a soma das linhas não deveria exigir abrir um PDF. O desenho recebe números
 * prontos.
 */

const number = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

export function buildInvoiceSummary(
  rows: ReadonlyArray<Record<string, unknown>>,
  context: { competence: string; empresa: string; cnpjEmpresa: string; emitidoPor: string },
): InvoiceSummaryDocument {
  const porEmpresa = new Map<string, InvoiceSummaryGroup>();
  let total = 0;
  let quantidade = 0;

  for (const row of rows) {
    /* Valor zerado fica de fora. A consulta já o descarta — este é o segundo
       cadeado, para quem um dia montar o documento a partir de outra lista.
       Uma linha de "R$ 0,00" numa relação de notas a emitir não informa nada:
       quem não emite nota recebe tudo pelo complemento, e aparecer aqui faria
       parecer que há uma nota de zero para cobrar. */
    const valor = number(row.nf_esperada);
    if (valor <= 0) continue;

    /* A empresa é a emitente daquela nota, e é ela que agrupa: a mesma pessoa
       pode ter fechamento em mais de uma empresa do grupo, e cada um é uma
       nota diferente. O nome vazio vira rótulo explícito em vez de um grupo
       sem título, que na folha lida como erro de impressão. */
    const empresa = text(row.empresa) || "Empresa não informada";
    let grupo = porEmpresa.get(empresa);
    if (!grupo) {
      grupo = { empresa, linhas: [], total: 0 };
      porEmpresa.set(empresa, grupo);
    }

    grupo.linhas.push({
      codigo: text(row.codigo),
      prestador: text(row.prestador),
      cnpj: formatTaxId(text(row.cnpj)),
      situacao: invoiceStatusLabels[text(row.status_nf)] ?? text(row.status_nf),
      valor,
    });
    grupo.total += valor;
    total += valor;
    quantidade += 1;
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
    grupos: [...porEmpresa.values()],
    quantidade,
    total,
    agrupadoPorEmpresa: porEmpresa.size > 1,
  };
}
