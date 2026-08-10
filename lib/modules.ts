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

export type ModuleAccessInput = {
  module: ModuleDefinition;
  /** Módulos incluídos no plano contratado. */
  planModules: ReadonlySet<string>;
  /** Liberações e bloqueios especiais concedidos pela plataforma ao workspace. */
  workspaceGrants: ReadonlyMap<string, boolean>;
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
  | "missing_capability";

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

  if (definition.dependsOn && !input.enabledKeys.has(definition.dependsOn)) {
    return { allowed: false, reason: "dependency_missing", upgradeable: true };
  }
  if (definition.requiredCapability && !hasCapability(input.role, definition.requiredCapability as Capability)) {
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
