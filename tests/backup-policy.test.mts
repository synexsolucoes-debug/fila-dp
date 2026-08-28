import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

const script = new URL("../scripts/verify-backup-policy.mjs", import.meta.url);

async function rodar(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run("node", [script.pathname, ...args], {
      env: { ...process.env, NEON_API_KEY: "", NEON_PROJECT_ID: "", ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
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
  assert.match(source, /MINIMO_DIAS = Number\(process\.env\.FDP_BACKUP_MINIMO_DIAS \?\? 7\)/u);
});

test("o runbook de restauração manda conferir antes de apontar a aplicação", async () => {
  /* Restaurar e apontar sem conferir é como o isolamento se perde em silêncio:
     um backup que volta sem RLS volta com os dados de todos os clientes
     visíveis para qualquer um. */
  const doc = await readFile(new URL("../docs/backup-e-restauracao.md", import.meta.url), "utf8");
  for (const comando of ["db:status", "verify:isolation", "verify:sql"]) {
    assert.ok(doc.includes(comando), `o runbook não manda rodar ${comando} antes de apontar`);
  }
  assert.match(doc, /branch nova/u, "restaurar por cima da produção destrói a evidência do incidente");
  assert.match(doc, /não são promessa de RTO/u,
    "os tempos medidos são do volume do ensaio; vendê-los como RTO seria inventar compromisso");
});
