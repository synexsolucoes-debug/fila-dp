import { tangerinoErrors } from "./errors.ts";
import { normalizeAdmissionStatus } from "./status.ts";
import type { AdmissionSnapshot, AdmissionSearchHit, ParsedAdmission } from "./types.ts";

/**
 * Interpretação do que o navegador leu.
 *
 * Separado do cliente de navegador de propósito: aqui não há Playwright, não há
 * rede e não há tela. A entrada é o `AdmissionSnapshot` — strings — e a saída é
 * o registro estruturado. Isso torna a regra de interpretação testável sem
 * levantar navegador, que é a diferença entre ter cobertura de verdade nos
 * casos difíceis e ter um teste que ninguém roda.
 */

const MAX_TEXT = 300;

function clean(value: string | undefined, max = MAX_TEXT) {
  if (typeof value !== "string") return "";
  // Tela de sistema vem com espaço duplo, quebra de linha e espaço fino; nada
  // disso é informação, e tudo isso quebra comparação de status entre consultas.
  return value.replace(/[\s ]+/gu, " ").trim().slice(0, max);
}

/** Índice visual serve para selecionar nesta leitura, nunca para criar vínculo. */
export function isStableExternalAdmissionId(value: string | undefined) {
  const id = clean(value, 120);
  return Boolean(id) && !/^(?:card|row):\d+$/u.test(id);
}

/**
 * Datas de tela brasileira viram ISO; o resto é devolvido como veio.
 *
 * Devolver o texto original quando não dá para converter é deliberado: é melhor
 * a tela mostrar "a partir de 12/2026" do que um campo vazio que faz parecer
 * que o Tangerino não informou nada.
 */
export function parseAdmissionDate(value: string | undefined) {
  const raw = clean(value, 40);
  if (!raw) return "";
  const brazilian = /(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(raw);
  if (brazilian) {
    const [, day, month, year] = brazilian;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? raw : iso;
  }
  const isoLike = /(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  if (isoLike) return isoLike[0];
  return raw;
}

/** Data e hora da última atualização, quando a tela traz as duas. */
export function parseSourceUpdatedAt(value: string | undefined) {
  const raw = clean(value, 60);
  if (!raw) return "";
  const stamp = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]{1,4}(\d{1,2}):(\d{2}))?/u.exec(raw);
  if (!stamp) return raw;
  const [, day, month, year, hour, minute] = stamp;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return raw;
  return hour ? `${date}T${hour.padStart(2, "0")}:${minute}` : date;
}

/**
 * O snapshot vira registro — ou a consulta falha dizendo o que faltou.
 *
 * O campo sem o qual não existe resposta é a situação. Sem ela não há o que
 * normalizar, o que comparar com a consulta anterior, nem o que mostrar; e a
 * causa quase certa de ela não estar lá é a tela ter mudado. Devolver `UNKNOWN`
 * neste caso seria transformar quebra de layout em "situação desconhecida" —
 * que parece resposta e não pede conserto de ninguém.
 *
 * Os demais campos são opcionais de verdade: nem todo processo tem pendência,
 * nem toda tela expõe protocolo. Ausência ali vira string vazia, e a tela mostra
 * só o que existe (§60).
 */
export function parseAdmission(snapshot: AdmissionSnapshot): ParsedAdmission {
  const rawStatus = clean(snapshot.rawStatus);
  if (!rawStatus) throw tangerinoErrors.uiChanged("leitura do processo", "situação da admissão");
  return {
    externalAdmissionId: clean(snapshot.externalAdmissionId, 120),
    rawStatus,
    normalizedStatus: normalizeAdmissionStatus(rawStatus),
    stage: clean(snapshot.stage, 120),
    pendingReason: clean(snapshot.pendingReason),
    admissionDate: parseAdmissionDate(snapshot.admissionDate),
    sourceUpdatedAt: parseSourceUpdatedAt(snapshot.sourceUpdatedAt),
  };
}

/**
 * Escolhe o processo — ou recusa a escolher.
 *
 * Três caminhos, e o terceiro é o que protege o dado: nenhum resultado é
 * `NOT_FOUND`, um resultado é o resultado, e mais de um é `MULTIPLE_MATCHES`.
 * Não existe "pega o primeiro", não existe "o mais parecido", não existe
 * desempate por semelhança de nome. Homônimo em folha de pagamento não é caso
 * raro, e um vínculo errado aqui contamina todas as consultas seguintes — porque
 * o `externalAdmissionId` do processo errado fica salvo (§47) e passa a ser
 * usado direto, sem nova pesquisa.
 *
 * Quando o vínculo externo já existe, ele é o critério: se uma das linhas o
 * carrega, ela vence sem empate. É por isso que a primeira consulta é a única
 * cara e as seguintes são determinísticas (§18).
 */
export function chooseAdmission(hits: readonly AdmissionSearchHit[], knownExternalId: string): AdmissionSearchHit {
  if (isStableExternalAdmissionId(knownExternalId)) {
    const exact = hits.filter((hit) => hit.id === knownExternalId);
    if (exact.length === 1) return exact[0];
  }
  if (hits.length === 0) throw tangerinoErrors.notFound();
  if (hits.length > 1) throw tangerinoErrors.multipleMatches(hits.length);
  return hits[0];
}

/**
 * O termo que o agente vai digitar na pesquisa do Tangerino.
 *
 * Prioridade da §18: identificador externo, matrícula, nome. O CPF não entra —
 * nem como último recurso. Ele viraria termo de busca digitado num campo de
 * terceiro, que é exatamente o caminho pelo qual um dado sensível sai do
 * controle do Vinculato sem que ninguém tenha decidido isso; e o par
 * matrícula + empresa já identifica a pessoa dentro do grupo.
 *
 * O termo é sempre derivado no servidor, do cadastro do colaborador. O frontend
 * manda o `employeeId` e nada mais (§17).
 */
export function admissionSearchTerm(target: { externalAdmissionId: string; registrationNumber: string; fullName: string }) {
  const externalId = isStableExternalAdmissionId(target.externalAdmissionId)
    ? clean(target.externalAdmissionId, 120)
    : "";
  const term = externalId || clean(target.registrationNumber, 60) || clean(target.fullName, 160);
  if (!term) {
    throw tangerinoErrors.uiChanged("preparação da pesquisa", "identificador do colaborador no cadastro do Vinculato");
  }
  return term;
}

/**
 * Compara duas consultas para saber se houve mudança.
 *
 * Compara o texto original, e não a situação normalizada. Duas frases diferentes
 * que hoje caem em `UNKNOWN` são mudança real do processo — e é justamente delas
 * que sai a evidência para completar o mapa de `status.ts`. Comparar o
 * normalizado esconderia toda alteração dentro de `UNKNOWN`.
 */
export function admissionChanged(previous: { rawStatus: string; normalizedStatus: string; stage?: string } | null, current: ParsedAdmission) {
  if (!previous) return true;
  return previous.rawStatus !== current.rawStatus
    || previous.normalizedStatus !== current.normalizedStatus
    || (previous.stage ?? "") !== current.stage;
}

/**
 * Gatilho operacional pedido pelo DP.
 *
 * A demanda do ERP não nasce de `rawStatus`: o Tangerino pode manter a situação
 * como "Em andamento" durante várias etapas. O dado inequívoco é a etapa que a
 * tela separa como `stage`. Normalizar acentos, caixa e pontuação evita que uma
 * alteração puramente visual ("DADOS CONTRATUAIS", por exemplo) desligue o
 * gatilho, sem aceitar sinônimos que nunca foram confirmados na tela real.
 */
export function isContractDataStage(stage: string) {
  const normalized = clean(stage, 120)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  return /(?:^|\s)dados contratuais(?:\s|$)/u.test(normalized);
}
