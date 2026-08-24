import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §36: limite de plano vale no servidor, não escondendo botão.
 *
 * Três dos quatro limites já eram aplicados de verdade — empresas, assentos e
 * integrações, todos conferidos na mesma instrução que grava. O quarto não:
 * `storage_limit_mb` aparecia no catálogo, na página de planos e na tela de
 * assinatura, e em nenhum lugar do caminho de escrita.
 *
 * O efeito era um limite anunciado e inexistente: o Starter dizia 1 GB e o
 * cliente subia quanto quisesse, 20 MB por vez — esse teto por arquivo era a
 * única barreira que existia.
 *
 * Verificado contra PostgreSQL com o plano Starter: 51 arquivos de 20 MB
 * gravam até 1020 MB, o 52º é barrado, e um de 4 MB que fecha exatamente
 * 1024 MB ainda entra. Bloqueia o que estoura, aceita o que cabe.
 */

const route = await readFile(new URL("../app/api/cards/[id]/attachments/route.ts", import.meta.url), "utf8");
const storage = await readFile(new URL("../lib/card-attachments.ts", import.meta.url), "utf8");

test("a cota é conferida na mesma instrução que grava", () => {
  // Conferir antes e gravar depois deixaria dois envios simultâneos passarem
  // juntos pela última fatia da cota.
  // A instrução começa na CTE do lock, não no INSERT: o lock vem antes.
  const inicio = storage.indexOf("WITH lock AS (");
  const statement = storage.slice(inicio, storage.indexOf(".bind(", inicio));
  assert.match(statement, /FROM entitlement/u, "a gravação precisa depender da entitlement");
  assert.match(statement, /COALESCE\(SUM\(size_bytes\), 0\)/u);
  assert.match(statement, /entitlement\.storage_limit_mb::bigint \* 1024 \* 1024/u);
  assert.match(statement, /pg_advisory_xact_lock/u, "sem o lock, dois envios simultâneos furam a cota");
});

test("o total considera o workspace inteiro, não o cartão", () => {
  // Somar só os anexos da demanda deixaria a cota do plano sem efeito: bastaria
  // espalhar os arquivos por várias demandas.
  // A instrução começa na CTE do lock, não no INSERT: o lock vem antes.
  const inicio = storage.indexOf("WITH lock AS (");
  const statement = storage.slice(inicio, storage.indexOf(".bind(", inicio));
  assert.match(statement, /FROM fdp_card_attachments WHERE workspace_id = \?/u);
  assert.match(statement, /FROM fdp_epi_attachments WHERE workspace_id = \?/u);
  assert.match(statement, /FROM fdp_contractor_documents WHERE workspace_id = \?/u,
    "notas fiscais de contratos PJ também consomem a cota do plano");
  assert.doesNotMatch(statement, /SUM\(size_bytes\)[\s\S]{0,120}card_id/u);
});

test("arquivo recusado não fica órfão no armazenamento", () => {
  // O upload acontece antes da gravação. Sem a remoção, o arquivo viraria lixo
  // invisível: pago, guardado e nunca referenciado por linha nenhuma.
  const bloco = storage.slice(storage.indexOf("if (stored)"), storage.indexOf("} catch (error)"));
  assert.match(bloco, /bucket\.delete\(objectKey\)/u);
  assert.match(bloco, /throw await storageQuotaError/u);
});

test("cota esgotada e assinatura inativa são erros diferentes", () => {
  // Cota resolve-se apagando anexo ou mudando de plano; assinatura inativa é
  // contrato, e nenhuma faxina de arquivos resolve. Confundir as duas manda o
  // cliente para o lugar errado.
  assert.match(storage, /"STORAGE_LIMIT_REACHED"/u);
  assert.match(storage, /"SUBSCRIPTION_INACTIVE"/u);
  assert.match(storage, /Remova anexos que não sejam mais necessários ou mude de plano/u);
  assert.match(storage, /não tem uma assinatura ativa/u);
});

test("a mensagem de cota diz quanto foi usado, quanto cabe e quanto pesa o arquivo", () => {
  // "Não foi possível concluir a operação" não diz ao usuário o que fazer.
  assert.match(storage, /\$\{megabytes\(used\)\} de \$\{megabytes\(total\)\}/u);
  assert.match(storage, /este arquivo tem \$\{megabytes\(incomingBytes\)\}/u);
  // E o detalhe estruturado permite a tela desenhar a barra de uso.
  assert.match(storage, /\{ usedBytes: used, limitBytes: total, incomingBytes \}/u);
});

test("o teto por arquivo continua valendo junto com a cota", () => {
  // A cota não substitui o limite individual: sem ele, um único arquivo enorme
  // consumiria o plano inteiro de uma vez.
  assert.match(storage, /MAX_CARD_ATTACHMENT_SIZE = 20 \* 1024 \* 1024/u);
  assert.match(storage, /input\.sizeBytes > MAX_CARD_ATTACHMENT_SIZE/u);
  assert.match(route, /content-length/u, "o tamanho declarado é recusado antes de ler o corpo");
});

test("os outros três limites do plano continuam aplicados no servidor", async () => {
  const empresas = await readFile(new URL("../app/api/companies/route.ts", import.meta.url), "utf8");
  assert.match(empresas, /entitlement\.company_limit/u);

  const membros = await readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8");
  assert.match(membros, /included_seats/u);

  const integracoes = await readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8");
  assert.match(integracoes, /integration_limit/u);
});

test("a soma da cota tem índice: ela roda dentro do lock a cada envio", async () => {
  // Sem índice em `workspace_id`, a soma é um Seq Scan da tabela inteira —
  // inclusive das linhas dos outros clientes — e o custo entra no caminho
  // crítico do upload, serializado pelo advisory lock.
  //
  // Medido com 60.052 anexos distribuídos como num multi-tenant real:
  //   sem índice: 6,72 ms · 1.734 buffers · Seq Scan
  //   com índice: 0,62 ms ·    58 buffers · Bitmap Heap Scan
  const migration = await readFile(
    new URL("../drizzle/postgres/0039_attachment_storage_quota_index.sql", import.meta.url), "utf8");
  assert.match(migration, /ON "fdp_card_attachments" \("workspace_id"\) INCLUDE \("size_bytes"\)/u);
  // `INCLUDE` evita voltar à tabela para ler a única coluna que a soma precisa.
  assert.match(migration, /IF NOT EXISTS/u, "reaplicar a migration não pode falhar");

  const contractorMigration = await readFile(
    new URL("../drizzle/postgres/0053_contractor_documents.sql", import.meta.url), "utf8");
  assert.match(contractorMigration, /fdp_contractor_documents_workspace_provider_idx/u);

  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0039_attachment_storage_quota_index"),
    "migration fora do journal não é aplicada pelo executor");
});
