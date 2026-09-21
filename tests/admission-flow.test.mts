import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  detectIdentityDivergence, mergeSheetFields, registryFields, sanitizeFieldMeta,
} from "../lib/admission-sheet-fields.ts";
import { HEARTBEAT_STALE_SECONDS, readWorkerHealth } from "../lib/tangerino/worker-health.ts";

/**
 * O fluxo da admissão: origem por campo, identidade, saúde do worker e conclusão.
 *
 * NENHUM número aqui pertence a uma pessoa.
 *
 * O que estes testes PROVAM — que a correção manual vence a releitura, que um
 * documento de outra pessoa não preenche a demanda, que worker mudo e
 * agendamento parado são diagnósticos distintos, e que a conclusão depende de
 * uma confirmação humana com matrícula.
 *
 * O que eles NÃO provam — que os rótulos do parser batem com a ficha real da
 * Sólides. Isso continua esperando uma amostra.
 */

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/* -------------------------------------------------------------------------- *
 * Origem por campo
 * -------------------------------------------------------------------------- */

test("a correção manual vence o documento, e o valor lido continua à vista", () => {
  const merged = mergeSheetFields({
    extracted: { taxId: "111.222.333-96", fullName: "FULANA DE TAL" },
    overrides: { taxId: "999.888.777-66" },
    registry: { position: "ANALISTA I E" },
    meta: { taxId: { source: "manual", by: "dp@exemplo.test", at: "2026-09-21T12:00:00.000Z" } },
  });
  assert.equal(merged.taxId.value, "999.888.777-66");
  assert.equal(merged.taxId.source, "manual");
  assert.equal(merged.taxId.documentValue, "111.222.333-96",
    "esconder o valor lido tornaria a divergência invisível em vez de resolvida");
  assert.equal(merged.taxId.by, "dp@exemplo.test");

  assert.equal(merged.fullName.source, "document");
  assert.equal(merged.position.source, "registry", "o cadastro completa o que o documento não traz");
});

test("campo ausente em todas as origens não entra com valor vazio", () => {
  const merged = mergeSheetFields({ extracted: {}, overrides: {}, registry: {}, meta: {} });
  assert.equal(Object.keys(merged).length, 0, "em branco é diferente de preenchido com nada");
});

test("o metadado por campo não carrega valor", () => {
  const meta = sanitizeFieldMeta({
    taxId: { source: "manual", by: "dp@exemplo.test", at: "2026-09-21T12:00:00.000Z", value: "111.222.333-96" },
    campoInventado: { source: "manual" },
    fullName: { source: "origem_falsa" },
  });
  assert.deepEqual(Object.keys(meta), ["taxId"]);
  assert.equal("value" in meta.taxId, false, "valor em coluna aberta desfaria a cifra ao lado");
});

/* -------------------------------------------------------------------------- *
 * Identidade
 * -------------------------------------------------------------------------- */

test("CPF de outra pessoa no documento vira divergência", () => {
  const divergencias = detectIdentityDivergence({
    extracted: { taxId: "111.222.333-96", fullName: "FULANA DE TAL" },
    employee: { fullName: "FULANA DE TAL", cpfLast4: "0000" },
  });
  assert.equal(divergencias.length, 1);
  assert.equal(divergencias[0].field, "taxId");
});

test("nome sem nenhum sobrenome em comum vira divergência", () => {
  const divergencias = detectIdentityDivergence({
    extracted: { fullName: "BELTRANO PEREIRA" },
    employee: { fullName: "FULANA DE TAL", cpfLast4: "" },
  });
  assert.equal(divergencias.length, 1);
  assert.equal(divergencias[0].field, "fullName");
});

test("mudança de nome com sobrenome em comum não é divergência", () => {
  // Casamento, nome social e abreviação mudam o texto sem mudar quem é. Um
  // alarme aqui tocaria em admissão legítima e seria ignorado por hábito.
  const divergencias = detectIdentityDivergence({
    extracted: { fullName: "FULANA NUNES DA SILVA" },
    employee: { fullName: "FULANA NUNES", cpfLast4: "" },
  });
  assert.deepEqual(divergencias, []);
});

test("sem colaborador vinculado não há o que divergir", () => {
  assert.deepEqual(detectIdentityDivergence({ extracted: { taxId: "111.222.333-96" }, employee: null }), []);
});

test("o cadastro não fornece documento pessoal", () => {
  const campos = registryFields({
    fullName: "FULANA DE TAL", admissionDate: "2025-10-13",
    positionName: "ANALISTA I E", companyName: "EMPRESA EXEMPLO LTDA",
  });
  assert.equal(campos.admissionDate, "13/10/2025", "a data sai no formato do documento");
  for (const documento of ["taxId", "pisNumber", "identityCard", "ctpsNumber", "driverLicense"]) {
    assert.equal(campos[documento], undefined,
      `${documento} do cadastro veio de digitação anterior; usá-lo aqui transformaria erro antigo em confirmação nova`);
  }
});

test("divergência de identidade impede o preenchimento pelo cadastro", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/route.ts");
  assert.match(route, /divergences\.length === 0 \? registryFields\(employee\) : \{\}/u,
    "anexar dado de uma pessoa à admissão de outra é o erro que ninguém percebe olhando a tela");
});

/* -------------------------------------------------------------------------- *
 * Saúde do worker
 * -------------------------------------------------------------------------- */

function fakeHealthDatabase(heartbeat: Record<string, unknown> | null, queue: { consultations: number; attachments: number }) {
  return {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: async () => (/fdp_tangerino_worker_heartbeats/u.test(sql) ? heartbeat : queue),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return statement;
    },
  } as never;
}

const agora = new Date("2026-09-21T12:00:00.000Z");
const batimento = (segundosAtras: number, extra: Record<string, unknown> = {}) => ({
  worker_id: "worker-abc", worker_version: "1.0.0",
  started_at: "2026-09-21T08:00:00.000Z",
  last_seen_at: new Date(agora.getTime() - segundosAtras * 1000).toISOString(),
  last_consultation_at: null, pending_consultations: 0, pending_attachments: 0,
  needs_authentication: 0, last_error_code: "", ...extra,
});

test("worker que nunca falou é dito assim, e a fila pesa no recado", async () => {
  const saude = await readWorkerHealth(fakeHealthDatabase(null, { consultations: 3, attachments: 1 }), "ws", agora);
  assert.equal(saude.availability, "never_seen");
  assert.match(saude.detail, /4 tarefas esperando/u);
});

test("worker calado além da janela vira 'stale', não 'com problema'", async () => {
  const saude = await readWorkerHealth(
    fakeHealthDatabase(batimento(HEARTBEAT_STALE_SECONDS + 60), { consultations: 0, attachments: 0 }), "ws", agora);
  assert.equal(saude.availability, "stale");
  assert.match(saude.detail, /desligado, suspenso ou sem rede/u,
    "o recado precisa apontar para a máquina, que é onde está a causa");
});

test("worker de pé esperando CAPTCHA é um estado próprio", async () => {
  const saude = await readWorkerHealth(
    fakeHealthDatabase(batimento(10, { needs_authentication: 1 }), { consultations: 1, attachments: 0 }), "ws", agora);
  assert.equal(saude.availability, "needs_authentication");
  assert.match(saude.detail, /CAPTCHA|duas etapas/u);
});

test("worker ativo e sem fila não é alarme", async () => {
  const saude = await readWorkerHealth(
    fakeHealthDatabase(batimento(10), { consultations: 0, attachments: 0 }), "ws", agora);
  assert.equal(saude.availability, "online");
  assert.match(saude.detail, /sem tarefas/u);
});

test("a fila é contada no servidor, não copiada do batimento", async () => {
  // O worker mudo não atualiza nada — e é justamente nele que saber o tamanho
  // da fila importa. Ler do batimento mostraria o número de antes de ele parar.
  const saude = await readWorkerHealth(
    fakeHealthDatabase(batimento(10, { pending_consultations: 99 }), { consultations: 2, attachments: 0 }), "ws", agora);
  assert.equal(saude.pendingConsultations, 2);
});

/* -------------------------------------------------------------------------- *
 * Conclusão e retenção
 * -------------------------------------------------------------------------- */

test("a conclusão exige matrícula do ERP e não acontece sozinha", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/confirm/route.ts");
  assert.match(route, /ERP_REGISTRATION_REQUIRED/u);
  assert.match(route, /confirmed_at IS NULL/u, "confirmar duas vezes não pode sobrescrever quem concluiu");
  assert.match(route, /state = 'ready'/u, "ficha não pronta não pode ser dada como cadastrada");
});

test("arquivar a demanda agenda o expurgo em vez de apagar no ato", () => {
  const route = source("../app/api/cards/[id]/route.ts");
  assert.match(route, /retention_until = COALESCE\(retention_until/u,
    "quem concluiu escolheu o prazo; arquivar depois não pode encurtá-lo em silêncio");
  assert.doesNotMatch(route, /DELETE FROM fdp_admission_sheets/u,
    "o expurgo imediato tirava o material da conferência no dia seguinte");
});

test("o expurgo só alcança ficha com prazo marcado", () => {
  const cron = source("../app/api/cron/integrations/route.ts");
  assert.match(cron, /DELETE FROM fdp_admission_sheets[\s\S]{0,200}retention_until IS NOT NULL/u,
    "ficha sem data é de demanda em andamento e não pode entrar no expurgo");
});

test("a edição manual não altera ficha já confirmada", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/route.ts");
  assert.match(route, /ADMISSION_SHEET_CONFIRMED/u);
});

test("a auditoria da edição nomeia campos, nunca valores", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/route.ts");
  assert.match(route, /after: \{ fields: Object\.keys\(incoming\) \}/u,
    "registrar o conteúdo recriaria em texto aberto o que a cifra protege");
});
