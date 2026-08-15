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

test("a cota é conferida na mesma instrução que grava", () => {
  // Conferir antes e gravar depois deixaria dois envios simultâneos passarem
  // juntos pela última fatia da cota.
  // A instrução começa na CTE do lock, não no INSERT: o lock vem antes.
  const inicio = route.indexOf("WITH lock AS (");
  const statement = route.slice(inicio, route.indexOf(".bind(", inicio));
  assert.match(statement, /SELECT \?, \?, \?, \?, \?, \?, \?, \? FROM entitlement/u, "a gravação precisa depender da entitlement");
  assert.match(statement, /COALESCE\(SUM\(size_bytes\), 0\)/u);
  assert.match(statement, /entitlement\.storage_limit_mb::bigint \* 1024 \* 1024/u);
  assert.match(statement, /pg_advisory_xact_lock/u, "sem o lock, dois envios simultâneos furam a cota");
});

test("o total considera o workspace inteiro, não o cartão", () => {
  // Somar só os anexos da demanda deixaria a cota do plano sem efeito: bastaria
  // espalhar os arquivos por várias demandas.
  // A instrução começa na CTE do lock, não no INSERT: o lock vem antes.
  const inicio = route.indexOf("WITH lock AS (");
  const statement = route.slice(inicio, route.indexOf(".bind(", inicio));
  assert.match(statement, /FROM fdp_card_attachments WHERE workspace_id = \?/u);
  assert.doesNotMatch(statement, /SUM\(size_bytes\)[\s\S]{0,120}card_id/u);
});

test("arquivo recusado não fica órfão no armazenamento", () => {
  // O upload acontece antes da gravação. Sem a remoção, o arquivo viraria lixo
  // invisível: pago, guardado e nunca referenciado por linha nenhuma.
  const bloco = route.slice(route.indexOf("if (!stored)"), route.indexOf("} catch (error)"));
  assert.match(bloco, /bucket\.delete\(objectKey\)/u);
  assert.match(bloco, /throw await storageQuotaError/u);
});

test("cota esgotada e assinatura inativa são erros diferentes", () => {
  // Cota resolve-se apagando anexo ou mudando de plano; assinatura inativa é
  // contrato, e nenhuma faxina de arquivos resolve. Confundir as duas manda o
  // cliente para o lugar errado.
  assert.match(route, /"STORAGE_LIMIT_REACHED"/u);
  assert.match(route, /"SUBSCRIPTION_INACTIVE"/u);
  assert.match(route, /Remova anexos que não sejam mais necessários ou mude de plano/u);
  assert.match(route, /não tem uma assinatura ativa/u);
});

test("a mensagem de cota diz quanto foi usado, quanto cabe e quanto pesa o arquivo", () => {
  // "Não foi possível concluir a operação" não diz ao usuário o que fazer.
  assert.match(route, /\$\{megabytes\(used\)\} de \$\{megabytes\(total\)\}/u);
  assert.match(route, /este arquivo tem \$\{megabytes\(incomingBytes\)\}/u);
  // E o detalhe estruturado permite a tela desenhar a barra de uso.
  assert.match(route, /\{ usedBytes: used, limitBytes: total, incomingBytes \}/u);
});

test("o teto por arquivo continua valendo junto com a cota", () => {
  // A cota não substitui o limite individual: sem ele, um único arquivo enorme
  // consumiria o plano inteiro de uma vez.
  assert.match(route, /MAX_FILE_SIZE = 20 \* 1024 \* 1024/u);
  assert.match(route, /file\.size > MAX_FILE_SIZE/u);
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
