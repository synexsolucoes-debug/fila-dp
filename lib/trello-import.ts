/**
 * Importador de quadro do Trello (item 1 do roadmap de
 * `docs/engenharia-reversa-trello.md`, §15 e §17).
 *
 * ## Por que em duas metades
 *
 * O JSON exportado de um quadro grande passa fácil de 10 MB, quase tudo
 * `actions` que não interessam (cada clique é uma ação). A função de entrada de
 * um servidor na Vercel recusa corpo acima de ~4,5 MB. Então:
 *
 * 1. **`readTrelloExport`** roda no navegador sobre o arquivo cru e devolve só o
 *    que o importador usa — no **mesmo formato** do Trello, um subconjunto. A
 *    rota roda a mesma função de novo sobre o que recebeu: a leitura é
 *    idempotente, e o servidor nunca confia no que a tela mandou só porque a
 *    tela mandou.
 * 2. **`planTrelloImport`** recebe o quadro lido e as escolhas de quem importa e
 *    devolve o plano: colunas, demandas, itens, comentários, etiquetas e avisos.
 *    A prévia mostra o plano; a gravação grava o plano. As duas leem a mesma
 *    função, então o que a prévia promete é o que entra.
 *
 * ## O que o Trello não diz e o importador pergunta (§17, "não copiar")
 *
 * O cartão do Trello é genérico; a demanda do Vinculato tem empresa e tipo de
 * processo. O importador **nunca** inventa os dois: a empresa vem de uma
 * etiqueta escolhida por quem importa (etiqueta "Padaria Pão Quente" → empresa
 * Padaria Pão Quente) ou da empresa padrão escolhida na prévia; o tipo de
 * processo, igual. Membro do Trello vira responsável **só** se alguém casou os
 * dois na prévia — o JSON não traz e-mail, e casar por nome é o defeito que o
 * §18 corrigiu na menção.
 *
 * ## Limites honestos do arquivo
 *
 * - `actions` vem truncado pelo Trello (as mais recentes). O plano diz quantos
 *   comentários leu e a data do mais antigo, em vez de fingir que trouxe tudo.
 * - Anexo do Trello é URL protegida pelo token de quem exportou. Entra como
 *   link na descrição, não como arquivo: baixar documento pessoal de terceiro é
 *   uma etapa separada, com aprovação.
 * - Data de criação do cartão não tem campo: vem dos 8 primeiros caracteres do
 *   id (segundos Unix, §2.1).
 */

/* ── Formato lido (subconjunto do JSON do Trello) ─────────────────────────── */

export type TrelloLabel = { id: string; name: string; color: string | null };
export type TrelloList = { id: string; name: string; closed: boolean; pos: number };
export type TrelloMember = { id: string; fullName: string; username: string };
export type TrelloCheckItem = { id: string; name: string; state: "complete" | "incomplete"; pos: number };
export type TrelloChecklist = { id: string; idCard: string; name: string; pos: number; checkItems: TrelloCheckItem[] };
export type TrelloCustomField = { id: string; name: string; type: string; options: Array<{ id: string; value: { text: string } }> };
export type TrelloCustomFieldItem = {
  idCustomField: string;
  idValue?: string | null;
  value?: { text?: string; number?: string; date?: string; checked?: string } | null;
};
export type TrelloAttachment = { id: string; name: string; url: string };
export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  closed: boolean;
  idList: string;
  pos: number;
  idShort: number | null;
  shortLink: string;
  due: string | null;
  dueComplete: boolean;
  /** Última atividade de qualquer tipo — o mais perto da conclusão que o arquivo diz. */
  dateLastActivity: string | null;
  idLabels: string[];
  idMembers: string[];
  customFieldItems: TrelloCustomFieldItem[];
  attachments: TrelloAttachment[];
};
/** Só comentários: `type` fica fixo em `commentCard`. */
export type TrelloCommentAction = {
  id: string;
  type: "commentCard";
  date: string;
  idMemberCreator: string;
  memberCreator?: { fullName: string } | null;
  data: { text: string; card: { id: string } };
};

export type TrelloBoardExport = {
  id: string;
  name: string;
  desc: string;
  url: string;
  labels: TrelloLabel[];
  lists: TrelloList[];
  members: TrelloMember[];
  cards: TrelloCard[];
  checklists: TrelloChecklist[];
  customFields: TrelloCustomField[];
  actions: TrelloCommentAction[];
};

export class TrelloImportError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/* ── Limites ──────────────────────────────────────────────────────────────── */

export const TRELLO_IMPORT_LIMITS = {
  cards: 2000,
  lists: 40,
  labels: 200,
  commentsPerCard: 100,
  checkItemsPerCard: 200,
  title: 180,
  description: 5000,
  comment: 2000,
  checkItem: 280,
} as const;

/* ── Leitura ──────────────────────────────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, max = 20_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const TRELLO_ID = /^[0-9a-f]{24}$/u;

function trelloId(value: unknown): string {
  const id = str(value, 40);
  return TRELLO_ID.test(id) ? id : "";
}

function isoDate(value: unknown): string | null {
  const raw = str(value, 40);
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * O JSON exportado (ou o recorte que a tela já leu) → só o que o importador usa.
 *
 * Recusa o que não é um quadro do Trello em vez de importar um quadro vazio: um
 * arquivo errado que "importa com sucesso" zero demandas é pior do que um erro.
 */
export function readTrelloExport(raw: unknown): TrelloBoardExport {
  const board = record(raw);
  const id = trelloId(board.id);
  const lists = array(board.lists);
  const cards = array(board.cards);
  if (!id || !Array.isArray(board.lists) || !Array.isArray(board.cards)) {
    throw new TrelloImportError("Este arquivo não é o JSON exportado de um quadro do Trello. No Trello: Menu do quadro → Imprimir, exportar e compartilhar → Exportar como JSON.", "TRELLO_NOT_A_BOARD");
  }
  if (cards.length > TRELLO_IMPORT_LIMITS.cards) {
    throw new TrelloImportError(`O quadro tem ${cards.length} cartões; o importador aceita até ${TRELLO_IMPORT_LIMITS.cards} por vez. Arquive no Trello os cartões antigos e exporte de novo.`, "TRELLO_TOO_MANY_CARDS");
  }
  if (lists.length > TRELLO_IMPORT_LIMITS.lists) {
    throw new TrelloImportError(`O quadro tem ${lists.length} listas; o importador aceita até ${TRELLO_IMPORT_LIMITS.lists}.`, "TRELLO_TOO_MANY_LISTS");
  }
  const parsedLists = lists.map((item) => {
    const list = record(item);
    return { id: trelloId(list.id), name: str(list.name, 200).trim(), closed: list.closed === true, pos: num(list.pos) };
  }).filter((list) => list.id);
  const listIds = new Set(parsedLists.map((list) => list.id));
  const parsedCards: TrelloCard[] = cards.map((item) => {
    const card = record(item);
    return {
      id: trelloId(card.id),
      name: str(card.name, 1000).trim(),
      desc: str(card.desc),
      closed: card.closed === true,
      idList: trelloId(card.idList),
      pos: num(card.pos),
      idShort: Number.isInteger(card.idShort) ? Number(card.idShort) : null,
      shortLink: str(card.shortLink, 20).replace(/[^A-Za-z0-9]/gu, ""),
      due: isoDate(card.due),
      dueComplete: card.dueComplete === true,
      dateLastActivity: isoDate(card.dateLastActivity),
      idLabels: array(card.idLabels).map(trelloId).filter(Boolean),
      idMembers: array(card.idMembers).map(trelloId).filter(Boolean),
      customFieldItems: array(card.customFieldItems).map((entry) => {
        const field = record(entry);
        const value = record(field.value);
        return {
          idCustomField: trelloId(field.idCustomField),
          idValue: trelloId(field.idValue) || null,
          value: field.value ? {
            text: str(value.text, 1000) || undefined,
            number: str(value.number, 40) || undefined,
            date: str(value.date, 40) || undefined,
            checked: str(value.checked, 10) || undefined,
          } : null,
        };
      }).filter((field) => field.idCustomField),
      attachments: array(card.attachments).map((entry) => {
        const attachment = record(entry);
        return { id: trelloId(attachment.id), name: str(attachment.name, 200).trim(), url: str(attachment.url, 2000) };
      }).filter((attachment) => attachment.id && /^https:\/\//u.test(attachment.url)),
    };
  }).filter((card) => card.id && listIds.has(card.idList));
  const cardIds = new Set(parsedCards.map((card) => card.id));
  return {
    id,
    name: str(board.name, 200).trim() || "Quadro do Trello",
    desc: str(board.desc, 2000),
    url: str(board.url, 500),
    labels: array(board.labels).map((item) => {
      const label = record(item);
      return { id: trelloId(label.id), name: str(label.name, 80).trim(), color: str(label.color, 30) || null };
    }).filter((label) => label.id).slice(0, TRELLO_IMPORT_LIMITS.labels),
    lists: parsedLists,
    members: array(board.members).map((item) => {
      const member = record(item);
      return { id: trelloId(member.id), fullName: str(member.fullName, 160).trim(), username: str(member.username, 80).trim() };
    }).filter((member) => member.id),
    cards: parsedCards,
    checklists: array(board.checklists).map((item) => {
      const checklist = record(item);
      return {
        id: trelloId(checklist.id),
        idCard: trelloId(checklist.idCard),
        name: str(checklist.name, 160).trim(),
        pos: num(checklist.pos),
        checkItems: array(checklist.checkItems).map((entry) => {
          const checkItem = record(entry);
          return { id: trelloId(checkItem.id), name: str(checkItem.name, 1000).trim(), state: checkItem.state === "complete" ? "complete" as const : "incomplete" as const, pos: num(checkItem.pos) };
        }).filter((checkItem) => checkItem.id && checkItem.name),
      };
    }).filter((checklist) => checklist.id && cardIds.has(checklist.idCard)),
    customFields: array(board.customFields).map((item) => {
      const field = record(item);
      return {
        id: trelloId(field.id),
        name: str(field.name, 120).trim(),
        type: str(field.type, 20),
        options: array(field.options).map((entry) => {
          const option = record(entry);
          return { id: trelloId(option.id), value: { text: str(record(option.value).text, 200) } };
        }).filter((option) => option.id),
      };
    }).filter((field) => field.id),
    actions: array(board.actions).flatMap((item): TrelloCommentAction[] => {
      const action = record(item);
      const data = record(action.data);
      const cardId = trelloId(record(data.card).id);
      const body = str(data.text);
      const date = isoDate(action.date);
      if (action.type !== "commentCard" || !cardIds.has(cardId) || !body.trim() || !date) return [];
      const creator = record(action.memberCreator);
      return [{
        id: trelloId(action.id) || `${cardId}-${date}`,
        type: "commentCard",
        date,
        idMemberCreator: trelloId(action.idMemberCreator),
        memberCreator: creator.fullName ? { fullName: str(creator.fullName, 160) } : null,
        data: { text: body, card: { id: cardId } },
      }];
    }),
  };
}

/** Data de criação lida do ObjectId: os 8 primeiros hexadecimais são segundos Unix. */
export function trelloCreatedAt(id: string): string | null {
  if (!TRELLO_ID.test(id)) return null;
  const seconds = Number.parseInt(id.slice(0, 8), 16);
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/* ── Escolhas de quem importa ─────────────────────────────────────────────── */

export type SlaBehavior = "running" | "paused" | "completed";

export type TrelloImportMapping = {
  boardName: string;
  /** Empresa da demanda quando nenhuma etiqueta de empresa estiver no cartão. */
  defaultCompanyId: string;
  /** Etiqueta do Trello → empresa do Vinculato. */
  labelCompany: Record<string, string>;
  defaultProcessType: string;
  /** Etiqueta do Trello → tipo de processo. */
  labelProcessType: Record<string, string>;
  /** Lista do Trello → comportamento do SLA na coluna. */
  listBehavior: Record<string, SlaBehavior>;
  /** Membro do Trello → usuário do Vinculato, confirmado à mão. */
  members: Record<string, string>;
  /** Cartões e listas arquivados no Trello entram arquivados (ou ficam de fora). */
  includeArchived: boolean;
};

/** O que existe no workspace e a prévia precisa para validar as escolhas. */
export type TrelloImportContext = {
  companies: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Quem pode ser responsável: administrador ou membro. `companyIds` nulo é
   * acesso a todas as empresas (administrador); senão, só as da lista — a
   * notificação de responsável leva o título da demanda.
   */
  members: ReadonlyArray<{ userId: string; name: string; companyIds?: ReadonlySet<string> | null }>;
  /** Tipos de processo aceitos — a validação de `validProcessType` fica na rota. */
  isValidProcessType: (value: string) => string | null;
};

/* ── Plano ────────────────────────────────────────────────────────────────── */

export type PlannedList = { trelloId: string; name: string; kind: string; slaBehavior: SlaBehavior; position: number };
export type PlannedCard = {
  trelloId: string;
  listIndex: number;
  title: string;
  description: string;
  companyId: string;
  processType: string;
  position: number;
  dueAt: string | null;
  archived: boolean;
  createdAt: string | null;
  /** Para coluna concluída: a última atividade no Trello, ou a criação. */
  closedAt: string | null;
  labelTrelloIds: string[];
  assigneeUserIds: string[];
  checklist: Array<{ title: string; completed: boolean; position: number }>;
  comments: Array<{ body: string; createdAt: string }>;
};
export type PlannedLabel = { trelloId: string; name: string; color: string };

export type TrelloImportPlan = {
  boardName: string;
  lists: PlannedList[];
  labels: PlannedLabel[];
  cards: PlannedCard[];
  summary: {
    cards: number;
    archivedCards: number;
    skippedArchived: number;
    checklistItems: number;
    comments: number;
    oldestComment: string | null;
    attachmentsAsLinks: number;
    unmappedMembers: string[];
  };
  warnings: string[];
};

/** A paleta do Trello em cores do Vinculato; sem cor vira cinza neutro. */
const LABEL_COLORS: Record<string, string> = {
  green: "#16a34a", yellow: "#ca8a04", orange: "#ea580c", red: "#dc2626", purple: "#9333ea",
  blue: "#2563eb", sky: "#0284c7", lime: "#65a30d", pink: "#db2777", black: "#334155",
};

export function trelloLabelColor(color: string | null): string {
  const base = (color ?? "").replace(/_(light|dark)$/u, "");
  return LABEL_COLORS[base] ?? "#64748b";
}

function labelDisplayName(label: TrelloLabel): string {
  return label.name || `Trello · ${label.color ?? "sem cor"}`;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function dateBr(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getUTCDate()).padStart(2, "0")}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${at.getUTCFullYear()}`;
}

/**
 * Colunas na ordem do Trello. A primeira aberta é a entrada (`new`); a primeira
 * com SLA concluído é a de concluídas (`done`) — os dois `kind` que o produto
 * procura pelo nome. As demais recebem `trello_N`, único no quadro.
 */
function planLists(board: TrelloBoardExport, mapping: TrelloImportMapping): PlannedList[] {
  const lists = [...board.lists]
    .filter((list) => mapping.includeArchived || !list.closed)
    .sort((a, b) => a.pos - b.pos);
  let hasNew = false;
  let hasDone = false;
  return lists.map((list, index) => {
    const slaBehavior = mapping.listBehavior[list.id] ?? "running";
    let kind = `trello_${index + 1}`;
    if (!hasNew && slaBehavior !== "completed") { kind = "new"; hasNew = true; }
    else if (!hasDone && slaBehavior === "completed") { kind = "done"; hasDone = true; }
    return { trelloId: list.id, name: clip(list.name || `Lista ${index + 1}`, 80), kind, slaBehavior, position: (index + 1) * 1000 };
  });
}

function customFieldLines(card: TrelloCard, fields: Map<string, TrelloCustomField>): string[] {
  return card.customFieldItems.flatMap((item) => {
    const field = fields.get(item.idCustomField);
    if (!field) return [];
    let value = "";
    if (item.idValue) value = field.options.find((option) => option.id === item.idValue)?.value.text ?? "";
    else if (item.value?.checked !== undefined) value = item.value.checked === "true" ? "Sim" : "Não";
    else if (item.value?.date) value = dateBr(item.value.date);
    else value = item.value?.text ?? item.value?.number ?? "";
    return value ? [`- ${field.name}: ${value}`] : [];
  });
}

function cardDescription(card: TrelloCard, board: TrelloBoardExport, fields: Map<string, TrelloCustomField>): string {
  const origin = card.shortLink ? `https://trello.com/c/${card.shortLink}` : board.url;
  const blocks = [card.desc.trim()];
  const custom = customFieldLines(card, fields);
  if (custom.length) blocks.push(["Campos do Trello:", ...custom].join("\n"));
  if (card.attachments.length) {
    blocks.push(["Anexos no Trello (links, não copiados):", ...card.attachments.map((attachment) => `- ${attachment.name || "anexo"}: ${attachment.url}`)].join("\n"));
  }
  blocks.push(`Importado do Trello${card.idShort ? ` (#${card.idShort})` : ""}: ${origin}`);
  const text = blocks.filter(Boolean).join("\n\n");
  if (text.length <= TRELLO_IMPORT_LIMITS.description) return text;
  /* A origem fica sempre: é por ela que se acha o resto no Trello. */
  const tail = `\n\n[descrição cortada no limite de ${TRELLO_IMPORT_LIMITS.description} caracteres]\nImportado do Trello: ${origin}`;
  return `${text.slice(0, TRELLO_IMPORT_LIMITS.description - tail.length)}${tail}`;
}

export function planTrelloImport(
  board: TrelloBoardExport,
  mapping: TrelloImportMapping,
  context: TrelloImportContext,
): TrelloImportPlan {
  const warnings: string[] = [];
  const companyIds = new Set(context.companies.map((company) => company.id));
  const memberIds = new Set(context.members.map((member) => member.userId));
  const memberAccess = new Map(context.members.map((member) => [member.userId, member.companyIds ?? null]));
  let assigneesWithoutAccess = 0;
  if (!companyIds.has(mapping.defaultCompanyId)) {
    throw new TrelloImportError("Escolha a empresa padrão das demandas importadas.", "TRELLO_COMPANY_REQUIRED");
  }
  for (const [labelId, companyId] of Object.entries(mapping.labelCompany)) {
    if (!companyIds.has(companyId)) throw new TrelloImportError("Uma etiqueta foi ligada a uma empresa que não existe ou a que você não tem acesso.", "TRELLO_COMPANY_INVALID");
    if (!board.labels.some((label) => label.id === labelId)) throw new TrelloImportError("Uma etiqueta escolhida não está neste quadro.", "TRELLO_LABEL_INVALID");
  }
  const defaultProcessType = context.isValidProcessType(mapping.defaultProcessType);
  if (!defaultProcessType) throw new TrelloImportError("Escolha um tipo de processo padrão válido.", "TRELLO_PROCESS_TYPE_INVALID");
  const labelProcessType = new Map<string, string>();
  for (const [labelId, processType] of Object.entries(mapping.labelProcessType)) {
    const valid = context.isValidProcessType(processType);
    if (!valid) throw new TrelloImportError(`O tipo de processo "${processType}" não é válido.`, "TRELLO_PROCESS_TYPE_INVALID");
    labelProcessType.set(labelId, valid);
  }
  for (const userId of Object.values(mapping.members)) {
    if (userId && !memberIds.has(userId)) throw new TrelloImportError("Um membro do Trello foi ligado a alguém que não está no workspace.", "TRELLO_MEMBER_INVALID");
  }

  const lists = planLists(board, mapping);
  const listIndex = new Map(lists.map((list, index) => [list.trelloId, index]));
  const closedLists = new Set(board.lists.filter((list) => list.closed).map((list) => list.id));
  const fields = new Map(board.customFields.map((field) => [field.id, field]));
  const checklistsByCard = new Map<string, TrelloChecklist[]>();
  for (const checklist of board.checklists) {
    checklistsByCard.set(checklist.idCard, [...checklistsByCard.get(checklist.idCard) ?? [], checklist]);
  }
  const commentsByCard = new Map<string, TrelloCommentAction[]>();
  for (const action of board.actions) {
    commentsByCard.set(action.data.card.id, [...commentsByCard.get(action.data.card.id) ?? [], action]);
  }
  const memberNames = new Map(board.members.map((member) => [member.id, member.fullName || member.username]));

  const companyLabelsSeen = new Set<string>();
  let skippedArchived = 0;
  let checklistItems = 0;
  let comments = 0;
  let attachments = 0;
  let oldestComment: string | null = null;
  const unmappedMembers = new Set<string>();
  const usedLabels = new Set<string>();
  const ambiguousCompany: string[] = [];

  const sortedCards = [...board.cards].sort((a, b) => a.pos - b.pos);
  const cards: PlannedCard[] = [];
  for (const card of sortedCards) {
    const archived = card.closed || closedLists.has(card.idList);
    if (archived && !mapping.includeArchived) { skippedArchived += 1; continue; }
    const index = listIndex.get(card.idList);
    if (index === undefined) { skippedArchived += 1; continue; }

    const companyLabels = card.idLabels.filter((labelId) => mapping.labelCompany[labelId]);
    const companies = [...new Set(companyLabels.map((labelId) => mapping.labelCompany[labelId]))];
    if (companies.length > 1) ambiguousCompany.push(card.name);
    companyLabels.forEach((labelId) => companyLabelsSeen.add(labelId));
    const processTypes = [...new Set(card.idLabels.map((labelId) => labelProcessType.get(labelId)).filter((value): value is string => Boolean(value)))];

    const companyId = companies[0] ?? mapping.defaultCompanyId;
    const assigneeUserIds = [...new Set(card.idMembers.flatMap((memberId) => {
      const userId = mapping.members[memberId];
      if (!userId) { unmappedMembers.add(memberNames.get(memberId) ?? memberId); return []; }
      const access = memberAccess.get(userId);
      if (access && !access.has(companyId)) { assigneesWithoutAccess += 1; return []; }
      return [userId];
    }))];

    const groups = [...checklistsByCard.get(card.id) ?? []].sort((a, b) => a.pos - b.pos);
    const checklist = groups
      .flatMap((group) => [...group.checkItems].sort((a, b) => a.pos - b.pos).map((item) => ({
        /* Várias checklists do Trello viram uma lista só, com o nome do grupo
           na frente — o Vinculato tem uma lista de itens por demanda (§7.4). */
        title: clip(groups.length > 1 && group.name ? `${group.name} · ${item.name}` : item.name, TRELLO_IMPORT_LIMITS.checkItem),
        completed: item.state === "complete",
      })))
      .slice(0, TRELLO_IMPORT_LIMITS.checkItemsPerCard)
      .map((item, position) => ({ ...item, position: (position + 1) * 1000 }));
    checklistItems += checklist.length;

    const cardComments = (commentsByCard.get(card.id) ?? [])
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-TRELLO_IMPORT_LIMITS.commentsPerCard)
      .map((action) => {
        if (!oldestComment || action.date < oldestComment) oldestComment = action.date;
        const author = action.memberCreator?.fullName || memberNames.get(action.idMemberCreator) || "membro do Trello";
        const header = `[Trello · ${author} · ${dateBr(action.date)}] `;
        return { body: clip(`${header}${action.data.text.trim()}`, TRELLO_IMPORT_LIMITS.comment), createdAt: action.date };
      });
    comments += cardComments.length;
    attachments += card.attachments.length;
    card.idLabels.forEach((labelId) => usedLabels.add(labelId));

    cards.push({
      trelloId: card.id,
      listIndex: index,
      title: clip(card.name || "Cartão sem título", TRELLO_IMPORT_LIMITS.title),
      description: cardDescription(card, board, fields),
      companyId,
      processType: processTypes[0] ?? defaultProcessType,
      position: 0,
      dueAt: card.due,
      archived,
      createdAt: trelloCreatedAt(card.id),
      /* O Trello não guarda quando o cartão terminou. A última atividade é o
         palpite mais próximo; a data de hoje jogaria todo o histórico no
         relatório deste mês. */
      closedAt: lists[index].slaBehavior === "completed" ? card.dateLastActivity ?? trelloCreatedAt(card.id) : null,
      /* Etiqueta usada para escolher a empresa não vira etiqueta da demanda: a
         empresa já é campo próprio, e repeti-la como etiqueta duplica o dado. */
      labelTrelloIds: card.idLabels.filter((labelId) => !mapping.labelCompany[labelId]),
      assigneeUserIds,
      checklist,
      comments: cardComments,
    });
  }
  /* Posição por coluna, na ordem do Trello, com o mesmo espaço do produto. */
  const perList = new Map<number, number>();
  for (const card of cards) {
    const next = (perList.get(card.listIndex) ?? 0) + 1000;
    perList.set(card.listIndex, next);
    card.position = next;
  }

  const labels = board.labels
    .filter((label) => usedLabels.has(label.id) && !mapping.labelCompany[label.id])
    .map((label) => ({ trelloId: label.id, name: clip(labelDisplayName(label), 80), color: trelloLabelColor(label.color) }));

  if (ambiguousCompany.length) {
    warnings.push(`${ambiguousCompany.length} cartão(ões) têm etiquetas de duas empresas; ficou a primeira. Ex.: "${clip(ambiguousCompany[0], 60)}".`);
  }
  if (unmappedMembers.size) {
    warnings.push(`Membros sem correspondência ficam fora dos responsáveis: ${[...unmappedMembers].slice(0, 5).join(", ")}${unmappedMembers.size > 5 ? "…" : ""}. Demanda aberta que ficar sem ninguém recebe o responsável da carteira do DP.`);
  }
  if (assigneesWithoutAccess) {
    warnings.push(`${assigneesWithoutAccess} atribuição(ões) ficaram de fora porque a pessoa não tem acesso à empresa da demanda.`);
  }
  if (board.actions.length && oldestComment) {
    warnings.push(`O Trello exporta só as ações mais recentes: os comentários lidos começam em ${dateBr(oldestComment)}. Comentários anteriores ficam no Trello.`);
  }
  if (attachments) warnings.push(`${attachments} anexo(s) entram como link na descrição; os arquivos continuam no Trello.`);
  if (!lists.some((list) => list.slaBehavior === "completed")) {
    warnings.push("Nenhuma coluna foi marcada como concluída: as demandas do Trello já terminadas vão aparecer como abertas.");
  }

  return {
    boardName: clip(mapping.boardName.trim() || board.name, 80),
    lists,
    labels,
    cards,
    summary: {
      cards: cards.length,
      archivedCards: cards.filter((card) => card.archived).length,
      skippedArchived,
      checklistItems,
      comments,
      oldestComment,
      attachmentsAsLinks: attachments,
      unmappedMembers: [...unmappedMembers],
    },
    warnings,
  };
}

/**
 * Sugestão de membro para a prévia: só nome completo **igual** (sem acento e
 * sem caixa) e só se for único. A pessoa confirma; nada é casado sozinho.
 */
export function suggestMemberMatches(
  board: Pick<TrelloBoardExport, "members">,
  members: ReadonlyArray<{ userId: string; name: string }>,
): Record<string, string> {
  const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
  const suggestions: Record<string, string> = {};
  for (const member of board.members) {
    const target = normalize(member.fullName);
    if (!target) continue;
    const matches = members.filter((candidate) => normalize(candidate.name) === target);
    if (matches.length === 1) suggestions[member.id] = matches[0].userId;
  }
  return suggestions;
}

/** Sugestão de empresa por etiqueta: nome da etiqueta igual ao nome da empresa, único. */
export function suggestLabelCompanies(
  board: Pick<TrelloBoardExport, "labels">,
  companies: ReadonlyArray<{ id: string; name: string }>,
): Record<string, string> {
  const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
  const suggestions: Record<string, string> = {};
  for (const label of board.labels) {
    const target = normalize(label.name);
    if (!target) continue;
    const matches = companies.filter((company) => normalize(company.name) === target);
    if (matches.length === 1) suggestions[label.id] = matches[0].id;
  }
  return suggestions;
}
