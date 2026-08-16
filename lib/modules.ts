import type { Capability } from "./authorization.ts";
import { hasCapability } from "./authorization.ts";

/**
 * Resolução de acesso a módulo (§8 da especificação).
 *
 * A ordem é fixa e cada etapa tem um motivo próprio de recusa. Isso importa:
 * "o menu não mostra" e "o plano não inclui" são situações diferentes, e o
 * cliente precisa saber qual delas é a sua — no primeiro caso ele pede acesso
 * ao administrador do workspace, no segundo ele pede upgrade.
 *
 * Este módulo é puro: não acessa banco nem sessão.
 */
export const moduleCategories = ["operacao", "folha", "pessoas", "gestao", "plataforma"] as const;
export type ModuleCategory = typeof moduleCategories[number];

export const moduleCategoryLabels: Record<ModuleCategory, string> = {
  operacao: "Operação",
  folha: "Folha e competências",
  pessoas: "Pessoas",
  gestao: "Gestão",
  plataforma: "Plataforma",
};

export type ModuleDefinition = {
  key: string;
  name: string;
  description: string;
  category: ModuleCategory;
  route: string;
  requiredCapability: string;
  dependsOn: string;
  status: "active" | "inactive";
  position: number;
};

/**
 * Capacidades de **escrita** que cada módulo governa.
 *
 * A tabela `fdp_modules` guarda uma capacidade por módulo: a de leitura, que é
 * a que decide se o módulo aparece. Negar um módulo para uma pessoa retirava
 * só essa — e o resto continuava valendo pelo papel.
 *
 * Verificado contra o produto de pé: um membro com Demandas, Inbox e Planner
 * todos negados criava demandas por `POST /api/cards` e recebia 201. Ele não
 * via o quadro e escrevia nele.
 *
 * A negação é por família, e só quando **todos** os módulos que governam a
 * capacidade estão negados: `cards.write` pertence a Demandas, Inbox e Planner
 * ao mesmo tempo, e negar só o Inbox não pode calar o quadro de quem continua
 * com ele liberado.
 *
 * A concessão continua sendo só de leitura, como a tela diz por escrito:
 * liberar um módulo mostra o módulo; escrever continua vindo do papel. A
 * assimetria é deliberada — liberar não pode promover ninguém.
 */
export const moduleWriteCapabilities: Record<string, readonly Capability[]> = {
  board: ["cards.write", "comments.write", "attachments.write"],
  inbox: ["cards.write"],
  planner: ["cards.write"],
  processes: [
    "processes.manage", "processes.publish", "competences.manage", "competences.transition",
    "competences.reopen", "movements.manage", "approvals.request", "approvals.decide",
    "obligations.manage", "pending_items.manage",
  ],
  time_tracking: ["time.manage", "time.approve", "time.export", "time.mappings.manage"],
  auxiliary: [
    "benefits.manage", "psychology.manage", "contractors.manage",
    "auxiliary.approvals.request", "auxiliary.approvals.decide", "auxiliary.close",
  ],
  psychologist_payments: ["psychology.payments.manage", "psychology.payments.close", "payments.reopen"],
  contractor_payments: [
    "contractors.payments.manage", "contractors.payments.close", "contractors.limits.manage",
    "contractors.export_caju", "payments.reopen",
  ],
  registrations: ["companies.manage", "employees.manage", "registrations.catalogs.manage"],
  integrations: ["integrations.manage", "integrations.run", "integrations.reconcile"],
  sankhya_browser: ["integrations.credentials.manage", "integrations.execute", "integrations.logs.view"],
  payroll: ["hr.write"],
  access: ["members.manage"],
  saas: ["saas.manage"],
  // Relatórios são leitura; não há escrita a negar além da própria visão.
  indicators: [],
};

/** Módulos que governam cada capacidade de escrita, derivado do mapa acima. */
export const capabilityOwners = (() => {
  const owners = new Map<string, Set<string>>();
  for (const [module_, caps] of Object.entries(moduleWriteCapabilities)) {
    for (const capability of caps) {
      const set = owners.get(capability) ?? new Set<string>();
      set.add(module_);
      owners.set(capability, set);
    }
  }
  return owners;
})();

/**
 * Capacidades de escrita a negar, dadas as exceções individuais da pessoa.
 *
 * Só entra a capacidade cujos módulos donos estejam **todos** negados. Módulo
 * sem exceção não conta como negado: ele segue o papel e o plano.
 */
export function deniedWriteCapabilities(byModule: ReadonlyMap<string, boolean>): Set<string> {
  const denied = new Set<string>();
  for (const [capability, owners] of capabilityOwners) {
    if (owners.size === 0) continue;
    let todosNegados = true;
    for (const module_ of owners) {
      if (byModule.get(module_) !== false) { todosNegados = false; break; }
    }
    if (todosNegados) denied.add(capability);
  }
  return denied;
}

export type ModuleAccessInput = {
  module: ModuleDefinition;
  /** Módulos incluídos no plano contratado. */
  planModules: ReadonlySet<string>;
  /** Liberações e bloqueios especiais concedidos pela plataforma ao workspace. */
  workspaceGrants: ReadonlyMap<string, boolean>;
  /** Exceções individuais do usuário dentro do grupo. */
  memberGrants?: ReadonlyMap<string, boolean>;
  role: string;
  workspaceStatus: string;
  subscriptionStatus: string;
  /** Chaves já resolvidas como liberadas, para checar dependência. */
  enabledKeys: ReadonlySet<string>;
};

export type ModuleAccessReason =
  | "ok"
  | "module_inactive"
  | "workspace_inactive"
  | "subscription_inactive"
  | "not_in_plan"
  | "revoked_by_platform"
  | "dependency_missing"
  | "missing_capability"
  | "denied_for_member";

export type ModuleAccess = { allowed: boolean; reason: ModuleAccessReason; upgradeable: boolean };

/** Texto exibido ao usuário para cada motivo. Nenhum deles é "erro genérico". */
export const moduleAccessMessages: Record<ModuleAccessReason, string> = {
  ok: "",
  module_inactive: "Este módulo não está disponível na plataforma no momento.",
  workspace_inactive: "Este grupo está suspenso ou cancelado. Fale com o administrador da plataforma.",
  subscription_inactive: "A assinatura deste grupo não está ativa.",
  not_in_plan: "Este módulo não faz parte do plano contratado. Solicite a mudança de plano.",
  revoked_by_platform: "O acesso a este módulo foi bloqueado pela administração da plataforma.",
  dependency_missing: "Este módulo depende de outro que não está liberado.",
  missing_capability: "Seu perfil não tem permissão para este módulo. Peça ao administrador do grupo.",
  denied_for_member: "O administrador do grupo bloqueou este módulo para o seu acesso.",
};

/**
 * Ordem obrigatória da liberação:
 *
 *   1. o módulo existe e está ativo no catálogo global;
 *   2. o workspace e a assinatura estão ativos;
 *   3. o módulo está no plano OU tem liberação especial da plataforma;
 *   4. a plataforma não revogou o módulo para este workspace;
 *   5. a dependência declarada está liberada;
 *   6. o papel do usuário possui a capability do módulo.
 *
 * O administrador do workspace nunca consegue liberar um módulo que o plano não
 * inclui: a etapa 3 acontece antes da etapa 6, e ele não controla nenhuma das
 * duas primeiras.
 */
export function resolveModuleAccess(input: ModuleAccessInput): ModuleAccess {
  const { module: definition } = input;
  if (definition.status !== "active") return { allowed: false, reason: "module_inactive", upgradeable: false };
  if (input.workspaceStatus !== "active") return { allowed: false, reason: "workspace_inactive", upgradeable: false };
  if (!["active", "trialing"].includes(input.subscriptionStatus)) {
    return { allowed: false, reason: "subscription_inactive", upgradeable: false };
  }

  const grant = input.workspaceGrants.get(definition.key);
  if (grant === false) return { allowed: false, reason: "revoked_by_platform", upgradeable: false };
  const contracted = input.planModules.has(definition.key) || grant === true;
  if (!contracted) return { allowed: false, reason: "not_in_plan", upgradeable: true };

  // Bloqueio individual vem depois do plano e antes de tudo mais: é exceção do
  // grupo sobre a pessoa, não sobre o contrato.
  const memberGrant = input.memberGrants?.get(definition.key);
  if (memberGrant === false) return { allowed: false, reason: "denied_for_member", upgradeable: false };

  if (definition.dependsOn && !input.enabledKeys.has(definition.dependsOn)) {
    return { allowed: false, reason: "dependency_missing", upgradeable: true };
  }
  // Liberação individual supre a capacidade de leitura que o papel não tem. As
  // ações de escrita continuam vindo do papel — liberar a tela sem as ações
  // entregaria uma tela decorativa.
  if (definition.requiredCapability && memberGrant !== true
    && !hasCapability(input.role, definition.requiredCapability as Capability)) {
    return { allowed: false, reason: "missing_capability", upgradeable: false };
  }
  return { allowed: true, reason: "ok", upgradeable: false };
}

export type ResolvedModule = ModuleDefinition & {
  allowed: boolean;
  reason: ModuleAccessReason;
  message: string;
  upgradeable: boolean;
};

/**
 * Resolve o catálogo inteiro na ordem de posição.
 *
 * Módulos bloqueados **continuam na resposta**, com o motivo. Esconder o módulo
 * sem explicação é o que faz o cliente achar que o produto está quebrado; dizer
 * "não está no seu plano" é informação comercial útil.
 */
export function resolveModules(input: {
  modules: readonly ModuleDefinition[];
  planModules: ReadonlySet<string>;
  workspaceGrants: ReadonlyMap<string, boolean>;
  memberGrants?: ReadonlyMap<string, boolean>;
  role: string;
  workspaceStatus: string;
  subscriptionStatus: string;
}): ResolvedModule[] {
  const ordered = [...input.modules].sort((left, right) => left.position - right.position || left.key.localeCompare(right.key));
  const enabledKeys = new Set<string>();
  const resolved: ResolvedModule[] = [];
  for (const definition of ordered) {
    const access = resolveModuleAccess({
      module: definition,
      planModules: input.planModules,
      workspaceGrants: input.workspaceGrants,
      memberGrants: input.memberGrants,
      role: input.role,
      workspaceStatus: input.workspaceStatus,
      subscriptionStatus: input.subscriptionStatus,
      enabledKeys,
    });
    if (access.allowed) enabledKeys.add(definition.key);
    resolved.push({
      ...definition,
      allowed: access.allowed,
      reason: access.reason,
      message: moduleAccessMessages[access.reason],
      upgradeable: access.upgradeable,
    });
  }
  return resolved;
}

/** Chaves liberadas, para o menu e para a proteção de rota no servidor. */
export function enabledModuleKeys(resolved: readonly ResolvedModule[]) {
  return resolved.filter((item) => item.allowed).map((item) => item.key);
}
