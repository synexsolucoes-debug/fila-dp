import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { credentialPublicHint, openCredentials, sealCredentials } from "../lib/integrations.ts";
import { dispatchTangerinoWorker } from "../lib/tangerino/actions-dispatch.ts";
import { tangerinoAgentConfig } from "../lib/tangerino/config.ts";
import { TangerinoAgentError, safeTangerinoError, tangerinoErrors } from "../lib/tangerino/errors.ts";
import { tangerinoBrowserLoginUrl } from "../lib/tangerino/hosts.ts";
import { verifyTangerinoBrowserLogin } from "../lib/tangerino/login.ts";
import { allowedTangerinoHosts, isAllowedTangerinoChallengeUrl, isAllowedTangerinoHost, isPrivateNetworkAddress } from "../lib/tangerino/navigation-security.ts";
import { admissionChanged, admissionSearchTerm, chooseAdmission, isContractDataStage, isStableExternalAdmissionId, parseAdmission, parseAdmissionDate, parseSourceUpdatedAt } from "../lib/tangerino/parser.ts";
import { readOnlyDecision, readOnlyViolationDetail } from "../lib/tangerino/read-only.ts";
import { TangerinoSelectors, TANGERINO_SELECTORS_ARE_PROVISIONAL } from "../lib/tangerino/selectors.ts";
import { admissionStatusLabels, explainAdmissionStatus, normalizeAdmissionStatus, statusRules, terminalAdmissionStatuses } from "../lib/tangerino/status.ts";
import { admissionStatuses, consultationStates } from "../lib/tangerino/types.ts";
import { signTangerinoWorkerRequest, verifyTangerinoWorkerRequest } from "../lib/tangerino/worker-auth.ts";
import { MockTangerinoSession } from "../worker/tangerino/mock-session.ts";

/**
 * O agente de consulta de admissão no Tangerino.
 *
 * O que estes testes provam e o que NÃO provam, dito antes de qualquer asserção
 * para que ninguém leia verde demais neles:
 *
 * PROVAM — a regra de tradução de status, a recusa de desempatar duplicidade, o
 * fechamento da navegação, a política de somente-leitura, o isolamento por
 * tenant no formato das consultas, o RBAC, e que o caminho do agente é o caminho
 * fechado que ele declara ter.
 *
 * Os seletores críticos foram mapeados em sessão real e autorizada em
 * 24/08/2026. As fixtures preservam a estrutura mínima observada sem copiar
 * dados da conta; estes testes cobram que o código continue alinhado a ela.
 */

/** Leitura síncrona relativa à raiz, para as asserções de código-fonte. */
function source(relative: string) {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

/* ── Normalização de status ────────────────────────────────────────────────── */

test("a frase do requisito vira WAITING_DOCUMENTS, com o texto original preservado", () => {
  const raw = "O colaborador ainda não enviou todos os documentos necessários para continuidade do processo.";
  assert.equal(normalizeAdmissionStatus(raw), "WAITING_DOCUMENTS");
  const parsed = parseAdmission({ rawStatus: raw });
  assert.equal(parsed.normalizedStatus, "WAITING_DOCUMENTS");
  // O texto original nunca é substituído pela tradução (§30): é dele que sai a
  // evidência quando a tradução estiver errada.
  assert.equal(parsed.rawStatus, raw);
});

test("cada situação interna tem ao menos uma frase que chega até ela", () => {
  const alcancadas = new Set(statusRules.map((rule) => rule.status));
  for (const status of admissionStatuses) {
    if (status === "UNKNOWN") continue;
    assert.ok(alcancadas.has(status), `nenhuma regra produz ${status}: ou falta o padrão, ou o estado não deveria existir`);
  }
});

test("incerteza vira UNKNOWN, e nunca um status plausível", () => {
  // O defeito mais caro desta integração seria dizer "concluída" para um
  // processo parado. Frase que não casa com nada não é chutada.
  for (const raw of ["", "   ", "Etapa 4 de 7", "Situação: —", "Processo #4711", "Responsável: Ana"]) {
    assert.equal(normalizeAdmissionStatus(raw), "UNKNOWN", `"${raw}" foi traduzido quando não deveria`);
  }
});

test("a regra específica ganha da regra larga", () => {
  // "aguardando assinatura do contrato" contém "aguardando"; "documentação em
  // análise" contém "documenta". Uma ordem acidental faria a larga comer a
  // estreita, e o resultado seria plausível o bastante para ninguém notar.
  assert.equal(normalizeAdmissionStatus("Aguardando assinatura do contrato"), "WAITING_SIGNATURE");
  assert.equal(normalizeAdmissionStatus("Documentação em análise pelo DP"), "DOCUMENT_ANALYSIS");
  assert.equal(normalizeAdmissionStatus("Aguardando documentação do colaborador"), "WAITING_DOCUMENTS");
  assert.equal(normalizeAdmissionStatus("Processo cancelado na etapa de documentação"), "CANCELLED");
  assert.equal(normalizeAdmissionStatus("Admissão concluída"), "COMPLETED");
});

test("situações observadas em tela carregam evidência sem inventar vencimento", () => {
  assert.equal(explainAdmissionStatus("Concluído").evidence, "tela");
  assert.equal(explainAdmissionStatus("Em andamento").evidence, "tela");
  // "Vencida" foi observada, mas o vocabulário interno não possui OVERDUE.
  // Até uma decisão de produto explícita, preservar UNKNOWN é mais seguro.
  assert.equal(normalizeAdmissionStatus("Vencida"), "UNKNOWN");
});

test("toda regra declara de onde veio, e nenhuma foi inventada", () => {
  const permitidas = new Set(["requisito", "dp_inequivoco", "tela"]);
  for (const rule of statusRules) {
    assert.ok(permitidas.has(rule.evidence), `regra ${rule.pattern.source} sem procedência declarada`);
  }
  // A explicação existe para responder "por que isso virou COMPLETED?" com um
  // padrão nomeado, e não com uma releitura do arquivo.
  const explicacao = explainAdmissionStatus("Admissão concluída");
  assert.equal(explicacao.status, "COMPLETED");
  assert.ok(explicacao.rule);
  assert.ok(explicacao.evidence);
  assert.equal(explainAdmissionStatus("bla bla").rule, null);
});

test("todo status tem rótulo, e UNKNOWN diz o que fazer", () => {
  for (const status of admissionStatuses) {
    assert.ok(admissionStatusLabels[status]?.length > 3, `${status} sem rótulo legível`);
  }
  assert.match(admissionStatusLabels.UNKNOWN, /texto original/iu);
  assert.deepEqual([...terminalAdmissionStatuses].sort(), ["CANCELLED", "COMPLETED"]);
});

/* ── Interpretação da tela ─────────────────────────────────────────────────── */

test("situação ausente é UI_CHANGED, e não UNKNOWN", () => {
  /* A distinção que este teste guarda:
     `UNKNOWN` é resposta — "o Tangerino disse algo que não sei traduzir".
     `UI_CHANGED` é defeito — "não achei o campo da situação".
     Trocar o segundo pelo primeiro transformaria quebra de layout em resposta,
     e ninguém consertaria o conector. */
  assert.throws(() => parseAdmission({ stage: "Documentação", pendingReason: "RG ilegível" }), (error: unknown) => {
    assert.ok(error instanceof TangerinoAgentError);
    assert.equal(error.state, "UI_CHANGED");
    assert.equal(error.layoutRelated, true);
    return true;
  });
});

test("campos ausentes viram vazio; a tela mostra só o que existe", () => {
  const parsed = parseAdmission({ rawStatus: "Em andamento" });
  assert.equal(parsed.normalizedStatus, "IN_PROGRESS");
  assert.deepEqual(
    { stage: parsed.stage, pendingReason: parsed.pendingReason, admissionDate: parsed.admissionDate, externalAdmissionId: parsed.externalAdmissionId },
    { stage: "", pendingReason: "", admissionDate: "", externalAdmissionId: "" },
  );
});

test("datas de tela viram ISO; o que não converte volta como veio", () => {
  assert.equal(parseAdmissionDate("01/09/2026"), "2026-09-01");
  assert.equal(parseAdmissionDate("2026-09-01"), "2026-09-01");
  assert.equal(parseSourceUpdatedAt("21/08/2026 14:30"), "2026-08-21T14:30");
  // Devolver o texto é melhor que devolver vazio: "a partir de 12/2026" informa
  // alguma coisa, um campo em branco faz parecer que o Tangerino nada disse.
  assert.equal(parseAdmissionDate("a partir de dezembro"), "a partir de dezembro");
  assert.equal(parseAdmissionDate(undefined), "");
});

test("espaço duplo e quebra de linha não viram mudança de status", () => {
  // Sem a limpeza, a mesma situação lida duas vezes com espaçamento diferente
  // dispararia `status_changed` e o histórico encheria de mudança que não houve.
  const primeira = parseAdmission({ rawStatus: "Documentação  em\n análise " });
  const segunda = parseAdmission({ rawStatus: "Documentação em análise" });
  assert.equal(primeira.rawStatus, segunda.rawStatus);
  assert.equal(admissionChanged({ rawStatus: primeira.rawStatus, normalizedStatus: primeira.normalizedStatus }, segunda), false);
});

test("a comparação usa o texto original, não a tradução", () => {
  /* Duas frases diferentes que hoje caem em UNKNOWN são mudança real do
     processo — e é justamente delas que sai a evidência para completar o mapa.
     Comparar o normalizado esconderia toda alteração dentro de UNKNOWN. */
  const atual = parseAdmission({ rawStatus: "Etapa 5 — conferência final" });
  assert.equal(atual.normalizedStatus, "UNKNOWN");
  assert.equal(admissionChanged({ rawStatus: "Etapa 4 — biometria", normalizedStatus: "UNKNOWN" }, atual), true);
  assert.equal(admissionChanged(null, atual), true, "sem consulta anterior, tudo é novidade");
});

/* ── Escolha do processo ───────────────────────────────────────────────────── */

test("duplicidade não é desempatada por semelhança", () => {
  /* Homônimo em folha não é caso raro. E o vínculo errado aqui contamina todas
     as consultas seguintes, porque o identificador do processo errado fica
     salvo e passa a ser usado direto, sem nova pesquisa. */
  const hits = [
    { id: "ADM-1", label: "Maria de Souza — 01/09/2026" },
    { id: "ADM-2", label: "Maria de Souza — 15/09/2026" },
  ];
  assert.throws(() => chooseAdmission(hits, ""), (error: unknown) => {
    assert.ok(error instanceof TangerinoAgentError);
    assert.equal(error.state, "MULTIPLE_MATCHES");
    assert.match(error.message, /2 processos/u);
    return true;
  });
  assert.throws(() => chooseAdmission([], ""), (error: unknown) =>
    error instanceof TangerinoAgentError && error.state === "NOT_FOUND");
  assert.equal(chooseAdmission([hits[0]], "").id, "ADM-1");
});

test("o vínculo já salvo desfaz o empate sem adivinhação", () => {
  const hits = [
    { id: "ADM-1", label: "Maria de Souza" },
    { id: "ADM-2", label: "Maria de Souza" },
  ];
  assert.equal(chooseAdmission(hits, "ADM-2").id, "ADM-2");
  // Vínculo que não bate com nenhuma linha não vira desempate silencioso: a
  // duplicidade continua sendo duplicidade.
  assert.throws(() => chooseAdmission(hits, "ADM-9"), (error: unknown) =>
    error instanceof TangerinoAgentError && error.state === "MULTIPLE_MATCHES");
});

test("posição visual de cartão nunca vira vínculo externo", () => {
  assert.equal(isStableExternalAdmissionId("ADM-4711"), true);
  assert.equal(isStableExternalAdmissionId("card:0"), false);
  assert.equal(isStableExternalAdmissionId("row:12"), false);
  assert.equal(admissionSearchTerm({ externalAdmissionId: "card:0", registrationNumber: "0042", fullName: "Maria" }), "0042");
  const hits = [{ id: "card:0", label: "Maria" }, { id: "card:1", label: "Maria" }];
  assert.throws(() => chooseAdmission(hits, "card:0"), (error: unknown) =>
    error instanceof TangerinoAgentError && error.state === "MULTIPLE_MATCHES");
  const agente = source("lib/tangerino/agent.ts");
  assert.match(agente, /isStableExternalAdmissionId\(externalIdCandidate\)/u);
  assert.match(agente, /if \(externalId\)[\s\S]*?saveExternalReference/u);
});

test("o termo de busca segue a prioridade da §18 e nunca é CPF", () => {
  assert.equal(admissionSearchTerm({ externalAdmissionId: "ADM-7", registrationNumber: "0042", fullName: "Maria" }), "ADM-7");
  assert.equal(admissionSearchTerm({ externalAdmissionId: "", registrationNumber: "0042", fullName: "Maria" }), "0042");
  assert.equal(admissionSearchTerm({ externalAdmissionId: "", registrationNumber: "", fullName: "Maria" }), "Maria");
  // Sem nada com que pesquisar, a consulta para: digitar vazio no campo de busca
  // do cliente devolveria a lista inteira de admissões da empresa.
  assert.throws(() => admissionSearchTerm({ externalAdmissionId: "", registrationNumber: "", fullName: "" }));
  /* O CPF não vira termo digitado num sistema de terceiro, e a garantia é
     estrutural: o contrato do alvo não tem esse campo, então não há de onde
     lê-lo. Conferir o tipo é mais forte que caçar a palavra no arquivo — um
     comentário que explica a exclusão não é uma violação dela. */
  const contrato = source("lib/tangerino/types.ts");
  const alvo = contrato.slice(contrato.indexOf("export type AdmissionConsultationTarget"));
  const campos = [...alvo.slice(0, alvo.indexOf("\n};")).matchAll(/^ {2}(\w+):/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(campos, ["companyId", "employeeId", "externalAdmissionId", "fullName", "registrationNumber", "workspaceId"]);
  const pesquisa = source("lib/tangerino/parser.ts");
  const corpo = pesquisa.slice(pesquisa.indexOf("export function admissionSearchTerm"));
  assert.doesNotMatch(corpo.slice(0, corpo.indexOf("\n}")), /cpf/iu, "o CPF entrou no termo de busca");
});

/* ── Somente leitura ───────────────────────────────────────────────────────── */

test("métodos de alteração são bloqueados, e leitura por POST continua passando", () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(readOnlyDecision({ method, url: "https://app.tangerino.com.br/api/admissao/1" }), "block", `${method} passou`);
  }
  for (const url of [
    "https://app.tangerino.com.br/api/admissao/1/aprovar",
    "https://app.tangerino.com.br/api/admissao/1/salvar",
    "https://app.tangerino.com.br/api/admissao/1/cancelar",
    "https://app.tangerino.com.br/api/admissao/1/assinar",
    "https://app.tangerino.com.br/api/documentos/upload",
  ]) {
    assert.equal(readOnlyDecision({ method: "POST", url }), "block", `${url} deveria ser bloqueado`);
  }
  /* A parte que a §67 pede cuidado: bloquear todo POST quebraria a consulta
     antes de ela começar. Login é POST, busca com filtro é POST. */
  for (const url of [
    "https://app.tangerino.com.br/api/auth/login",
    "https://app.tangerino.com.br/api/admissao/pesquisar",
    "https://app.tangerino.com.br/graphql",
    "https://apis.tangerino.com.br/admissao-demissao-api/api/v1/documentos/admissao/download-zip",
    "https://apis.tangerino.com.br/admissao-demissao-api/api/v1/ficha-cadastral/report/194851",
  ]) {
    assert.equal(readOnlyDecision({ method: "POST", url }), "allow", `${url} deveria passar`);
  }
  assert.equal(readOnlyDecision({ method: "GET", url: "https://app.tangerino.com.br/qualquer" }), "allow");
});

test("mutation de GraphQL é bloqueada mesmo com caminho de leitura", () => {
  const url = "https://app.tangerino.com.br/graphql";
  assert.equal(readOnlyDecision({ method: "POST", url, body: '{"query":"mutation { aprovarAdmissao(id: 1) }"}' }), "block");
  assert.equal(readOnlyDecision({ method: "POST", url, body: '{"query":"query { admissao(id: 1) { status } }"}' }), "allow");
});

test("POST que não dá para classificar passa, mas fica registrado", () => {
  // A concessão consciente da faixa do meio. Está aqui como teste para que ela
  // seja uma decisão visível, e não um efeito colateral de regex frouxa.
  assert.equal(readOnlyDecision({ method: "POST", url: "https://app.tangerino.com.br/api/telemetria" }), "observe");
});

test("o registro de violação não carrega querystring nem corpo", () => {
  // É justamente uma requisição de alteração: é ali que estariam token de
  // sessão, identificador de pessoa e conteúdo de formulário (§52).
  const detalhe = readOnlyViolationDetail({ method: "post", url: "https://app.tangerino.com.br/api/admissao/salvar?token=segredo&cpf=111" });
  assert.deepEqual(detalhe, { method: "POST", path: "/api/admissao/salvar" });
});

test("a sessão do agente não expõe nenhum comando de escrita", () => {
  /* A garantia forte da §8 é estrutural: um agente que não tem como apertar
     "Salvar" não aperta "Salvar" — nem por engano, nem porque um texto na
     página mandou (§23). Este teste guarda essa ausência. */
  const contrato = source("lib/tangerino/types.ts");
  const bloco = contrato.slice(contrato.indexOf("export interface TangerinoBrowserSession"));
  const corpo = bloco.slice(0, bloco.indexOf("\n}"));
  for (const proibido of ["salvar", "save", "submit", "approve", "aprovar", "delete", "excluir", "click", "admitir", "assinar", "upload"]) {
    assert.doesNotMatch(corpo, new RegExp(proibido, "iu"), `o contrato ganhou um comando "${proibido}"`);
  }
  const metodos = [...corpo.matchAll(/^ {2}(\w+)\(/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(metodos, ["back", "close", "ensureAuthenticated", "openAdmission", "openAdmissions", "readAdmission", "searchAdmission"]);
});

test("a autorização do worker é assinada por workspace, job e prazo curto", () => {
  const previousKey = process.env.FDP_TANGERINO_VAULT_KEY;
  const previousKeys = process.env.FDP_TANGERINO_VAULT_KEYS;
  const previousVersion = process.env.FDP_TANGERINO_VAULT_KEY_VERSION;
  process.env.FDP_TANGERINO_VAULT_KEY = Buffer.alloc(32, 31).toString("base64");
  delete process.env.FDP_TANGERINO_VAULT_KEYS;
  process.env.FDP_TANGERINO_VAULT_KEY_VERSION = "1";
  try {
    const now = new Date("2026-08-24T15:00:00.000Z");
    const signed = signTangerinoWorkerRequest({
      workspaceId: "workspace-1", authorizationId: "authorization-1", action: "UPLOAD", value: "abc:123", now,
    });
    const headers = new Headers(signed);
    assert.equal(verifyTangerinoWorkerRequest({
      headers, workspaceId: "workspace-1", authorizationId: "authorization-1", action: "UPLOAD", value: "abc:123", now,
    }), true);
    assert.equal(verifyTangerinoWorkerRequest({
      headers, workspaceId: "workspace-2", authorizationId: "authorization-1", action: "UPLOAD", value: "abc:123", now,
    }), false, "a assinatura foi reutilizada em outro workspace");
    assert.equal(verifyTangerinoWorkerRequest({
      headers, workspaceId: "workspace-1", authorizationId: "authorization-1", action: "UPLOAD", value: "abc:123",
      now: new Date("2026-08-24T15:06:00.000Z"),
    }), false, "a assinatura vencida continuou válida");
  } finally {
    if (previousKey === undefined) delete process.env.FDP_TANGERINO_VAULT_KEY;
    else process.env.FDP_TANGERINO_VAULT_KEY = previousKey;
    if (previousKeys === undefined) delete process.env.FDP_TANGERINO_VAULT_KEYS;
    else process.env.FDP_TANGERINO_VAULT_KEYS = previousKeys;
    if (previousVersion === undefined) delete process.env.FDP_TANGERINO_VAULT_KEY_VERSION;
    else process.env.FDP_TANGERINO_VAULT_KEY_VERSION = previousVersion;
  }
});

/* ── Navegação ─────────────────────────────────────────────────────────────── */

test("a allowlist aceita subdomínio oficial e recusa sufixo forjado", () => {
  assert.equal(isAllowedTangerinoHost("app.tangerino.com.br"), true);
  assert.equal(isAllowedTangerinoHost("tangerino.com.br"), true);
  assert.equal(isAllowedTangerinoHost("empregador.solides.com.br"), true);
  // O ataque clássico contra allowlist escrita com `includes`.
  assert.equal(isAllowedTangerinoHost("tangerino.com.br.invasor.test"), false);
  assert.equal(isAllowedTangerinoHost("nao-tangerino.com.br"), false);
  assert.equal(isAllowedTangerinoHost("evil.test"), false);
});

test("host extra do cliente vem do ambiente, não da tela", () => {
  // Um campo na interface transformaria a allowlist em algo que o próprio
  // atacante preenche.
  const hosts = allowedTangerinoHosts({ FDP_TANGERINO_BROWSER_ALLOWED_HOSTS: "dp.cliente.example, lixo inválido!!" });
  assert.ok(hosts.includes("dp.cliente.example"));
  assert.ok(!hosts.some((host) => host.includes("!")));
  assert.equal(isAllowedTangerinoHost("dp.cliente.example", { FDP_TANGERINO_BROWSER_ALLOWED_HOSTS: "dp.cliente.example" }), true);
});

test("endereços privados e de metadados são recusados", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "169.254.169.254", "172.16.0.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateNetworkAddress(address), true, `${address} passou`);
  }
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  // O padrão da função é recusar: o que não é IP não é liberado por omissão.
  assert.equal(isPrivateNetworkAddress("não-é-ip"), true);
});

/* ── Erros e retry ─────────────────────────────────────────────────────────── */

test("cada falha nomeada carrega o estado que a tela precisa distinguir", () => {
  const casos: Array<[TangerinoAgentError, string]> = [
    [tangerinoErrors.notFound(), "NOT_FOUND"],
    [tangerinoErrors.multipleMatches(3), "MULTIPLE_MATCHES"],
    [tangerinoErrors.authenticationRequired(""), "AUTHENTICATION_REQUIRED"],
    [tangerinoErrors.uiChanged("leitura", "situação"), "UI_CHANGED"],
    [tangerinoErrors.timeout("login"), "TIMEOUT"],
    [tangerinoErrors.unavailable(""), "TANGERINO_UNAVAILABLE"],
  ];
  for (const [error, state] of casos) assert.equal(error.state, state);
  // Toda mensagem existe para ser lida por quem administra, e nenhuma é vazia.
  for (const [error] of casos) assert.ok(error.message.length > 20, `${error.code} sem mensagem útil`);
});

test("só o que pode dar certo da segunda vez é repetível", () => {
  /* Repetir `AUTHENTICATION_REQUIRED` arrisca bloquear a conta do cliente por
     tentativas sucessivas; repetir `NOT_FOUND`, `MULTIPLE_MATCHES` ou
     `UI_CHANGED` gasta navegador para chegar à mesma conclusão (§43). */
  for (const error of [
    tangerinoErrors.authenticationRequired(""),
    tangerinoErrors.notFound(),
    tangerinoErrors.multipleMatches(2),
    tangerinoErrors.uiChanged("x", "y"),
  ]) {
    assert.ok(!error.retryable || error.requiresUserAction, `${error.code} seria repetido automaticamente`);
  }
  assert.equal(tangerinoErrors.timeout("login").retryable, true);
  assert.equal(tangerinoErrors.unavailable("").retryable, true);
});

test("a mensagem de erro não carrega senha, token nem cookie", () => {
  /* O expurgo acontece na fronteira porque depois dela há três destinos — log,
     banco e tela — e só uma chance de acertar. O caso do `Bearer` é o que mais
     engana: o segredo está na SEGUNDA palavra, e um padrão que consome um termo
     só apaga "Bearer" e deixa o token à mostra. */
  const suja = new Error("falha ao autenticar com password=Sup3rSecreta e Authorization: Bearer abc.def");
  const limpa = safeTangerinoError(suja);
  assert.doesNotMatch(limpa.message, /Sup3rSecreta|abc\.def/u);
  assert.match(limpa.message, /oculto/u);
  assert.doesNotMatch(safeTangerinoError(new Error("erro em ?token=xyz123")).message, /xyz123/u);
  // Timeout é a única falha genérica classificável pela mensagem com segurança.
  assert.equal(safeTangerinoError(new Error("Timeout 30000ms exceeded")).state, "TIMEOUT");
  // Uma falha já nomeada atravessa intacta.
  const nomeada = tangerinoErrors.notFound();
  assert.equal(safeTangerinoError(nomeada), nomeada);
});

/* ── Caminho do agente ─────────────────────────────────────────────────────── */

test("o caminho feliz percorre exatamente os comandos previstos", async () => {
  const session = new MockTangerinoSession("success");
  await session.ensureAuthenticated();
  await session.openAdmissions();
  const hits = await session.searchAdmission("0042");
  await session.openAdmission(chooseAdmission(hits, ""));
  const parsed = parseAdmission(await session.readAdmission());
  await session.back();
  await session.close();

  assert.deepEqual(session.calls, [
    "ensureAuthenticated", "openAdmissions", "searchAdmission:0042", "openAdmission:ADM-4711", "readAdmission", "back", "close",
  ]);
  assert.equal(parsed.normalizedStatus, "DOCUMENT_ANALYSIS");
  assert.equal(parsed.rawStatus, "Documentação em análise");
  assert.equal(parsed.pendingReason, "Comprovante de residência ilegível");
  assert.equal(parsed.admissionDate, "2026-09-01");
});

test("a mudança de etapa é percebida mesmo quando a situação não muda", () => {
  const atual = parseAdmission({ rawStatus: "Em andamento", stage: "Dados contratuais" });
  assert.equal(admissionChanged({
    rawStatus: "Em andamento", normalizedStatus: "IN_PROGRESS", stage: "Documentação",
  }, atual), true);
});

test("somente a etapa Dados contratuais libera a demanda do ERP", () => {
  for (const stage of ["Dados contratuais", "DADOS CONTRATUAIS", "3. Dados Contratuais", "Dados contratuais — preenchimento"]) {
    assert.equal(isContractDataStage(stage), true, stage);
  }
  for (const stage of ["Documentação", "Dados pessoais", "Contrato", "Em andamento", ""]) {
    assert.equal(isContractDataStage(stage), false, stage);
  }
});

test("a demanda do ERP usa a etapa visual e uma chave idempotente", async () => {
  const demand = await readFile(new URL("../lib/tangerino/demand.ts", import.meta.url), "utf8");
  assert.match(demand, /isContractDataStage\(input\.admission\.stage\)/u);
  assert.match(demand, /admission-contract-data:/u);
  assert.match(demand, /recordIntegrationEvent/u);
  assert.match(demand, /status = 'processed'[\s\S]*result_type = 'card'/u);
  assert.match(demand, /INSERT INTO fdp_cards/u);
  assert.doesNotMatch(demand, /rawStatus.*Dados contratuais/u,
    "o texto de situação não pode substituir a etapa como gatilho");
});

test("o teste de conexão autentica e não consulta nenhum colaborador", async () => {
  const session = new MockTangerinoSession("success");
  await verifyTangerinoBrowserLogin(session, {
    username: "conta.dedicada",
    password: "segredo-de-teste",
    timeoutMs: 30_000,
  });
  assert.deepEqual(session.calls, ["ensureAuthenticated"]);
  assert.equal(tangerinoBrowserLoginUrl, "https://app.tangerino.com.br/Tangerino/pages/LoginPage");
});

test("MFA e CAPTCHA param o fluxo em vez de serem contornados", async () => {
  // Um agente que contorna mecanismo de segurança é indistinguível de um
  // invasor. A resposta certa é parar e pedir ação humana (§16).
  for (const cenario of ["mfa", "captcha", "session_expired"] as const) {
    const session = new MockTangerinoSession(cenario);
    await assert.rejects(session.ensureAuthenticated(), (error: unknown) => {
      assert.ok(error instanceof TangerinoAgentError);
      assert.equal(error.state, "AUTHENTICATION_REQUIRED");
      assert.equal(error.requiresUserAction, true);
      assert.equal(error.retryable, false, "tentar de novo bloquearia a conta do cliente");
      return true;
    });
    // E para de verdade: nenhum comando depois do login foi executado.
    assert.deepEqual(session.calls, ["ensureAuthenticated"]);
  }
});

test("elemento crítico ausente devolve UI_CHANGED com etapa e seletor", async () => {
  const session = new MockTangerinoSession("ui_changed");
  await assert.rejects(session.openAdmissions(), (error: unknown) => {
    assert.ok(error instanceof TangerinoAgentError);
    assert.equal(error.state, "UI_CHANGED");
    assert.equal(error.layoutRelated, true);
    // Registrar qual etapa e qual elemento é o que torna a §44 acionável.
    assert.match(error.message, /abertura da Admiss/u);
    assert.match(error.message, /menu de Admiss/u);
    return true;
  });
});

test("tela sem situação nunca vira COMPLETED por inferência", async () => {
  // A §65 escrita como teste: falta o campo, e o resultado é UI_CHANGED.
  const session = new MockTangerinoSession("missing_status");
  const snapshot = await session.readAdmission();
  assert.equal(snapshot.rawStatus, undefined);
  assert.throws(() => parseAdmission(snapshot), (error: unknown) =>
    error instanceof TangerinoAgentError && error.state === "UI_CHANGED");
});

/* ── Multi-tenancy, RBAC e credenciais ─────────────────────────────────────── */

test("toda consulta ao banco é escopada por workspace", async () => {
  /* Nenhum usuário consulta admissão de outro workspace (§58). O RLS forçado é
     a garantia final, mas uma consulta sem `workspace_id` no WHERE já seria um
     erro de raciocínio — e é isso que este teste pega, antes do banco. */
  for (const arquivo of ["lib/tangerino/queue.ts", "lib/tangerino/agent.ts", "lib/tangerino/health-check.ts"]) {
    const conteudo = await readFile(new URL(`../${arquivo}`, import.meta.url), "utf8");
    const consultas = [...conteudo.matchAll(/(SELECT|UPDATE|INSERT INTO|DELETE FROM)[\s\S]*?`\)/gu)].map((match) => match[0]);
    assert.ok(consultas.length >= 4, `${arquivo}: nenhuma consulta encontrada, o teste está lendo o arquivo errado`);
    for (const consulta of consultas) {
      assert.match(consulta, /workspace_id/u, `${arquivo}: consulta sem workspace_id\n${consulta.slice(0, 160)}`);
    }
  }
});

test("o alvo da consulta é montado no servidor, não recebido do cliente", async () => {
  /* A §17 e a §78 no mesmo ponto: o frontend manda `employeeId` e nada mais.
     Aceitar termo de busca do cliente daria a ele uma consulta livre dentro do
     Tangerino da empresa. */
  const rota = await readFile(new URL("../app/api/integrations/tangerino/admissions/[employeeId]/consult/route.ts", import.meta.url), "utf8");
  const usosDoCorpo = [...rota.matchAll(/body\.(\w+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(usosDoCorpo)], ["force"], "a rota passou a ler outro campo do corpo");
  assert.match(rota, /loadConsultationTarget\(d1, workspace\.id, employeeId\)/u);
  assert.match(rota, /requireCapability\(workspace, "integrations\.tangerino\.admission\.read"\)/u);
  // Acesso por empresa depois de carregar o alvo: é o cadastro que diz de qual
  // empresa o colaborador é.
  assert.match(rota, /requireCompanyAccess\(d1, workspace\.id, user\.id, workspace\.role, target\.companyId\)/u);
  // Playwright jamais dentro da requisição HTTP (§33, §36).
  assert.doesNotMatch(rota, /playwright|chromium/iu);
  assert.match(rota, /status: result\.outcome === "queued" \? 202 : 200/u);
});

test("a permissão de consultar é separada de executar integração", () => {
  assert.ok(capabilities.includes("integrations.tangerino.admission.read"));
  assert.ok(capabilityCatalog["integrations.tangerino.admission.read"], "permissão sem descrição no catálogo");
  // O analista de DP consulta; o observador e o convidado, não.
  assert.equal(hasCapability("admin", "integrations.tangerino.admission.read"), true);
  assert.equal(hasCapability("member", "integrations.tangerino.admission.read"), true);
  assert.equal(hasCapability("observer", "integrations.tangerino.admission.read"), false);
  assert.equal(hasCapability("guest", "integrations.tangerino.admission.read"), false);
  // Consultar não é administrar o conector.
  assert.equal(hasCapability("member", "integrations.credentials.manage"), false);
  assert.equal(hasCapability("member", "integrations.execute"), false);
});

test("a credencial do agente tem cofre próprio e nunca sai em claro", () => {
  const anterior = { ...process.env };
  process.env.FDP_TANGERINO_VAULT_KEY = Buffer.alloc(32, 23).toString("base64");
  process.env.FDP_TANGERINO_VAULT_KEY_VERSION = "1";
  process.env.FDP_INTEGRATION_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const credenciais = { username: "consulta.dp", password: "Senha-Forte-2026" };
    const selado = sealCredentials("tangerino_browser", credenciais);
    assert.doesNotMatch(selado.encryptedValue, /consulta|Senha-Forte/u);
    assert.deepEqual(openCredentials("tangerino_browser", selado), credenciais);
    // A senha não tem representação pública; o usuário só aparece mascarado.
    assert.equal(credentialPublicHint("tangerino_browser", credenciais), "con********");
    /* O cofre é separado do global de propósito: o worker roda fora da
       aplicação e recebe só a chave do próprio agente. Sem ela, nem com a chave
       global no ambiente a credencial abre. */
    delete process.env.FDP_TANGERINO_VAULT_KEY;
    assert.throws(() => openCredentials("tangerino_browser", selado), /cofre|chave/iu);
  } finally {
    process.env = anterior;
  }
});

test("o disparo do worker não leva contexto de cliente ao GitHub", async () => {
  /* O payload é `{ "ref": "main" }` e nada mais. Mandar workspace ou colaborador
     vazaria quem está sendo consultado para um sistema que não precisa saber e
     guarda log de webhook por padrão. */
  let capturado: { url: string; body: string } | null = null;
  const resultado = await dispatchTangerinoWorker({
    env: { FDP_TANGERINO_ACTIONS_TOKEN: "token-de-teste" },
    fetcher: (async (url: string, init: RequestInit) => {
      capturado = { url: String(url), body: String(init.body) };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
  assert.equal(resultado.status, "dispatched");
  const enviado = capturado as unknown as { url: string; body: string };
  assert.deepEqual(JSON.parse(enviado.body), { ref: "main" });
  assert.match(enviado.url, /tangerino-worker\.yml/u);
  // Repositório, workflow e ref entram no caminho da chamada: valor com `../`
  // viraria outra chamada à API do GitHub com o token da plataforma anexado.
  assert.equal((await dispatchTangerinoWorker({ env: { FDP_TANGERINO_ACTIONS_TOKEN: "t", FDP_TANGERINO_ACTIONS_REF: "../../main" } })).status, "misconfigured");
  assert.equal((await dispatchTangerinoWorker({ env: {} })).status, "not_configured");
});

test("o modo persistente não dispara GitHub Actions nem pelo token de fallback", async () => {
  let chamouGitHub = false;
  const resultado = await dispatchTangerinoWorker({
    env: {
      FDP_TANGERINO_WORKER_MODE: "persistent",
      FDP_TANGERINO_ACTIONS_TOKEN: "token-tangerino",
      FDP_SANKHYA_ACTIONS_TOKEN: "token-sankhya",
    },
    fetcher: (async () => {
      chamouGitHub = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  assert.equal(resultado.status, "persistent");
  assert.equal(chamouGitHub, false);
});

/* ── Configuração e portões ────────────────────────────────────────────────── */

test("o agente nasce desligado e a Vercel é sempre headless", () => {
  assert.equal(tangerinoAgentConfig({}).enabled, false, "um agente que navega no sistema do cliente não liga por omissão");
  assert.equal(tangerinoAgentConfig({ TANGERINO_BROWSER_AGENT_ENABLED: "true" }).enabled, true);
  /* `headless: false` num runner sem servidor gráfico não abre janela para
     ninguém ver — só falha de um jeito difícil de ler. A janela serve ao
     mapeamento, que acontece na máquina de quem está mapeando. */
  assert.equal(tangerinoAgentConfig({ VERCEL_ENV: "production", TANGERINO_BROWSER_HEADLESS_OFF: "true" }).headless, true);
  assert.equal(tangerinoAgentConfig({ TANGERINO_BROWSER_HEADLESS_OFF: "true" }).headless, false);
  // Screenshot não é padrão, e nunca em produção (§53).
  assert.equal(tangerinoAgentConfig({ VERCEL_ENV: "production", DEBUG_TANGERINO_SCREENSHOTS: "true" }).screenshots, false);
});

test("o modo assistido exige perfil persistente e nunca liga na Vercel", () => {
  const semPerfil = tangerinoAgentConfig({ FDP_TANGERINO_INTERACTIVE_AUTH: "true" });
  assert.equal(semPerfil.interactiveAuth, false);
  assert.equal(semPerfil.profileRoot, "");

  const windows = tangerinoAgentConfig({
    NODE_ENV: "production",
    FDP_TANGERINO_PROFILE_ROOT: "C:\\ProgramData\\Vinculato\\TangerinoProfiles",
    FDP_TANGERINO_INTERACTIVE_AUTH: "true",
  });
  assert.equal(windows.interactiveAuth, true);
  assert.equal(windows.headless, false, "o desafio humano precisa de janela visível");

  const vercel = tangerinoAgentConfig({
    VERCEL: "1",
    FDP_TANGERINO_PROFILE_ROOT: "C:\\perfil",
    FDP_TANGERINO_INTERACTIVE_AUTH: "true",
    TANGERINO_BROWSER_HEADLESS_OFF: "true",
  });
  assert.equal(vercel.interactiveAuth, false);
  assert.equal(vercel.headless, true);
});

test("os limites são presos em faixa, e variável ausente cai no padrão", () => {
  const absurdo = tangerinoAgentConfig({
    TANGERINO_BROWSER_TIMEOUT_MS: "999999999",
    TANGERINO_BROWSER_CONCURRENCY: "500",
    TANGERINO_CONSULTATION_RATE_PER_MINUTE: "0",
    TANGERINO_SESSION_TTL_MS: "1",
    FDP_TANGERINO_INTERACTIVE_AUTH_TIMEOUT_MS: "999999999",
  });
  assert.equal(absurdo.timeoutMs, 300_000, "sem teto, um job fica infinito (§42)");
  assert.equal(absurdo.concurrency, 8, "sem teto, dezenas de navegadores simultâneos (§38)");
  assert.equal(absurdo.rateLimitPerMinute, 1, "limite zero desligaria a consulta para todo mundo");
  assert.equal(absurdo.sessionTtlMs, 60_000);
  assert.equal(absurdo.interactiveAuthTimeoutMs, 15 * 60_000);
  /* `Number("")` é 0, que é finito: sem o recorte de texto vazio, toda variável
     não definida seria presa no mínimo da faixa em vez de usar o padrão — e o
     agente rodaria com concorrência 1 e cache 0 sem ninguém ter pedido. */
  const vazio = tangerinoAgentConfig({});
  assert.equal(vazio.concurrency, 2);
  assert.equal(vazio.cacheTtlSeconds, 60);
  assert.equal(vazio.rateLimitPerMinute, 6);
  assert.equal(vazio.timeoutMs, 90_000);
});

test("o trinco, o limite e o cache existem na fila e não na tela", async () => {
  const fila = await readFile(new URL("../lib/tangerino/queue.ts", import.meta.url), "utf8");
  // O índice parcial é quem realmente impede duas consultas simultâneas: duas
  // requisições concorrentes passam juntas pela verificação em SQL.
  assert.match(fila, /tangerino_consultations_active_uq/u);
  assert.match(fila, /already_running/u);
  assert.match(fila, /assertWithinRateLimit/u);
  const migration = await readFile(new URL("../drizzle/postgres/0056_tangerino_admission_agent.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]*?tangerino_consultations_active_uq[\s\S]*?WHERE "state" IN \('QUEUED', 'RUNNING'\)/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  // Uma consulta que diz ter lido algo sem ter lido nada é recusada pelo banco.
  assert.match(migration, /"state" <> 'SUCCESS' OR length\("raw_status"\) > 0/u);
});

test("todos os doze estados de consulta existem no tipo e no banco", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0056_tangerino_admission_agent.sql", import.meta.url), "utf8");
  for (const state of consultationStates) {
    assert.match(migration, new RegExp(`'${state}'`, "u"), `o banco não aceita o estado ${state}`);
  }
  for (const status of admissionStatuses) {
    assert.match(migration, new RegExp(`'${status}'`, "u"), `o banco não aceita a situação ${status}`);
  }
});

/* ── Evidência do mapeamento real ──────────────────────────────────────────── */

test("os seletores críticos refletem a estrutura confirmada em tela", () => {
  assert.equal(TANGERINO_SELECTORS_ARE_PROVISIONAL, false);
  const fonte = source("lib/tangerino/selectors.ts");
  assert.match(fonte, /24\/08\/2026/u);
  assert.equal(TangerinoSelectors.admissionsMenuCss, "a.item-menu.item-modulo-menu-pricing");
  assert.match(TangerinoSelectors.admissionsFrameCss, /admissao-demissao\.tangerino\.com\.br/u);
  assert.equal(TangerinoSelectors.searchCss[0], 'input[placeholder="Digite o nome"]');
  assert.equal(TangerinoSelectors.resultCardCss, ".cards-scroll > .s-card");
  assert.equal(TangerinoSelectors.resultNameCss, "strong.s-title");
  assert.ok(TangerinoSelectors.statusLabels.some((pattern) => pattern.test("Status da admissão")));
  assert.ok(TangerinoSelectors.stageLabels.some((pattern) => pattern.test("Status da etapa")));
  assert.ok(!TangerinoSelectors.admissionDateLabels.some((pattern) => pattern.test("Data limite para a admissão")));
  // A lista de ações proibidas existe para o agente ignorá-las de propósito.
  assert.ok(TangerinoSelectors.forbiddenActions.length >= 8);
  for (const acao of ["Salvar", "Excluir", "Admitir", "Aprovar", "Rejeitar", "Assinar", "Finalizar"]) {
    assert.ok(TangerinoSelectors.forbiddenActions.some((pattern) => pattern.test(acao)), `"${acao}" saiu da lista de proibidas`);
  }
});

test("nenhum comando do cliente de navegador encosta numa ação de alteração", () => {
  /* A prova de que a lista acima é para ignorar, e não decoração: o cliente de
     navegador não referencia `forbiddenActions` em nenhum clique. */
  const cliente = source("worker/tangerino/playwright-session.ts");
  const cliques = [...cliente.matchAll(/\.click\(\)/gu)];
  assert.ok(cliques.length > 0 && cliques.length <= 7, `${cliques.length} cliques: um agente de leitura clica em navegação e downloads autorizados`);
  assert.doesNotMatch(cliente, /forbiddenActions/u, "o cliente encostou na lista de ações proibidas");
  assert.doesNotMatch(cliente, /getByRole\("button", \{ name: \/(?:salvar|aprovar|admitir|excluir)/iu);
  // O runner efêmero mantém contexto novo. O persistente usa diretório opaco
  // por workspace, sem compartilhar cookies entre clientes.
  assert.match(cliente, /newContext\(/u);
  assert.match(cliente, /launchPersistentContext\(/u);
  assert.match(cliente, /createHash\("sha256"\)\.update\(tenant\)/u);
  assert.match(cliente, /acceptDownloads: true/u);
  assert.match(cliente, /downloadAllDocumentsButtons/u);
  assert.match(cliente, /exportRegistrationFormButtons/u);
});

test("o CAPTCHA é detectado pelo widget, e não só pela palavra", () => {
  /* Descoberto pela verificação por fixture: a tela de desafio também diz
     "Acessar sua conta", e o reCAPTCHA vive num iframe sem escrever a palavra
     em lugar nenhum. Detectar só por texto a classificaria como login, e o
     agente digitaria a senha no meio de um CAPTCHA. */
  assert.ok(TangerinoSelectors.captchaWidgets.length >= 5);
  for (const marca of ["recaptcha", "hcaptcha", "data-sitekey"]) {
    assert.ok(TangerinoSelectors.captchaWidgets.some((selector) => selector.toLowerCase().includes(marca)),
      `o seletor de "${marca}" saiu da lista`);
  }
  const cliente = source("worker/tangerino/playwright-session.ts");
  assert.match(cliente, /detectAuthBarrier\(text, await hasCaptchaWidget\(page\)\)/u);
  assert.match(cliente, /waitForManualAuthentication/u);
  const helperCaptcha = cliente.slice(cliente.indexOf("export async function hasCaptchaWidget"), cliente.indexOf("export function tangerinoProfileDirectory"));
  assert.doesNotMatch(helperCaptcha, /\.click\(/u, "o worker tentou clicar dentro do CAPTCHA");
});

test("o modo assistido libera só recursos do desafio e nunca a navegação principal", () => {
  for (const url of [
    "https://www.google.com/recaptcha/api2/anchor",
    "https://www.gstatic.com/recaptcha/releases/abc/script.js",
    "https://newassets.hcaptcha.com/captcha/v1.js",
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/orchestrate",
  ]) assert.equal(isAllowedTangerinoChallengeUrl(url), true, url);
  for (const url of [
    "http://www.google.com/recaptcha/api2/anchor",
    "https://www.google.com/search?q=recaptcha",
    "https://google.com.evil.test/recaptcha/api2/anchor",
    "https://usuario:senha@www.google.com/recaptcha/api2/anchor",
    "https://evil.test/captcha",
  ]) assert.equal(isAllowedTangerinoChallengeUrl(url), false, url);
  const cliente = source("worker/tangerino/playwright-session.ts");
  assert.match(cliente, /interactiveChallengeResource && request\.isNavigationRequest\(\)[\s\S]*?mainFrame\(\)[\s\S]*?route\.abort/u);
});

