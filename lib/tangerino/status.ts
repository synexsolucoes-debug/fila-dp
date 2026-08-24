import type { AdmissionStatus } from "./types.ts";

/**
 * Tradução do texto do Tangerino para a situação interna do Vinculato.
 *
 * A regra que governa este arquivo é a mais fácil de quebrar sem perceber:
 * **incerteza não vira dado**. Um mapa generoso, que chuta a partir de palavras
 * soltas, produz exatamente o defeito mais caro que esta integração pode ter —
 * dizer "admissão concluída" para um processo que está parado. O usuário toma
 * decisão em cima disso: para de cobrar documento, fecha a demanda, admite no
 * ERP. Um `UNKNOWN` com o texto original ao lado custa uma leitura; um
 * `COMPLETED` errado custa uma admissão errada.
 *
 * Por isso cada padrão abaixo carrega de onde veio, e a lista cresce só quando
 * alguém viu a frase na tela. O `rawStatus` é preservado em todo caminho — a
 * tela mostra os dois, e quem lê decide se a tradução faz sentido.
 */

/**
 * De onde saiu cada padrão.
 *
 * `requisito` — a frase foi dada por escrito por quem conhece o Tangerino.
 * `dp_inequivoco` — a frase não é do Tangerino, mas é vocabulário de DP cujo
 *   sentido não muda de sistema para sistema ("aguardando assinatura" não
 *   significa outra coisa em lugar nenhum). Entram só as que passam nesse teste.
 * `tela` — confirmada na interface real durante o mapeamento da §72.
 *
 * Nada além destes três entra. "Parece que deve ser" não é evidência.
 */
export type StatusEvidence = "requisito" | "dp_inequivoco" | "tela";

export type StatusRule = {
  pattern: RegExp;
  status: AdmissionStatus;
  evidence: StatusEvidence;
};

/**
 * A ordem importa: a primeira regra que casar decide.
 *
 * As mais específicas vêm primeiro porque frases de DP se aninham — "aguardando
 * assinatura do contrato" contém "aguardando", e "documentação em análise"
 * contém "documenta". Uma ordem alfabética ou acidental faria a regra larga
 * comer a estreita e o resultado seria plausível o bastante para ninguém notar.
 */
export const statusRules: readonly StatusRule[] = Object.freeze([
  // Cancelamento primeiro: um processo cancelado pode continuar exibindo a
  // etapa em que parou, e a etapa não é a situação.
  { pattern: /\bcancelad[oa]\b|\bprocesso cancelado\b/iu, status: "CANCELLED", evidence: "dp_inequivoco" },
  { pattern: /\bdesistiu\b|\bdesist[êe]ncia\b/iu, status: "CANCELLED", evidence: "dp_inequivoco" },

  // Valores observados literalmente no campo "Status da admissão" em 24/08/2026.
  { pattern: /^conclu[íi]d[oa]$/iu, status: "COMPLETED", evidence: "tela" },
  { pattern: /^em andamento$/iu, status: "IN_PROGRESS", evidence: "tela" },

  { pattern: /\badmiss[ãa]o (?:conclu[íi]da|finalizada|efetivada)\b/iu, status: "COMPLETED", evidence: "dp_inequivoco" },
  { pattern: /\b(?:processo )?conclu[íi]d[oa]\b|\bfinalizad[oa]\b|\badmitid[oa]\b/iu, status: "COMPLETED", evidence: "dp_inequivoco" },

  { pattern: /\bpronto para admiss[ãa]o\b|\bapto (?:para|à) admiss[ãa]o\b|\baguardando admiss[ãa]o\b/iu, status: "READY_FOR_ADMISSION", evidence: "dp_inequivoco" },

  { pattern: /\baguardando assinatura\b|\bpendente de assinatura\b|\bassinatura pendente\b/iu, status: "WAITING_SIGNATURE", evidence: "dp_inequivoco" },

  // "Documentação em análise" é a frase que o pedido usa na tela de exemplo.
  { pattern: /\bdocumenta[çc][ãa]o em an[áa]lise\b|\bem an[áa]lise documental\b|\ban[áa]lise (?:de |da )?documenta[çc][ãa]o\b/iu, status: "DOCUMENT_ANALYSIS", evidence: "requisito" },
  { pattern: /\bdocumentos? em (?:an[áa]lise|confer[êe]ncia)\b|\bconferindo documenta[çc][ãa]o\b/iu, status: "DOCUMENT_ANALYSIS", evidence: "dp_inequivoco" },

  // A frase literal do pedido: "ainda não enviou todos os documentos necessários".
  { pattern: /\bn[ãa]o enviou (?:todos os |os )?documentos\b/iu, status: "WAITING_DOCUMENTS", evidence: "requisito" },
  { pattern: /\baguardando documenta[çc][ãa]o\b|\baguardando documentos\b|\bdocumenta[çc][ãa]o pendente\b|\bdocumentos? pendentes?\b|\bpend[êe]ncia documental\b/iu, status: "WAITING_DOCUMENTS", evidence: "requisito" },
  { pattern: /\benvio de documentos\b|\bfalta(?:m|ndo)? documentos?\b/iu, status: "WAITING_DOCUMENTS", evidence: "dp_inequivoco" },

  { pattern: /\baguardando (?:o |a )?(?:candidat|colaborador|preenchimento|cadastro do)/iu, status: "WAITING_CANDIDATE", evidence: "dp_inequivoco" },
  { pattern: /\bficha (?:de admiss[ãa]o )?n[ãa]o preenchida\b|\bconvite (?:enviado|pendente)\b/iu, status: "WAITING_CANDIDATE", evidence: "dp_inequivoco" },

  { pattern: /\bem andamento\b|\bem progresso\b|\biniciad[oa]\b/iu, status: "IN_PROGRESS", evidence: "dp_inequivoco" },

  { pattern: /\bn[ãa]o iniciad[oa]\b|\baguardando in[íi]cio\b|\bpendente\b/iu, status: "PENDING", evidence: "dp_inequivoco" },
]);

/**
 * Normaliza sem tirar conclusão do vazio.
 *
 * Texto vazio devolve `UNKNOWN`, e não `PENDING`: "a tela não trouxe situação"
 * e "a situação é pendente" são coisas diferentes, e só a primeira é verdade
 * quando não veio nada.
 */
export function normalizeAdmissionStatus(rawStatus: string): AdmissionStatus {
  const text = rawStatus.trim();
  if (!text) return "UNKNOWN";
  for (const rule of statusRules) {
    if (rule.pattern.test(text)) return rule.status;
  }
  return "UNKNOWN";
}

/**
 * A regra que decidiu, para quem for auditar a tradução depois.
 *
 * Existe porque "por que isso virou COMPLETED?" é a primeira pergunta de quem
 * desconfia do resultado, e a resposta precisa ser um padrão nomeado, não uma
 * releitura do arquivo.
 */
export function explainAdmissionStatus(rawStatus: string) {
  const text = rawStatus.trim();
  if (!text) return { status: "UNKNOWN" as AdmissionStatus, rule: null, evidence: null };
  for (const rule of statusRules) {
    if (rule.pattern.test(text)) return { status: rule.status, rule: rule.pattern.source, evidence: rule.evidence };
  }
  return { status: "UNKNOWN" as AdmissionStatus, rule: null, evidence: null };
}

/** Rótulos em português para a tela; `UNKNOWN` diz o que fazer, não só o que é. */
export const admissionStatusLabels: Record<AdmissionStatus, string> = {
  PENDING: "Não iniciado",
  IN_PROGRESS: "Em andamento",
  WAITING_CANDIDATE: "Aguardando o colaborador",
  WAITING_DOCUMENTS: "Aguardando documentos",
  DOCUMENT_ANALYSIS: "Documentação em análise",
  WAITING_SIGNATURE: "Aguardando assinatura",
  READY_FOR_ADMISSION: "Pronto para admissão",
  COMPLETED: "Admissão concluída",
  CANCELLED: "Processo cancelado",
  UNKNOWN: "Situação não reconhecida — leia o texto original",
};

/**
 * Situações que encerram o processo.
 *
 * Usado para decidir se vale voltar a consultar. Não usado para alterar demanda
 * nenhuma: a §50 é explícita, e nesta versão o Vinculato detecta, registra e
 * mostra — quem avança o processo continua sendo uma pessoa.
 */
export const terminalAdmissionStatuses: ReadonlySet<AdmissionStatus> = new Set(["COMPLETED", "CANCELLED"]);
