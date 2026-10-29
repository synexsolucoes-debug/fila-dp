import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TRELLO_IMPORT_LIMITS, TrelloImportError, planTrelloImport, readTrelloExport,
  suggestLabelCompanies, suggestMemberMatches, trelloCreatedAt, trelloLabelColor,
  type TrelloImportContext, type TrelloImportMapping,
} from "../lib/trello-import.ts";

/**
 * Importador de quadro do Trello (item 1 do roadmap de
 * `docs/engenharia-reversa-trello.md`).
 *
 * O quadro abaixo é como um escritório de DP monta a fila no Trello: uma lista
 * por etapa, uma etiqueta por empresa, checklists de documentos.
 */

const id = (n: number) => `5f1a2b3c${String(n).padStart(16, "0")}`;
const BOARD = id(1);
const L_RECEBIDO = id(10), L_AGUARDANDO = id(11), L_CONCLUIDO = id(12), L_ANTIGA = id(13);
const LB_PADARIA = id(20), LB_URGENTE = id(21), LB_RESCISAO = id(22), LB_SEM_NOME = id(23);
const M_ANA = id(30), M_JOAO = id(31);
const C_RESC = id(40), C_FERIAS = id(41), C_FEITO = id(42), C_ARQ = id(43), C_LISTA_ARQ = id(44);
const CF_MATRICULA = id(50), CF_EXAME = id(51), CF_REGIME = id(52), OPT_CLT = id(53);

function trelloExport() {
  return {
    id: BOARD, name: "DP — Fila 2025", desc: "", url: "https://trello.com/b/abc/dp",
    labels: [
      { id: LB_PADARIA, name: "Padaria Pão Quente", color: "green" },
      { id: LB_URGENTE, name: "Urgente", color: "red_dark" },
      { id: LB_RESCISAO, name: "Rescisão", color: "purple" },
      { id: LB_SEM_NOME, name: "", color: null },
    ],
    lists: [
      { id: L_CONCLUIDO, name: "Concluído", closed: false, pos: 3 },
      { id: L_RECEBIDO, name: "Recebido", closed: false, pos: 1 },
      { id: L_AGUARDANDO, name: "Aguardando documento", closed: false, pos: 2 },
      { id: L_ANTIGA, name: "2024", closed: true, pos: 4 },
    ],
    members: [
      { id: M_ANA, fullName: "Ana Souza", username: "anasouza" },
      { id: M_JOAO, fullName: "João Pereira", username: "joaop" },
    ],
    cards: [
      {
        id: C_FERIAS, name: "Férias — Carla", desc: "", closed: false, idList: L_RECEBIDO, pos: 200,
        idShort: 8, shortLink: "Fer1as00", due: null, dueComplete: false,
        idLabels: [], idMembers: [M_JOAO], customFieldItems: [], attachments: [],
      },
      {
        id: C_RESC, name: "Rescisão — Marcos", desc: "Pedido de demissão.", closed: false, idList: L_RECEBIDO, pos: 100,
        idShort: 7, shortLink: "Resc1sao", due: "2025-03-14T15:00:00.000Z", dueComplete: false,
        idLabels: [LB_PADARIA, LB_URGENTE, LB_RESCISAO], idMembers: [M_ANA, M_JOAO],
        customFieldItems: [
          { idCustomField: CF_MATRICULA, value: { text: "00123" } },
          { idCustomField: CF_EXAME, value: { checked: "true" } },
          { idCustomField: CF_REGIME, idValue: OPT_CLT },
        ],
        attachments: [
          { id: id(60), name: "aviso.pdf", url: "https://trello.com/1/cards/x/attachments/y/download/aviso.pdf" },
          { id: id(61), name: "perigo", url: "javascript:alert(1)" },
        ],
      },
      {
        id: C_FEITO, name: "Admissão antiga concluída", desc: "", closed: false, idList: L_CONCLUIDO, pos: 1,
        idShort: 3, shortLink: "Fe1to000", due: null, dueComplete: true, dateLastActivity: "2025-02-28T18:00:00.000Z",
        idLabels: [LB_SEM_NOME], idMembers: [], customFieldItems: [], attachments: [],
      },
      {
        id: C_ARQ, name: "Cartão arquivado", desc: "", closed: true, idList: L_RECEBIDO, pos: 300,
        idShort: 2, shortLink: "Arq00000", due: null, dueComplete: false,
        idLabels: [], idMembers: [], customFieldItems: [], attachments: [],
      },
      {
        id: C_LISTA_ARQ, name: "Na lista arquivada", desc: "", closed: false, idList: L_ANTIGA, pos: 1,
        idShort: 1, shortLink: "Ant00000", due: null, dueComplete: false,
        idLabels: [], idMembers: [], customFieldItems: [], attachments: [],
      },
      { id: "nao-e-id", name: "lixo", idList: L_RECEBIDO },
    ],
    checklists: [
      { id: id(70), idCard: C_RESC, name: "eSocial", pos: 2, checkItems: [
        { id: id(71), name: "S-2299", state: "incomplete", pos: 1 },
      ] },
      { id: id(72), idCard: C_RESC, name: "Documentos", pos: 1, checkItems: [
        { id: id(74), name: "Exame demissional", state: "incomplete", pos: 2 },
        { id: id(73), name: "Aviso assinado", state: "complete", pos: 1 },
      ] },
      { id: id(75), idCard: C_FERIAS, name: "Passos", pos: 1, checkItems: [
        { id: id(76), name: "Programar no sistema", state: "incomplete", pos: 1 },
      ] },
    ],
    customFields: [
      { id: CF_MATRICULA, name: "Matrícula", type: "text", options: [] },
      { id: CF_EXAME, name: "Exame feito?", type: "checkbox", options: [] },
      { id: CF_REGIME, name: "Regime", type: "list", options: [{ id: OPT_CLT, value: { text: "CLT" } }] },
    ],
    actions: [
      { id: id(80), type: "commentCard", date: "2025-03-10T12:00:00.000Z", idMemberCreator: M_ANA,
        memberCreator: { fullName: "Ana Souza" }, data: { text: "Aviso recebido.", card: { id: C_RESC } } },
      { id: id(81), type: "commentCard", date: "2025-03-09T12:00:00.000Z", idMemberCreator: M_JOAO,
        memberCreator: { fullName: "João Pereira" }, data: { text: "Cliente pediu urgência.", card: { id: C_RESC } } },
      { id: id(82), type: "updateCard", date: "2025-03-11T12:00:00.000Z", data: { card: { id: C_RESC } } },
    ],
  };
}

const context: TrelloImportContext = {
  companies: [{ id: "padaria", name: "Padaria Pão Quente" }, { id: "geral", name: "Escritório" }],
  members: [{ userId: "u-ana", name: "Ana Souza" }, { userId: "u-ana2", name: "Ana Souza" }, { userId: "u-joao", name: "Joao Pereira" }],
  isValidProcessType: (value) => {
    const upper = value.toUpperCase();
    return upper && !upper.startsWith("ADMISS") ? upper : null;
  },
};

function mapping(change: Partial<TrelloImportMapping> = {}): TrelloImportMapping {
  return {
    boardName: "", defaultCompanyId: "geral",
    labelCompany: { [LB_PADARIA]: "padaria" },
    defaultProcessType: "OUTROS",
    labelProcessType: { [LB_RESCISAO]: "RESCISÃO" },
    listBehavior: { [L_AGUARDANDO]: "paused", [L_CONCLUIDO]: "completed" },
    members: { [M_ANA]: "u-ana" },
    includeArchived: false,
    ...change,
  };
}

/* ── Leitura ───────────────────────────────────────────────────────────── */

test("arquivo que não é quadro do Trello é recusado, não importado vazio", () => {
  assert.throws(() => readTrelloExport({ foo: 1 }), (error: unknown) => error instanceof TrelloImportError && error.code === "TRELLO_NOT_A_BOARD");
  assert.throws(() => readTrelloExport([]), TrelloImportError);
});

test("a leitura é idempotente: a rota relê o recorte que a tela mandou", () => {
  const once = readTrelloExport(trelloExport());
  assert.deepEqual(readTrelloExport(JSON.parse(JSON.stringify(once))), once);
});

test("só comentários entram das ações, e cartão com id inválido sai", () => {
  const board = readTrelloExport(trelloExport());
  assert.equal(board.actions.length, 2);
  assert.ok(board.cards.every((card) => card.id !== "nao-e-id"));
});

test("anexo só com https: link javascript: não chega à descrição", () => {
  const board = readTrelloExport(trelloExport());
  assert.deepEqual(board.cards.find((card) => card.id === C_RESC)?.attachments.map((item) => item.name), ["aviso.pdf"]);
});

test("limite de cartões é recusado com orientação", () => {
  const raw = trelloExport();
  raw.cards = Array.from({ length: TRELLO_IMPORT_LIMITS.cards + 1 }, () => raw.cards[0]);
  assert.throws(() => readTrelloExport(raw), /Arquive no Trello/u);
});

test("data de criação vem do ObjectId", () => {
  assert.equal(trelloCreatedAt("5f1a2b3c0000000000000000"), new Date(0x5f1a2b3c * 1000).toISOString());
  assert.equal(trelloCreatedAt("xyz"), null);
});

test("cor do Trello vira cor do Vinculato, variantes incluídas", () => {
  assert.equal(trelloLabelColor("red_dark"), trelloLabelColor("red"));
  assert.equal(trelloLabelColor(null), "#64748b");
});

/* ── Plano ─────────────────────────────────────────────────────────────── */

test("colunas na ordem do Trello, com entrada e concluída marcadas", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  assert.deepEqual(plan.lists.map((list) => [list.name, list.kind, list.slaBehavior]), [
    ["Recebido", "new", "running"],
    ["Aguardando documento", "trello_2", "paused"],
    ["Concluído", "done", "completed"],
  ]);
});

test("arquivados ficam de fora por padrão e entram arquivados quando pedidos", () => {
  const board = readTrelloExport(trelloExport());
  const without = planTrelloImport(board, mapping(), context);
  assert.equal(without.summary.skippedArchived, 2);
  assert.ok(!without.cards.some((card) => card.archived));
  const withArchived = planTrelloImport(board, mapping({ includeArchived: true }), context);
  assert.equal(withArchived.summary.archivedCards, 2);
  assert.equal(withArchived.lists.length, 4);
});

test("empresa e processo vêm das etiquetas; a etiqueta de empresa não vira etiqueta", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  const rescisao = plan.cards.find((card) => card.trelloId === C_RESC)!;
  assert.equal(rescisao.companyId, "padaria");
  assert.equal(rescisao.processType, "RESCISÃO");
  assert.deepEqual(rescisao.labelTrelloIds, [LB_URGENTE, LB_RESCISAO]);
  assert.ok(!plan.labels.some((label) => label.trelloId === LB_PADARIA));
  const ferias = plan.cards.find((card) => card.trelloId === C_FERIAS)!;
  assert.equal(ferias.companyId, "geral");
  assert.equal(ferias.processType, "OUTROS");
});

test("ordem dos cartões na coluna segue o pos do Trello", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  const entrada = plan.cards.filter((card) => card.listIndex === 0).sort((a, b) => a.position - b.position);
  assert.deepEqual(entrada.map((card) => card.trelloId), [C_RESC, C_FERIAS]);
});

test("membro só vira responsável se alguém casou os dois", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  assert.deepEqual(plan.cards.find((card) => card.trelloId === C_RESC)!.assigneeUserIds, ["u-ana"]);
  assert.deepEqual(plan.summary.unmappedMembers, ["João Pereira"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("João Pereira")));
});

test("checklists viram itens na ordem, com o nome do grupo quando há mais de um", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  assert.deepEqual(plan.cards.find((card) => card.trelloId === C_RESC)!.checklist.map((item) => [item.title, item.completed]), [
    ["Documentos · Aviso assinado", true],
    ["Documentos · Exame demissional", false],
    ["eSocial · S-2299", false],
  ]);
  assert.deepEqual(plan.cards.find((card) => card.trelloId === C_FERIAS)!.checklist.map((item) => item.title), ["Programar no sistema"]);
});

test("comentários em ordem, com autor e data do Trello na frente", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  const comments = plan.cards.find((card) => card.trelloId === C_RESC)!.comments;
  assert.deepEqual(comments.map((comment) => comment.body), [
    "[Trello · João Pereira · 09/03/2025] Cliente pediu urgência.",
    "[Trello · Ana Souza · 10/03/2025] Aviso recebido.",
  ]);
  assert.ok(plan.warnings.some((warning) => warning.includes("09/03/2025")));
});

test("descrição leva campos, anexos como link e a origem no Trello", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  const description = plan.cards.find((card) => card.trelloId === C_RESC)!.description;
  assert.match(description, /^Pedido de demissão\./u);
  assert.match(description, /- Matrícula: 00123/u);
  assert.match(description, /- Exame feito\?: Sim/u);
  assert.match(description, /- Regime: CLT/u);
  assert.match(description, /- aviso\.pdf: https:\/\/trello\.com/u);
  assert.match(description, /Importado do Trello \(#7\): https:\/\/trello\.com\/c\/Resc1sao/u);
});

test("descrição longa é cortada sem perder a origem", () => {
  const raw = trelloExport();
  raw.cards[1].desc = "x".repeat(20_000);
  const plan = planTrelloImport(readTrelloExport(raw), mapping(), context);
  const description = plan.cards.find((card) => card.trelloId === C_RESC)!.description;
  assert.ok(description.length <= TRELLO_IMPORT_LIMITS.description);
  assert.match(description, /Importado do Trello: https:\/\/trello\.com\/c\/Resc1sao$/u);
});

test("etiqueta sem nome entra com nome derivado da cor", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  assert.ok(plan.labels.some((label) => label.trelloId === LB_SEM_NOME && label.name === "Trello · sem cor"));
});

test("concluída usa a última atividade do Trello como conclusão, não a data de hoje", () => {
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping(), context);
  assert.equal(plan.cards.find((card) => card.trelloId === C_FEITO)!.closedAt, "2025-02-28T18:00:00.000Z");
  assert.equal(plan.cards.find((card) => card.trelloId === C_RESC)!.closedAt, null);
});

test("responsável sem acesso à empresa da demanda fica de fora, com aviso", () => {
  const restrito: TrelloImportContext = {
    ...context,
    members: [{ userId: "u-ana", name: "Ana Souza", companyIds: new Set(["geral"]) }, { userId: "u-joao", name: "Joao Pereira", companyIds: null }],
  };
  const plan = planTrelloImport(readTrelloExport(trelloExport()), mapping({ members: { [M_ANA]: "u-ana", [M_JOAO]: "u-joao" } }), restrito);
  // A rescisão é da Padaria (pela etiqueta): Ana só vê "geral"; João é administrador.
  assert.deepEqual(plan.cards.find((card) => card.trelloId === C_RESC)!.assigneeUserIds, ["u-joao"]);
  assert.ok(plan.warnings.some((warning) => warning.startsWith("1 atribuição")));
});

/* ── O que o importador recusa ─────────────────────────────────────────── */

test("sem empresa padrão válida não há plano", () => {
  assert.throws(() => planTrelloImport(readTrelloExport(trelloExport()), mapping({ defaultCompanyId: "" }), context), /empresa padrão/u);
});

test("admissão não entra como tipo de processo — é da Sólides", () => {
  assert.throws(() => planTrelloImport(readTrelloExport(trelloExport()), mapping({ labelProcessType: { [LB_RESCISAO]: "ADMISSÃO" } }), context), /não é válido/u);
});

test("membro ligado a alguém de fora do workspace é recusado", () => {
  assert.throws(() => planTrelloImport(readTrelloExport(trelloExport()), mapping({ members: { [M_ANA]: "intruso" } }), context), /não está no workspace/u);
});

test("etiqueta de empresa apontando para empresa inexistente é recusada", () => {
  assert.throws(() => planTrelloImport(readTrelloExport(trelloExport()), mapping({ labelCompany: { [LB_PADARIA]: "outra" } }), context), /empresa que não existe/u);
});

/* ── Sugestões ─────────────────────────────────────────────────────────── */

test("sugestão de membro só com nome completo igual e único", () => {
  const suggestions = suggestMemberMatches(readTrelloExport(trelloExport()), context.members);
  // Duas "Ana Souza" no workspace: nenhuma sugestão. "João" casa sem acento.
  assert.deepEqual(suggestions, { [M_JOAO]: "u-joao" });
});

test("sugestão de empresa pelo nome da etiqueta", () => {
  assert.deepEqual(suggestLabelCompanies(readTrelloExport(trelloExport()), context.companies), { [LB_PADARIA]: "padaria" });
});

/* ── A rota ────────────────────────────────────────────────────────────── */

test("a rota relê o arquivo no servidor, exige administrador e não dispara automações", async () => {
  const route = await readFile(new URL("../app/api/boards/import/trello/route.ts", import.meta.url), "utf8");
  assert.match(route, /readTrelloExport\(body\.board\)/u);
  assert.match(route, /requireWorkspaceRole\(workspace\.role, \["admin"\]\)/u);
  assert.doesNotMatch(route, /runAutomations/u);
  assert.match(route, /source_type, archived/u);
});
