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
  // Tangerino e Sankhya varrem: o primeiro, admissões pendentes de conferência.
  assert.equal(canRunNow(tangerino, "active"), true);
  assert.equal(canRunNow(sankhya, "active"), true);
});

test("o Agente Tangerino varre admissões pendentes, e não a base inteira", async () => {
  const sweep = await readFile(new URL("../lib/tangerino/sweep.ts", import.meta.url), "utf8");
  // Desfecho não se reconsulta: gastar sessão de navegador para reler algo que
  // já terminou é o jeito de fazer o cliente ser bloqueado na origem.
  assert.match(sweep, /NOT IN \('COMPLETED', 'CANCELLED'\)/u);
  // Sem identificador na origem não há o que consultar.
  assert.match(sweep, /reference\.source = 'tangerino'/u);
  // Já em curso não entra de novo.
  assert.match(sweep, /state IN \('QUEUED', 'RUNNING'\)/u);
  assert.match(sweep, /SWEEP_BATCH_LIMIT/u, "uma varredura sem teto vira enxurrada de sessões");
});

test("a varredura só enfileira leitura: ela não decide nem escreve", async () => {
  const sweep = await readFile(new URL("../lib/tangerino/sweep.ts", import.meta.url), "utf8");
  for (const proibido of [/UPDATE fdp_employees/u, /DELETE /u, /fdp_agent_proposals/u]) {
    assert.ok(!proibido.test(sweep), `a varredura passou a alterar domínio: ${proibido}`);
  }
  // O único INSERT é o da própria consulta.
  const inserts = sweep.match(/INSERT INTO (\w+)/gu) ?? [];
  assert.deepEqual([...new Set(inserts)], ["INSERT INTO fdp_tangerino_admission_consultations"]);
});

test("a varredura não é atribuída a nenhuma pessoa", async () => {
  const sweep = await readFile(new URL("../lib/tangerino/sweep.ts", import.meta.url), "utf8");
  // Atribuí-la a alguém faria a auditoria dizer que um operador pediu o que a
  // máquina decidiu sozinha.
  assert.match(sweep, /requested_by_user_id.*\n?.*NULL|NULL, 'QUEUED'/u);
});

test("o Sankhya é preparado pela plataforma, e a tela diz isso (§21)", () => {
  const sankhya = productAgents.find((agent) => agent.key === "sankhya_agent")!;
  assert.equal(sankhya.setupBy, "platform");
  assert.ok(sankhya.setupNote.length > 60,
    "card sem formulário e sem explicação é o mesmo beco de antes com outra aparência");
  for (const key of ["teams_agent", "tangerino_agent"]) {
    const agent = productAgents.find((item) => item.key === key)!;
    assert.equal(agent.setupBy, "workspace");
    assert.equal(agent.setupNote, "");
  }
});

test("os conectores aposentados param de executar sozinhos", async () => {
  const sql = await readFile(
    new URL("../drizzle/postgres/0067_retire_legacy_connectors.sql", import.meta.url), "utf8");
  assert.match(sql, /schedule_enabled" = 0/u);
  assert.match(sql, /'paused'/u);
  for (const canal of ["tangerino", "solides", "email", "whatsapp", "drive", "onedrive", "erp"]) {
    assert.ok(sql.includes(`'${canal}'`), `${canal} continuaria executando invisível`);
  }
  // Aposentar não é destruir: o caminho de volta continua aberto.
  for (const destrutivo of [/DELETE FROM/u, /DROP /u, /TRUNCATE/u]) {
    assert.ok(!destrutivo.test(sql), `a migration destrói em vez de aposentar: ${destrutivo}`);
  }
});

test("a varredura agendada não agenda mais os conectores aposentados", async () => {
  const scheduler = await readFile(new URL("../lib/agent-scheduler.ts", import.meta.url), "utf8");
  const consulta = scheduler.slice(scheduler.indexOf("FROM fdp_integrations i"), scheduler.indexOf("ORDER BY i.channel"));
  assert.match(consulta, /'tangerino_browser'/u);
  assert.ok(!/'solides'/u.test(consulta), "a Sólides voltou a ser agendada, agora sem cartão na tela");
  assert.ok(!/IN \('tangerino'/u.test(consulta), "o conector de API do Tangerino voltou a ser agendado");
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

test("a Central de Integrações também lista só os três (§9)", async () => {
  /* Esta era a metade que ficou de fora: a Central de Agentes foi religada ao
     catálogo e a de Integrações não, então quem opera continuava escolhendo
     entre dez conectores para configurar três. Duas telas com duas listas é
     exatamente o arranjo que a decisão de produto existe para eliminar. */
  const source = await readFile(
    new URL("../app/api/integrations/overview/route.ts", import.meta.url), "utf8");
  assert.match(source, /visibleChannels/u, "a tela operacional voltou a listar todos os canais");
  assert.match(source, /i\.channel IN \(SELECT jsonb_array_elements_text/u);
  // O filtro vem do catálogo, e nunca de uma lista escrita aqui.
  for (const canal of ["onedrive", "whatsapp", "drive", "erp"]) {
    assert.ok(!source.includes(`'${canal}'`), `a rota escreveu a própria lista de canais: ${canal}`);
  }
});

test("o Agente Tangerino não pede endpoint em lugar nenhum (§1, §2)", async () => {
  /* O defeito relatado: a Central de Integrações pedia "Endpoint oficial"
     obrigatório ao Agente Tangerino e não oferecia usuário nem senha — o
     inverso exato da decisão de produto. A causa era uma terceira cópia da
     lista de canais, nos tipos da tela, que nunca teve `tangerino_browser`. */
  const { connectorFields } = await import("../lib/connector-config.ts");
  assert.ok(!connectorFields("tangerino_browser").some((field) => field.key === "endpoint"),
    "o Agente Tangerino voltou a aceitar endpoint");
  assert.deepEqual(connectorFields("tangerino_browser").map((f) => f.key), ["accountReference"]);
});

test("os campos do formulário vêm do catálogo, não de listas paralelas", async () => {
  const { agentConfigFields, agentCredentialFields } = await import("../lib/agent-catalog.ts");
  // Usuário e senha vão para o cofre; nunca para o config_json.
  assert.deepEqual(agentCredentialFields("tangerino_browser").map((f) => f.key), ["username", "password"]);
  assert.deepEqual(agentConfigFields("tangerino_browser").map((f) => f.key), ["accountReference"]);
  assert.ok(agentConfigFields("tangerino_browser").every((f) => !f.secret),
    "campo secreto não pode ser gravado em configuração");
});

test("a tela conhece o canal do Agente Tangerino", async () => {
  const tipos = await readFile(
    new URL("../app/painel/features/integrations/integrations.types.ts", import.meta.url), "utf8");
  assert.match(tipos, /"tangerino_browser"/u, "o canal sumiu do tipo e a tela volta a desconhecê-lo");

  const drawer = await readFile(
    new URL("../app/painel/features/integrations/IntegrationDrawers.tsx", import.meta.url), "utf8");
  assert.match(drawer, /tangerino_browser: \[\{ name: "username"/u,
    "sem entrada no mapa de credenciais, o agente fica sem usuário e senha");
  assert.match(drawer, /CANAIS_DE_NAVEGADOR\.has\(connector\.channel\)/u,
    "agente de navegador não pode receber campo de endpoint");

  const view = await readFile(
    new URL("../app/painel/features/integrations/IntegrationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /const credentialNames = \["username", "password"/u,
    "a tela mostra usuário e senha, mas precisa também enviá-los ao cofre");
});

test("o botão testa o Agente Tangerino sem exigir endpoint", async () => {
  const [view, route, worker] = await Promise.all([
    readFile(new URL("../app/painel/features/integrations/IntegrationsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/verify/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/tangerino/runner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(view, /isTangerino \|\| Boolean\(config\.endpoint\)/u,
    "o botão voltou a exigir endpoint de um agente que não possui esse campo");
  assert.match(route, /queueTangerinoHealthCheck/u,
    "a rota voltou a enviar o Tangerino ao verificador genérico");
  assert.match(route, /wakeTangerinoWorker/u,
    "o teste foi enfileirado, mas o worker não é acordado");
  assert.match(worker, /processNextTangerinoHealthCheck/u,
    "o worker não drena a fila de testes de login");
});

test("um teste Tangerino já enfileirado pode reacordar o worker", async () => {
  const healthSource = await readFile(new URL("../lib/tangerino/health-check.ts", import.meta.url), "utf8");
  assert.match(healthSource, /activeTangerinoHealthCheck/u);
  assert.match(healthSource, /if \(activeRun\) return activeRun/u);
  assert.match(healthSource, /if \(concurrentRun\) return concurrentRun/u);
});

test("o servidor recusa endpoint no agente de navegador, e não só a tela", async () => {
  const { buildConnectorConfig } = await import("../lib/connector-config.ts");
  // Esconder o campo impede o formulário, não a requisição. Aceitar aqui
  // recriaria a configuração de API pela porta dos fundos, gravada como legítima.
  const built = buildConnectorConfig({
    channel: "tangerino_browser", currentDisplayName: "Agente Tangerino",
    body: { endpoint: "https://employer.tangerino.com.br/employee/find-all", accountReference: "cliente-1" },
  });
  assert.equal(built.config.endpoint, undefined);
  assert.equal(built.config.accountReference, "cliente-1");
});

test("nenhuma lista paralela de canais deixa o Agente Tangerino de fora", async () => {
  /* Foram **quatro** listas do mesmo conjunto, e o agente faltava em três
     delas. A pior consequência não foi um campo a menos: o normalizador da tela
     trocava canal desconhecido por "erp", então o Agente Tangerino chegava como
     se fosse o conector de ERP — formulário genérico, endpoint obrigatório,
     nenhum campo de acesso, e erro nenhum em lugar nenhum. */
  const arquivos = [
    "../lib/integrations.ts",
    "../app/painel/features/integrations/integrations.types.ts",
    "../app/painel/features/integrations/integrations.api.ts",
    "../app/painel/features/integrations/IntegrationDrawers.tsx",
  ];
  for (const arquivo of arquivos) {
    const source = await readFile(new URL(arquivo, import.meta.url), "utf8");
    assert.match(source, /tangerino_browser/u, `${arquivo} não conhece o Agente Tangerino`);
  }
});

test("canal desconhecido não é rebatizado como outro canal real", async () => {
  const api = await readFile(
    new URL("../app/painel/features/integrations/integrations.api.ts", import.meta.url), "utf8");
  assert.ok(!/channels\.has\(rawChannel\) \? rawChannel : "erp"/u.test(api),
    "canal desconhecido voltou a virar erp, e a tela volta a mentir sobre qual conector é");
});

test("configurado é ter o que o agente exige, não ter algo gravado", async () => {
  const { agentIsConfigured } = await import("../lib/agent-catalog.ts");
  /* O Agente Tangerino não exige campo nenhum: o único que ele tem é opcional.
     Medir por "config_json vazio" o deixava em "Não configurado" para sempre,
     e o setup travava logo depois de a credencial ser guardada — o caminho
     inteiro ficava inalcançável por causa de um campo que ninguém precisa
     preencher. */
  assert.equal(agentIsConfigured("tangerino_browser", {}), true);
  // O Sankhya exige endereço e empresa: sem eles, não está configurado.
  assert.equal(agentIsConfigured("sankhya_browser", {}), false);
  assert.equal(agentIsConfigured("sankhya_browser", { endpoint: "https://x.sankhya.com.br/" }), false);
  assert.equal(agentIsConfigured("sankhya_browser", { endpoint: "https://x.sankhya.com.br/", companyId: "co-1" }), true);
  // Campo em branco não conta como preenchido.
  assert.equal(agentIsConfigured("sankhya_browser", { endpoint: "  ", companyId: "co-1" }), false);
  // Canal fora do catálogo nunca é "configurado".
  assert.equal(agentIsConfigured("erp", { endpoint: "x" }), false);
});

test("o estado do agente não trava depois da credencial", async () => {
  const { agentIsConfigured, agentState } = await import("../lib/agent-catalog.ts");
  const configurado = agentIsConfigured("tangerino_browser", {});
  assert.equal(agentState({ configured: configurado }), "credential_pending");
  assert.equal(agentState({ configured: configurado, hasCredential: true }), "test_pending");
  assert.equal(agentState({ configured: configurado, hasCredential: true, testedAt: "2026-01-01" }), "ready");
});
