import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { credentialPublicHint, openCredentials, sealCredentials } from "../lib/integrations.ts";
import { nextSankhyaRunAt, sanitizeSankhyaConfig } from "../lib/sankhya/config.ts";
import { SankhyaConnectorError, safeSankhyaError } from "../lib/sankhya/errors.ts";
import { parseSankhyaExport } from "../lib/sankhya/files.ts";
import { isPrivateNetworkAddress } from "../lib/sankhya/navigation-security.ts";
import { normalizeSankhyaEmployee, persistedSankhyaEmployee } from "../lib/sankhya/normalization.ts";
import { MockSankhyaSession } from "../worker/sankhya/mock-session.ts";

test("credenciais Sankhya usam AES-GCM, são recuperáveis apenas no backend e têm dica mascarada", () => {
  const previous = process.env.FDP_INTEGRATION_VAULT_KEY;
  const previousVersion = process.env.FDP_INTEGRATION_VAULT_KEY_VERSION;
  process.env.FDP_INTEGRATION_VAULT_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.FDP_INTEGRATION_VAULT_KEY_VERSION = "1";
  try {
    const credentials = { username: "integracao.dp", password: "Senha-Forte-123" };
    const sealed = sealCredentials("sankhya_browser", credentials);
    assert.doesNotMatch(sealed.encryptedValue, /integracao|Senha-Forte/u);
    assert.deepEqual(openCredentials("sankhya_browser", sealed), credentials);
    assert.equal(credentialPublicHint("sankhya_browser", credentials), "int**********");
    assert.throws(() => sealCredentials("sankhya_browser", { username: "user", password: "curta" }), /tamanho inválido/u);
  } finally {
    if (previous === undefined) delete process.env.FDP_INTEGRATION_VAULT_KEY; else process.env.FDP_INTEGRATION_VAULT_KEY = previous;
    if (previousVersion === undefined) delete process.env.FDP_INTEGRATION_VAULT_KEY_VERSION; else process.env.FDP_INTEGRATION_VAULT_KEY_VERSION = previousVersion;
  }
});

test("URL do Sankhya exige HTTPS, host permitido e bloqueia destinos de SSRF", () => {
  const previous = process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
  process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = "erp.cliente.example";
  try {
    const config = sanitizeSankhyaConfig({ endpoint: "https://erp.cliente.example/mge/", companyId: "company-a" });
    assert.equal(config.endpoint, "https://erp.cliente.example/mge/");
    assert.throws(() => sanitizeSankhyaConfig({ endpoint: "http://erp.cliente.example" }), /seguro|HTTPS/iu);
    assert.throws(() => sanitizeSankhyaConfig({ endpoint: "https://127.0.0.1/admin" }), /seguro|autorizado/iu);
  } finally {
    if (previous === undefined) delete process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS; else process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = previous;
  }
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) assert.equal(isPrivateNetworkAddress(address), true, address);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
});

test("normalização converte moeda brasileira sem multiplicar salário e minimiza CPF", () => {
  const { normalized, errors } = normalizeSankhyaEmployee({
    "Código": "S-42", "Matrícula": "0042", "Nome": "Ana de Souza", "CPF": "529.982.247-25",
    "Data Admissão": "13/08/2026", "Salário Base": "9.000,00", "Cargo": "Analista", "Situação": "Ativo",
  });
  assert.deepEqual(errors, []);
  assert.equal(normalized.salaryCents, 900_000);
  assert.equal(normalized.admissionDate, "2026-08-13");
  assert.equal(normalized.cpfDigits, "52998224725");
  const snapshot = persistedSankhyaEmployee(normalized);
  assert.equal(snapshot.cpfLast4, "4725");
  assert.equal("cpfDigits" in snapshot, false);
});

test("exportação CSV é estruturada, limitada e arquivo não permitido é recusado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vinculato-sankhya-test-"));
  try {
    const csv = join(directory, "resultado.csv");
    await writeFile(csv, "Código;Matrícula;Nome;Salário\r\n1;001;Ana;9.000,00\r\n", "utf8");
    const records = await parseSankhyaExport(csv, "resultado.csv", 1_000_000);
    assert.equal(records.length, 1);
    assert.equal(records[0].Nome, "Ana");
    assert.equal(records[0]["Salário"], "9.000,00");
    await assert.rejects(parseSankhyaExport(csv, "resultado.exe", 1_000_000), /tipo de arquivo/u);
    await assert.rejects(parseSankhyaExport(csv, "resultado.csv", 2), /excede o limite/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("mock cobre sucesso, login inválido, MFA, CAPTCHA e timeout", async () => {
  await new MockSankhyaSession("success").authenticate();
  for (const [scenario, code, flag] of [
    ["invalid_login", "SANKHYA_LOGIN_INVALID", ""], ["mfa", "SANKHYA_MFA_REQUIRED", "requiresUserAction"],
    ["captcha", "SANKHYA_CAPTCHA_REQUIRED", "requiresUserAction"], ["timeout", "SANKHYA_LOGIN_TIMEOUT", "retryable"],
  ] as const) {
    await assert.rejects(new MockSankhyaSession(scenario).authenticate(), (error) => {
      assert.ok(error instanceof SankhyaConnectorError); assert.equal(error.code, code);
      if (flag) assert.equal(error[flag], true);
      return true;
    });
  }
  await assert.rejects(new MockSankhyaSession("selector_missing").openDpExplorer(), (error) => error instanceof SankhyaConnectorError && error.layoutRelated);
  await assert.rejects(new MockSankhyaSession("invalid_file").extract(), (error) => error instanceof SankhyaConnectorError && error.code === "SANKHYA_EXPORT_CONTENT_INVALID");
  const flow = new MockSankhyaSession("success", [{ Código: "1" }]);
  await flow.authenticate(); await flow.openDpExplorer(); await flow.runRoutine(); await flow.extract(); await flow.logout(); await flow.close();
  assert.deepEqual(flow.calls, ["authenticate", "openDpExplorer", "runRoutine", "extract", "logout", "close"]);
});

test("agendamento respeita frequência, horário e fuso configurados", () => {
  const base = { endpoint: "https://cliente.sankhya.com.br", companyId: "company-a", companyContext: "", routine: "employees" as const,
    routineName: "DP Explorer", automaticEnabled: true, scheduleTime: "02:00", scheduleWeekday: 1, timezone: "America/Sao_Paulo",
    timeoutMs: 300_000, maxAttempts: 3, downloadLimitBytes: 25_000_000, diagnosticRetentionHours: 24 };
  assert.equal(nextSankhyaRunAt({ ...base, frequency: "hourly" }, new Date("2026-08-13T12:00:00Z")), "2026-08-13T13:00:00.000Z");
  assert.equal(nextSankhyaRunAt({ ...base, frequency: "daily" }, new Date("2026-08-13T12:00:00Z")), "2026-08-14T05:00:00.000Z");
});

test("migrations, rotas e worker mantêm escopo por workspace, lock e limpeza obrigatória", async () => {
  const [migration, queue, worker, credentialsRoute, overview, logsRoute, browser] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0038_sankhya_browser_connector.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/sankhya/queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sankhya/worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/credentials/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/logs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/sankhya/playwright-session.ts", import.meta.url), "utf8"),
  ]);
  for (const table of ["fdp_integration_run_logs", "fdp_integration_diagnostics", "fdp_employee_external_refs", "fdp_employee_sync_changes"]) assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  assert.match(migration, /fdp_sankhya_active_run_uq[\s\S]+workspace_id[\s\S]+integration_id/u);
  assert.match(queue, /workspace_id = \? AND id = \? AND channel = 'sankhya_browser'/u);
  assert.match(worker, /finally[\s\S]+session\.logout\(\)[\s\S]+session\.close\(\)/u);
  assert.doesNotMatch(overview, /SELECT[^;]+encrypted_value/iu);
  assert.doesNotMatch(credentialsRoute, /return Response\.json\([^;]*encryptedValue/iu);
  assert.match(logsRoute, /integrations\.logs\.view/u);
  assert.doesNotMatch(browser, /--no-sandbox/u);
  assert.match(browser, /clearCookies[\s\S]+localStorage\.clear[\s\S]+sessionStorage\.clear/u);
});

test("sanitização de erro remove segredos", () => {
  const safe = safeSankhyaError(new Error("password=SuperSecret token=abcdef cookie=session123"));
  assert.doesNotMatch(safe.message, /SuperSecret|abcdef|session123/u);
});
