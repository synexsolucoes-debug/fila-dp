const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_SERVER_URL,
  MODULES,
  isInternalUrl,
  normalizeServerUrl,
  readSettings,
  resolveServerUrl,
  sanitizeBounds,
  writeSettings,
} = require("../src/config.cjs");

test("endereço digitado sem protocolo vira https e só a origem", () => {
  assert.equal(normalizeServerUrl("vinculato.empresa.com.br/painel/dp"), "https://vinculato.empresa.com.br");
  assert.equal(normalizeServerUrl("  https://app.exemplo.com/  "), "https://app.exemplo.com");
});

test("http só é aceito para localhost", () => {
  assert.equal(normalizeServerUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeServerUrl("http://vinculato.empresa.com.br"), null);
  assert.equal(normalizeServerUrl("file:///C:/Windows"), null);
  assert.equal(normalizeServerUrl("javascript:alert(1)"), null);
});

test("endereço com credencial embutida é recusado", () => {
  assert.equal(normalizeServerUrl("https://user:senha@app.exemplo.com"), null);
});

test("vazio e lixo são recusados", () => {
  assert.equal(normalizeServerUrl(""), null);
  assert.equal(normalizeServerUrl(null), null);
  assert.equal(normalizeServerUrl("https://"), null);
});

test("preferência do usuário vence a variável, que vence o padrão", () => {
  assert.equal(resolveServerUrl({ serverUrl: "a.exemplo.com" }, { VINCULATO_URL: "b.exemplo.com" }), "https://a.exemplo.com");
  assert.equal(resolveServerUrl({}, { VINCULATO_URL: "b.exemplo.com" }), "https://b.exemplo.com");
  assert.equal(resolveServerUrl({ serverUrl: "http://inseguro.com" }, {}), DEFAULT_SERVER_URL);
});

test("só o próprio servidor fica dentro do app", () => {
  const server = "https://app.exemplo.com";
  assert.equal(isInternalUrl("https://app.exemplo.com/painel/folha?x=1", server), true);
  assert.equal(isInternalUrl("https://app.exemplo.com.golpe.io/painel", server), false);
  assert.equal(isInternalUrl("http://app.exemplo.com/painel", server), false);
  assert.equal(isInternalUrl("https://www.gov.br/esocial", server), false);
  assert.equal(isInternalUrl("não é url", server), false);
});

test("posição salva inválida ou minúscula é descartada", () => {
  assert.deepEqual(sanitizeBounds({ x: 10, y: 20, width: 1280, height: 800 }), { x: 10, y: 20, width: 1280, height: 800 });
  assert.equal(sanitizeBounds({ x: 10, y: 20, width: 100, height: 100 }), null);
  assert.equal(sanitizeBounds({ x: "a", y: 0, width: 1280, height: 800 }), null);
  assert.equal(sanitizeBounds(undefined), null);
});

test("configuração grava e lê do perfil, tolerando arquivo corrompido", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinculato-desktop-"));
  assert.deepEqual(readSettings(dir), {});
  writeSettings(dir, { serverUrl: "https://a.exemplo.com" });
  writeSettings(dir, { maximized: true });
  assert.deepEqual(readSettings(dir), { serverUrl: "https://a.exemplo.com", maximized: true });
  fs.writeFileSync(path.join(dir, "vinculato-desktop.json"), "{quebrado");
  assert.deepEqual(readSettings(dir), {});
});

test("módulos do menu apontam para rotas existentes do painel", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "panel-routes.ts"), "utf8");
  const accelerators = new Set();
  for (const item of MODULES) {
    if (item.type === "separator") continue;
    assert.match(item.path, /^\/painel/u);
    const segment = item.path.replace(/^\/painel\/?/u, "");
    if (segment) assert.ok(routes.includes(`"${segment}"`), `rota ${item.path} não existe em lib/panel-routes.ts`);
    if (item.accelerator) {
      assert.ok(!accelerators.has(item.accelerator), `atalho repetido: ${item.accelerator}`);
      accelerators.add(item.accelerator);
    }
  }
});
