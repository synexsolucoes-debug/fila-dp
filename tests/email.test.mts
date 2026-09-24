import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertTransactionalEmailConfigured,
  dispatchTransactionalEmail,
  escapeHtml,
  sendAccessRecoveryEmail,
  sendMemberActivationEmail,
  sendSignupConfirmationEmail,
  transactionalEmailConfigured,
} from "../lib/email.ts";

/**
 * `lib/email.ts` não importa `../db` nem `lib/fila-dp-db.ts` — é o único
 * ponto que fala com o Resend, e por isso pode ser importado direto aqui
 * (diferente de `lib/domain-event-automations.ts`, por exemplo).
 */

// NODE_ENV é somente-leitura no tipo de `process.env` do Next.js; o valor em
// si é mutável em tempo de execução, então a suíte muda por um objeto sem
// esse tipo estrito.
const env = process.env as Record<string, string | undefined>;

const originalApiKey = env.RESEND_API_KEY;
const originalFrom = env.FDP_EMAIL_FROM;
const originalNodeEnv = env.NODE_ENV;
const originalFetch = globalThis.fetch;

function clearEmailConfig() {
  delete env.RESEND_API_KEY;
  delete env.FDP_EMAIL_FROM;
}

function restoreEnv() {
  if (originalApiKey === undefined) delete env.RESEND_API_KEY; else env.RESEND_API_KEY = originalApiKey;
  if (originalFrom === undefined) delete env.FDP_EMAIL_FROM; else env.FDP_EMAIL_FROM = originalFrom;
  if (originalNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = originalNodeEnv;
  globalThis.fetch = originalFetch;
}

/* ── `escapeHtml` ─────────────────────────────────────────────────────────── */

test("escapeHtml neutraliza os cinco caracteres que quebrariam o HTML do e-mail", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml("Maria D'Ávila & Cia"), "Maria D&#39;Ávila &amp; Cia");
});

/* ── `transactionalEmailConfigured` / `assertTransactionalEmailConfigured` ── */

test("sem RESEND_API_KEY e FDP_EMAIL_FROM, transactionalEmailConfigured é falso", () => {
  clearEmailConfig();
  try {
    assert.equal(transactionalEmailConfigured(), false);
  } finally {
    restoreEnv();
  }
});

test("com as duas variáveis, transactionalEmailConfigured é verdadeiro", () => {
  env.RESEND_API_KEY = "re_test_key";
  env.FDP_EMAIL_FROM = "no-reply@vinculato.com";
  try {
    assert.equal(transactionalEmailConfigured(), true);
  } finally {
    restoreEnv();
  }
});

test("assertTransactionalEmailConfigured recusa em produção sem configuração, mas não fora dela", () => {
  clearEmailConfig();
  env.NODE_ENV = "production";
  try {
    assert.throws(() => assertTransactionalEmailConfigured(), /EMAIL_NOT_CONFIGURED|indisponível/u);
  } finally {
    restoreEnv();
  }

  clearEmailConfig();
  env.NODE_ENV = "test";
  try {
    assert.doesNotThrow(() => assertTransactionalEmailConfigured());
  } finally {
    restoreEnv();
  }
});

/* ── `dispatchTransactionalEmail` ────────────────────────────────────────── */

test("sem provedor configurado, dispatchTransactionalEmail devolve development sem chamar fetch", async () => {
  clearEmailConfig();
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("não deveria chamar fetch"); }) as typeof fetch;
  try {
    const result = await dispatchTransactionalEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>", idempotencyKey: "k1" });
    assert.deepEqual(result, { provider: "development", id: "not-sent" });
    assert.equal(called, false);
  } finally {
    restoreEnv();
  }
});

test("com provedor configurado, dispatchTransactionalEmail envia a Idempotency-Key e devolve o id do Resend", async () => {
  env.RESEND_API_KEY = "re_test_key";
  env.FDP_EMAIL_FROM = "no-reply@vinculato.com";
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenHeaders = init?.headers as Record<string, string>;
    seenBody = JSON.parse(String(init?.body));
    return { ok: true, json: async () => ({ id: "resend-123" }) } as Response;
  }) as typeof fetch;
  try {
    const result = await dispatchTransactionalEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>", idempotencyKey: "k1" });
    assert.deepEqual(result, { provider: "resend", id: "resend-123" });
    assert.equal(seenHeaders?.["Idempotency-Key"], "k1");
    assert.equal(seenBody?.from, "no-reply@vinculato.com");
    assert.deepEqual(seenBody?.to, ["a@b.com"]);
  } finally {
    restoreEnv();
  }
});

test("uma resposta não-ok do Resend vira ApiError, não uma exceção genérica", async () => {
  env.RESEND_API_KEY = "re_test_key";
  env.FDP_EMAIL_FROM = "no-reply@vinculato.com";
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      dispatchTransactionalEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>", idempotencyKey: "k1" }),
      /EMAIL_DELIVERY_FAILED|Não foi possível enviar/u,
    );
  } finally {
    restoreEnv();
  }
});

/* ── `sendMemberActivationEmail` / `sendAccessRecoveryEmail`: nunca lançam ── */

test("sem provedor configurado, convite e recuperação devolvem null em vez de lançar", async () => {
  clearEmailConfig();
  try {
    assert.equal(await sendMemberActivationEmail({ to: "a@b.com", name: "Ana", activationUrl: "https://x/y", idempotencyKey: "k1" }), null);
    assert.equal(await sendAccessRecoveryEmail({ to: "a@b.com", name: "Ana", recoveryUrl: "https://x/y", idempotencyKey: "k1" }), null);
  } finally {
    restoreEnv();
  }
});

test("com provedor configurado, convite e recuperação chegam ao Resend com o link no corpo", async () => {
  env.RESEND_API_KEY = "re_test_key";
  env.FDP_EMAIL_FROM = "no-reply@vinculato.com";
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return { ok: true, json: async () => ({ id: "resend-123" }) } as Response;
  }) as typeof fetch;
  try {
    const activation = await sendMemberActivationEmail({ to: "a@b.com", name: "Ana", activationUrl: "https://x/definir", idempotencyKey: "k1" });
    const recovery = await sendAccessRecoveryEmail({ to: "a@b.com", name: "Ana", recoveryUrl: "https://x/recuperar", idempotencyKey: "k2" });
    assert.deepEqual(activation, { provider: "resend", id: "resend-123" });
    assert.deepEqual(recovery, { provider: "resend", id: "resend-123" });
    assert.match(String(bodies[0]?.html), /https:\/\/x\/definir/u);
    assert.match(String(bodies[1]?.html), /https:\/\/x\/recuperar/u);
  } finally {
    restoreEnv();
  }
});

test("o nome do convidado é escapado no HTML do e-mail", async () => {
  env.RESEND_API_KEY = "re_test_key";
  env.FDP_EMAIL_FROM = "no-reply@vinculato.com";
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return { ok: true, json: async () => ({ id: "resend-123" }) } as Response;
  }) as typeof fetch;
  try {
    await sendMemberActivationEmail({ to: "a@b.com", name: "<script>alert(1)</script>", activationUrl: "https://x/y", idempotencyKey: "k1" });
    assert.doesNotMatch(String(body?.html), /<script>/u);
  } finally {
    restoreEnv();
  }
});

/* ── confirmação de cadastro: continua exigindo o provedor ────────────────── */

test("sendSignupConfirmationEmail continua recusando em produção sem provedor configurado", async () => {
  clearEmailConfig();
  env.NODE_ENV = "production";
  try {
    await assert.rejects(
      sendSignupConfirmationEmail({ to: "a@b.com", name: "Ana", confirmationUrl: "https://x/y", idempotencyKey: "k1" }),
      /EMAIL_NOT_CONFIGURED|indisponível/u,
    );
  } finally {
    restoreEnv();
  }
});

/* ── as rotas chamam o e-mail sem travar a resposta em caso de falha ──────── */

test("o convite de membro envia o e-mail de ativação e nunca deixa a falha travar a resposta", async () => {
  const route = await readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8");
  assert.match(route, /sendMemberActivationEmail/u);
  assert.match(route, /idempotencyKey:\s*tokenId/u);
  // A chamada precisa estar dentro de um try/catch que não relança: a
  // ativação/link continua sendo devolvida mesmo se o e-mail falhar.
  const activationBlock = route.slice(route.indexOf("let activation"), route.indexOf("await recordActivity"));
  assert.match(activationBlock, /try\s*\{[\s\S]*sendMemberActivationEmail[\s\S]*\}\s*catch/u);
  assert.match(activationBlock, /emailSent/u);
});

test("a recuperação de acesso gerada por um administrador envia o e-mail e nunca lança", async () => {
  const route = await readFile(new URL("../app/api/members/[id]/recovery/route.ts", import.meta.url), "utf8");
  assert.match(route, /sendAccessRecoveryEmail/u);
  assert.match(route, /idempotencyKey:\s*tokenId/u);
  const block = route.slice(route.indexOf("const { token, hash }"), route.lastIndexOf("return Response.json"));
  assert.match(block, /try\s*\{[\s\S]*sendAccessRecoveryEmail[\s\S]*\}\s*catch/u);
  assert.match(block, /emailSent/u);
});
