import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { classifyInfrastructureFault } from "../lib/infrastructure-errors.ts";
import { expectedMigrations, latestMigration } from "../lib/schema-manifest.ts";

/**
 * O defeito que estes testes protegem: com o banco atrás da versão do
 * aplicativo, TODA a operação respondia "Não foi possível concluir a operação."
 * — a mesma frase de um defeito qualquer. O cliente via uma tela morta e nem
 * ele nem quem opera sabia que faltava aplicar migração.
 */

function postgresError(code: string, message = "erro do banco") {
  return Object.assign(new Error(message), { code, name: "NeonDbError" });
}

test("banco atrás da aplicação é reconhecido como desatualização, não como defeito", () => {
  // Códigos reais devolvidos pelo PostgreSQL quando falta tabela, coluna ou tipo.
  for (const code of ["42P01", "42703", "42883", "42704", "3F000"]) {
    const fault = classifyInfrastructureFault(postgresError(code));
    assert.equal(fault?.code, "SCHEMA_OUTDATED", `${code} deveria indicar schema desatualizado`);
    assert.equal(fault?.status, 503, "desatualização é indisponibilidade temporária, não erro do cliente");
    assert.match(fault!.message, /migra/iu, "a mensagem precisa dizer o que resolve");
  }
});

test("banco fora do ar é reconhecido como indisponibilidade", () => {
  for (const code of ["08006", "57P03", "53300", "28P01", "3D000"]) {
    assert.equal(classifyInfrastructureFault(postgresError(code))?.code, "DATABASE_UNAVAILABLE", code);
  }
  for (const message of ["connect ECONNREFUSED 10.0.0.1:5432", "fetch failed", "Banco não configurado. Defina DATABASE_URL"]) {
    assert.equal(classifyInfrastructureFault(new Error(message))?.code, "DATABASE_UNAVAILABLE", message);
  }
});

test("a mensagem operacional não vaza SQL, tabela, host nem credencial", () => {
  const leaky = postgresError("42P01", 'relation "fdp_modules" does not exist');
  const fault = classifyInfrastructureFault(leaky);
  assert.ok(fault);
  assert.doesNotMatch(fault.message, /fdp_|SELECT|INSERT|relation|postgres:\/\/|senha|password/iu);
  // O motivo técnico segue para o log, não para a tela.
  assert.equal(fault.reason, "schema_drift:42P01");
});

test("papel sem privilégio é reconhecido como permissão, não como defeito", () => {
  // Acontece quando uma versão nova cria objetos e o papel da aplicação fica
  // sem GRANT sobre eles: o schema está em dia e mesmo assim tudo falha.
  const fault = classifyInfrastructureFault(postgresError("42501", "permission denied for table fdp_modules"));
  assert.equal(fault?.code, "DATABASE_PERMISSION_DENIED");
  assert.equal(fault?.status, 503);
  assert.match(fault!.message, /permiss/iu);
  assert.doesNotMatch(fault!.message, /fdp_/u);
});

test("defeito inesperado continua no caminho genérico", () => {
  assert.equal(classifyInfrastructureFault(new TypeError("x is not a function")), null);
  assert.equal(classifyInfrastructureFault(postgresError("23505", "duplicate key")), null);
  assert.equal(classifyInfrastructureFault(null), null);
});

test("a resposta da API classifica a falha operacional em vez de esconder", async () => {
  const { apiErrorResponse } = await import("../lib/api-errors.ts");
  const response = apiErrorResponse(postgresError("42P01", 'relation "fdp_modules" does not exist'));
  assert.equal(response.status, 503);
  const body = await response.json() as { error: string; code: string; requestId: string };
  assert.equal(body.code, "SCHEMA_OUTDATED");
  assert.ok(body.requestId, "a resposta precisa trazer o número de chamado para o usuário reportar");
  assert.doesNotMatch(body.error, /fdp_|relation/iu);
});

test("o manifesto de schema acompanha o diretório de migrations", async () => {
  const directory = new URL("../drizzle/postgres/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).sort();
  assert.deepEqual([...expectedMigrations], files,
    "regenerar com `npm run schema:manifest` — a aplicação precisa saber qual schema ela espera");
  assert.equal(latestMigration, files.at(-1));

  // O journal do Drizzle precisa listar as mesmas migrations, na mesma ordem.
  // Escrever o .sql à mão e esquecer o journal passa despercebido em toda
  // verificação local e só reprova no `db:check` da integração — tarde demais.
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const tags = [...journal.entries].sort((left, right) => left.idx - right.idx).map((entry) => entry.tag);
  assert.deepEqual(tags, files.map((file) => file.replace(/\.sql$/u, "")),
    "migration fora do journal do Drizzle: adicione a entrada em drizzle/postgres/meta/_journal.json");
  assert.ok(journal.entries.every((entry, index) => entry.idx === index), "os índices do journal precisam ser sequenciais");
});

test("a prontidão confere acesso, não só o histórico de migrações", async () => {
  const source = await readFile(new URL("../lib/readiness.ts", import.meta.url), "utf8");
  // Histórico completo com papel sem privilégio dizia "ok" enquanto o produto
  // estava fora do ar. A sondagem de leitura fecha esse buraco.
  assert.match(source, /probeReadAccess/u);
  assert.match(source, /LIMIT 0/u, "a sondagem não pode trazer dado de cliente");
  assert.match(source, /DATABASE_PERMISSION_DENIED/u);
  for (const table of ["fdp_workspaces", "fdp_modules", "fdp_saas_plans"]) {
    assert.match(source, new RegExp(table), `a sondagem precisa cobrir ${table}`);
  }

  const route = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  // Detalhe de migração pendente é informação de operação, não pública.
  assert.match(route, /isPlatformAdmin/u);
  assert.match(route, /report\.status === "ok" \? 200 : 503/u);
  assert.doesNotMatch(route, /DATABASE_URL|password|token/iu);
});

test("a tela de falha do painel identifica a causa e dá referência de suporte", async () => {
  const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  // O erro inteiro é preservado, não só a frase.
  assert.match(source, /throw requestErrorFrom\(response, payload\)/u);
  assert.match(source, /setStartupFailure\(cause\)/u);
  assert.match(source, /supportReference\(startupFailure\)/u);
  assert.match(source, /Informe ao suporte/u);
  // Falha de infraestrutura não é apresentada como erro da conta do cliente.
  assert.match(source, /Não é um problema da sua conta/u);
});

test("todo arquivo de teste está na lista que o npm test executa", async () => {
  // O script enumera os arquivos um a um. Um teste novo fica invisível até ser
  // registrado — passa a suíte inteira sem nunca ter rodado. Já aconteceu com
  // tests/contractor-registry.test.mts nesta sessão.
  const files = (await readdir(new URL("../tests", import.meta.url).pathname))
    .filter((file) => /\.test\.(mts|mjs)$/u.test(file))
    .sort();
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test ?? "";
  const missing = files.filter((file) => !script.includes(`tests/${file}`));
  assert.deepEqual(missing, [], `adicione ao script "test" do package.json: ${missing.join(", ")}`);
});
