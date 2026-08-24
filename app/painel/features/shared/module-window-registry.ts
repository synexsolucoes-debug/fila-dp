export type ModuleWindowViewKey =
  | "board"
  | "inbox"
  | "planner"
  | "processManagement"
  | "processes"
  | "auxiliary"
  | "registrations"
  | "timeTracking"
  | "epi"
  | "payroll"
  | "psychologistPayments"
  | "contractorPayments"
  | "indicators"
  | "integrations";

export type ModuleWindowRegistryItem = {
  moduleKey: string;
  viewKey: ModuleWindowViewKey;
  label: string;
  capability?: string;
  context: string;
};

/**
 * Registro das janelas disponíveis no Vinculato.
 *
 * Esta estrutura NÃO executa etapas BPMN e NÃO cria relacionamento
 * persistente entre processo e módulo. Ela apenas fornece identificadores
 * estáveis para essa evolução futura.
 */
export const moduleWindowRegistry: readonly ModuleWindowRegistryItem[] = [
  {
    moduleKey: "demands",
    viewKey: "board",
    label: "Demandas",
    context: "Demandas",
  },
  {
    moduleKey: "demands",
    viewKey: "inbox",
    label: "Inbox",
    context: "Demandas",
  },
  {
    moduleKey: "demands",
    viewKey: "planner",
    label: "Planner",
    context: "Demandas",
  },
  {
    moduleKey: "processes",
    viewKey: "processManagement",
    label: "Processos",
    capability: "processes.read",
    context: "Processos",
  },
  {
    moduleKey: "operations",
    viewKey: "processes",
    label: "Operação DP",
    context: "Operação DP",
  },
  {
    moduleKey: "auxiliary",
    viewKey: "auxiliary",
    label: "Módulos auxiliares",
    context: "Operação DP",
  },
  {
    moduleKey: "registrations",
    viewKey: "registrations",
    label: "Cadastros",
    context: "Cadastros",
  },
  {
    moduleKey: "timeTracking",
    viewKey: "timeTracking",
    label: "Ponto",
    context: "Ponto",
  },
  {
    moduleKey: "epi",
    viewKey: "epi",
    label: "Controle de EPI",
    context: "Gestão de EPI",
  },
  {
    moduleKey: "payroll",
    viewKey: "payroll",
    label: "Folha",
    context: "Folha",
  },
  {
    moduleKey: "contractorPayments",
    viewKey: "contractorPayments",
    label: "Pagamentos PJ",
    context: "Pagamentos",
  },
  {
    moduleKey: "psychologistPayments",
    viewKey: "psychologistPayments",
    label: "Pagamento de Psicólogos",
    context: "Pagamentos",
  },
  {
    moduleKey: "indicators",
    viewKey: "indicators",
    label: "Relatórios",
    context: "Dados e Integrações",
  },
  {
    moduleKey: "integrations",
    viewKey: "integrations",
    label: "Estado das integrações",
    context: "Dados e Integrações",
  },
] as const;

export function findModuleWindow(viewKey: ModuleWindowViewKey) {
  return moduleWindowRegistry.find((item) => item.viewKey === viewKey) ?? null;
}