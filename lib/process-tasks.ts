/**
 * Tarefa-modelo, tarefa instanciada e automação de etapa (§24, §27, §41, §42).
 *
 * Este arquivo existe por causa de um achado da auditoria: o produto tinha
 * *etapa* como entidade completa e *tarefa* como string. `checklist_json` era um
 * array de títulos, e `fdp_checklist_items` guardava título, marcado e posição.
 *
 * O efeito prático não era de cadastro. `evaluateStepRequirements` só sabia
 * contar itens em aberto, então **todo** item pendente barrava o avanço com o
 * mesmo peso: não havia tarefa opcional, não havia "esta é a que trava",
 * não havia dependência entre duas, e não havia como exigir a prova de uma
 * tarefa específica. Quem precisava dessas distinções criava uma etapa a mais —
 * e o desenho do processo passava a descrever a limitação da ferramenta em vez
 * do trabalho real.
 *
 * O que passa a valer:
 *
 *   Tarefa-modelo  = o desenho, dentro da versão. Imutável depois de publicada.
 *   Tarefa         = a instância dela numa demanda, com prazo e responsável.
 *   Dependência    = ordem entre tarefas da mesma etapa, por `templateKey`.
 *   Bloqueio       = quais tarefas em aberto impedem a etapa de ser deixada.
 *
 * Três decisões que valem registrar:
 *
 * 1. **Retrocompatibilidade é o caso comum, não a exceção** (§48, §108). Etapa
 *    sem `tasks_json` cai no `checklist_json` de sempre, e o modelo resultante é
 *    obrigatório e bloqueante — exatamente o que o motor fazia antes. Nenhuma
 *    demanda aberta muda de comportamento por causa deste arquivo.
 *
 * 2. **Dependência é por chave, não por id.** O desenho é escrito antes de a
 *    demanda existir; a tarefa "Conferir CPF" precisa dizer que depende de
 *    "Receber documentos" sem conhecer o UUID que só nasce na instanciação.
 *
 * 3. **Ciclo de dependência não derruba a demanda.** Um desenho que se fecha em
 *    círculo travaria toda tarefa dele para sempre. `blockedTasks` detecta o
 *    ciclo e o reporta como bloqueio explicável, em vez de deixar a pessoa
 *    diante de uma etapa que nunca avança e não diz por quê.
 */
import { domainEventNames, type DomainEventName } from "./domain-events.ts";
import { attachmentMatchesDocument } from "./process-documents.ts";
import { cleanText } from "./registrations.ts";

const text = (value: unknown) => (value == null ? "" : String(value));
const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

export const TASK_COMPLETION_RULES = ["manual", "evidence", "document"] as const;
export type TaskCompletionRule = typeof TASK_COMPLETION_RULES[number];

export const TASK_SLA_UNITS = ["minutes", "hours", "days"] as const;
export type TaskSlaUnit = typeof TASK_SLA_UNITS[number];

/** Uma tarefa como a versão a desenhou (§24). */
export type TaskTemplate = {
  /** Chave estável dentro da etapa. Derivada do nome quando não informada. */
  key: string;
  name: string;
  description: string;
  instructions: string;
  /** Pessoa nomeada. Vazio deixa a tarefa para a área. */
  assigneeUserId: string;
  /** Perfil responsável, quando a tarefa é de quem ocupa um papel (§24). */
  assigneeRole: string;
  areaId: string;
  slaValue: number;
  slaUnit: TaskSlaUnit;
  required: boolean;
  blocksAdvance: boolean;
  evidenceRequired: boolean;
  documentRequired: string;
  completionRule: TaskCompletionRule;
  /** Chaves de outras tarefas da mesma etapa que precisam vir antes. */
  dependsOn: string[];
  position: number;
};

/**
 * Slug estável a partir do nome.
 *
 * Sem acento e sem espaço porque a chave viaja em JSON, em URL de filtro e no
 * corpo de um webhook; com acento ela sobrevive aos três, mas a primeira
 * comparação feita com a forma não normalizada falha em silêncio.
 */
export function taskKey(value: string) {
  const slug = cleanText(value, 80)
    .normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug.slice(0, 60);
}

function completionRule(value: unknown): TaskCompletionRule {
  const raw = text(value);
  return (TASK_COMPLETION_RULES as readonly string[]).includes(raw)
    ? raw as TaskCompletionRule
    : "manual";
}

function slaUnit(value: unknown): TaskSlaUnit {
  const raw = text(value);
  return (TASK_SLA_UNITS as readonly string[]).includes(raw) ? raw as TaskSlaUnit : "hours";
}

/**
 * Lê as tarefas-modelo de uma etapa.
 *
 * `tasksJson` manda quando existe. Sem ele, cada título de `checklist` vira uma
 * tarefa obrigatória e bloqueante — que é o significado que o motor já dava a
 * um item de checklist, agora dito por escrito em vez de implícito na contagem.
 *
 * Chaves repetidas são desambiguadas com sufixo em vez de recusadas: o desenho
 * já publicado que tenha duas tarefas de mesmo nome continua instanciando as
 * duas, e a dependência resolve pela primeira — que é o que alguém que escreveu
 * o nome duas vezes quis dizer.
 */
export function parseTaskTemplates(input: {
  tasksJson?: unknown;
  checklist?: readonly string[];
}): TaskTemplate[] {
  const raw = Array.isArray(input.tasksJson) ? input.tasksJson : [];
  const seen = new Set<string>();
  const uniqueKey = (candidate: string, index: number) => {
    const base = candidate || `tarefa-${index + 1}`;
    if (!seen.has(base)) { seen.add(base); return base; }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const next = `${base}-${suffix}`;
      if (!seen.has(next)) { seen.add(next); return next; }
    }
    return `${base}-${index + 1}`;
  };

  if (raw.length > 0) {
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item, index) => {
        const name = cleanText(item.name ?? item.title, 200);
        return {
          key: uniqueKey(taskKey(text(item.key) || name), index),
          name,
          description: cleanText(item.description, 1000),
          instructions: cleanText(item.instructions, 4000),
          assigneeUserId: cleanText(item.assigneeUserId, 80),
          assigneeRole: cleanText(item.assigneeRole, 60),
          areaId: cleanText(item.areaId, 80),
          slaValue: Math.max(0, Math.min(9999, Number(item.slaValue ?? 0) || 0)),
          slaUnit: slaUnit(item.slaUnit),
          // Ausente significa obrigatória: é o padrão do produto, e um desenho
          // que esqueceu o campo não pode virar tarefa que ninguém precisa fazer.
          required: item.required === undefined ? true : flag(item.required),
          blocksAdvance: item.blocksAdvance === undefined ? true : flag(item.blocksAdvance),
          evidenceRequired: flag(item.evidenceRequired),
          documentRequired: cleanText(item.documentRequired, 200),
          completionRule: completionRule(item.completionRule),
          dependsOn: Array.isArray(item.dependsOn)
            ? item.dependsOn.map((entry) => taskKey(text(entry))).filter(Boolean)
            : [],
          position: (index + 1) * 1000,
        };
      })
      .filter((task) => Boolean(task.name))
      .slice(0, 120);
  }

  return (input.checklist ?? []).map((title, index) => ({
    key: uniqueKey(taskKey(title), index),
    name: cleanText(title, 200),
    description: "", instructions: "",
    assigneeUserId: "", assigneeRole: "", areaId: "",
    slaValue: 0, slaUnit: "hours" as TaskSlaUnit,
    required: true, blocksAdvance: true,
    evidenceRequired: false, documentRequired: "",
    completionRule: "manual" as TaskCompletionRule,
    dependsOn: [], position: (index + 1) * 1000,
  })).filter((task) => Boolean(task.name)).slice(0, 120);
}

/* -------------------------------------------------------------------------- *
 * A tarefa instanciada
 * -------------------------------------------------------------------------- */

/** Uma tarefa como ela existe na demanda (§41). */
export type DemandTask = {
  id: string;
  cardId: string;
  stepId: string;
  templateKey: string;
  title: string;
  description: string;
  instructions: string;
  completed: boolean;
  position: number;
  areaId: string;
  assigneeUserId: string;
  assigneeRole: string;
  slaValue: number;
  slaUnit: string;
  startedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  completedBy: string;
  required: boolean;
  blocksAdvance: boolean;
  evidenceRequired: boolean;
  documentRequired: string;
  completionRule: TaskCompletionRule;
  dependsOn: string[];
  /** Quantidade de anexos ligados a esta tarefa. Alimenta a regra de conclusão. */
  attachmentCount: number;
  /** Nomes dos anexos desta tarefa, para a conferência por documento. */
  attachmentNames: string[];
};

export function taskOf(row: Record<string, unknown>): DemandTask {
  const depends = row.depends_on_json;
  const list = Array.isArray(depends)
    ? depends
    : (() => { try { const p = JSON.parse(text(depends) || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } })();
  return {
    id: text(row.id),
    cardId: text(row.card_id),
    stepId: text(row.process_step_id),
    templateKey: text(row.template_key),
    title: text(row.title),
    description: text(row.description),
    instructions: text(row.instructions),
    completed: flag(row.completed),
    position: Number(row.position ?? 0),
    areaId: text(row.area_id),
    assigneeUserId: text(row.assignee_user_id),
    assigneeRole: text(row.assignee_role),
    slaValue: Number(row.sla_value ?? 0),
    slaUnit: text(row.sla_unit) || "hours",
    startedAt: text(row.started_at) || null,
    dueAt: text(row.due_at) || null,
    completedAt: text(row.completed_at) || null,
    completedBy: text(row.completed_by),
    required: row.required === undefined ? true : flag(row.required),
    blocksAdvance: row.blocks_advance === undefined ? true : flag(row.blocks_advance),
    evidenceRequired: flag(row.evidence_required),
    documentRequired: text(row.document_required),
    completionRule: completionRule(row.completion_rule),
    dependsOn: list.map((entry: unknown) => taskKey(text(entry))).filter(Boolean),
    attachmentCount: Number(row.attachment_count ?? 0),
    attachmentNames: Array.isArray(row.attachment_names)
      ? row.attachment_names.map((entry) => text(entry)).filter(Boolean)
      : [],
  };
}

/* -------------------------------------------------------------------------- *
 * Dependência e bloqueio
 * -------------------------------------------------------------------------- */

export type TaskBlock = { taskId: string; title: string; reason: string; code: string };

/**
 * Tarefas que ainda não podem ser feitas porque outra vem antes (§24).
 *
 * A resposta é por tarefa e traz o motivo pronto: a tela desenha o item
 * desabilitado com o texto no título, e a rota recusa a marcação com a mesma
 * frase. Duas leituras da mesma função, nunca duas regras.
 */
export function blockedTasks(tasks: readonly DemandTask[]): Map<string, TaskBlock> {
  const byKey = new Map<string, DemandTask>();
  for (const task of tasks) if (task.templateKey) byKey.set(task.templateKey, task);

  const blocked = new Map<string, TaskBlock>();

  /* Ciclo: "A depende de B, B depende de A" trava as duas para sempre e não
     tem como ser resolvido por quem opera. Ele é dito como ciclo — quem
     desenhou precisa corrigir a versão — em vez de aparecer como uma
     dependência pendente que nunca se resolve. */
  const state = new Map<string, "visitando" | "pronto">();
  const inCycle = new Set<string>();
  const walk = (key: string, path: string[]): void => {
    const status = state.get(key);
    if (status === "pronto") return;
    if (status === "visitando") {
      for (const item of path.slice(path.indexOf(key))) inCycle.add(item);
      return;
    }
    state.set(key, "visitando");
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dependency)) walk(dependency, [...path, key]);
    }
    state.set(key, "pronto");
  };
  for (const key of byKey.keys()) walk(key, []);

  for (const task of tasks) {
    if (task.completed) continue;
    if (task.templateKey && inCycle.has(task.templateKey)) {
      blocked.set(task.id, {
        taskId: task.id, title: task.title, code: "TASK_DEPENDENCY_CYCLE",
        reason: "As dependências desta tarefa formam um ciclo no desenho do processo. Corrija a versão.",
      });
      continue;
    }
    const pending = task.dependsOn
      .map((key) => byKey.get(key))
      .filter((dependency): dependency is DemandTask => Boolean(dependency) && !dependency!.completed);
    if (pending.length === 0) continue;
    blocked.set(task.id, {
      taskId: task.id, title: task.title, code: "TASK_DEPENDENCY_PENDING",
      reason: pending.length === 1
        ? `Depende de «${pending[0].title}», que ainda não foi concluída.`
        : `Depende de ${pending.length} tarefas que ainda não foram concluídas: ${pending.map((item) => `«${item.title}»`).join(", ")}.`,
    });
  }
  return blocked;
}

/**
 * Por que esta tarefa ainda não pode ser marcada como concluída.
 *
 * Devolve `null` quando pode. A regra de conclusão é conferida contra os anexos
 * **da própria tarefa**, e não da demanda: era essa a distinção que faltava —
 * um comprovante enviado na etapa de Registro satisfazia a exigência escrita na
 * etapa de Documentação, e ninguém percebia (§43).
 */
export function taskCompletionBlocker(
  task: DemandTask, blocked: ReadonlyMap<string, TaskBlock>,
): TaskBlock | null {
  const dependency = blocked.get(task.id);
  if (dependency) return dependency;

  if (task.completionRule === "evidence" && task.attachmentCount === 0) {
    return {
      taskId: task.id, title: task.title, code: "TASK_EVIDENCE_REQUIRED",
      reason: "Esta tarefa só é concluída com uma evidência anexada nela.",
    };
  }
  if (task.completionRule === "document") {
    const wanted = task.documentRequired || task.title;
    // Mesma leitura que a etapa faz (§26): as palavras significativas do
    // documento precisam aparecer no nome do arquivo. Reusar a função, e não
    // reescrevê-la, é o que impede a tarefa e a etapa de discordarem sobre o
    // mesmo arquivo.
    if (!task.attachmentNames.some((filename) => attachmentMatchesDocument(filename, wanted))) {
      return {
        taskId: task.id, title: task.title, code: "TASK_DOCUMENT_REQUIRED",
        reason: `Esta tarefa só é concluída com o documento «${wanted}» anexado nela.`,
      };
    }
  }
  if (task.evidenceRequired && task.attachmentCount === 0) {
    return {
      taskId: task.id, title: task.title, code: "TASK_EVIDENCE_REQUIRED",
      reason: "Esta tarefa exige evidência anexada antes de ser concluída.",
    };
  }
  return null;
}

/**
 * Tarefas em aberto que travam a saída da etapa (§42).
 *
 * "Em aberto" aqui é mais estreito que "não concluída": só entra o que é
 * obrigatório **e** declarado como bloqueante. Uma tarefa opcional pendente é
 * trabalho que ficou para depois, não um impedimento — e tratar as duas como a
 * mesma coisa era exatamente a limitação que este módulo remove.
 */
export function advanceBlockingTasks(tasks: readonly DemandTask[], stepId: string) {
  return tasks.filter((task) =>
    !task.completed
    && task.required
    && task.blocksAdvance
    // Item solto (etapa vazia) vale para a etapa atual: é o caso da demanda
    // legada e do que o usuário adiciona à mão, e o motor sempre o considerou.
    && (task.stepId === stepId || task.stepId === ""));
}

/* -------------------------------------------------------------------------- *
 * Automações da etapa (§27)
 * -------------------------------------------------------------------------- */

export const AUTOMATION_TRIGGERS = [
  "step_entered", "step_completed", "task_overdue", "all_required_done", "process_completed",
] as const;
export type AutomationTrigger = typeof AUTOMATION_TRIGGERS[number];

export const AUTOMATION_ACTIONS = [
  "create_demand", "create_task", "notify_responsible", "record_event",
] as const;
export type AutomationAction = typeof AUTOMATION_ACTIONS[number];

export type StepAutomationRule = {
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** Área destino, para `create_task`. */
  areaId: string;
  /** Título da tarefa criada, ou do aviso enviado. */
  label: string;
  /**
   * Nome do evento de domínio, para `record_event`.
   *
   * Restrito ao catálogo (`lib/domain-events.ts`) e não texto livre: o evento
   * publicado alimenta webhook de cliente e trilha de auditoria, e um nome
   * inventado numa aba de configuração viraria um evento que nenhum consumidor
   * reconhece — descoberto só quando a integração de alguém não disparou.
   */
  eventName: DomainEventName | "";
};

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  step_entered: "a demanda chega nesta etapa",
  step_completed: "esta etapa é concluída",
  task_overdue: "uma tarefa desta etapa vence",
  all_required_done: "todas as tarefas obrigatórias são concluídas",
  process_completed: "o processo é concluído",
};

export const AUTOMATION_ACTION_LABELS: Record<AutomationAction, string> = {
  create_demand: "abrir uma demanda",
  create_task: "criar uma tarefa em outra área",
  notify_responsible: "avisar quem responde",
  record_event: "registrar um evento de domínio",
};

export function parseStepAutomations(value: unknown): StepAutomationRule[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item): StepAutomationRule => ({
      trigger: (AUTOMATION_TRIGGERS as readonly string[]).includes(text(item.trigger))
        ? text(item.trigger) as AutomationTrigger : "step_entered",
      action: (AUTOMATION_ACTIONS as readonly string[]).includes(text(item.action))
        ? text(item.action) as AutomationAction : "record_event",
      areaId: cleanText(item.areaId, 80),
      label: cleanText(item.label, 200),
      eventName: (domainEventNames as readonly string[]).includes(text(item.eventName))
        ? text(item.eventName) as DomainEventName : "",
    }))
    // Uma automação sem o que ela precisa é ruído na aba e nada em execução: a
    // que cria tarefa sem título, e a que registra evento sem nome, não valem.
    .filter((rule) => {
      if (rule.action === "create_task") return Boolean(rule.label);
      if (rule.action === "record_event") return Boolean(rule.eventName);
      return true;
    })
    .slice(0, 40);
}

export function automationsFor(rules: readonly StepAutomationRule[], trigger: AutomationTrigger) {
  return rules.filter((rule) => rule.trigger === trigger);
}

/** Prazo da tarefa a partir do SLA dela. Sem SLA, a tarefa herda o da etapa. */
export function taskDeadline(
  template: Pick<TaskTemplate, "slaValue" | "slaUnit">, fallbackDueAt: string | null, now = Date.now(),
): string | null {
  if (template.slaValue <= 0) return fallbackDueAt;
  const minutes = { minutes: 1, hours: 60, days: 60 * 24 }[template.slaUnit] ?? 60;
  return new Date(now + template.slaValue * minutes * 60_000).toISOString();
}
