import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { rasterizeSignature } from "../mobile/src/lib/png.ts";

/**
 * App Expo do Vinculato Campo (`mobile/`).
 *
 * O app tem tsc e testes próprios; estes rodam na CI da raiz para que as
 * garantias que tocam o servidor não dependam de alguém lembrar de rodar o
 * pacote do celular.
 */
const read = (path: string) => readFile(new URL(`../mobile/${path}`, import.meta.url), "utf8");

test("o app se identifica e se autentica do jeito que o servidor espera", async () => {
  const api = await read("src/lib/api.ts");
  assert.match(api, /NATIVE_CLIENT_HEADER = "x-vinculato-client"/u);
  assert.match(api, /NATIVE_CLIENT_VALUE = "campo-app"/u);
  assert.match(api, /Authorization = `Bearer \$\{init\.token\}`/u);
  assert.match(api, /client: "app"/u, "o login do app pede o token, não o cookie");
});

test("a fila do app tem idempotência e não enfileira decisões", async () => {
  const queue = await read("src/lib/queue.ts");
  const kinds = queue.match(/export type QueuedKind = ([^;]+);/u)?.[1] ?? "";
  assert.doesNotMatch(kinds, /sanitiz|dispos/u, "higienização e descarte não podem esperar na fila");
  assert.match(queue, /"idempotency-key": operation\.idempotencyKey/u);
  // A chave nasce uma vez, na criação da operação — não a cada tentativa.
  assert.equal((queue.match(/idempotencyKey: `campo-app:/gu) ?? []).length, 1);
});

test("as regras de EPI vêm da raiz, sem cópia no app", async () => {
  const sources = await Promise.all(["src/app/devolucao.tsx", "src/app/dano.tsx", "src/app/vencimentos.tsx", "src/app/cuidado.tsx"].map(read));
  assert.match(sources[0], /from "@\/lib\/epi"/u);
  assert.match(sources[1], /damageRouting/u);
  assert.match(sources[2], /from "@\/app\/campo\/sesmt\.logic"/u);
  assert.match(sources[3], /disposalStockEffect/u);
  for (const source of sources) assert.doesNotMatch(source, /function (returnRouting|damageRouting|dueEntries)\(/u);
});

test("a assinatura do app sai como PNG válido", () => {
  const png = rasterizeSignature([[{ x: 0, y: 0 }, { x: 100, y: 40 }]], 100, 40);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const idatAt = Buffer.from(png).indexOf("IDAT");
  const length = new DataView(png.buffer).getUint32(idatAt - 4);
  assert.ok(inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length)).length > 0);
});
