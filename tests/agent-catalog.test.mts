import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  agentState, agentStateLabels, canRunNow, isVisibleChannel, productAgentByChannel,
  productAgents, resolveProductAgent, visibleChannels,
} from "../lib/agent-catalog.ts";

/* A decisão de produto é curta — Teams, Tangerino e Sankhya — e por isso mesmo
   fácil de desfazer sem querer: basta alguém acrescentar um canal a uma lista
   qualquer e ele reaparece na tela. Estes testes são a rede embaixo dela. */

/* -------------------------------------------------------------------------- *
 * Só três, e sempre os mesmos
 * -------------------------------------------------------------------------- */

test("a experiência mostra exatamente três agentes (§9, §14)", () => {
  assert.deepEqual(productAgents.map((agent) => agent.label),
    ["Agente Teams", "Agente Tangerino", "Agente Sankhya"]);
});

test("os conectores aposentados não são visíveis", () => {
  for (const antigo of ["email", "whatsapp", "drive", "onedrive", "solides", "tangerino", "erp"]) {
    assert.equal(isVisibleChannel(antigo), false, `${antigo} voltou à experiência operacional`);
    assert.equal(productAgentByChannel(antigo), null);
  }
});

test("o Tangerino visível é o de navegador, e não o da API (§1)", () => {
  const tangerino = productAgents.find((agent) => agent.key === "tangerino_agent");
  assert.equal(tangerino?.channel, "tangerino_browser");
  assert.equal(tangerino?.mechanism, "browser");
  // A inversão que existia: `tangerino` (API) era listado como agente e o
  // navegador não aparecia em lugar nenhum.
  assert.equal(isVisibleChannel("tangerino"), false);
  assert.equal(isVisibleChannel("tangerino_browser"), true);
});

test("nenhum agente pede token, endpoint de API ou mapeamento do Tangerino (§1, §19)", () => {
  const tangerino = productAgents.find((agent) => agent.key === "tangerino_agent");
  const chaves = (tangerino?.fields ?? []).map((field) => field.key);
  assert.deepEqual(chaves, ["username", "password", "accountReference"]);
  for (const proibido of ["token", "endpoint", "authorization", "mapping"]) {
    assert.ok(!chaves.includes(proibido), `o Agente Tangerino voltou a exigir ${proibido}`);
  }
});

test("Tangerino e Sankhya pedem usuário e senha; o Teams não (§2, §6, §7)", () => {
  for (const key of ["tangerino_agent", "sankhya_agent"]) {
    const fields = productAgents.find((agent) => agent.key === key)?.fields ?? [];
    assert.ok(fields.some((field) => field.key === "username"), `${key} sem usuário`);
    const senha = fields.find((field) => field.key === "password");
    assert.equal(senha?.secret, true, `${key}: a senha precisa ser tratada como segredo`);
  }
  const teams = productAgents.find((agent) => agent.key === "teams_agent")?.fields ?? [];
  assert.ok(!teams.some((field) => field.secret), "o Teams não entra em sistema nenhum: não há senha a guardar");
  assert.ok(teams.some((field) => field.key === "channelId"));
});

test("cada campo diz o que é, sem jargão de canal", () => {
  for (const agent of productAgents) {
    for (const field of agent.fields) {
      assert.ok(field.hint.length > 20, `${agent.key}.${field.key} sem explicação`);
      for (const tecnico of ["tangerino_browser", "sankhya_browser", "config_json", "webhook_secret"]) {
        assert.ok(!field.hint.includes(tecnico) && !field.label.includes(tecnico),
          `nome técnico vazou em ${agent.key}.${field.key}: ${tecnico}`);
      }
    }
  }
});

/* -------------------------------------------------------------------------- *
 * Nome técnico não atravessa a fronteira (§2, §4, §15)
 * -------------------------------------------------------------------------- */

test("nenhum rótulo de produto carrega o nome interno", () => {
  for (const agent of productAgents) {
    assert.match(agent.label, /^Agente /u, `${agent.key} não se apresenta como agente`);
    for (const tecnico of ["browser", "_agent", "webhook", "api"]) {
      assert.ok(!agent.label.toLowerCase().includes(tecnico), `${agent.label} expõe detalhe interno`);
    }
  }
});

test("as chaves internas já gravadas continuam resolvendo (§17)", () => {
  // Recusá-las faria o histórico deixar de abrir: o dado continua no banco e
  // ninguém alcança.
  assert.equal(resolveProductAgent("sankhya")?.key, "sankhya_agent");
  assert.equal(resolveProductAgent("sankhya_browser")?.key, "sankhya_agent");
  assert.equal(resolveProductAgent("tangerino")?.key, "tangerino_agent");
  assert.equal(resolveProductAgent("tangerino_browser")?.key, "tangerino_agent");
  assert.equal(resolveProductAgent("teams")?.key, "teams_agent");
});

test("o alias do Tangerino não ressuscita a API", () => {
  // `tangerino` resolve para o agente — mas o canal de destino é o do navegador.
  assert.equal(resolveProductAgent("tangerino")?.channel, "tangerino_browser");
});

test("chave desconhecida não vira agente", () => {
  for (const nada of ["solides", "erp", "email", "", null, 42]) {
    assert.equal(resolveProductAgent(nada), null, `${String(nada)} passou por agente`);
  }
});

/* -------------------------------------------------------------------------- *
 * Estados (§10)
 * -------------------------------------------------------------------------- */

test("os oito estados existem e são frases, não enums", () => {
  const estados = Object.keys(agentStateLabels);
  assert.equal(estados.length, 8);
  for (const [key, meta] of Object.entries(agentStateLabels)) {
    // Enum é sublinhado ou CAIXA_ALTA; maiúscula inicial é português.
    assert.ok(!/_|\b[A-Z]{2,}\b/u.test(meta.label), `${key} chegou à tela como enum: ${meta.label}`);
    assert.ok(meta.detail.length > 20, `${key} não explica o que significa`);
  }
});

test("o estado segue o caminho do setup, do primeiro degrau ao último", () => {
  assert.equal(agentState({}), "not_configured");
  assert.equal(agentState({ configured: true }), "credential_pending");
  assert.equal(agentState({ configured: true, hasCredential: true }), "test_pending");
  assert.equal(agentState({ configured: true, hasCredential: true, testedAt: "2026-01-01" }), "ready");
  assert.equal(agentState({ configured: true, hasCredential: true, testedAt: "2026-01-01", enabled: true }), "active");
});

test("gravar a senha não conecta o agente (§23)", () => {
  // O degrau que fazia alguém gravar a senha e não entender por que continuava
  // sem funcionar: credencial guardada não é credencial provada.
  const estado = agentState({ configured: true, hasCredential: true });
  assert.equal(estado, "test_pending");
  assert.match(agentStateLabels[estado].detail, /não prova|teste/iu);
});

test("pausa vence tudo, porque foi decisão de alguém", () => {
  assert.equal(agentState({ paused: true, configured: true, hasCredential: true, testedAt: "x", enabled: true }), "paused");
  assert.equal(agentState({ paused: true }), "paused");
});

test("degradado e erro aparecem antes de 'ativo'", () => {
  const base = { configured: true, hasCredential: true, testedAt: "x", enabled: true };
  assert.equal(agentState({ ...base, consecutiveFailures: 3 }), "degraded");
  assert.equal(agentState({ ...base, degraded: true }), "degraded");
  assert.equal(agentState({ ...base, lastRunFailed: true }), "error");
});

/* -------------------------------------------------------------------------- *
 * Executar agora (§25)
 * -------------------------------------------------------------------------- */

test("executar agora só existe para quem tem o que executar", () => {
  const teams = productAgents.find((agent) => agent.key === "teams_agent")!;
  const tangerino = productAgents.find((agent) => agent.key === "tangerino_agent")!;
  const sankhya = productAgents.find((agent) => agent.key === "sankhya_agent")!;
  assert.equal(canRunNow(teams, "active"), false, "o Teams recebe avisos; não há o que ele vá buscar");
  assert.equal(canRunNow(tangerino, "active"), false, "a consulta do Tangerino parte da ficha do colaborador");
  assert.equal(canRunNow(sankhya, "active"), true);
});

test("executar agora fica bloqueado enquanto o acesso não foi provado", () => {
  const sankhya = productAgents.find((agent) => agent.key === "sankhya_agent")!;
  for (const estado of ["not_configured", "credential_pending", "test_pending", "paused", "error", "degraded"] as const) {
    assert.equal(canRunNow(sankhya, estado), false, `executar liberado em ${estado}`);
  }
});

/* -------------------------------------------------------------------------- *
 * Os fluxos guiados (§11, §12, §13)
 * -------------------------------------------------------------------------- */

test("cada agente traz o caminho até funcionar, na ordem", () => {
  for (const agent of productAgents) {
    assert.ok(agent.steps.length >= 4, `${agent.key} sem roteiro`);
    assert.match(agent.steps[0], /Configurar/u);
  }
  const teams = productAgents.find((agent) => agent.key === "teams_agent")!;
  assert.ok(teams.steps.some((step) => /webhook/iu.test(step)), "o Teams precisa do passo do webhook");
  assert.ok(teams.steps.some((step) => /Power Automate/u.test(step)));
  const sankhya = productAgents.find((agent) => agent.key === "sankhya_agent")!;
  assert.ok(sankhya.steps.some((step) => /Testar login/u.test(step)));
});

/* -------------------------------------------------------------------------- *
 * A fronteira, no código
 * -------------------------------------------------------------------------- */

test("o runtime não mantém uma segunda lista de canais", async () => {
  const source = await readFile(new URL("../lib/agent-runtime.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  // Era assim que a divergência nascia: uma lista aqui, outra no catálogo, e a
  // tela mostrando a errada.
  assert.ok(!/agentChannels\s*=\s*\[/u.test(code), "voltou a existir lista de canais no runtime");
  assert.match(source, /isVisibleChannel/u);
  assert.match(source, /productAgentByChannel/u);
});

test("a tela recebe nome de produto, e não a coluna do banco", async () => {
  const source = await readFile(new URL("../lib/agent-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /displayName: product\.label/u,
    "o nome voltou a vir de display_name, que guarda o que alguém digitou um dia");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.ok(!/^\s*channel,$/mu.test(code), "o canal interno voltou a sair na resposta da API");
});

test("o provisionamento cria os três agentes", async () => {
  const source = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  for (const channel of visibleChannels) {
    assert.ok(source.includes(`["${channel}"`), `${channel} não é provisionado — o agente nasce inalcançável`);
  }
});

test("a migration provisiona o Tangerino sem apagar nada (§17, §18)", async () => {
  const sql = await readFile(
    new URL("../drizzle/postgres/0066_tangerino_agent_provisioning.sql", import.meta.url), "utf8");
  assert.match(sql, /INSERT INTO "fdp_integrations"/u);
  assert.match(sql, /tangerino_browser/u);
  for (const destrutivo of [/DELETE FROM/u, /DROP TABLE/u, /DROP COLUMN/u, /TRUNCATE/u]) {
    assert.ok(!destrutivo.test(sql), `a migration apaga dado: ${destrutivo}`);
  }
  // Renomear canal persistido é exatamente o que a decisão manda evitar.
  assert.ok(!/SET "channel"/u.test(sql), "a migration renomeia canal persistido");
});
