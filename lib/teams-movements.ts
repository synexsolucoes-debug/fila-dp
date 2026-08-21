/**
 * Interpretação das mensagens publicadas no canal do Teams monitorado por um
 * workspace.
 *
 * O requisito que dita o desenho: **uma mensagem que apenas contém a palavra
 * "salário" não pode virar demanda**. Alguém perguntando "qual o prazo pra
 * alteração salarial?" no canal não está solicitando nada, e abrir uma demanda
 * de movimentação a partir disso gera trabalho falso no DP — que é pior do que
 * não automatizar.
 *
 * Por isso a classificação não é por palavra-chave. Ela exige **evidência
 * estruturada**: um gatilho de movimentação, a pessoa, o valor de destino e a
 * vigência. Cada peça vale um ponto de confiança; interrogação, hipótese e
 * negação subtraem. O resultado cai em três faixas:
 *
 *   - `create`  — dados completos e texto assertivo: abre a demanda;
 *   - `review`  — reconheceu a movimentação mas falta dado: abre **sugestão**,
 *                 que o usuário confirma, completa ou rejeita;
 *   - `ignore`  — não é uma movimentação: não gera nada.
 *
 * Nada aqui toca banco ou rede: é função pura, para poder ser testada com o
 * texto real que o cliente publica.
 */

export type MovementKind = "salary_change" | "role_change" | "admission" | "termination" | "warning";
export type MovementDecision = "create" | "review" | "ignore";

export type TeamsInterpretation = {
  kind: MovementKind | null;
  decision: MovementDecision;
  /** 0..1, arredondado em duas casas para caber no log e no banco sem ruído. */
  confidence: number;
  employeeName: string;
  previousSalary: number | null;
  newSalary: number | null;
  previousRole: string;
  newRole: string;
  /** Vigência em `AAAA-MM-DD`, vazio quando a mensagem não informa. */
  effectiveDate: string;
  /** Campos obrigatórios ausentes — é o que a tela de sugestão pede ao usuário. */
  missing: string[];
  /** Sinais que produziram a nota, para diagnóstico quando a decisão surpreender. */
  signals: string[];
};

/** Limite a partir do qual a demanda é aberta sem intervenção humana. */
export const CREATE_THRESHOLD = 0.75;
/** Abaixo disto a mensagem não é considerada movimentação de forma alguma. */
export const REVIEW_THRESHOLD = 0.45;

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/** Remove marcação e normaliza espaços — o Teams entrega o corpo em HTML. */
export function plainTextFromTeams(value: unknown, max = 5000) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<\/(p|div|li|tr)>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

/** Minúsculas sem acento, só para casar padrões; a extração usa o texto original. */
function fold(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
}

/**
 * Converte dinheiro em português para número.
 *
 * Regra pt-BR e não a do JavaScript: ponto separa milhar, vírgula separa
 * decimal. `5.500` é cinco mil e quinhentos, não cinco e meio — interpretar
 * errado aqui grava um salário mil vezes menor na demanda.
 */
export function parseBrazilianMoney(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/gu, "");
  if (!cleaned) return null;
  const hasComma = cleaned.includes(",");
  const normalized = hasComma
    ? cleaned.replace(/\./gu, "").replace(",", ".")
    : cleaned.replace(/\.(?=\d{3}\b)/gu, "");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > 100_000_000) return null;
  return Math.round(value * 100) / 100;
}

const MONEY = /R\$\s*([\d][\d.,]*)|(?<![\d/])(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?![\d/])/giu;

function extractMoney(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(MONEY)) {
    const parsed = parseBrazilianMoney(match[1] ?? match[2] ?? "");
    if (parsed !== null) values.push(parsed);
  }
  return values;
}

function isoDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return "";
  return iso;
}

/** Vigência: aceita `DD/MM/AAAA`, `AAAA-MM-DD` e "1º de setembro de 2026". */
export function extractEffectiveDate(text: string): string {
  const slash = /(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(text);
  if (slash) {
    const iso = isoDate(Number(slash[3]), Number(slash[2]), Number(slash[1]));
    if (iso) return iso;
  }
  const iso8601 = /(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (iso8601) {
    const iso = isoDate(Number(iso8601[1]), Number(iso8601[2]), Number(iso8601[3]));
    if (iso) return iso;
  }
  const written = /(\d{1,2})\s*º?\s+de\s+([a-zç]+)\s+de\s+(\d{4})/iu.exec(fold(text));
  if (written) {
    const month = MONTHS[written[2]];
    if (month) {
      const iso = isoDate(Number(written[3]), month, Number(written[1]));
      if (iso) return iso;
    }
  }
  return "";
}

const NAME_TOKEN = "[A-ZÀ-ÝÁÉÍÓÚÃÕÂÊÔÇ][a-zà-ÿáéíóúãõâêôç'’-]+";
const NAME_LINK = "(?:da|de|do|dos|das|e|del|di)";
const FULL_NAME = new RegExp(`${NAME_TOKEN}(?:\\s+(?:${NAME_LINK}\\s+)?${NAME_TOKEN})+`, "u");

/**
 * Nome do colaborador: a sequência de nomes próprios imediatamente **antes** do
 * gatilho da movimentação.
 *
 * Pegar o primeiro nome próprio da mensagem erraria em "Conforme alinhado com o
 * RH, Maria Souza passará…": quem sofre a movimentação é quem antecede o verbo,
 * não quem aparece primeiro no texto.
 */
export function extractEmployeeName(text: string, triggerIndex: number): string {
  const before = triggerIndex > 0 ? text.slice(0, triggerIndex) : text;
  const candidates = [...before.matchAll(new RegExp(FULL_NAME.source, "gu"))]
    .map((match) => match[0].trim())
    // "Recursos Humanos" e "Departamento Pessoal" casam com o formato de nome
    // próprio sem serem pessoas; basta a primeira palavra ser conhecida.
    .filter((candidate) => !STOP_WORDS.has(fold(candidate.split(/\s+/u)[0])));
  const chosen = candidates.length ? candidates[candidates.length - 1] : "";
  if (chosen) return chosen.slice(0, 160);
  // Sem sobrenome ainda pode haver um primeiro nome isolado ("João terá…").
  const single = [...before.matchAll(new RegExp(`${NAME_TOKEN}`, "gu"))]
    .map((match) => match[0])
    .filter((token) => !STOP_WORDS.has(fold(token)));
  return single.length ? single[single.length - 1].slice(0, 160) : "";
}

/**
 * Palavras que aparecem em maiúscula no início da frase mas não são nome de
 * gente. Sem esta lista, "Estamos avaliando um aumento salarial" grava
 * `employeeName: "Estamos"` — um nome inventado numa sugestão é pior do que
 * nenhum, porque parece dado conferido.
 */
const MANUAL_STOP_WORDS = [
  "conforme", "informo", "informamos", "prezados", "pessoal", "bom", "boa", "segue",
  "olá", "ola", "atenção", "atencao", "favor", "solicito", "solicitamos", "comunicamos",
  "equipe", "time", "colaborador", "colaboradora", "funcionario", "funcionaria",
  "senhor", "senhora", "aprovado", "aprovada", "urgente", "aviso", "comunicado",
  "departamento", "recursos", "humanos", "gestor", "gestora", "diretoria",
  "estamos", "temos", "vamos", "alguem", "ninguem", "todos", "todas", "hoje", "amanha",
  "boas", "bons", "obrigado", "obrigada", "atenciosamente", "att", "segundo", "apos",
];

const SALARY_TRIGGERS = [
  "alteracao salarial", "alteracao de salario", "aumento salarial", "aumento de salario",
  "reajuste salarial", "reajuste de salario", "ajuste salarial", "novo salario",
  "mudanca salarial", "correcao salarial", "revisao salarial", "promocao salarial",
  "passa a receber", "passara a receber", "salario passa", "salario passara",
];

const ROLE_TRIGGERS = [
  "mudanca de funcao", "mudanca de cargo", "alteracao de cargo", "alteracao de funcao",
  "troca de cargo", "troca de funcao", "nova funcao", "novo cargo", "promocao para",
  "promovido a", "promovida a", "promovido para", "promovida para",
  "passara de", "passa de", "passara a ocupar", "passa a ocupar",
  "assumira o cargo", "assumira a funcao", "assume o cargo", "assume a funcao",
  "transferencia de cargo", "mudanca de posicao", "alteracao de posicao",
];

const ADMISSION_TRIGGERS = [
  "admissao aprovada", "aprovacao de admissao", "processo admissional", "nova admissao",
  "novo colaborador", "nova colaboradora", "candidato aprovado", "candidata aprovada",
];

const TERMINATION_TRIGGERS = [
  "desligamento de", "solicitacao de desligamento", "rescisao de", "demissao de",
  "sera desligado", "sera desligada", "ultimo dia de trabalho", "encerramento do vinculo",
];

const WARNING_TRIGGERS = [
  "advertencia para", "advertencia de", "aplicar advertencia", "advertencia disciplinar",
  "suspensao disciplinar", "medida disciplinar",
];

/** Marcas de que o texto discute a possibilidade, em vez de comunicar o fato. */
const HYPOTHETICAL = [
  "sera que", "podemos", "poderia", "poderiamos", "seria possivel", "talvez",
  "gostaria de saber", "alguem sabe", "duvida", "como funciona", "qual o prazo",
  "qual e o prazo", "estamos avaliando", "em analise", "em estudo", "proposta de",
  "simulacao", "hipotese", "caso haja", "se houver", "pensando em", "cogitando",
  "previsao de", "ainda nao", "aguardando aprovacao", "pendente de aprovacao",
];

/** Marcas de que a movimentação foi desfeita — o oposto de um pedido. */
const NEGATION = [
  "nao havera", "nao tera", "nao sera", "cancelado", "cancelada", "cancelamento",
  "suspenso", "suspensa", "desconsiderar", "desconsidere", "ignorar", "ignore",
  "foi revertido", "revertida", "sem alteracao", "nenhuma alteracao", "nao haverá",
];

/**
 * A lista cresce sozinha a partir dos próprios gatilhos: nenhuma palavra que
 * compõe um gatilho, uma hipótese ou uma negação pode ser nome de colaborador.
 * Mantendo isso derivado, adicionar um gatilho novo não deixa um buraco aqui.
 */
const STOP_WORDS = new Set([
  ...MANUAL_STOP_WORDS,
  ...[...SALARY_TRIGGERS, ...ROLE_TRIGGERS, ...ADMISSION_TRIGGERS, ...TERMINATION_TRIGGERS,
    ...WARNING_TRIGGERS, ...HYPOTHETICAL, ...NEGATION]
    .flatMap((phrase) => phrase.split(/\s+/u))
    .filter((word) => word.length > 1),
]);

function firstTriggerIndex(folded: string, original: string, triggers: string[]) {
  let best = -1;
  for (const trigger of triggers) {
    const index = folded.indexOf(trigger);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  // O texto dobrado preserva o comprimento (NFD é removido, não substituído por
  // tamanho diferente), então o índice vale para o original.
  return best >= 0 && best < original.length ? best : -1;
}

const ROLE_STOP = /\b(a partir|apartir|em|no dia|com vigencia|com vigência|vigencia|vigência|conforme|devido|pois|porque|,|\.|;)\b/iu;

function cleanRole(value: string) {
  const trimmed = value.replace(/^[\s:–—-]+/u, "").trim();
  const stop = ROLE_STOP.exec(trimmed);
  const cut = stop && stop.index > 0 ? trimmed.slice(0, stop.index) : trimmed;
  return cut.replace(/[.,;:]+$/u, "").trim().slice(0, 120);
}

/** "de X para Y" — a forma que carrega cargo anterior e novo de uma vez. */
function extractRolePair(text: string) {
  const pattern = /(?:passar[áa]?|passa|mudar[áa]?|muda|migrar[áa]?|ir[áa]?)\s+(?:de\s+)?(?:o\s+cargo\s+de\s+|a\s+fun[çc][ãa]o\s+de\s+|de\s+)([^]{2,80}?)\s+(?:para|a)\s+([^]{2,80}?)(?=$|[.,;]|\s+(?:a partir|em|no dia|com vig[êe]ncia|conforme))/iu;
  const match = pattern.exec(text);
  if (match) return { previous: cleanRole(match[1]), next: cleanRole(match[2]) };

  const explicit = /(?:cargo|fun[çc][ãa]o|posi[çc][ãa]o)\s+(?:atual\s+)?(?:de\s+)?([^]{2,80}?)\s+para\s+([^]{2,80}?)(?=$|[.,;]|\s+(?:a partir|em|no dia|com vig[êe]ncia|conforme))/iu;
  const explicitMatch = explicit.exec(text);
  if (explicitMatch) return { previous: cleanRole(explicitMatch[1]), next: cleanRole(explicitMatch[2]) };
  return null;
}

/** Formas que informam apenas o cargo de destino. */
function extractNewRoleOnly(text: string) {
  const patterns = [
    /promovid[oa]\s+(?:a|para)\s+([^]{2,80}?)(?=$|[.,;]|\s+(?:a partir|em|no dia|com vig[êe]ncia|conforme))/iu,
    /(?:assumir[áa]|assume|ocupar[áa]|ocupa)\s+(?:o\s+cargo\s+de\s+|a\s+fun[çc][ãa]o\s+de\s+)([^]{2,80}?)(?=$|[.,;]|\s+(?:a partir|em|no dia|com vig[êe]ncia|conforme))/iu,
    /(?:nov[oa]\s+(?:cargo|fun[çc][ãa]o|posi[çc][ãa]o))\s*(?::|ser[áa]|é|e)?\s*([^]{2,80}?)(?=$|[.,;]|\s+(?:a partir|em|no dia|com vig[êe]ncia|conforme))/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const role = match ? cleanRole(match[1]) : "";
    if (role.length >= 2) return role;
  }
  return "";
}

function countHits(folded: string, list: string[]) {
  return list.filter((term) => folded.includes(term)).length;
}

function round(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/**
 * Admissão chega frequentemente como card, com “Nome completo: …”; os demais
 * eventos costumam citar o colaborador antes ou depois do gatilho. O cadastro
 * conhecido vence qualquer heurística, pois é a evidência menos ambígua.
 */
function extractOperationalName(text: string, triggerIndex: number, known: readonly string[]) {
  const foldedText = fold(text);
  const knownMatch = [...known]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => foldedText.includes(fold(candidate)));
  if (knownMatch) return knownMatch.slice(0, 160);

  const labelled = /nome\s+completo\s*:\s*([^]{3,160}?)(?=\s+(?:cpf|cnh|e-?mail|telefone|solicitad[oa]\s+por|\d+:)\s*:|$)/iu.exec(text);
  if (labelled) return labelled[1].replace(/[.,;:]+$/u, "").trim().slice(0, 160);

  const afterTrigger = /(?:desligamento|rescis[ãa]o|demiss[ãa]o|advert[êe]ncia|suspens[ãa]o)\s+(?:de|para|do|da)?\s*([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:(?:da|de|do|dos|das|e)\s+)?[A-ZÀ-Ý][a-zà-ÿ]+)+)/u.exec(text);
  if (afterTrigger) return afterTrigger[1].trim().slice(0, 160);

  const cardTitle = /^(?:aprovad[oa]|rejeitad[oa]|pendente)?\s*([A-ZÀ-Ý][A-ZÀ-Ý\s]{5,100}?)(?=\s*[-–—])/u.exec(text);
  if (cardTitle) return cardTitle[1].replace(/\s+/gu, " ").trim().slice(0, 160);

  return extractEmployeeName(text, triggerIndex);
}

/**
 * Interpreta a mensagem e devolve a movimentação, a confiança e a decisão.
 *
 * `knownEmployees` é opcional e serve para elevar a confiança quando o nome
 * citado existe no cadastro do workspace: casar com o cadastro é a evidência
 * mais forte de que a mensagem fala de uma pessoa real, e não de um exemplo.
 */
export function interpretTeamsMessage(rawText: unknown, knownEmployees: readonly string[] = []): TeamsInterpretation {
  const text = plainTextFromTeams(rawText);
  const empty: TeamsInterpretation = {
    kind: null, decision: "ignore", confidence: 0, employeeName: "",
    previousSalary: null, newSalary: null, previousRole: "", newRole: "",
    effectiveDate: "", missing: [], signals: [],
  };
  if (text.length < 12) return { ...empty, signals: ["mensagem_curta"] };

  const folded = fold(text);
  const salaryIndex = firstTriggerIndex(folded, text, SALARY_TRIGGERS);
  const roleIndex = firstTriggerIndex(folded, text, ROLE_TRIGGERS);
  const admissionCard = folded.includes("nome completo:") && folded.includes("cpf:")
    && (folded.includes("solicitado por") || folded.includes("resposta pendente"));
  const admissionTriggerIndex = firstTriggerIndex(folded, text, ADMISSION_TRIGGERS);
  const admissionIndex = admissionTriggerIndex >= 0 ? admissionTriggerIndex : admissionCard ? 0 : -1;
  const terminationIndex = firstTriggerIndex(folded, text, TERMINATION_TRIGGERS);
  const warningIndex = firstTriggerIndex(folded, text, WARNING_TRIGGERS);
  if ([salaryIndex, roleIndex, admissionIndex, terminationIndex, warningIndex].every((index) => index < 0)) {
    return { ...empty, signals: ["sem_gatilho_de_movimentacao"] };
  }

  const effectiveDate = extractEffectiveDate(text);
  const hypothetical = countHits(folded, HYPOTHETICAL);
  const negated = countHits(folded, NEGATION);
  const interrogative = text.includes("?") ? 1 : 0;

  const salary = salaryIndex >= 0 ? scoreSalary(text, salaryIndex, effectiveDate, knownEmployees) : null;
  const role = roleIndex >= 0 ? scoreRole(text, roleIndex, effectiveDate, knownEmployees) : null;
  const admission = admissionIndex >= 0 ? scoreOperational("admission", text, admissionIndex, effectiveDate, knownEmployees) : null;
  const termination = terminationIndex >= 0 ? scoreOperational("termination", text, terminationIndex, effectiveDate, knownEmployees) : null;
  const warning = warningIndex >= 0 ? scoreOperational("warning", text, warningIndex, effectiveDate, knownEmployees) : null;

  // Uma mensagem pode citar as duas coisas ("promovido a Analista com salário de
  // R$ 5.500"). Fica com a leitura mais bem evidenciada em vez de abrir duas
  // demandas a partir de um comunicado só.
  const chosen = [salary, role, admission, termination, warning]
    .filter((item): item is Scored => item !== null)
    .sort((left, right) => right.score - left.score)[0] ?? null;
  if (!chosen) return { ...empty, signals: ["sem_gatilho_de_movimentacao"] };

  const penalties: string[] = [];
  let score = chosen.score;
  if (interrogative) { score -= 0.35; penalties.push("pergunta"); }
  if (hypothetical) { score -= Math.min(0.45, 0.3 * hypothetical); penalties.push("linguagem_hipotetica"); }
  if (negated) { score -= 0.6; penalties.push("movimentacao_negada_ou_cancelada"); }

  const confidence = round(score);
  const missing = chosen.missing;
  // Abrir demanda exige nota alta **e** o conjunto mínimo de dados. Sem os dois,
  // vira sugestão: um cartão incompleto no fluxo do DP custa mais caro do que
  // uma sugestão que alguém confirma em cinco segundos.
  const decision: MovementDecision = confidence >= CREATE_THRESHOLD && missing.length === 0
    ? "create"
    : (chosen.kind === "salary_change" || chosen.kind === "role_change") && confidence >= REVIEW_THRESHOLD
      ? "review" : "ignore";

  return {
    kind: chosen.kind,
    decision,
    confidence,
    employeeName: chosen.employeeName,
    previousSalary: chosen.previousSalary,
    newSalary: chosen.newSalary,
    previousRole: chosen.previousRole,
    newRole: chosen.newRole,
    effectiveDate,
    missing,
    signals: [...chosen.signals, ...penalties],
  };
}

type Scored = {
  kind: MovementKind; score: number; employeeName: string;
  previousSalary: number | null; newSalary: number | null;
  previousRole: string; newRole: string; missing: string[]; signals: string[];
};

function nameScore(name: string, known: readonly string[]) {
  if (!name) return { bonus: 0, signal: "" };
  const folded = fold(name);
  const matched = known.some((candidate) => {
    const other = fold(candidate);
    return other === folded || other.includes(folded) || folded.includes(other);
  });
  return matched
    ? { bonus: 0.3, signal: "colaborador_encontrado_no_cadastro" }
    : { bonus: 0.2, signal: "nome_identificado" };
}

function scoreSalary(text: string, triggerIndex: number, effectiveDate: string, known: readonly string[]): Scored {
  const signals = ["gatilho_salarial"];
  let score = 0.4;

  const employeeName = extractEmployeeName(text, triggerIndex);
  const named = nameScore(employeeName, known);
  score += named.bonus;
  if (named.signal) signals.push(named.signal);

  const values = extractMoney(text);
  // "de R$ 4.000 para R$ 5.500" — o de destino é o último citado; com um valor
  // só, ele é o novo salário e o anterior fica em branco (a origem informa).
  const newSalary = values.length ? values[values.length - 1] : null;
  const previousSalary = values.length > 1 ? values[values.length - 2] : null;
  if (newSalary !== null) { score += 0.25; signals.push("valor_identificado"); }
  if (previousSalary !== null) { score += 0.05; signals.push("valor_anterior_identificado"); }
  if (effectiveDate) { score += 0.15; signals.push("vigencia_identificada"); }

  const missing: string[] = [];
  if (!employeeName) missing.push("colaborador");
  if (newSalary === null) missing.push("novoSalario");
  if (!effectiveDate) missing.push("dataVigencia");

  return {
    kind: "salary_change", score, employeeName, previousSalary, newSalary,
    previousRole: "", newRole: "", missing, signals,
  };
}

function scoreRole(text: string, triggerIndex: number, effectiveDate: string, known: readonly string[]): Scored {
  const signals = ["gatilho_de_cargo"];
  let score = 0.4;

  const employeeName = extractEmployeeName(text, triggerIndex);
  const named = nameScore(employeeName, known);
  score += named.bonus;
  if (named.signal) signals.push(named.signal);

  const pair = extractRolePair(text);
  const previousRole = pair?.previous ?? "";
  const newRole = pair?.next || extractNewRoleOnly(text);
  if (newRole) { score += 0.25; signals.push("cargo_destino_identificado"); }
  if (previousRole) { score += 0.05; signals.push("cargo_atual_identificado"); }
  if (effectiveDate) { score += 0.15; signals.push("vigencia_identificada"); }

  const missing: string[] = [];
  if (!employeeName) missing.push("colaborador");
  if (!newRole) missing.push("novoCargo");
  if (!effectiveDate) missing.push("dataVigencia");

  return {
    kind: "role_change", score, employeeName, previousSalary: null, newSalary: null,
    previousRole, newRole, missing, signals,
  };
}

function scoreOperational(kind: "admission" | "termination" | "warning", text: string, triggerIndex: number,
  effectiveDate: string, known: readonly string[]): Scored {
  const signals = [`gatilho_${kind}`];
  let score = kind === "admission" ? 0.55 : 0.45;
  const employeeName = extractOperationalName(text, triggerIndex, known);
  const named = nameScore(employeeName, known);
  // Um card admissional descreve candidato ainda ausente do cadastro; o rótulo
  // “Nome completo” é evidência suficiente mesmo sem correspondência interna.
  score += kind === "admission" && employeeName ? 0.3 : named.bonus;
  if (employeeName) signals.push(kind === "admission" ? "nome_do_card_identificado" : named.signal || "nome_identificado");
  if (effectiveDate) { score += 0.15; signals.push("vigencia_identificada"); }

  return {
    kind, score, employeeName, previousSalary: null, newSalary: null,
    previousRole: "", newRole: "", missing: employeeName ? [] : ["colaborador"], signals,
  };
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function brazilianDate(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return "não informada";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export const MOVEMENT_PROCESS_TYPE: Record<MovementKind, string> = {
  salary_change: "ALTERAÇÃO SALARIAL",
  role_change: "ALTERAÇÃO DE CARGO/FUNÇÃO",
  admission: "ADMISSÃO",
  termination: "DESLIGAMENTO",
  warning: "ADVERTÊNCIA",
};

export type TeamsMessageOrigin = {
  senderName: string;
  teamName: string;
  channelName: string;
  messageId: string;
  messageUrl: string;
  originalText: string;
};

/**
 * Demanda gerada a partir da movimentação, com o texto original preservado.
 *
 * A mensagem crua entra na descrição de propósito: quando a interpretação erra,
 * quem abrir o cartão precisa conseguir conferir contra o que foi realmente
 * publicado, sem ter que voltar ao Teams.
 */
export function movementTaskDraft(interpretation: TeamsInterpretation, origin: TeamsMessageOrigin) {
  const kind = interpretation.kind;
  if (!kind) throw new Error("movementTaskDraft exige uma movimentação reconhecida.");
  const employee = interpretation.employeeName || "colaborador não identificado";
  const vigencia = brazilianDate(interpretation.effectiveDate);
  const solicitante = origin.senderName || "não identificado";

  const common = [
    `Origem: Microsoft Teams · ${origin.teamName || "equipe não informada"} › ${origin.channelName || "canal não informado"}`,
    `Solicitante: ${solicitante}`,
    `Vigência: ${vigencia}`,
    origin.messageUrl ? `Mensagem: ${origin.messageUrl}` : `Identificador da mensagem: ${origin.messageId || "não informado"}`,
    `Confiança da interpretação: ${Math.round(interpretation.confidence * 100)}%`,
    "",
    "Mensagem original:",
    origin.originalText.slice(0, 1500),
  ];

  if (kind === "salary_change") {
    const previous = interpretation.previousSalary !== null ? BRL.format(interpretation.previousSalary) : "não informado";
    const next = interpretation.newSalary !== null ? BRL.format(interpretation.newSalary) : "não informado";
    return {
      processType: MOVEMENT_PROCESS_TYPE.salary_change,
      title: `Alteração salarial — ${employee}`.slice(0, 160),
      description: [
        `Alteração salarial identificada no Teams para ${employee}.`,
        `Salário anterior: ${previous} · Novo salário: ${next}`,
        ...common,
      ].join("\n").slice(0, 4000),
      checklist: [
        "Conferir a solicitação com o gestor responsável",
        "Validar o novo salário contra a faixa do cargo e o acordo coletivo",
        "Confirmar a data de vigência com a folha",
        "Registrar a alteração salarial no ERP/folha",
        "Atualizar o cadastro do colaborador no Vinculato",
        "Comunicar o colaborador e arquivar o comprovante",
      ],
    };
  }

  if (kind === "role_change") return {
    processType: MOVEMENT_PROCESS_TYPE.role_change,
    title: `Alteração de cargo/função — ${employee}`.slice(0, 160),
    description: [
      `Alteração de cargo/função identificada no Teams para ${employee}.`,
      `Cargo atual: ${interpretation.previousRole || "não informado"} · Novo cargo: ${interpretation.newRole || "não informado"}`,
      ...common,
    ].join("\n").slice(0, 4000),
    checklist: [
      "Conferir a solicitação com o gestor responsável",
      "Validar o novo cargo no plano de cargos e salários",
      "Verificar se há alteração salarial vinculada à mudança de função",
      "Confirmar a data de vigência com a folha",
      "Registrar a alteração de cargo no ERP/folha",
      "Atualizar o cadastro do colaborador no Vinculato",
      "Comunicar o colaborador e arquivar o comprovante",
    ],
  };

  const simple = {
    admission: {
      title: `Admissão — ${employee}`,
      intro: `Aprovação ou solicitação de admissão identificada no Teams para ${employee}.`,
      checklist: [
        "Conferir a decisão e os dados do candidato no card de aprovação",
        "Validar empresa, cargo, salário e data de admissão",
        "Conferir documentos obrigatórios e exame admissional",
        "Registrar ou acompanhar a admissão no sistema oficial",
        "Preparar acessos, benefícios e integração do novo colaborador",
        "Arquivar a evidência da aprovação ou da rejeição",
      ],
    },
    termination: {
      title: `Desligamento — ${employee}`,
      intro: `Solicitação de desligamento identificada no Teams para ${employee}.`,
      checklist: [
        "Conferir solicitante, motivo e aprovação do gestor",
        "Confirmar último dia e tipo de desligamento",
        "Calcular prazos de aviso, verbas e exame demissional",
        "Registrar o desligamento no sistema oficial",
        "Revogar acessos e recolher equipamentos",
        "Arquivar documentos e comprovantes da rescisão",
      ],
    },
    warning: {
      title: `Advertência — ${employee}`,
      intro: `Solicitação de advertência identificada no Teams para ${employee}.`,
      checklist: [
        "Conferir o relato, a data do fato e as evidências",
        "Validar a medida com o responsável de RH/DP",
        "Preparar o documento sem incluir dado sensível desnecessário",
        "Coletar ciência e assinaturas aplicáveis",
        "Registrar a medida no histórico funcional",
        "Arquivar documento e evidências com acesso restrito",
      ],
    },
  }[kind];

  return {
    processType: MOVEMENT_PROCESS_TYPE[kind],
    title: simple.title.slice(0, 160),
    description: [simple.intro, ...common].join("\n").slice(0, 4000),
    checklist: simple.checklist,
  };
}

