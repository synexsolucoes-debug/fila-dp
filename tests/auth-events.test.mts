import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §40 pede login e logout na auditoria. Eles não estavam, e o motivo era
 * estrutural: `fdp_audit_events.workspace_id` é NOT NULL e a tabela tem RLS por
 * workspace — mas o login acontece antes de existir contexto de workspace, e
 * quem pertence a vários não tem um "correto" a que atribuir o evento. A trilha
 * global também não servia: a política dela exige `app.platform_admin` até para
 * escrever, e o login não tem essa marca nem deveria forjá-la.
 *
 * O que existia cobria parte e continua valendo: `fdp_auth_sessions` guarda a
 * sessão bem-sucedida com dispositivo e IP. O que faltava era durabilidade da
 * tentativa recusada — `clearLoginIdentityFailures` apaga o rate limit assim
 * que um login dá certo, que é o comportamento correto dele, mas leva junto o
 * rastro do padrão clássico: vinte tentativas erradas e depois uma certa.
 */

const migration = await readFile(new URL("../drizzle/postgres/0040_auth_events.sql", import.meta.url), "utf8");
const module_ = await readFile(new URL("../lib/auth-events.ts", import.meta.url), "utf8");
const login = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");

test("a trilha de acesso não depende de workspace", () => {
  const tabela = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "fdp_auth_events"'));
  const corpo = tabela.slice(0, tabela.indexOf(");"));
  assert.doesNotMatch(corpo, /workspace_id/u, "exigir workspace é o que impedia registrar o login");
  // O usuário é opcional: a tentativa contra e-mail inexistente também é evento.
  assert.match(corpo, /"user_id" text,/u);
  assert.match(corpo, /"email" text NOT NULL/u);
});

test("gravar é livre, ler é só da plataforma", () => {
  // Um evento que precisa de permissão para nascer não é trilha: o login
  // precisa registrar antes de existir qualquer contexto.
  assert.match(migration, /CREATE POLICY "fdp_auth_events_append" ON "fdp_auth_events" FOR INSERT WITH CHECK \(true\)/u);
  // A tabela mostra e-mails tentados e o padrão de acesso de todos os clientes.
  assert.match(migration, /FOR SELECT\s*\n\s*USING \(current_setting\('app\.platform_admin', true\) = 'true'\)/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
});

test("a trilha é append-only", () => {
  // Verificado contra PostgreSQL: UPDATE e DELETE respondem
  // "fdp_auth_events is append-only".
  assert.match(migration, /RAISE EXCEPTION 'fdp_auth_events is append-only'/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_auth_events"/u);
});

test("registrar nunca derruba o acesso", () => {
  // Uma trilha que impede alguém de entrar quando o banco engasga troca um
  // problema de observabilidade por um de disponibilidade.
  const fn = module_.slice(module_.indexOf("export async function recordAuthEvent"));
  assert.match(fn, /catch \(error\) \{/u);
  // Comentários fora antes de procurar: o próprio texto que explica a decisão
  // menciona `throw`, e casar com ele acusaria o contrário do que se quer.
  const codigo = fn.replace(/\/\/[^\n]*/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(codigo, /\bthrow\b/u, "a falha de registro não pode escapar da função");
  // Mas ela precisa acender em algum lugar.
  assert.match(fn, /log\("error", "auth\.event_not_recorded"/u);
});

test("IP e agente entram como hash, não em claro", () => {
  // Verificado contra PostgreSQL: a mesma origem produz o mesmo hash, então dá
  // para correlacionar "esta origem tentou doze e-mails" sem guardar o endereço
  // numa tabela que já contém e-mail.
  assert.match(module_, /createHash\("sha256"\)/u);
  assert.match(module_, /ip_hash/u);
  assert.doesNotMatch(module_, /event\.address\s*\)/u, "o endereço não pode ir cru para o banco");
});

test("o login registra sucesso e as três recusas, distinguindo-as", () => {
  assert.match(login, /outcome: "success"/u);
  // A trilha separa "senha errada" de "e-mail inexistente" — a resposta ao
  // cliente continua sem dizer qual dos dois, para não confirmar contas.
  assert.match(login, /reason: current \? "senha incorreta" : "e-mail sem conta"/u);
  assert.match(login, /reason: "conta bloqueada"/u);
  assert.match(login, /reason: "sem associação a grupo"/u);
  // E a resposta pública continua igual para credencial inválida.
  assert.match(login, /"E-mail ou senha incorretos\."/u);
});

test("logout lê a identidade antes de encerrar a sessão", async () => {
  const logout = await readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8");
  // Depois de `clearAuthSession` não há mais de quem registrar o evento.
  assert.ok(logout.indexOf("getChatGPTUser") < logout.indexOf("await clearAuthSession()"),
    "a identidade precisa ser lida antes do encerramento");
  assert.match(logout, /action: "logout", outcome: "success"/u);
});

test("redefinir senha entra na trilha", async () => {
  const reset = await readFile(new URL("../app/api/auth/reset/route.ts", import.meta.url), "utf8");
  // É o evento que quem investiga acesso indevido procura primeiro.
  assert.match(reset, /action: "password_reset", outcome: "success"/u);
});

test("a leitura da trilha exige administrador da plataforma", async () => {
  const route = await readFile(new URL("../app/api/platform/auth-events/route.ts", import.meta.url), "utf8");
  assert.match(route, /requirePlatformAdmin\(auth\.user\)/u);
  assert.match(route, /withPlatformContext/u);
  // O hash de origem serve para correlacionar dentro do banco, não para sair.
  assert.doesNotMatch(route, /ip_hash,|event\.ip_hash/u);
  // A contagem de recusas é o número que denuncia varredura antes do cliente reclamar.
  assert.match(route, /deniedLoginsLast24h/u);
});

test("a migration está no journal", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0040_auth_events"));
});
