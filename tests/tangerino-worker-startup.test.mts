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
