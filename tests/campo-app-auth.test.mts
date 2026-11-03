import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Login do aplicativo Vinculato Campo (Expo).
 *
 * O app não tem cookie: recebe um token na resposta do login e o envia como
 * `Authorization: Bearer`. As garantias que importam:
 *
 *  1. o login do app passa pelas **mesmas** verificações do site (limite de
 *     tentativas, conta bloqueada, senha, grupo, trilha de auditoria);
 *  2. a sessão do app é a mesma tabela da do site — aparece em "Sessões" e é
 *     revogada por lá;
 *  3. com `Authorization`, vale só o token, nunca o cookie;
 *  4. sair do app revoga o token.
 */
const login = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
const session = await readFile(new URL("../lib/auth/session.ts", import.meta.url), "utf8");

test("o token do app sai depois de todas as verificações do login do site", () => {
  const appBranch = login.indexOf('body.client === "app"');
  assert.ok(appBranch > 0, "o login precisa ter o ramo do app");
  for (const check of ["checkLoginRateLimit", 'reason: "conta bloqueada"', "verifyPassword", 'reason: "sem associação a grupo"', "clearLoginIdentityFailures"]) {
    const at = login.indexOf(check);
    assert.ok(at > 0 && at < appBranch, `${check} precisa acontecer antes de entregar o token`);
  }
  assert.match(login.slice(appBranch, appBranch + 1400), /createSessionToken\(identity/u);
  assert.match(login.slice(appBranch, appBranch + 1400), /recordAuthEvent/u);
  assert.match(login.slice(appBranch, appBranch + 1400), /no-store/u);
});

test("a sessão do app é a mesma tabela da sessão do site", () => {
  const create = session.slice(session.indexOf("export async function createSessionToken"));
  assert.match(create.slice(0, 900), /INSERT INTO fdp_auth_sessions/u);
  assert.match(create.slice(0, 900), /hashSessionToken\(token\)/u, "o token não é guardado em claro");
});

test("com Authorization vale só o token, e sair revoga o token", () => {
  const read = session.slice(session.indexOf("export async function getSessionUser"));
  const authAt = read.indexOf("authorization");
  const cookieAt = read.indexOf("cookies()");
  assert.ok(authAt > 0 && authAt < cookieAt, "o token é lido antes do cookie");
  assert.match(read, /if \(authorization\) return readSessionToken\(/u, "token inválido não cai para o cookie");
  const clear = session.slice(session.indexOf("export async function clearAuthSession"));
  assert.match(clear.slice(0, 700), /bearerToken[\s\S]*SET revoked_at = CURRENT_TIMESTAMP/u);
});

test("o filtro de origem recebe o cabeçalho do app", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /nativeClient: request\.headers\.get\("x-vinculato-client"\)/u);
});
