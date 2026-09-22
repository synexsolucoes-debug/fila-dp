import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TangerinoWorkerConfigurationError,
  assertWorkerConfiguration,
  inspectWorkerConfiguration,
  isWorkerConfigurationError,
} from "../lib/tangerino/worker-configuration.ts";

/**
 * O worker Windows sobe numa janela que fecha quando o processo termina.
 * Enquanto a parada não vinha escrita, o sintoma para quem opera era a janela
 * abrir e sumir — sem mensagem, sem log, sem o que tentar. Os testes aqui
 * guardam as duas metades do conserto: a causa sai em texto acionável, e nada
 * fecha em silêncio.
 */

const completo = {
  DATABASE_URL: "postgres://vinculato:segredo-da-conexao@db.exemplo.com:5432/fila",
  FDP_TANGERINO_VAULT_KEYS: '{"1":"chave-secreta-em-base64"}',
  TANGERINO_BROWSER_AGENT_ENABLED: "true",
  FDP_TANGERINO_PROFILE_ROOT: "C:\\Vinculato\\perfil",
  FDP_TANGERINO_INTERACTIVE_AUTH: "true",
};

test("ambiente completo do Windows não acusa nada", () => {
  assert.deepEqual(inspectWorkerConfiguration(completo, { requireInteractiveWindow: true }), []);
  assert.doesNotThrow(() => assertWorkerConfiguration(completo, { requireInteractiveWindow: true }));
});

test("cada variável ausente vira um nome e um passo, não um erro genérico", () => {
  const problems = inspectWorkerConfiguration({}, { requireInteractiveWindow: true });
  assert.deepEqual(problems.map((problem) => problem.variable).sort(), [
    "DATABASE_URL",
    "FDP_TANGERINO_INTERACTIVE_AUTH",
    "FDP_TANGERINO_PROFILE_ROOT",
    "FDP_TANGERINO_VAULT_KEYS",
    "TANGERINO_BROWSER_AGENT_ENABLED",
  ]);
  // Sem o remédio, a lista de nomes não move ninguém: a pessoa lê "falta
  // FDP_TANGERINO_VAULT_KEYS" e continua sem saber de onde a chave sai.
  for (const problem of problems) {
    assert.ok(problem.remedy.length > 20, `${problem.variable} precisa dizer o que fazer`);
  }
});

test("a mensagem do erro nunca carrega o valor de nenhuma variável", () => {
  const erro = new TangerinoWorkerConfigurationError(
    inspectWorkerConfiguration({ ...completo, TANGERINO_BROWSER_AGENT_ENABLED: "" }, { requireInteractiveWindow: true }),
  );
  // Ela é impressa na tela do computador do DP e gravada em log: chave de cofre
  // e string de conexão não podem viajar junto com o diagnóstico.
  assert.ok(!erro.message.includes("chave-secreta-em-base64"));
  assert.ok(!erro.message.includes("segredo-da-conexao"));
  assert.ok(!erro.message.includes("db.exemplo.com"));
  assert.match(erro.message, /TANGERINO_BROWSER_AGENT_ENABLED/u);
  assert.match(erro.message, /configurar-worker\.ps1/u);
});

test("DATABASE_URL preenchida com o valor errado não é tratada como ausente", () => {
  // Colar a URL do painel no lugar da string de conexão é o engano comum. Dizer
  // "ausente" manda procurar uma linha que está lá, escrita, na frente da pessoa.
  const [problema] = inspectWorkerConfiguration({ ...completo, DATABASE_URL: "https://vinculato.vercel.app" });
  assert.equal(problema?.variable, "DATABASE_URL");
  assert.match(problema.remedy, /precisa começar com postgres/u);
});

test("perfil vazio não acusa FDP_TANGERINO_INTERACTIVE_AUTH que já está true", () => {
  const problems = inspectWorkerConfiguration(
    { ...completo, FDP_TANGERINO_PROFILE_ROOT: "" },
    { requireInteractiveWindow: true },
  );
  assert.deepEqual(problems.map((problem) => problem.variable), ["FDP_TANGERINO_PROFILE_ROOT"]);
});

test("janela visível só é exigida de quem roda no Windows", () => {
  const semJanela = { ...completo, FDP_TANGERINO_PROFILE_ROOT: "", FDP_TANGERINO_INTERACTIVE_AUTH: "" };
  assert.deepEqual(inspectWorkerConfiguration(semJanela), []);
});

test("falta de configuração se distingue de qualquer outra falha", () => {
  // O worker Windows decide por este teste se imprime a mensagem em texto ou se
  // mantém o registro estruturado, que guarda só o nome do erro.
  assert.equal(isWorkerConfigurationError(new TangerinoWorkerConfigurationError([])), true);
  assert.equal(isWorkerConfigurationError(new Error("falha de navegação em /colaborador/993212")), false);
  assert.equal(isWorkerConfigurationError(null), false);
});

test("o worker Windows imprime a falta de configuração antes de encerrar", async () => {
  const fonte = await readFile(new URL("../worker/tangerino/windows.ts", import.meta.url), "utf8");
  assert.match(fonte, /isWorkerConfigurationError\(error\)/u);
  assert.match(fonte, /process\.stderr\.write/u);
  assert.match(fonte, /requireInteractiveWindow: true/u);
});

test("o script de inicialização no Windows não fecha a janela em silêncio", async () => {
  const script = await readFile(new URL("../scripts/windows/start-tangerino-worker.ps1", import.meta.url), "utf8");
  // Toda saída passa por Segurar, que espera a pessoa ler. Um `exit` solto
  // reintroduz exatamente o defeito: janela que abre e some.
  const saidas = script.match(/^\s*exit \d/gmu) ?? [];
  assert.equal(saidas.length, 2, "cada saída do script precisa ser contada e passar por Segurar");
  assert.match(script, /function Segurar/u);
  assert.match(script, /Read-Host/u);
  // A versão do Node é conferida antes de chamar o worker: com Node antigo o
  // processo morre em "bad option", sem nada na tela.
  assert.match(script, /maiorNode -lt 24/u);
  assert.match(script, /\$codigo -ne 0/u);
});

test("a tarefa do Windows sobe o worker pelo mesmo caminho que o npm", async () => {
  // O script chamava `node --experimental-strip-types`. O worker importa
  // diretórios ("../db") e o atalho "@/db", que o resolvedor do Node recusa com
  // ERR_UNSUPPORTED_DIR_IMPORT antes da primeira linha — a janela abria e
  // fechava na mesma hora, sem mensagem. Só o tsx resolve esses caminhos.
  const script = await readFile(new URL("../scripts/windows/start-tangerino-worker.ps1", import.meta.url), "utf8");
  assert.match(script, /node --import tsx worker\/tangerino\/windows\.ts/u);
  assert.doesNotMatch(script, /experimental-strip-types worker\/tangerino/u);

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["worker:tangerino:windows"] ?? "", /--import tsx worker\/tangerino\/windows\.ts/u);
});

test("a instalação concede o perfil por SID, e não por nome de grupo", async () => {
  // "Administrators" e "SYSTEM" não existem num Windows em português — lá são
  // "Administradores" e "SISTEMA". A concessão falhava calada, e o diretório com
  // os cookies autenticados da Sólides ficava sem as regras pretendidas.
  const script = await readFile(new URL("../scripts/windows/install-tangerino-worker.ps1", import.meta.url), "utf8");
  assert.match(script, /S-1-5-18/u, "SISTEMA precisa ir por SID");
  assert.match(script, /S-1-5-32-544/u, "Administradores precisa ir por SID");
  // Só o código conta: o comentário acima da correção cita os nomes em inglês
  // justamente para explicar por que eles não servem.
  const codigo = script.split("\n").filter((linha) => !linha.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(codigo, /"Administrators"|"SYSTEM"/u);
});

test("a instalação exporta o perfil para a conferência de prontidão", async () => {
  // check-tangerino-worker.mts cobra FDP_TANGERINO_PROFILE_ROOT do processo.
  // Sem exportar, toda instalação acusava "não chegou ao processo" — um erro
  // que descrevia o script, e não a configuração da pessoa.
  const script = await readFile(new URL("../scripts/windows/install-tangerino-worker.ps1", import.meta.url), "utf8");
  const conferencia = await readFile(new URL("../scripts/windows/check-tangerino-worker.mts", import.meta.url), "utf8");
  assert.match(conferencia, /FDP_TANGERINO_PROFILE_ROOT/u);
  assert.match(script, /\$env:FDP_TANGERINO_PROFILE_ROOT = \$config\["FDP_TANGERINO_PROFILE_ROOT"\]/u);
});

test("o diagnóstico da fila sobe pelo mesmo caminho que o worker", async () => {
  // Mesma armadilha do start-tangerino-worker.ps1: com
  // `--experimental-strip-types` o script morre em ERR_UNSUPPORTED_DIR_IMPORT
  // antes da primeira linha, e quem está diagnosticando um silêncio recebe
  // outro silêncio.
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts["tangerino:diagnostico"] ?? "";
  assert.match(script, /--import tsx/u);
  assert.doesNotMatch(script, /experimental-strip-types/u);
});

test("o diagnóstico percorre toda a corrente que enche a fila", async () => {
  // Cada elo vazio produz o mesmo sintoma — silêncio. Um diagnóstico que
  // esquecesse um elo mandaria a pessoa procurar no lugar errado.
  const fonte = await readFile(new URL("../scripts/windows/diagnosticar-tangerino.mts", import.meta.url), "utf8");
  for (const elo of [
    "fdp_workspace_module_grants",
    "fdp_integrations",
    "fdp_integration_credentials",
    "fdp_employees",
    "fdp_employee_external_refs",
    "fdp_tangerino_admission_consultations",
    "fdp_tangerino_worker_heartbeats",
  ]) {
    assert.match(fonte, new RegExp(elo, "u"), `o diagnóstico precisa olhar ${elo}`);
  }
  // E precisa abrir a credencial: é o único jeito de saber se a chave do cofre
  // deste computador é a mesma que selou o segredo.
  assert.match(fonte, /openCredentials\(/u);
});

test("o diagnóstico separa versão ausente de chave errada", async () => {
  // Três causas, três remédios. "Não abre" mandaria trocar a chave em duas
  // delas — e numa a chave está certa, só falta registrar a versão.
  const fonte = await readFile(new URL("../scripts/windows/diagnosticar-tangerino.mts", import.meta.url), "utf8");
  assert.match(fonte, /VAULT_NOT_CONFIGURED/u);
  assert.match(fonte, /VAULT_KEY_VERSION_MISSING/u);
  assert.match(fonte, /no singular\) registra SOMENTE a versão 1/u);
});

test("o montador do ambiente pede o mapa de versões antes da chave única", async () => {
  const script = await readFile(new URL("../scripts/windows/configurar-worker.ps1", import.meta.url), "utf8");
  // FDP_TANGERINO_VAULT_KEY registra só a versão 1. Perguntar por ela primeiro
  // levava quem tem deployment rotacionado a um arquivo que parece completo e
  // não abre nada.
  const plural = script.indexOf('Read-Host "  FDP_TANGERINO_VAULT_KEYS');
  const singular = script.indexOf('Read-Host "  FDP_TANGERINO_VAULT_KEY"');
  assert.ok(plural > 0 && singular > 0, "as duas perguntas precisam existir");
  assert.ok(plural < singular, "o mapa de versões vem primeiro");
});

test("o montador recusa a string de conexão de exemplo", async () => {
  // `postgres://usuario:senha@host:5432/banco` começa com postgres e passava na
  // validação antiga. O worker só descobria em ENOTFOUND, longe daqui.
  const script = await readFile(new URL("../scripts/windows/configurar-worker.ps1", import.meta.url), "utf8");
  assert.match(script, /\$placeholders = @\(/u);
  for (const exemplo of ['"host"', '"hostname"', '"example.com"']) {
    assert.ok(script.includes(exemplo), `${exemplo} precisa ser recusado como servidor`);
  }
  // E o endereço lido é mostrado para conferência: é a única parte da string
  // que quem configura reconhece de olho.
  assert.match(script, /Servidor lido: \$servidor/u);
  assert.match(script, /\[System\.Uri\]::new\(\$databaseUrl\)/u);
});

test("chave mais nova que o selo não vira conselho de mexer no arquivo", async () => {
  // A máquina do DP ficou com a versão 3 e a credencial selada na 2: rotação
  // pela metade, não configuração errada. A mensagem antiga mandava trocar de
  // variável, o que ali não resolveria nada — o que falta é do lado do
  // deployment, e só regravar o acesso no painel sela de novo.
  const fonte = await readFile(new URL("../scripts/windows/diagnosticar-tangerino.mts", import.meta.url), "utf8");
  assert.match(fonte, /numeros\.every\(\(numero\) => numero > versaoNecessaria\)/u);
  assert.match(fonte, /falta terminar a rotação/u);
  assert.match(fonte, /regravar usuário e senha da Sólides no painel/u);
  // E os outros dois casos continuam separados, com remédios diferentes.
  assert.match(fonte, /no singular\) registra SOMENTE a versão 1/u);
  assert.match(fonte, /Falta a versão \$\{versaoNecessaria\} no mapa/u);
});

test("uma varredura reaproveita o navegador e drena os anexos que acabou de descobrir", async () => {
  const runner = await readFile(new URL("../worker/tangerino/runner.ts", import.meta.url), "utf8");
  const cliente = await readFile(new URL("../worker/tangerino/playwright-session.ts", import.meta.url), "utf8");
  assert.match(runner, /PlaywrightTangerinoSession\.create\(\{ workspaceId, deferClose: true \}\)/u);
  assert.match(runner, /discovery\.demandsCreated \+ discovery\.attachmentsBackfilled > 0\) await drainQueuedWork\(\)/u);
  assert.match(runner, /shared\.session\?\.dispose\(\)/u);
  assert.match(cliente, /if \(this\.deferredClose\) return;/u);
  assert.match(cliente, /async dispose\(\)/u);
  assert.match(cliente, /this\.persistentProfile \? tangerinoAdmissionsEntryUrls\[0\] : input\.endpoint/u,
    "perfil com cookie válido deve testar a área autenticada antes de voltar ao login");
});
