import { Archive, CreditCard, FileCheck2, FileSpreadsheet, LayoutDashboard, ReceiptText, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Os nove destinos do Pagamento PJ (§74).
 *
 * O módulo era uma tela só, rolando: totais no topo, lançamentos fixos no
 * meio, exportação Caju condicional e, no fim, uma tabela de fechamentos com
 * treze colunas. Quem entrava para conferir um limite de nota passava por
 * tudo; quem entrava para saber quanto sair no mês passava por tudo. E dois
 * assuntos com dados próprios no servidor — as políticas de limite e o
 * histórico de competências — não tinham lugar nenhum: existiam só dentro de
 * um diálogo ou de um `<select>`.
 *
 * Cada destino aqui é um recorte com dados próprios que já vêm do servidor.
 * Nenhum é casca esperando conteúdo, que é o que a §75 proíbe — e é também
 * por isso que não existe "Contratos": a entidade não existe no banco, o que
 * há é uma referência de contrato dentro do prestador.
 *
 * A lista mora aqui, e não dentro do componente, porque três lugares precisam
 * dela e nenhum deles deve ter a própria cópia: o menu do painel, o módulo que
 * decide o que desenhar, e os testes que conferem que os dois concordam.
 */
export type ContractorSectionId =
  | "contractorPayments"
  | "contractorProviders"
  | "contractorCycles"
  | "contractorClosings"
  | "contractorInvoices"
  | "contractorAdjustments"
  | "contractorLimits"
  | "contractorCaju"
  | "contractorArchive";

export type ContractorSection = {
  id: ContractorSectionId;
  label: string;
  icon: LucideIcon;
  /** O que a tela responde — vira o subtítulo do cabeçalho do módulo. */
  description: string;
};

export const contractorSections: readonly ContractorSection[] = [
  {
    id: "contractorPayments",
    label: "Visão geral",
    icon: LayoutDashboard,
    description: "Quanto a competência deve, o que ainda trava o fechamento e onde está cada prestador.",
  },
  {
    id: "contractorProviders",
    label: "Prestadores",
    icon: Users,
    description: "Quem é PJ nesta empresa, com valor de contrato, forma de complemento e situação.",
  },
  {
    id: "contractorCycles",
    label: "Competências",
    icon: FileSpreadsheet,
    description: "As competências abertas e encerradas, com data de pagamento e quando foram fechadas.",
  },
  {
    id: "contractorClosings",
    label: "Pagamentos",
    icon: ReceiptText,
    description: "A apuração de cada prestador: base, créditos, descontos, nota esperada e complemento.",
  },
  {
    id: "contractorInvoices",
    label: "Notas Fiscais",
    icon: FileCheck2,
    description: "Quem precisa emitir nota, quem já enviou, o que ainda falta conferir e quem está apto a receber.",
  },
  {
    id: "contractorAdjustments",
    label: "Ajustes",
    icon: SlidersHorizontal,
    description: "Lançamentos que se repetem por competência — plano de saúde, convênios, adicionais.",
  },
  {
    id: "contractorLimits",
    label: "Limites de nota",
    icon: ShieldCheck,
    description: "Até quanto cada prestador emite nota, e de onde vem o limite que valeu na apuração.",
  },
  {
    id: "contractorCaju",
    label: "Complemento Caju",
    icon: CreditCard,
    description: "O valor que sai fora da nota, o lote enviado ao cartão e o que voltou com erro.",
  },
  {
    id: "contractorArchive",
    label: "Encerramentos",
    icon: Archive,
    description: "O que já foi pago e fechado na competência, com os relatórios para conferência externa.",
  },
];

const byId = new Map(contractorSections.map((section) => [section.id, section]));

export function contractorSection(id: string): ContractorSection | undefined {
  return byId.get(id as ContractorSectionId);
}

export function isContractorSection(id: string): id is ContractorSectionId {
  return byId.has(id as ContractorSectionId);
}
