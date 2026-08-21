import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContextLeakError, FORBIDDEN_CONTEXT_FIELDS, assertNoForbiddenFields, redact, redactDeep,
} from "../lib/assistant/redaction.ts";

/* -------------------------------------------------------------------------- */
/* Limite de privacidade                                                       */
/* -------------------------------------------------------------------------- */

test("dado pessoal digitado pelo usuário não sai junto com a pergunta", () => {
  // O caso que motiva o módulo: alguém cola o CPF na pergunta. Confiar na
  // entrada seria confiar que ninguém faz isso.
  const pergunta = "O CPF 529.982.247-25 do prestador está certo? O outro é 11144477735.";
  const resultado = redact(pergunta);
  assert.doesNotMatch(resultado.text, /529\.982\.247-25/u);
  assert.doesNotMatch(resultado.text, /11144477735/u);
  assert.match(resultado.text, /\[CPF\]/u);
  assert.equal(resultado.redacted, true);
});

test("CNPJ, conta bancária, cartão, e-mail, telefone, Pix e dinheiro são redigidos", () => {
  const casos: Array<[string, RegExp]> = [
    ["O CNPJ 11.222.333/0001-81 mudou", /\[CNPJ\]/u],
    ["Conta 1234 / 56789012-3", /\[CONTA\]/u],
    ["Cartão 4111 1111 1111 1111", /\[CARTÃO\]/u],
    ["Manda para ana@empresa.com.br", /\[E-MAIL\]/u],
    ["Ligar para (11) 98765-4321", /\[TELEFONE\]/u],
    ["Pix 3f2504e0-4f89-11d3-9a0c-0305e82c3301", /\[CHAVE PIX\]/u],
    ["O salário é R$ 8.500,00 por mês", /\[VALOR\]/u],
  ];
  for (const [entrada, esperado] of casos) {
    const saida = redact(entrada).text;
    assert.match(saida, esperado, `não redigiu: ${entrada}`);
  }
});

test("falso positivo é aceitável; falso negativo não", () => {
  // O CPF sem máscara é 11 dígitos seguidos, e é exatamente assim que ele
  // costuma ser colado. Deixar passar por falta de máscara seria o pior caso.
  assert.match(redact("cpf 52998224725 confirmado").text, /\[CPF\]/u);

  // Data não pode virar cartão: sem esta exceção toda pergunta sobre prazo
  // ficaria ilegível.
  const data = redact("O prazo é 12-05-2026").text;
  assert.match(data, /12-05-2026/u);

  // Texto sem dado pessoal atravessa intacto — a redação não pode inutilizar a
  // pergunta comum.
  const comum = "Como faço para arquivar um grupo empresarial?";
  assert.equal(redact(comum).text, comum);
  assert.equal(redact(comum).redacted, false);
});

test("a redação relata o que encontrou sem guardar o que redigiu", () => {
  const resultado = redact("CPF 529.982.247-25 e CPF 111.444.777-35 e e-mail a@b.com");
  const cpf = resultado.hits.find((hit) => hit.kind === "cpf");
  assert.equal(cpf?.count, 2, "precisa contar as duas ocorrências");
  assert.ok(resultado.hits.some((hit) => hit.kind === "email"));
  // O relatório diz o tipo e a quantidade — nunca o valor.
  assert.doesNotMatch(JSON.stringify(resultado.hits), /529|111|a@b/u);
});

test("a redação profunda preserva a estrutura e agrega as ocorrências", () => {
  const contexto = {
    tela: "Pagamentos PJ",
    itens: [{ nota: "CPF 529.982.247-25" }, { nota: "CPF 111.444.777-35" }],
    ativo: true,
    total: 3,
  };
  const { value, hits } = redactDeep(contexto);
  assert.equal(value.tela, "Pagamentos PJ");
  assert.equal(value.ativo, true, "booleano não pode virar string");
  assert.equal(value.total, 3, "número não pode virar string");
  assert.deepEqual(value.itens.map((item) => item.nota), ["CPF [CPF]", "CPF [CPF]"]);
  // Dez CPFs em campos diferentes são uma informação só para quem audita.
  assert.deepEqual(hits, [{ kind: "cpf", count: 2 }]);
});

test("campo proibido no contexto falha em vez de ser limpo", () => {
  // A redação protege contra o dado que aparece por acidente dentro de um texto.
  // Um campo com este nome significa que alguém montou o contexto errado — aí a
  // resposta certa é quebrar, para que quebre em teste e não em produção com o
  // dado já a caminho.
  assert.throws(
    () => assertNoForbiddenFields({ usuario: { nome: "Ana", password_hash: "x" } }),
    (error: Error) => error instanceof ContextLeakError && /password_hash/u.test(error.message),
  );
  assert.throws(
    () => assertNoForbiddenFields({ lista: [{ ok: 1 }, { taxId: "529" }] }),
    (error: Error) => error instanceof ContextLeakError && /\[1\]\.taxId/u.test(error.message),
  );
  // Contexto legítimo passa.
  assertNoForbiddenFields({ tela: "Painel", papel: "admin", modulos: ["board", "inbox"] });
});

test("a lista de campos proibidos cobre credencial, documento e dinheiro", () => {
  for (const campo of ["password_hash", "payout_encrypted", "tax_id", "cpf", "base_amount", "net_amount"]) {
    assert.ok((FORBIDDEN_CONTEXT_FIELDS as readonly string[]).includes(campo), `falta ${campo} na lista`);
  }
});

test("o módulo de privacidade não depende de configuração para funcionar", async () => {
  const source = await readFile(new URL("../lib/assistant/redaction.ts", import.meta.url), "utf8");
  // Um limite de privacidade que pode ser desligado por variável de ambiente não
  // é um limite. Ele não lê env, e não recebe um "modo permissivo".
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /disable|bypass|skipRedaction/iu);
});

/* -------------------------------------------------------------------------- */
/* Provedor e rota                                                             */
/* -------------------------------------------------------------------------- */

test("sem configuração o assistente diz o que falta em vez de fingir que funciona", async () => {
  const { readAssistantConfig, assertConfigured } = await import("../lib/assistant/provider.ts");

  const vazio = readAssistantConfig({});
  assert.equal(vazio.configured, false);
  assert.ok(!vazio.configured && vazio.detail.includes("FDP_ASSISTANT_PROVIDER"));

  const semChave = readAssistantConfig({ FDP_ASSISTANT_PROVIDER: "anthropic" });
  assert.equal(semChave.configured, false);
  assert.ok(!semChave.configured && semChave.missing.includes("ANTHROPIC_API_KEY"));

  const desconhecido = readAssistantConfig({ FDP_ASSISTANT_PROVIDER: "meu-modelo" });
  assert.equal(desconhecido.configured, false);

  const gatewayLocal = readAssistantConfig({ FDP_ASSISTANT_PROVIDER: "gateway" });
  assert.equal(gatewayLocal.configured, false, "fora da Vercel o Gateway ainda precisa de chave");

  const gatewayVercel = readAssistantConfig({ FDP_ASSISTANT_PROVIDER: "gateway", VERCEL: "1" });
  assert.equal(gatewayVercel.configured, true, "na Vercel o Gateway usa OIDC sem chave persistente");
  assert.ok(gatewayVercel.configured && gatewayVercel.config.model === "openai/gpt-5.5");
  assert.ok(gatewayVercel.configured && gatewayVercel.config.apiKey === "");

  const gatewayAutomatico = readAssistantConfig({ VERCEL: "1" });
  assert.equal(gatewayAutomatico.configured, true, "deployment Vercel deve selecionar o Gateway automaticamente");
  assert.ok(gatewayAutomatico.configured && gatewayAutomatico.config.provider === "gateway");

  // A recusa ao usuário final não repete nome de variável secreta.
  assert.throws(() => assertConfigured(vazio), (error: { code: string; message: string }) => {
    assert.equal(error.code, "ASSISTANT_NOT_CONFIGURED");
    assert.doesNotMatch(error.message, /API_KEY/u);
    return true;
  });

  const pronto = readAssistantConfig({
    FDP_ASSISTANT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-teste",
  });
  assert.equal(pronto.configured, true);
  assert.ok(pronto.configured && pronto.config.model.length > 0, "precisa de um modelo padrão");
});

test("a instrução do sistema diz o que o assistente não tem", async () => {
  const { buildSystemPrompt } = await import("../lib/assistant/provider.ts");
  const prompt = buildSystemPrompt({
    workspaceName: "Grupo Ensaio",
    userName: "Ana",
    role: "member",
    screen: "Pagamentos PJ",
    allowedModules: [{ key: "board", name: "Demandas" }],
    blockedModules: [{ key: "payroll", name: "Folha", reason: "não está no plano" }],
  });
  // Sem isso o modelo inventa número quando perguntado sobre folha — que num
  // sistema de DP é pior que não responder.
  assert.match(prompt, /NÃO tem acesso a dados de colaboradores/u);
  assert.match(prompt, /não invente número/u);
  assert.match(prompt, /NÃO executa ações/u);
  assert.match(prompt, /Demandas/u);
  assert.match(prompt, /Folha \(não está no plano\)/u);
});

test("a redação acontece antes da rede, no adaptador, não na rota", async () => {
  const source = await readFile(new URL("../lib/assistant/provider.ts", import.meta.url), "utf8");
  const redactAt = source.indexOf("redactDeep(input.messages");
  const generateAt = source.indexOf("await generateText");
  const fetchAt = source.indexOf("await fetch(config.baseUrl");
  assert.ok(redactAt > 0 && generateAt > redactAt && fetchAt > redactAt,
    "a redação precisa ser o último passo antes da rede — na rota seria fácil esquecer numa chamada nova");
  // A chave nunca é devolvida ao cliente.
  assert.doesNotMatch(source, /Response\.json\([^)]*apiKey/u);
  // Erro do provedor não vaza corpo da requisição.
  assert.match(source, /ASSISTANT_PROVIDER_ERROR/u);
});

test("a rota manda contexto de tela e permissão, e nada de dado pessoal", async () => {
  const source = await readFile(new URL("../app/api/assistant/chat/route.ts", import.meta.url), "utf8");
  // O que sai: papel, tela, módulos com motivo.
  assert.match(source, /allowedModules:/u);
  assert.match(source, /blockedModules:/u);
  // O que não pode sair: nenhuma consulta a dado de pessoa ou dinheiro.
  for (const tabela of ["fdp_employees", "fdp_contractor_profiles", "fdp_payroll", "fdp_contractor_closings", "fdp_auxiliary_providers"]) {
    assert.ok(!source.includes(tabela), `o contexto do assistente não pode ler ${tabela}`);
  }
  // A pergunta é gravada já redigida: o texto original não fica nem no banco.
  assert.match(source, /const safeQuestion = redact\(question\)/u);
  assert.match(source, /safeQuestion\.text, JSON\.stringify\(safeQuestion\.hits\)/u);
});

test("a conversa é isolada por grupo e por pessoa", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0035_assistant_conversations.sql", import.meta.url), "utf8");
  for (const table of ["fdp_assistant_conversations", "fdp_assistant_messages"]) {
    assert.ok(migration.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`), `${table} sem FORCE RLS`);
  }
  const route = await readFile(new URL("../app/api/assistant/chat/route.ts", import.meta.url), "utf8");
  // RLS isola o grupo; a consulta ainda precisa isolar a pessoa dentro dele.
  assert.match(route, /c\.user_id = \?/u);
});

test("a tela avisa o que foi removido da pergunta", async () => {
  const source = await readFile(new URL("../app/painel/features/assistant/AssistantPanel.tsx", import.meta.url), "utf8");
  // Sem o aviso a pessoa acha que o assistente ignorou o dado, e repete.
  assert.match(source, /data\.redacted/u);
  assert.match(source, /Dado pessoal não sai do sistema/u);
  // O limite é dito antes de a pessoa digitar, não depois.
  assert.match(source, /não<\/b> vê colaborador/u);
  // Esc fecha: o painel não pode virar parede entre a pessoa e a tela.
  assert.match(source, /event\.key === "Escape"/u);
});

test("o assistente não cobre a navegação inferior no celular", async () => {
  const css = await readFile(new URL("../app/painel/features/assistant/assistant.module.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.match(css, /\.launcher \{ right: 12px; bottom: calc\(82px \+ env\(safe-area-inset-bottom\)\); \}/u);
  assert.match(css, /\.panel \{[\s\S]{0,180}bottom: calc\(82px \+ env\(safe-area-inset-bottom\)\)/u);
});
