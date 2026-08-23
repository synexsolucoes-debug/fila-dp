import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTOMATION_KEYS, PLATFORM_ONLY_CHANNEL, buildConnectorConfig, connectorFields, safeRequestBody,
} from "../lib/connector-config.ts";

/* A configuração de conector passou a ter duas portas: o console do workspace e
   o console da plataforma. Duas portas com duas cópias das regras é o defeito
   que estes testes existem para impedir — a cópia que fica para trás aceita o
   que a outra recusa, e um endpoint fora da allowlist gravado por uma delas é o
   conector apontando para um host que ninguém autorizou. */

/* -------------------------------------------------------------------------- *
 * Os campos que cada canal aceita
 * -------------------------------------------------------------------------- */

test("cada canal declara os campos que aceita, e o Sankhya não passa por aqui", () => {
  assert.deepEqual(connectorFields(PLATFORM_ONLY_CHANNEL), []);
  assert.ok(connectorFields("teams").some((field) => field.key === "automations"));
  assert.ok(connectorFields("solides").some((field) => field.key === "admissionsSince"));
  assert.ok(connectorFields("tangerino").some((field) => field.key === "accountReference"));
  // Canal sem configuração própria ainda tem endpoint: é o mínimo que todo
  // conector precisa, e devolver lista vazia esconderia o formulário inteiro.
  assert.deepEqual(connectorFields("whatsapp").map((field) => field.key), ["endpoint"]);
});

test("todo campo declarado tem rótulo e explicação", () => {
  for (const channel of ["teams", "solides", "tangerino", "email", "drive"]) {
    for (const field of connectorFields(channel)) {
      assert.ok(field.label.length > 2, `${channel}.${field.key} sem rótulo`);
      assert.ok(field.hint.length > 20, `${channel}.${field.key} sem explicação do que é`);
    }
  }
});

/* -------------------------------------------------------------------------- *
 * A fronteira do Sankhya
 * -------------------------------------------------------------------------- */

test("o Sankhya é recusado por esta cartilha: ele tem porta própria", () => {
  assert.throws(
    () => buildConnectorConfig({ channel: PLATFORM_ONLY_CHANNEL, currentDisplayName: "S", body: {} }),
    /SANKHYA_CONFIG_SEPARATE|configuração própria/u,
  );
});

/* -------------------------------------------------------------------------- *
 * Endpoint
 * -------------------------------------------------------------------------- */

test("endpoint fora da lista permitida é recusado", () => {
  assert.throws(() => buildConnectorConfig({
    channel: "teams", currentDisplayName: "Teams", body: { endpoint: "https://evil.example.com/hook" },
  }));
});

test("endpoint oficial do canal é aceito", () => {
  const built = buildConnectorConfig({
    channel: "teams", currentDisplayName: "Teams", body: { endpoint: "https://graph.microsoft.com/v1.0" },
  });
  assert.equal(built.config.endpoint, "https://graph.microsoft.com/v1.0");
});

test("endpoint sem HTTPS é recusado", () => {
  assert.throws(() => buildConnectorConfig({
    channel: "teams", currentDisplayName: "Teams", body: { endpoint: "http://graph.microsoft.com/v1.0" },
  }));
});

test("gravar sem endpoint não inventa um: o campo apenas fica de fora", () => {
  const built = buildConnectorConfig({ channel: "whatsapp", currentDisplayName: "WhatsApp", body: {} });
  assert.equal(built.config.endpoint, undefined);
  assert.deepEqual(built.configuredFields, []);
});

/* -------------------------------------------------------------------------- *
 * Status é consequência, não escolha
 * -------------------------------------------------------------------------- */

test("gravar configuração devolve o conector para 'aguardando credencial'", () => {
  // Trocar o endereço invalida a conexão provada contra o endereço antigo.
  // Manter 'connected' faria a tela afirmar uma conexão que ninguém provou.
  const built = buildConnectorConfig({ channel: "whatsapp", currentDisplayName: "W", body: {} });
  assert.equal(built.status, "needs_credentials");
  const paused = buildConnectorConfig({ channel: "whatsapp", currentDisplayName: "W", body: { status: "paused" } });
  assert.equal(paused.status, "paused", "quem estava pausado não volta a aceitar job por ter sido reconfigurado");
});

test("nome vazio mantém o nome atual em vez de apagar", () => {
  const built = buildConnectorConfig({ channel: "whatsapp", currentDisplayName: "Nome atual", body: {} });
  assert.equal(built.displayName, "Nome atual");
});

/* -------------------------------------------------------------------------- *
 * Teams
 * -------------------------------------------------------------------------- */

test("os avisos do Teams nascem todos ligados, e desligar um não desliga os outros", () => {
  const padrao = buildConnectorConfig({ channel: "teams", currentDisplayName: "T", body: {} });
  const automations = padrao.config.automations as Record<string, boolean>;
  for (const key of AUTOMATION_KEYS) assert.equal(automations[key], true, `${key} nasceu desligado`);

  const parcial = buildConnectorConfig({
    channel: "teams", currentDisplayName: "T", body: { automations: { warning: false } },
  });
  const depois = parcial.config.automations as Record<string, boolean>;
  assert.equal(depois.warning, false);
  assert.equal(depois.admission, true, "desmarcar um aviso não pode silenciar os demais");
});

/* -------------------------------------------------------------------------- *
 * Admissões
 * -------------------------------------------------------------------------- */

test("data de corte inválida é recusada com o formato esperado", () => {
  assert.throws(
    () => buildConnectorConfig({ channel: "solides", currentDisplayName: "S", body: { admissionsSince: "ontem" } }),
    /AAAA-MM-DD|SOLIDES_ADMISSIONS_SINCE_INVALID/u,
  );
  assert.throws(
    () => buildConnectorConfig({ channel: "solides", currentDisplayName: "S", body: { admissionsSince: "2026-13-45" } }),
    /AAAA-MM-DD|SOLIDES_ADMISSIONS_SINCE_INVALID/u,
  );
});

test("a data também aceita o formato brasileiro, e guarda em ISO", () => {
  // Quem administra digita 05/01/2026 sem pensar. Recusar seria pedir que a
  // pessoa aprendesse o formato interno; o parser converte, e o que fica
  // gravado é sempre ISO — uma forma só do lado de dentro.
  const built = buildConnectorConfig({
    channel: "solides", currentDisplayName: "S", body: { admissionsSince: "05/01/2026" },
  });
  assert.equal(built.config.admissionsSince, "2026-01-05");
});

test("o tamanho da página tem teto, e valor absurdo não vira requisição gigante", () => {
  const built = buildConnectorConfig({
    channel: "tangerino", currentDisplayName: "T", body: { pageSize: 99999 },
  });
  assert.equal(built.config.pageSize, 150);
});

test("campos de admissão não vazam para canais que não os têm", () => {
  const built = buildConnectorConfig({
    channel: "whatsapp", currentDisplayName: "W", body: { admissionsSince: "2026-01-05", accountReference: "X" },
  });
  assert.equal(built.config.admissionsSince, undefined);
  assert.equal(built.config.accountReference, undefined);
});

/* -------------------------------------------------------------------------- *
 * Segredo nunca entra pela configuração
 * -------------------------------------------------------------------------- */

test("corpo livre com campo secreto é recusado, inclusive aninhado", () => {
  assert.throws(() => safeRequestBody({ password: "x" }), /INTEGRATION_CONFIG_UNSAFE|secretos/u);
  assert.throws(() => safeRequestBody({ auth: { apiKey: "x" } }), /INTEGRATION_CONFIG_UNSAFE|secretos/u);
  assert.throws(() => safeRequestBody({ nivel1: { nivel2: { token: "x" } } }), /INTEGRATION_CONFIG_UNSAFE|secretos/u);
});

test("corpo livre grande demais é recusado", () => {
  assert.throws(() => safeRequestBody({ campo: "x".repeat(20_000) }), /INTEGRATION_CONFIG_UNSAFE|16 KB/u);
});

test("corpo livre comum atravessa", () => {
  assert.deepEqual(safeRequestBody({ filtro: "ativos" }), { filtro: "ativos" });
  assert.equal(safeRequestBody(""), null);
});

test("um segredo empurrado pelo corpo livre não chega ao config gravado", () => {
  assert.throws(() => buildConnectorConfig({
    channel: "whatsapp", currentDisplayName: "W", body: { requestBody: { authorization: "Bearer x" } },
  }));
});

/* -------------------------------------------------------------------------- *
 * As duas portas, uma cartilha
 * -------------------------------------------------------------------------- */

const workspaceRoute = () => readFile(new URL("../app/api/integrations/[id]/route.ts", import.meta.url), "utf8");
const platformRoute = () => readFile(
  new URL("../app/api/platform/integrations/[id]/actions/route.ts", import.meta.url), "utf8");

test("nenhuma das duas rotas reescreve as regras por conta própria", async () => {
  for (const [nome, source] of [["workspace", await workspaceRoute()], ["plataforma", await platformRoute()]] as const) {
    assert.match(source, /buildConnectorConfig/u, `a porta do ${nome} deixou de usar a cartilha compartilhada`);
    // As funções que moravam soltas na rota: se voltarem, voltou a divergência.
    for (const copiada of [/function admissionSyncConfig/u, /function teamsConfig/u, /function safeRequestBody/u]) {
      assert.ok(!copiada.test(source), `a porta do ${nome} recriou a regra localmente: ${copiada}`);
    }
  }
});

test("as duas portas conferem se empresa e quadro são do workspace", async () => {
  // `config_json` é texto livre: nenhuma chave estrangeira o protege, e o
  // isolamento por linha não olha para dentro de um JSON.
  for (const [nome, source] of [["workspace", await workspaceRoute()], ["plataforma", await platformRoute()]] as const) {
    assert.match(source, /assertConnectorTargets/u, `a porta do ${nome} grava destino sem conferir o dono`);
  }
});

test("a plataforma não vira atalho: motivo, confirmação e auditoria dupla continuam valendo", async () => {
  const source = await platformRoute();
  assert.match(source, /configure_connector/u);
  assert.match(source, /requirePlatformAdmin/u);
  assert.match(source, /requiredPlatformReason/u);
  assert.match(source, /PLATFORM_CONFIRMATION_REQUIRED/u);
  assert.match(source, /fdp_platform_audit_events/u);
  assert.match(source, /fdp_audit_events/u);
});

test("cada configuração fica na sua porta, e nenhuma aceita o canal da outra", async () => {
  const source = await platformRoute();
  const connector = source.slice(source.indexOf(`action === "configure_connector"`),
    source.indexOf(`action === "test_connection"`));
  assert.match(connector, /PLATFORM_ONLY_CHANNEL/u,
    "configure_connector precisa recusar o Sankhya, que tem caminho dedicado");
  const sankhya = source.slice(source.indexOf(`action === "configure_sankhya"`),
    source.indexOf(`action === "configure_connector"`));
  assert.match(sankhya, /SANKHYA_INTEGRATION_REQUIRED/u,
    "configure_sankhya precisa continuar recusando os demais canais");
});

test("a auditoria da plataforma registra os nomes dos campos, não o que foi gravado", async () => {
  const source = await platformRoute();
  const connector = source.slice(source.indexOf(`action === "configure_connector"`),
    source.indexOf(`action === "test_connection"`));
  assert.match(connector, /configuredFields/u);
  assert.ok(!/config: built\.config|configuration: built\.config/u.test(connector),
    "o conteúdo gravado carrega endpoint e identificadores do cliente: a auditoria guarda o que mudou, não o valor");
});

/* -------------------------------------------------------------------------- *
 * A tela
 * -------------------------------------------------------------------------- */

test("o console da plataforma passou a oferecer configuração aos demais conectores", async () => {
  const feature = await readFile(
    new URL("../app/plataforma/features/IntegrationsFeature.tsx", import.meta.url), "utf8");
  assert.match(feature, /ConnectorPlatformConfiguration/u);
  // O botão do cartão dizia "Detalhes" em nove dos dez conectores, e nada
  // indicava que havia configuração em algum lugar.
  assert.match(feature, /moduleBlocked \? "Detalhes" : "Configurar"/u);
});

test("a tela pergunta os campos ao servidor em vez de manter a própria lista", async () => {
  const panel = await readFile(
    new URL("../app/plataforma/features/ConnectorPlatformConfiguration.tsx", import.meta.url), "utf8");
  assert.match(panel, /fields\.map/u);
  // Uma lista de campos escrita na tela envelhece sozinha, e o sintoma é mudo:
  // a pessoa preenche o que o servidor descarta sem erro nenhum.
  for (const canal of ["tenantId", "admissionsSince", "accountReference"]) {
    assert.ok(!panel.includes(`"${canal}"`), `a tela recriou a lista de campos: ${canal}`);
  }
});

test("o formulário nasce com o que está gravado, e o motivo é obrigatório", async () => {
  const panel = await readFile(
    new URL("../app/plataforma/features/ConnectorPlatformConfiguration.tsx", import.meta.url), "utf8");
  // Gravar substitui o config inteiro: em branco, apagaria o que não fosse
  // redigitado, e o estrago só apareceria na próxima sincronização.
  assert.match(panel, /configuration\[field\.key\]/u);
  assert.match(panel, /reasonValid/u);
  assert.match(panel, /minLength=\{5\}/u);
});

test("a rota de detalhe entrega configuração e campos para os conectores comuns", async () => {
  const detail = await readFile(
    new URL("../app/api/platform/integrations/[id]/detail/route.ts", import.meta.url), "utf8");
  assert.match(detail, /connectorConfiguration/u);
  assert.match(detail, /connectorFields/u);
  assert.match(detail, /AUTOMATION_LABELS/u);
});

test("gravar não apaga o que o formulário não desenha", async () => {
  /* `requestBody` mora no config_json, é aceito pelo servidor e não tem campo
     próprio na tela. Se o formulário nascesse só com o que desenha, gravar
     devolveria um objeto sem ele — e o corpo configurado do conector sumiria
     sem ninguém ter pedido, aparecendo só na sincronização seguinte. */
  const panel = await readFile(
    new URL("../app/plataforma/features/ConnectorPlatformConfiguration.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{ \.\.\.configuration, displayName \}/u,
    "a semente do formulário voltou a ignorar o que está gravado fora dos campos desenhados");

  // E o servidor de fato lê essa chave de volta, senão preservá-la na tela não
  // adiantaria nada.
  const preservado = buildConnectorConfig({
    channel: "whatsapp", currentDisplayName: "W", body: { requestBody: { filtro: "ativos" } },
  });
  assert.deepEqual(preservado.config.requestBody, { filtro: "ativos" });
});
