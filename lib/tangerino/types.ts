/**
 * Contratos do agente de consulta de admissão no Tangerino.
 *
 * O agente é **somente leitura**. Ele navega, pesquisa, abre e lê; não salva,
 * não aprova, não cancela. Essa restrição não é convenção de código: está
 * escrita no tipo da sessão — não existe método de escrita para chamar — e é
 * imposta em tempo de execução pela política de `read-only.ts`, que bloqueia o
 * método HTTP de alteração dentro do próprio navegador.
 *
 * O motivo de existir por navegador, e não por API: a API oficial do Tangerino
 * (`lib/tangerino.ts`) expõe `employee/find-all` filtrado por `lastUpdate` e
 * nada sobre o andamento de um processo admissional. Ela continua no projeto e
 * segue servindo à conciliação cadastral; o que ela não faz é responder "em que
 * pé está a admissão do João", que é o que esta camada responde.
 */

/**
 * Situação interna de uma admissão.
 *
 * Estes são os estados do **Vinculato**, não do Tangerino. Nenhum deles é um
 * texto que o Tangerino escreva: o mapa de tradução vive em `status.ts` e só
 * ganha entrada com evidência de tela real.
 */
export const admissionStatuses = [
  "PENDING",
  "IN_PROGRESS",
  "WAITING_CANDIDATE",
  "WAITING_DOCUMENTS",
  "DOCUMENT_ANALYSIS",
  "WAITING_SIGNATURE",
  "READY_FOR_ADMISSION",
  "COMPLETED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type AdmissionStatus = typeof admissionStatuses[number];

/**
 * Desfecho de uma consulta.
 *
 * `SUCCESS` é um dos doze, não o normal com exceções: cada um dos outros onze
 * descreve uma situação que a tela precisa saber distinguir. Tratar todos como
 * "erro" devolveria ao usuário a mesma frase para "o processo não existe" e
 * "a sessão do Tangerino caiu" — que pedem coisas diferentes de quem lê.
 */
export const consultationStates = [
  "QUEUED",
  "RUNNING",
  "SUCCESS",
  "NOT_FOUND",
  "MULTIPLE_MATCHES",
  "AUTHENTICATION_REQUIRED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "TANGERINO_UNAVAILABLE",
  "UI_CHANGED",
  "TIMEOUT",
  "CONSULTATION_FAILED",
] as const;
export type ConsultationState = typeof consultationStates[number];

/** Estados em que a consulta ainda pode mudar sozinha. */
export const activeConsultationStates: ReadonlySet<ConsultationState> = new Set(["QUEUED", "RUNNING"]);

/**
 * O que a tela do Tangerino devolveu, ainda como texto.
 *
 * É deliberadamente burro: strings do jeito que apareceram. A interpretação
 * acontece depois, em `parser.ts`, para que o teste de interpretação não precise
 * de navegador e o de navegação não precise de regra de negócio.
 *
 * Todo campo é opcional porque a tela pode não trazê-lo. `undefined` significa
 * "não veio", nunca "veio vazio" — a diferença importa: um campo ausente pode
 * ser mudança de layout, um campo vazio é um dado que o Tangerino não tem.
 */
export type AdmissionSnapshot = {
  /** Identificador do processo no Tangerino, quando a tela o expõe. */
  externalAdmissionId?: string;
  /** O texto de situação, exatamente como escrito na tela. */
  rawStatus?: string;
  /** Etapa do fluxo, quando a tela separa etapa de situação. */
  stage?: string;
  /** O que falta, quando a tela diz. */
  pendingReason?: string;
  /** Data de admissão prevista ou registrada. */
  admissionDate?: string;
  /** Quando o Tangerino diz ter atualizado o processo. */
  sourceUpdatedAt?: string;
  /** Nome exibido no processo aberto, para conferir que é quem se procurou. */
  displayName?: string;
};

/**
 * Uma linha do resultado da pesquisa.
 *
 * `id` é o que permite abrir o processo sem depender do nome de novo; quando a
 * tela não o expõe, o cliente devolve a posição da linha, que é o mínimo para
 * abrir sem adivinhar.
 */
export type AdmissionSearchHit = {
  id: string;
  label: string;
};

/** Resultado estruturado da leitura, já interpretado. */
export type ParsedAdmission = {
  externalAdmissionId: string;
  rawStatus: string;
  normalizedStatus: AdmissionStatus;
  stage: string;
  pendingReason: string;
  admissionDate: string;
  sourceUpdatedAt: string;
};

/** O que o agente devolve ao Vinculato quando a consulta termina. */
export type ConsultationResult = {
  state: ConsultationState;
  source: "BROWSER";
  errorCode: string;
  admission: ParsedAdmission | null;
  /** Quantos processos a pesquisa encontrou. Só é lido em `MULTIPLE_MATCHES`. */
  matchCount: number;
  consultedAt: string;
  durationMs: number;
};

/**
 * Os únicos comandos que o agente sabe executar.
 *
 * A lista é fechada de propósito. Não existe `clickAnything`, e por isso não
 * existe caminho — nem por engano, nem por instrução vinda da página — que leve
 * o navegador a apertar "Salvar". Se um dia for preciso escrever no Tangerino,
 * isso será outro tipo, com outra revisão, e não um parâmetro a mais aqui.
 */
export interface TangerinoBrowserSession {
  /** Garante sessão válida. Lança `AUTHENTICATION_REQUIRED` diante de MFA/CAPTCHA. */
  ensureAuthenticated(input: { endpoint: string; username: string; password: string; timeoutMs: number }): Promise<void>;
  /** Abre a área de Admissão. */
  openAdmissions(): Promise<void>;
  /** Pesquisa e devolve os cartões encontrados, sem escolher nenhum. */
  searchAdmission(term: string): Promise<AdmissionSearchHit[]>;
  /** Seleciona em memória um cartão já identificado, sem abrir ações da ficha. */
  openAdmission(hit: AdmissionSearchHit): Promise<void>;
  /** Lê situação e etapa do cartão selecionado. */
  readAdmission(): Promise<AdmissionSnapshot>;
  /** Limpa a seleção sem alterar nem navegar pelo processo. */
  back(): Promise<void>;
  /** Encerra a sessão e destrói o contexto. */
  close(): Promise<void>;
}

/** Extensão usada somente pelo job que já possui autorização explícita. */
export interface TangerinoArtifactSession extends TangerinoBrowserSession {
  /** Baixa os documentos e a ficha da admissão selecionada, sem aprovar nada. */
  downloadAdmissionArtifacts(input: { externalAdmissionId: string; targetDirectory: string }): Promise<{
    documentArchivePath: string;
    registrationFormPath: string;
  }>;
}

export type TangerinoSessionFactory = (input: {
  workspaceId: string;
  integrationId: string;
  consultationId: string;
}) => Promise<TangerinoBrowserSession>;

/**
 * O que o backend entrega ao agente.
 *
 * Vem inteiro do servidor: o frontend manda o `employeeId` e mais nada. Deixar
 * o navegador pesquisar o termo que o cliente pedir seria dar ao usuário uma
 * consulta livre dentro do Tangerino da empresa — que é a definição do problema
 * que a §78 proíbe. Não há campo de CPF aqui, e é assim que ele não vira termo
 * digitado num sistema de terceiro.
 */
export type AdmissionConsultationTarget = {
  workspaceId: string;
  companyId: string;
  employeeId: string;
  /** Vínculo já salvo, quando existe. Torna a segunda consulta determinística. */
  externalAdmissionId: string;
  registrationNumber: string;
  fullName: string;
};
