import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { log, redactLogFields, requestIdFrom } from "../lib/observability.ts";
import { domainEventTypes, isDomainEventType, parseEventTypes, sanitizeEventPayload } from "../lib/outbox.ts";
import {
  SIGNATURE_TOLERANCE_SECONDS, deliveryBody, deliveryDelaySeconds, signPayload, signatureHeader, validateWebhookUrl, verifySignature,
} from "../lib/webhooks.ts";
import { apiScopes, generateApiToken, hashApiToken, parseScopes, requestFingerprint } from "../lib/api-v1.ts";
import { requiresSameOrigin } from "../lib/request-security.ts";

process.env.FDP_AUTH_SECRET ??= "test-secret-for-phase-9-tests-only";

test("logs estruturados carregam correlação e nunca PII", () => {
  const entry = log("info", "test.event", { requestId: "req-1", workspaceId: "ws-1", jobId: "job-1" }, {
    status: "ok", email: "pessoa@empresa.com", cpf: "12345678901", token: "segredo", payload: { a: 1 }, attempt: 3,
  });
  assert.equal(entry.requestId, "req-1");
  assert.equal(entry.workspaceId, "ws-1");
  assert.equal(entry.jobId, "job-1");
  assert.equal(entry.status, "ok");
  assert.equal(entry.attempt, 3);
  for (const forbidden of ["email", "cpf", "token", "payload"]) {
    assert.equal(Object.hasOwn(entry, forbidden), false, `campo sensível vazou: ${forbidden}`);
  }
  const redacted = redactLogFields({ name: "Fulano", secret: "x", count: 2, nested: { deep: true } });
  assert.deepEqual(Object.keys(redacted), ["count"]);
});

test("o requestId reaproveita o cabeçalho válido e recusa lixo", () => {
  const reused = requestIdFrom(new Request("https://fila.dp/api", { headers: { "x-fila-dp-request-id": "abc-123-def-456" } }));
  assert.equal(reused, "abc-123-def-456");
  const generated = requestIdFrom(new Request("https://fila.dp/api", { headers: { "x-fila-dp-request-id": "curto" } }));
  assert.notEqual(generated, "curto");
  assert.match(generated, /^[0-9a-f-]{36}$/u);
});

test("a assinatura de webhook cobre o timestamp e rejeita replay, adulteração e formato inválido", () => {
  const secret = "whsec_exemplo_para_teste_de_assinatura";
  const body = JSON.stringify({ id: "evt-1", type: "contractor_closing.closed" });
  const now = 1_800_000_000;
  const header = signatureHeader(secret, now, body);
  assert.match(header, /^t=\d+,v1=[a-f0-9]{64}$/u);

  assert.equal(verifySignature({ secret, header, body, nowSeconds: now }).valid, true);
  // Corpo adulterado com a mesma assinatura.
  assert.deepEqual(verifySignature({ secret, header, body: `${body} `, nowSeconds: now }), { valid: false, reason: "mismatch" });
  // Segredo errado.
  assert.equal(verifySignature({ secret: "whsec_outro_segredo_qualquer_aqui", header, body, nowSeconds: now }).valid, false);
  // Replay fora da janela.
  assert.deepEqual(
    verifySignature({ secret, header, body, nowSeconds: now + SIGNATURE_TOLERANCE_SECONDS + 1 }),
    { valid: false, reason: "expired" },
  );
  assert.equal(verifySignature({ secret, header, body, nowSeconds: now + SIGNATURE_TOLERANCE_SECONDS - 1 }).valid, true);
  assert.deepEqual(verifySignature({ secret, header: "v1=deadbeef", body, nowSeconds: now }), { valid: false, reason: "malformed" });

  // Assinar só o corpo permitiria replay: o timestamp precisa entrar no material assinado.
  assert.notEqual(signPayload(secret, now, body), signPayload(secret, now + 1, body));
});

test("o backoff das entregas cresce e tem teto", () => {
  assert.equal(deliveryDelaySeconds(1), 30);
  assert.equal(deliveryDelaySeconds(2), 60);
  assert.equal(deliveryDelaySeconds(3), 120);
  assert.equal(deliveryDelaySeconds(20), 3600);
  assert.ok(deliveryDelaySeconds(6) < deliveryDelaySeconds(7) || deliveryDelaySeconds(7) === 3600);
});

test("o destino do webhook exige HTTPS público e recusa rede interna", () => {
  assert.equal(validateWebhookUrl("https://cliente.com.br/hooks/fila-dp"), "https://cliente.com.br/hooks/fila-dp");
  assert.throws(() => validateWebhookUrl("http://cliente.com.br/hook"), /HTTPS/);
  assert.throws(() => validateWebhookUrl("https://localhost/hook"), /rede interna/);
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/hook"), /rede interna/);
  assert.throws(() => validateWebhookUrl("https://10.0.0.5/hook"), /rede interna/);
  assert.throws(() => validateWebhookUrl("https://192.168.1.10/hook"), /rede interna/);
  assert.throws(() => validateWebhookUrl("https://169.254.169.254/latest/meta-data"), /rede interna/);
  assert.throws(() => validateWebhookUrl("https://user:pass@cliente.com.br/hook"), /credenciais/);
  assert.throws(() => validateWebhookUrl("nao-e-url"), /URL HTTPS/);
});

test("o corpo entregue identifica evento, entrega e origem sem vazar dado pessoal", () => {
  const body = deliveryBody({
    deliveryId: "dlv-1", eventId: "evt-1", eventType: "contractor_closing.closed",
    entityType: "contractor_closing", entityId: "ccl-1", occurredAt: "2026-08-09T12:00:00.000Z",
    workspaceId: "ws-1", payload: { competence: "2026-08", netAmount: 8200 },
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.id, "evt-1");
  assert.equal(parsed.deliveryId, "dlv-1");
  assert.equal(parsed.type, "contractor_closing.closed");
  assert.equal(parsed.workspaceId, "ws-1");
  assert.deepEqual(parsed.data, { competence: "2026-08", netAmount: 8200 });
});

test("a carga do evento é allowlisted e os tipos são fechados", () => {
  const payload = sanitizeEventPayload({
    competence: "2026-08", netAmount: 8200, employeeName: "Fulano", cpf: "12345678901",
    diagnosis: "nada disso", status: "closed", nested: { a: 1 },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["competence", "netAmount", "status"]);
  assert.ok(domainEventTypes.includes("contractor_closing.closed"));
  assert.equal(isDomainEventType("contractor_closing.closed"), true);
  assert.equal(isDomainEventType("qualquer.coisa"), false);
  assert.deepEqual(parseEventTypes(["contractor_closing.closed", "invalido", "contractor_closing.closed"]), ["contractor_closing.closed"]);
  assert.throws(() => parseEventTypes(["invalido"]), /evento suportado/);
});

test("a chave de API é opaca, guardada como HMAC e sempre com escopo declarado", () => {
  const first = generateApiToken();
  const second = generateApiToken();
  assert.match(first.token, /^fdp_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/u);
  assert.notEqual(first.token, second.token);
  assert.equal(first.token.startsWith(first.prefix), true);
  // O hash é determinístico para o mesmo token e diferente entre tokens.
  assert.equal(hashApiToken(first.token), first.tokenHash);
  assert.notEqual(first.tokenHash, second.tokenHash);
  // O token nunca é derivável do hash guardado.
  assert.equal(first.tokenHash.includes(first.token), false);

  assert.deepEqual(parseScopes(["payments.read", "payments.read", "invalido"]), ["payments.read"]);
  assert.throws(() => parseScopes([]), /escopo válido/);
  assert.throws(() => parseScopes(["inexistente"]), /escopo válido/);
  assert.deepEqual([...apiScopes].sort(), ["companies.read", "competences.read", "employees.read", "payments.read", "payments.write"]);
});

test("a impressão da requisição distingue corpo e caminho para a idempotência", () => {
  const a = requestFingerprint("POST", "/api/v1/contractor-components", '{"amount":100}');
  assert.equal(a, requestFingerprint("POST", "/api/v1/contractor-components", '{"amount":100}'));
  assert.notEqual(a, requestFingerprint("POST", "/api/v1/contractor-components", '{"amount":101}'));
  assert.notEqual(a, requestFingerprint("POST", "/api/v1/outra", '{"amount":100}'));
});

test("rotas servidor-a-servidor ficam fora da checagem de origem, o painel não", () => {
  assert.equal(requiresSameOrigin("POST", "/api/v1/contractor-components"), false);
  assert.equal(requiresSameOrigin("POST", "/api/webhooks/worker"), false);
  assert.equal(requiresSameOrigin("POST", "/api/integrations/worker"), false);
  // O painel continua protegido contra CSRF.
  assert.equal(requiresSameOrigin("POST", "/api/payments/contractors/components"), true);
  assert.equal(requiresSameOrigin("POST", "/api/settings/api-keys"), true);
  assert.equal(requiresSameOrigin("GET", "/api/v1/companies"), false);
});

test("o outbox grava o evento no mesmo lote do fato e a publicação é idempotente", async () => {
  const [outbox, contractorTransition, psychologyTransition] = await Promise.all([
    readFile(new URL("../lib/outbox.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/transition/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/psychology/closings/[id]/transition/route.ts", import.meta.url), "utf8"),
  ]);
  // O evento entra no mesmo batch da auditoria da mutação.
  for (const source of [contractorTransition, psychologyTransition]) {
    assert.match(source, /prepareDomainEvent\(/);
    assert.match(source, /await d1\.batch\(statements\)/);
  }
  assert.match(outbox, /ON CONFLICT \(workspace_id, endpoint_id, event_id\) DO NOTHING/);
  assert.match(outbox, /status = 'pending'/);
});

test("o executor de webhooks usa lease, backoff e dead-letter fora da requisição do usuário", async () => {
  const [webhooks, worker] = await Promise.all([
    readFile(new URL("../lib/webhooks.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/webhooks/worker/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(webhooks, /FOR UPDATE SKIP LOCKED/);
  assert.match(webhooks, /lease_token/);
  assert.match(webhooks, /dead_letter/);
  assert.match(webhooks, /AbortSignal\.timeout/);
  assert.match(webhooks, /redirect: "error"/);
  assert.match(worker, /matchesSecret/);
  assert.match(worker, /timingSafeEqual/);
  assert.match(worker, /publishPendingDomainEvents/);
  assert.doesNotMatch(worker, /getWorkspaceSnapshot/);
});

test("a API pública autentica, limita, escopa e versiona antes de qualquer consulta", async () => {
  const [apiV1, companies, components] = await Promise.all([
    readFile(new URL("../lib/api-v1.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/companies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/contractor-components/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(apiV1, /timingSafeEqual/);
  assert.match(apiV1, /setTenantContext/);
  assert.match(apiV1, /API_RATE_LIMITED/);
  assert.match(apiV1, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(apiV1, /X-Fila-DP-Api-Version/);
  // Autenticação e escopo antes da consulta de negócio.
  const authIndex = companies.indexOf("authenticateApiRequest");
  const scopeIndex = companies.indexOf("requireScope");
  const queryIndex = companies.indexOf("d1.prepare");
  assert.ok(authIndex >= 0 && scopeIndex > authIndex && queryIndex > scopeIndex);
  // Escrita reusa o serviço interno em vez de duplicar a regra.
  assert.match(components, /createContractorComponent/);
  assert.match(components, /requireScope\(context, "payments\.write"\)/);
  assert.match(components, /beginIdempotentRequest/);
  assert.match(components, /completeIdempotentRequest/);
  // Escrita não pagina: o que importa é limitar o tamanho do corpo aceito.
  assert.match(components, /REQUEST_TOO_LARGE/);
});

test("a API pública pagina por cursor e nunca expõe CPF", async () => {
  const [employees, closings] = await Promise.all([
    readFile(new URL("../app/api/v1/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/contractor-closings/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [employees, closings]) {
    assert.match(source, /paginationFrom/);
    assert.match(source, /nextCursor/);
    assert.match(source, /LIMIT \?/);
  }
  assert.match(employees, /cpf_last4/);
  assert.doesNotMatch(employees, /cpf_hash/);
});

test("demandas e biblioteca interna têm paginação estável no servidor", async () => {
  const [cards, processes] = await Promise.all([
    readFile(new URL("../app/api/cards/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [cards, processes]) {
    assert.match(source, /searchParams\.get\("cursor"\)/u);
    assert.match(source, /limit \+ 1/u);
    assert.match(source, /nextCursor/u);
    assert.match(source, /ORDER BY [\s\S]{0,80}\.id LIMIT \?/u);
  }
  assert.match(processes, /definition_id IN/u, "versões devem ser lidas somente para os processos da página");
});

test("o OpenAPI descreve apenas o que existe e documenta a verificação da assinatura", async () => {
  const source = await readFile(new URL("../app/api/v1/openapi.json/route.ts", import.meta.url), "utf8");
  for (const path of ["/companies", "/employees", "/competences", "/contractor-closings", "/contractor-components"]) {
    assert.ok(source.includes(`"${path}"`), `caminho ausente no OpenAPI: ${path}`);
  }
  // Endpoints inexistentes não são prometidos.
  for (const absent of ["/timesheets", "/payroll", "/admissions", "/documents"]) {
    assert.equal(source.includes(`"${absent}"`), false, `OpenAPI promete endpoint inexistente: ${absent}`);
  }
  assert.match(source, /X-Fila-DP-Signature/);
  assert.match(source, /300 segundos/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /x-required-scope/);
});

test("as tabelas de escala são tenant-scoped, com RLS forçada e evento imutável", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0019_outbox_webhooks_public_api.sql", import.meta.url), "utf8"),
  ]);
  for (const table of ["fdp_domain_events", "fdp_webhook_endpoints", "fdp_webhook_deliveries", "fdp_api_keys", "fdp_api_idempotency_records"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`));
  }
  for (const declaration of ["domainEvents", "webhookEndpoints", "webhookDeliveries", "apiKeys", "apiIdempotencyRecords"]) {
    assert.match(schema, new RegExp(`export const ${declaration} = pgTable`));
  }
  assert.match(migration, /domain events are append-only/);
  assert.match(migration, /published domain event is immutable/);
  // A chave é guardada como hash único e o endpoint só aceita HTTPS.
  assert.match(migration, /fdp_api_keys_token_hash_uq/);
  assert.match(migration, /fdp_webhook_endpoints_url_check/);
  assert.match(migration, /LIKE 'https:\/\/%'/);
});
