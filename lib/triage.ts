/**
 * Central de Triagem: entender a incerteza sem inventar dado (§13 a §19).
 *
 * A triagem existe porque o sistema, em algum ponto, não teve certeza: não
 * soube de quem era a entrada, não alcançou confiança suficiente, ou tocou em
 * algo que uma pessoa precisa decidir. O trabalho desta tela não é "aprovar" —
 * é **resolver a incerteza**, e o pior desfecho possível é alguém confirmar um
 * vínculo por eliminação porque a tela não explicou o que estava em dúvida.
 *
 * ## Camada de leitura, como a Central de Trabalho
 *
 * Existem duas filas de incerteza no produto, e elas continuam existindo:
 * `fdp_agent_proposals` (o que um agente propôs e o motor não autorizou) e
 * `fdp_movement_suggestions` (o que a leitura do Teams reconheceu sem os dados
 * obrigatórios). Elas guardam coisas diferentes, com regras e constraints
 * próprias, e fundi-las jogaria fora invariantes.
 *
 * O que este módulo faz é dar **uma leitura só** para as duas, e mandar a
 * resolução de volta para a rota dona de cada uma (§17). Nenhum `UPDATE` sai
 * daqui: confirmar uma triagem passa exatamente pelas mesmas validações que
 * valem quando uma pessoa faz a mesma coisa pela tela do módulo.
 *
 * O módulo é puro — sem banco, sem React — porque a redação de dado pessoal e a
 * tradução de confiança precisam ser verificáveis linha a linha.
 */

/* -------------------------------------------------------------------------- *
 * Confiança
 * -------------------------------------------------------------------------- */

import { AUTOMATIC_THRESHOLD, SUGGESTION_THRESHOLD } from "./agent-proposals.ts";

export type ConfidenceBand = {
  level: "alta" | "media" | "baixa";
  label: string;
  tone: "positive" | "warning" | "critical";
  /** O número, para quem quiser conferir — nunca sozinho na tela (§19). */
  percent: number;
  detail: string;
};

/**
 * Confiança em palavra, com o número disponível (§19).
 *
 * "0,84" não diz nada para quem opera: não há como saber se é bom ou ruim sem
 * conhecer os limiares. As faixas são exatamente os limiares que o motor
 * determinístico já usa para decidir — importados, e não copiados, porque duas
 * cópias divergem e a tela passaria a dizer "alta" sobre uma nota que o motor
 * mandou para triagem.
 */
export function confidenceBand(confidence: number): ConfidenceBand {
  const value = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  const percent = Math.round(value * 100);
  if (value >= AUTOMATIC_THRESHOLD) {
    return {
      level: "alta", label: "Alta", tone: "positive", percent,
      detail: "Leitura consistente. Ainda assim, a decisão de aplicar é de uma pessoa.",
    };
  }
  if (value >= SUGGESTION_THRESHOLD) {
    return {
      level: "media", label: "Média", tone: "warning", percent,
      detail: "A leitura reconheceu o essencial, mas não o suficiente para dispensar conferência.",
    };
  }
  return {
    level: "baixa", label: "Baixa", tone: "critical", percent,
    detail: "Leitura frágil. Confira a origem antes de confirmar qualquer vínculo.",
  };
}

/* -------------------------------------------------------------------------- *
 * Motivo da incerteza
 * -------------------------------------------------------------------------- */

/**
 * O que exatamente ficou em dúvida, e o que resolve (§14, §56).
 *
 * Cada código do motor determinístico vira uma frase que diz a causa e a saída.
 * Um código sem tradução aqui devolve a razão gravada com a proposta — que já é
 * texto, e é melhor do que mostrar `AGENT_LOW_CONFIDENCE` para quem opera.
 */
const UNCERTAINTY: Record<string, { title: string; action: string }> = {
  AGENT_ENTITY_UNRESOLVED: {
    title: "O agente não identificou a quem esta entrada se refere.",
    action: "Escolha o colaborador e a empresa. Nada é aplicado até o vínculo ser confirmado.",
  },
  AGENT_LOW_CONFIDENCE: {
    title: "A leitura automática ficou abaixo do mínimo para virar sugestão.",
    action: "Confira a origem ao lado e decida: confirmar, corrigir ou descartar.",
  },
  AGENT_AUTOMATION_OFF: {
    title: "A automação por agente está desligada neste grupo.",
    action: "Toda entrada vem para cá enquanto a política estiver assim.",
  },
  AGENT_SENSITIVE_ACTION: {
    title: "Ação sensível: salário, desligamento, aprovação ou escrita em ERP.",
    action: "A decisão é sempre de uma pessoa, com qualquer confiança. Use o fluxo do módulo.",
  },
  AGENT_HUMAN_REQUESTED: {
    title: "O próprio agente pediu validação humana.",
    action: "Confira o que ele encontrou e confirme ou recuse.",
  },
  AGENT_NEEDS_CONFIRMATION: {
    title: "A leitura é plausível, mas este grupo exige confirmação humana.",
    action: "Confirme para aplicar pelo fluxo normal do módulo.",
  },
  AGENT_EVIDENCE_REQUIRED: {
    title: "Sem evidência anexada, a ação automática vira sugestão.",
    action: "Confira a origem antes de confirmar — não haverá o que reconferir depois.",
  },
  AGENT_PAUSED: {
    title: "O agente estava pausado quando a entrada chegou.",
    action: "Nada dele é aplicado enquanto estiver pausado. Reative-o na Central de Agentes.",
  },
  AGENT_PROPOSAL_UNTRACEABLE: {
    title: "A proposta não identifica o agente ou o evento que a originou.",
    action: "Sem rastro não há o que conferir. Descarte e verifique o conector.",
  },
  AGENT_ACTION_UNKNOWN: {
    title: "A ação proposta não está no catálogo de ações permitidas a um agente.",
    action: "Descarte. Se a ação deveria existir, ela precisa entrar no catálogo, não na exceção.",
  },
  AGENT_INSTANCE_REQUIRED: {
    title: "Avançar etapa exige a demanda correspondente, e ela não veio.",
    action: "Abra a demanda pelo processo e avance por lá.",
  },
  MOVEMENT_INCOMPLETE: {
    title: "A mensagem reconheceu a movimentação, mas faltaram dados obrigatórios.",
    action: "Complete o que falta com a mensagem original ao lado e confirme.",
  },
};

export function uncertaintyExplanation(code: string, fallback = "") {
  const known = UNCERTAINTY[code];
  if (known) return known;
  return {
    title: fallback || "A entrada precisa de conferência humana.",
    action: "Confira a origem e decida: confirmar, recusar ou descartar.",
  };
}

/* -------------------------------------------------------------------------- *
 * Dado pessoal
 * -------------------------------------------------------------------------- */

/**
 * Redação de dado pessoal na apresentação (§15).
 *
 * O payload de uma admissão traz CPF, e-mail, telefone e conta bancária. A
 * triagem é operada por quem trata a movimentação, não necessariamente por quem
 * pode ver o cadastro completo — e a tela de triagem não é o lugar de expor o
 * documento inteiro para conferir um nome.
 *
 * A redação é parcial de propósito: esconder tudo tornaria a conferência
 * impossível ("é este João ou o outro?"), e mostrar tudo distribuiria dado
 * sensível sem necessidade. Os quatro dígitos finais bastam para conferir.
 */
export function redactPersonalData(value: string): string {
  return value
    // CPF, com ou sem pontuação.
    .replace(/\b(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})[-\s]?(\d{2})\b/gu, "•••.•••.$3-$4")
    // CNPJ.
    .replace(/\b(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})\/?(\d{4})-?(\d{2})\b/gu, "••.•••.•••/$4-$5")
    // E-mail: a inicial e o domínio bastam para reconhecer de quem é.
    .replace(/\b([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)\b/gu, "$1•••@$2")
    // Telefone brasileiro com DDD.
    .replace(/\b\(?(\d{2})\)?[\s-]?9?\d{4}[-\s]?(\d{4})\b/gu, "($1) ••••-$2");
}

/* -------------------------------------------------------------------------- *
 * Payload legível
 * -------------------------------------------------------------------------- */

export type TriageField = { label: string; value: string };

/**
 * Nomes de campo que o payload costuma trazer, em português.
 *
 * O que não está aqui **não** é escondido: ele aparece com a chave original
 * humanizada. Esconder o desconhecido faria a triagem mentir por omissão quando
 * o conector mudasse de formato — e é justamente aí que alguém precisa ver o
 * campo novo.
 */
const FIELD_LABELS: Record<string, string> = {
  admissionDate: "Data de admissão",
  agentKey: "Agente",
  cardId: "Demanda",
  companyId: "Empresa",
  companyName: "Empresa",
  confidence: "Confiança",
  cpf: "CPF",
  documentsMissing: "Documentos faltantes",
  documentsPresent: "Documentos entregues",
  effectiveDate: "Vigência",
  email: "E-mail",
  employeeId: "Colaborador",
  employeeName: "Colaborador",
  externalId: "Identificador na origem",
  newRole: "Novo cargo",
  newSalary: "Novo salário",
  previousRole: "Cargo anterior",
  previousSalary: "Salário anterior",
  processType: "Tipo de processo",
  proposedAction: "Ação proposta",
  registrationNumber: "Matrícula",
  requestedBy: "Solicitante",
  unityName: "Unidade",
};

const humanizeKey = (key: string) => {
  const spaced = key.replace(/[_-]+/gu, " ").replace(/([a-z\d])([A-Z])/gu, "$1 $2").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : key;
};

const MAX_FIELDS = 12;
const MAX_VALUE_LENGTH = 160;

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (Array.isArray(value)) return value.slice(0, 6).map((item) => readableValue(item)).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).trim().slice(0, MAX_VALUE_LENGTH);
}

/**
 * O payload como frases, não como JSON (§15).
 *
 * Despejar o objeto cru na tela é o atalho que transforma a triagem em trabalho
 * de programador: quem opera passa a caçar a chave certa no meio de trinta
 * campos técnicos. Aqui saem no máximo doze campos, já rotulados, já redigidos
 * e sem objeto aninhado — o detalhe técnico continua existindo, atrás de um
 * pedido explícito de quem administra.
 */
export function summarizePayload(payload: unknown, options: { redact?: boolean } = {}): TriageField[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const redact = options.redact !== false;
  const fields: TriageField[] = [];
  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (fields.length >= MAX_FIELDS) break;
    const value = readableValue(raw);
    if (!value) continue;
    fields.push({
      label: FIELD_LABELS[key] ?? humanizeKey(key),
      value: redact ? redactPersonalData(value) : value,
    });
  }
  return fields;
}

/* -------------------------------------------------------------------------- *
 * Contrato comum
 * -------------------------------------------------------------------------- */

export type TriageSource = "agent_proposal" | "movement_suggestion";

export type TriageDecision = "confirm" | "reject" | "discard";

export type TriageItem = {
  id: string;
  source: TriageSource;
  sourceId: string;
  /** Agente ou canal de origem. */
  origin: string;
  originLabel: string;
  eventName: string;
  title: string;
  /** O que o sistema propõe fazer, em português. */
  proposal: string;
  status: string;
  confidence: ConfidenceBand;
  uncertainty: { title: string; action: string };
  /** Vínculos que o sistema achou prováveis — nenhum deles é aplicado sozinho. */
  likely: { employeeId: string; employeeName: string; companyId: string; companyName: string; processId: string; processStep: string };
  fields: TriageField[];
  evidenceIds: string[];
  /** Endereço que resolve este item, na tela do módulo dono dele (§17). */
  resolveHref: string;
  createdAt: string;
  /** Histórico, quando já resolvido (§18). */
  resolution: {
    decidedBy: string;
    decidedAt: string;
    decision: string;
    note: string;
    resultType: string;
    resultId: string;
    failure: string;
  } | null;
};

/**
 * De onde o item veio, em nome de produto.
 *
 * "Sankhya (navegador)" contava ao operador como a leitura é feita, o que é
 * detalhe interno: quem tria precisa saber **quem** trouxe o item, não que
 * mecanismo aquele agente usa por dentro. As chaves antigas continuam na
 * tabela porque estão gravadas em propostas já existentes — traduzi-las é o
 * que mantém o histórico legível sem migrar dado (§15, §17).
 */
export const triageOriginLabels: Record<string, string> = {
  sankhya_browser: "Agente Sankhya",
  sankhya: "Agente Sankhya",
  sankhya_agent: "Agente Sankhya",
  tangerino_browser: "Agente Tangerino",
  tangerino: "Agente Tangerino",
  tangerino_agent: "Agente Tangerino",
  teams: "Agente Teams",
  teams_agent: "Agente Teams",
  /* Conector aposentado pela decisão de produto. O rótulo fica porque as
     propostas que ele gerou continuam na fila e precisam dizer de onde vieram —
     esconder a origem seria pedir que alguém decidisse às cegas. */
  solides: "Sólides (conector anterior)",
};

export function originLabel(origin: string) {
  return triageOriginLabels[origin] ?? origin;
}

/** Ações propostas em português; o operador não lê `process.advance`. */
export const proposedActionLabels: Record<string, string> = {
  "process.advance": "Avançar a etapa da demanda",
  "process.start": "Abrir uma demanda a partir do processo",
  "card.comment": "Comentar na demanda",
  "card.attach_evidence": "Anexar evidência à demanda",
  "employee.link": "Vincular o colaborador",
  "triage.open": "Abrir triagem",
  "movement.suggest": "Sugerir movimentação",
  unknown: "Ação não reconhecida",
};

export function proposalLabel(action: string) {
  return proposedActionLabels[action] ?? action;
}

/**
 * Onde este item se resolve.
 *
 * Sempre a tela do módulo dono, nunca uma tela paralela dentro da triagem
 * (§9): a proposta de agente termina na demanda que ela move, e a sugestão do
 * Teams termina na tela de movimentações, que é onde as regras de aprovação e
 * de faixa salarial já vivem.
 */
export function triageResolveHref(item: { source: TriageSource; sourceId: string }) {
  const id = encodeURIComponent(item.sourceId);
  return item.source === "agent_proposal"
    ? `/painel/triagem/${id}`
    : `/painel/triagem/movimentacao-${id}`;
}
