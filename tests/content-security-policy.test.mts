import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildContentSecurityPolicy, createCspNonce } from "../lib/content-security-policy.ts";

/* A auditoria encontrou a CSP sem nenhuma diretiva de script — o mesmo que não
   ter CSP para o risco que importa. Estes testes protegem o que foi fechado. */

const production = buildContentSecurityPolicy({ nonce: "NONCE123", environment: "production" });
const development = buildContentSecurityPolicy({ nonce: "NONCE123", environment: "development" });

function directive(policy: string, name: string) {
  const found = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return found ?? "";
}

test("a política declara de onde script pode vir", () => {
  const scriptSrc = directive(production, "script-src");
  assert.ok(scriptSrc, "script-src ausente: era exatamente a lacuna apontada");
  assert.match(scriptSrc, /'self'/u);
  assert.match(scriptSrc, /'nonce-NONCE123'/u);
});

test("script inline sem nonce não executa, e host externo não carrega", () => {
  const scriptSrc = directive(production, "script-src");
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "'unsafe-inline' devolveria o XSS ao jogo");
  assert.ok(!/https?:(?!\/)/u.test(scriptSrc), "script-src não pode abrir um esquema inteiro");
  assert.equal(scriptSrc, "script-src 'self' 'nonce-NONCE123'");
});

test("'unsafe-eval' existe em desenvolvimento e nunca em produção", () => {
  assert.match(directive(development, "script-src"), /'unsafe-eval'/u);
  assert.ok(!production.includes("'unsafe-eval'"),
    "recarregamento a quente não é motivo para afrouxar produção");
});

test("as diretivas que já existiam continuam valendo", () => {
  for (const expected of [
    "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ]) {
    assert.ok(production.includes(expected), `diretiva perdida: ${expected}`);
  }
});

test("o produto continua funcionando: estilo, imagem, fonte e conexão declarados", () => {
  // Uma CSP que quebra a aplicação é revertida no primeiro incidente e não
  // protege nada. Estas são as permissões que o Next e os anexos exigem.
  assert.match(directive(production, "style-src"), /'unsafe-inline'/u);
  assert.match(directive(production, "img-src"), /blob:/u);
  assert.match(directive(production, "connect-src"), /https:/u);
  assert.match(directive(production, "worker-src"), /blob:/u);
  assert.match(directive(production, "default-src"), /'self'/u);
});

test("em produção a política força HTTPS", () => {
  assert.match(production, /upgrade-insecure-requests/u);
  assert.ok(!development.includes("upgrade-insecure-requests"), "em desenvolvimento o servidor é http");
});

test("o nonce é imprevisível e diferente a cada requisição", () => {
  const first = createCspNonce();
  const second = createCspNonce();
  assert.notEqual(first, second);
  assert.ok(first.length >= 16, "nonce curto demais para resistir a tentativa");
});

test("a política é escrita no proxy, com nonce, e não duplicada na configuração", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /Content-Security-Policy/u, "o proxy precisa escrever a política");
  assert.match(proxy, /x-nonce/u, "sem propagar o nonce, o Next não hidrata");

  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const declared = config.match(/key:\s*"Content-Security-Policy"/gu) ?? [];
  assert.equal(declared.length, 0,
    "duas políticas ao mesmo tempo viram a interseção das duas e quebram a aplicação");
});

test("o proxy alcança as páginas, não só a API", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.ok(!/matcher:\s*"\/api\/:path\*"/u.test(proxy),
    "com alcance só na API, nenhuma página receberia a política");
  assert.match(proxy, /_next\/static/u, "asset estático não precisa passar pelo proxy");
});
