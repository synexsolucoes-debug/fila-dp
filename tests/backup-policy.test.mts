import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * §85: a estratégia de backup e restauração.
 *
 * O ensaio de restauração já provava que o produto *sabe* voltar. O que faltava
 * era provar que existe **de onde** voltar — janela de recuperação configurada
 * no provedor, fora do repositório.
 *
 * Estes testes protegem a propriedade que torna a conferência honesta: ela
 * nunca pode aprovar o que não olhou. Um verificador que passasse sem credencial
 * seria pior que verificador nenhum, porque a equipe veria CI verde e concluiria
 * que está coberta.
 */

const scriptUrl = new URL("../scripts/verify-backup-policy.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);

async function rodar(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run("node", [script, ...args], {
      env: { ...process.env, NEON_API_KEY: "", NEON_PROJECT_ID: "", ...env },
    });

    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      code: failure.code ?? 1,
      out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

test("sem credencial, o verificador reprova em vez de passar calado", async () => {
  /* É a propriedade inteira. Um "ok" aqui viraria a frase "backup verificado"
     num relatório sobre nada. */
  const resultado = await rodar([]);

  assert.equal(resultado.code, 1);
  assert.match(resultado.out, /NÃO VERIFICADO/u);
});

test("o modo permissivo continua dizendo alto que não verificou", async () => {
  // Sai com zero para não travar fork, mas não pode ficar em silêncio: silêncio
  // e aprovação são indistinguíveis para quem lê o log depois.
  const resultado = await rodar(["--permitir-sem-credencial"]);

  assert.equal(resultado.code, 0);
  assert.match(resultado.out, /NÃO VERIFICADO/u);
});

test("a mensagem diz onde conferir à mão", async () => {
  // "Não verificado" sem o próximo passo transfere o problema sem resolver.
  const resultado = await rodar([]);

  assert.match(resultado.out, /History retention/u);
  assert.match(resultado.out, /NEON_API_KEY/u);
});

test("o script não inventa retenção quando o campo falta", async () => {
  /* Campo ausente não é retenção zero: pode ser mudança de contrato da API.
     Tratar ausência como zero geraria alarme falso; tratá-la como suficiente
     esconderia o caso real. */
  const source = await readFile(script, "utf8");

  assert.match(source, /typeof segundos !== "number"/u);
  assert.match(source, /não trouxe `history_retention_seconds`/u);
});

test("o mínimo é explícito e ajustável, não constante escondida", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /FDP_BACKUP_MINIMO_DIAS/u);
  assert.match(
    source,
    /MINIMO_DIAS = Number\(process\.env\.FDP_BACKUP_MINIMO_DIAS \?\? 7\)/u,
  );
});

test("o runbook de restauração manda conferir antes de apontar a aplicação", async () => {
  /* Restaurar e apontar sem conferir é como o isolamento se perde em silêncio:
     um backup que volta sem RLS volta com os dados de todos os clientes
     visíveis para qualquer um. */
  const doc = await readFile(
    new URL("../docs/backup-e-restauracao.md", import.meta.url),
    "utf8",
  );

  for (const comando of ["db:status", "verify:isolation", "verify:sql"]) {
    assert.ok(
      doc.includes(comando),
      `o runbook não manda rodar ${comando} antes de apontar`,
    );
  }

  assert.match(
    doc,
    /branch nova/u,
    "restaurar por cima da produção destrói a evidência do incidente",
  );

  assert.match(
    doc,
    /não são promessa de RTO/u,
    "os tempos medidos são do volume do ensaio; vendê-los como RTO seria inventar compromisso",
  );
});

test("a CI entrega a credencial ao verificador, em vez de só aceitá-la nos segredos", async () => {
  /* O defeito que este teste fecha: o passo estava fixo em
     `--permitir-sem-credencial` e **sem bloco `env`**. Cadastrar NEON_API_KEY
     nos segredos do repositório não mudava nada — a credencial nunca chegava ao
     script, e a CI seguiria imprimindo "NÃO VERIFICADO" para sempre, com a
     pendência marcada como resolvida no painel de quem configurou.

     Configuração que parece resolver e não resolve é pior que pendência
     declarada: a pendência alguém ainda vai cobrar; a falsa solução ninguém
     volta para conferir. */
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );

  const passo = workflow.slice(
    workflow.indexOf("Conferir a política de backup do provedor"),
  );

  const bloco = passo.slice(0, passo.indexOf("- name:", 1));

  assert.match(
    bloco,
    /NEON_API_KEY:\s*\$\{\{\s*secrets\.NEON_API_KEY\s*\}\}/u,
    "o passo precisa passar NEON_API_KEY ao script, senão o segredo cadastrado não tem efeito",
  );

  assert.match(
    bloco,
    /NEON_PROJECT_ID:\s*\$\{\{\s*secrets\.NEON_PROJECT_ID\s*\}\}/u,
    "sem NEON_PROJECT_ID o verificador não sabe qual projeto olhar",
  );

  /* E o modo tem de ser escolhido, não fixado: com credencial confere de
     verdade; sem ela — em fork, onde segredo não é exposto — segue permissivo.
     Se o permissivo voltar a ser incondicional, cadastrar o segredo volta a ser
     um gesto sem efeito. */
  assert.ok(
    /npm run verify:backup\s*$/mu.test(bloco),
    "falta o caminho estrito: com credencial, a janela precisa ser conferida de verdade",
  );

  assert.match(
    bloco,
    /--permitir-sem-credencial/u,
    "o caminho permissivo precisa continuar existindo para fork, que não recebe segredo",
  );
});