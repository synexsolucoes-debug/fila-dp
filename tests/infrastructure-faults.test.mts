import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("o procedimento de produção pergunta ao banco o que está pendente", async () => {
  /* O passo chamado "veja o que está pendente" rodava `db:check`, que valida os
     arquivos do clone e não abre conexão nenhuma. Quem seguia o roteiro à risca
     aplicava sem saber o que ia aplicar, e só descobria depois. Um roteiro que
     promete uma resposta e entrega outra é pior que um roteiro incompleto:
     quem o segue acredita ter conferido. */
  const runbook = await readFile(new URL("../docs/aplicar-migracoes-em-producao.md", import.meta.url), "utf8");
  const passo = runbook.slice(runbook.indexOf("## Passo 2"), runbook.indexOf("## Passo 3"));
  assert.match(passo, /npm run db:status/u, "o passo precisa consultar o banco, não só os arquivos");
  assert.match(passo, /api\/health/u, "e dizer como conferir sem credencial nenhuma");
  assert.doesNotMatch(passo.replace(/> `npm run db:check`[\s\S]*?produção\./u, ""), /npm run db:check/u,
    "db:check não responde o que está pendente — só entra aqui para dizer que não responde");

  // O comando existe e está declarado — sem isso o roteiro manda rodar o que
  // não roda.
  const pacote = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pacote.scripts["db:status"] ?? "", /migration-status\.mjs/u);

  /* E ele não escreve: conferir estado é gesto de leitura, e um comando de
     conferência que altera o banco não é rodado quando mais importa — na
     dúvida, antes de aplicar. */
  const script = await readFile(new URL("../scripts/migration-status.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE TABLE|DROP)\b/u,
    "db:status precisa ser somente leitura");
});

test("só o build de produção migra, e migração que falha não publica", async () => {
  /* Aplicar no deploy foi decisão de quem opera: o passo manual já foi
     esquecido, e schema atrasado derruba o painel inteiro. O que este teste
     prende são as bordas dessa decisão.

     A mais perigosa é o preview. Um deployment de preview cuja `DATABASE_URL`
     aponte para produção migraria o banco de verdade a partir de um branch
     qualquer — a forma mais fácil que existe de aplicar em produção uma
     migração que ninguém revisou. */
  const passo = await readFile(new URL("../scripts/deploy-migrate.mjs", import.meta.url), "utf8");
  assert.match(passo, /VERCEL_ENV/u);
  assert.match(passo, /ambiente !== "production"/u, "qualquer ambiente que não seja produção precisa sair sem migrar");
  assert.match(passo, /!process\.env\.VERCEL/u, "build local e o da integração também não migram");

  /* E o build precisa parar quando a migração não aplica: publicar a versão
     nova apontando para um banco que ela não entende troca uma falha visível
     no deploy por `SCHEMA_OUTDATED` na cara de quem usa. */
  assert.match(passo, /process\.exit\(1\)/u);

  // A saída de emergência existe e não exige mexer em código.
  assert.match(passo, /FDP_MIGRATE_ON_DEPLOY/u);

  /* O comando do deploy é o que a Vercel chama, e ele precisa migrar ANTES de
     construir: migrar depois publicaria o build junto com um banco que ainda
     não mudou. */
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as {
    buildCommand?: string;
  };
  const pacote = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const comando = vercel.buildCommand ?? "";
  assert.match(comando, /build:deploy/u, "o build da Vercel precisa passar pelo passo de migração");
  const roteiro = pacote.scripts["build:deploy"] ?? "";
  assert.ok(
    roteiro.indexOf("deploy-migrate") < roteiro.indexOf("next build") && roteiro.includes("&&"),
    `a migração precisa vir antes do build, e só seguir se der certo — está "${roteiro}"`,
  );
  // `npm run build` continua sendo só o build: é o que a integração roda, e
  // ali não existe banco de produção para migrar.
  assert.equal(pacote.scripts.build, "next build");
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
  // Prontidão degradada continua respondendo 503. A condição deixou de ser só
  // essa — a fila parada também derruba o veredito —, mas a garantia original
  // não pode se perder no meio da nova: schema atrás da aplicação é indisponível.
  assert.match(route, /report\.status !== "ok"/u);
  assert.match(route, /status: unavailable \? 503 : 200/u);
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

/**
 * O defeito que este teste protege: sem `FDP_INTEGRATION_VAULT_KEY` o cofre
 * recusava toda gravação de credencial com 503, mas `/api/health` respondia
 * "ok" porque só olhava o banco. Quem operava via apenas "não salva".
 */
test("a prontidão acusa capacidade desligada por segredo ausente", async () => {
  const { missingConfiguration } = await import("../lib/readiness.ts");
  const keys = ["FDP_AUTH_SECRET", "FDP_PII_HASH_SECRET", "FDP_INTEGRATION_VAULT_KEY", "FDP_INTEGRATION_VAULT_KEYS", "FDP_INTEGRATION_WORKER_SECRET", "BLOB_READ_WRITE_TOKEN"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key]; else process.env[key] = previous.get(key);
    }
  };
  try {
    for (const key of keys) delete process.env[key];
    const capabilities = missingConfiguration().map((entry) => entry.capability);
    assert.ok(capabilities.includes("Cofre de credenciais das integrações"));
    assert.ok(capabilities.includes("Executor assíncrono de integrações e webhooks"));
    assert.ok(capabilities.includes("Anexos das demandas"));

    // Só o cofre configurado já religa a gravação de credencial.
    process.env.FDP_INTEGRATION_VAULT_KEY = Buffer.alloc(32, 3).toString("base64");
    assert.ok(!missingConfiguration().some((entry) => entry.capability === "Cofre de credenciais das integrações"));

    // O fallback declarado no código é respeitado: o CPF aceita o segredo de sessão.
    process.env.FDP_AUTH_SECRET = "segredo-de-sessao-suficientemente-longo";
    assert.ok(!missingConfiguration().some((entry) => entry.capability === "Proteção de CPF no cadastro de pessoas"));

    // Com tudo configurado, nada é reportado como desligado.
    process.env.FDP_INTEGRATION_WORKER_SECRET = "segredo-do-executor";
    process.env.BLOB_READ_WRITE_TOKEN = "token-do-blob";
    assert.deepEqual(missingConfiguration(), []);
  } finally {
    restore();
  }
});

test("o cofre recusado nomeia a variável que falta em vez de só falhar", async () => {
  const source = await readFile(new URL("../lib/integrations.ts", import.meta.url), "utf8");
  assert.match(source, /VAULT_NOT_CONFIGURED/u);
  assert.match(source, /FDP_INTEGRATION_VAULT_KEY/u);
  // O template de produção precisa listar o que o deployment exige de verdade.
  const template = await readFile(new URL("../vercel-env.example", import.meta.url), "utf8");
  for (const key of ["FDP_INTEGRATION_VAULT_KEY", "FDP_INTEGRATION_WORKER_SECRET", "FDP_PII_HASH_SECRET"]) {
    assert.match(template, new RegExp(key), `${key} precisa estar no template de produção`);
  }
});

test("todo arquivo de teste está na lista que o npm test executa", async () => {
  // O script enumera os arquivos um a um. Um teste novo fica invisível até ser
  // registrado — passa a suíte inteira sem nunca ter rodado. Já aconteceu com
  // tests/contractor-registry.test.mts nesta sessão.
  const files = (await readdir(fileURLToPath(new URL("../tests", import.meta.url))))
    .filter((file) => /\.test\.(mts|mjs)$/u.test(file))
    .sort();
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test ?? "";
  const missing = files.filter((file) => !script.includes(`tests/${file}`));
  assert.deepEqual(missing, [], `adicione ao script "test" do package.json: ${missing.join(", ")}`);
});
