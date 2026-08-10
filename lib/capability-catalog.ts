import { capabilities, type Capability } from "./authorization.ts";

/**
 * Tradução das capacidades para linguagem de quem administra o grupo.
 *
 * `competences.transition` não diz nada para o cliente. "Avançar a competência
 * entre as etapas do fechamento" diz. A tela de usuários precisa explicar o que
 * está concedendo — escolher um papel sem saber o que ele permite é como assinar
 * em branco.
 *
 * Todo item de `capabilities` precisa estar descrito aqui: há teste que reprova
 * quando uma capacidade nova entra no sistema sem explicação.
 */
export const capabilityAreas = [
  { key: "workspace", label: "Grupo e acesso" },
  { key: "demands", label: "Demandas e colaboração" },
  { key: "registrations", label: "Cadastros" },
  { key: "operations", label: "Operação do DP" },
  { key: "payments", label: "Pagamentos auxiliares" },
  { key: "time", label: "Ponto" },
  { key: "platform", label: "Integrações, plano e auditoria" },
] as const;

export type CapabilityArea = typeof capabilityAreas[number]["key"];

type CapabilityDescription = { area: CapabilityArea; label: string };

export const capabilityCatalog: Record<Capability, CapabilityDescription> = {
  "workspace.read": { area: "workspace", label: "Entrar no grupo e ver a operação" },
  "workspace.manage": { area: "workspace", label: "Alterar nome, quadros e configurações do grupo" },
  "members.directory.read": { area: "workspace", label: "Ver quem tem acesso ao grupo" },
  "members.manage": { area: "workspace", label: "Criar, alterar papel e remover usuários" },

  "cards.read": { area: "demands", label: "Ver demandas e prazos" },
  "cards.write": { area: "demands", label: "Criar, editar e mover demandas" },
  "comments.write": { area: "demands", label: "Comentar em demandas" },
  "attachments.read": { area: "demands", label: "Baixar anexos" },
  "attachments.write": { area: "demands", label: "Anexar e remover arquivos" },
  "reports.read": { area: "demands", label: "Abrir relatórios e indicadores" },

  "companies.read": { area: "registrations", label: "Ver empresas do grupo" },
  "companies.manage": { area: "registrations", label: "Criar e editar empresas" },
  "employees.read": { area: "registrations", label: "Ver colaboradores" },
  "employees.manage": { area: "registrations", label: "Cadastrar e editar colaboradores" },
  "registrations.catalogs.manage": { area: "registrations", label: "Manter catálogos de cadastro" },
  "hr.read": { area: "registrations", label: "Ver dados de folha e indicadores de RH" },
  "hr.write": { area: "registrations", label: "Registrar dados de folha e indicadores de RH" },

  "processes.read": { area: "operations", label: "Ver processos operacionais" },
  "processes.manage": { area: "operations", label: "Editar processos operacionais" },
  "processes.publish": { area: "operations", label: "Publicar versão de processo" },
  "competences.read": { area: "operations", label: "Ver competências e fechamentos" },
  "competences.manage": { area: "operations", label: "Criar e editar competências" },
  "competences.transition": { area: "operations", label: "Avançar a competência entre as etapas do fechamento" },
  "competences.reopen": { area: "operations", label: "Reabrir competência fechada, com justificativa" },
  "movements.read": { area: "operations", label: "Ver movimentações da folha" },
  "movements.manage": { area: "operations", label: "Preparar e editar movimentações" },
  "approvals.read": { area: "operations", label: "Ver aprovações pendentes" },
  "approvals.request": { area: "operations", label: "Solicitar aprovação" },
  "approvals.decide": { area: "operations", label: "Aprovar ou recusar solicitações" },
  "obligations.read": { area: "operations", label: "Ver obrigações da competência" },
  "obligations.manage": { area: "operations", label: "Tratar obrigações da competência" },
  "pending_items.read": { area: "operations", label: "Ver pendências do fechamento" },
  "pending_items.manage": { area: "operations", label: "Resolver pendências do fechamento" },

  "benefits.read": { area: "payments", label: "Ver benefícios da competência" },
  "benefits.manage": { area: "payments", label: "Lançar e ajustar benefícios" },
  "psychology.read": { area: "payments", label: "Ver consultas registradas" },
  "psychology.manage": { area: "payments", label: "Registrar consultas para pagamento" },
  "contractors.read": { area: "payments", label: "Ver prestadores PJ" },
  "contractors.manage": { area: "payments", label: "Cadastrar e editar prestadores PJ" },
  "auxiliary.approvals.request": { area: "payments", label: "Solicitar aprovação em módulos auxiliares" },
  "auxiliary.approvals.decide": { area: "payments", label: "Aprovar lançamentos dos módulos auxiliares" },
  "auxiliary.close": { area: "payments", label: "Fechar módulos auxiliares da competência" },
  "psychology.payments.read": { area: "payments", label: "Ver apuração de pagamento de psicólogos" },
  "psychology.payments.manage": { area: "payments", label: "Lançar pagamentos de psicólogos" },
  "psychology.payments.close": { area: "payments", label: "Fechar o pagamento de psicólogos" },
  "contractors.payments.read": { area: "payments", label: "Ver apuração de pagamentos PJ" },
  "contractors.payments.manage": { area: "payments", label: "Lançar pagamentos PJ" },
  "contractors.payments.close": { area: "payments", label: "Fechar pagamentos PJ" },
  "contractors.limits.manage": { area: "payments", label: "Configurar o limite de nota fiscal" },
  "payments.reopen": { area: "payments", label: "Reabrir pagamento fechado, com justificativa" },

  "time.read": { area: "time", label: "Ver marcações e conferências de ponto" },
  "time.manage": { area: "time", label: "Tratar inconsistências de ponto" },
  "time.approve": { area: "time", label: "Aprovar a conferência de ponto" },
  "time.export": { area: "time", label: "Exportar eventos de hora para a folha" },
  "time.mappings.manage": { area: "time", label: "Configurar rubricas e mapeamentos de ponto" },

  "integrations.status.read": { area: "platform", label: "Ver o estado das integrações" },
  "integrations.manage": { area: "platform", label: "Configurar conectores e credenciais" },
  "integrations.run": { area: "platform", label: "Executar integrações" },
  "integrations.reconcile": { area: "platform", label: "Conciliar retornos da integração" },
  "saas.read": { area: "platform", label: "Ver plano, limites e faturas" },
  "saas.manage": { area: "platform", label: "Contratar, trocar de plano e cancelar" },
  "audit.read": { area: "platform", label: "Consultar a trilha de auditoria" },
};

/** Capacidades de uma área, na ordem canônica de `capabilities`. */
export function capabilitiesOfArea(area: CapabilityArea): Capability[] {
  return capabilities.filter((capability) => capabilityCatalog[capability].area === area);
}

export const roleLabels = {
  admin: "Administrador",
  member: "Membro",
  observer: "Observador",
  guest: "Convidado",
} as const;

export const roleSummaries = {
  admin: "Administra o grupo inteiro: usuários, empresas, plano, integrações e auditoria. Enxerga todas as empresas.",
  member: "Executa a operação do dia a dia — demandas, competências, movimentações e pagamentos auxiliares — nas empresas liberadas.",
  observer: "Só consulta. Não cria, não edita e não aprova nada.",
  guest: "Acesso mínimo: vê demandas e pode comentar. Indicado para quem participa de um assunto pontual.",
} as const;
