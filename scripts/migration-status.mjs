import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expectedMigrations } from "../lib/schema-manifest.ts";

/**
 * O que já foi aplicado no banco, e o que falta.
 *
 * O procedimento de produção tinha um passo chamado "veja o que está pendente"
 * que rodava `db:check` — e `db:check` valida os arquivos do clone sem falar
 * com banco nenhum. Quem seguia o roteiro à risca aplicava às cegas e só
 * descobria o resultado depois, pelo `/api/health`.
 *
 * Este comando responde a pergunta antes: liga no banco, lê
 * `fdp_schema_migrations` e compara com o que esta versão do aplicativo espera.
 * Não executa DDL e não altera nada — dá para rodar em produção a qualquer
 * hora, inclusive só para conferir.
 *
 * Ele também acusa duas coisas que o `db:migrate` só descobriria no meio do
 * caminho: migração aplicada cujo arquivo mudou depois (checksum diferente), e
 * migração aplicada no banco que não existe mais no clone — sinal de que o
 * clone está atrás do que foi publicado.
 *
 * Uso:
 *   DATABASE_URL="postgresql://…" npm run db:status
 */

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  console.error("Defina DATABASE_URL com a conexão do banco que você quer conferir.");
  console.error("Sem ela, o que dá para saber sem credencial é o /api/health do próprio deployment.");
  process.exit(2);
}

/* O mesmo critério do executor: PostgreSQL direto quando é local, Neon por HTTP
   no resto. Divergir aqui faria o relatório falar de um banco e a aplicação de
   outro. */
async function connect(url) {
  const explicit = String(process.env.FDP_DB_DRIVER ?? "").trim().toLowerCase();
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const local = explicit === "pg" || (explicit !== "neon" && !process.env.VERCEL && ["localhost", "127.0.0.1", "::1"].includes(host));
  if (!local) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url, { fullResults: true });
    return { query: async (text) => (await sql.query(text, [])).rows ?? [], close: async () => undefined };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 2 });
  return { query: async (text) => (await pool.query(text)).rows ?? [], close: () => pool.end() };
}

const db = await connect(databaseUrl);
let falhou = false;
try {
  const existe = (await db.query("SELECT to_regclass('public.fdp_schema_migrations') AS t"))[0]?.t;
  if (!existe) {
    console.log("Este banco não tem histórico de migração — nenhuma foi aplicada por aqui ainda.");
    console.log(`Esta versão do aplicativo espera ${expectedMigrations.length}.`);
    console.log("\nSe o banco já tem tabelas do produto, use uma única vez: npm run db:migrate:baseline");
    process.exit(1);
  }

  const aplicadas = new Map(
    (await db.query("SELECT id, checksum, applied_at FROM fdp_schema_migrations ORDER BY id"))
      .map((row) => [String(row.id), row]),
  );

  const diretorio = join(process.cwd(), "drizzle", "postgres");
  const arquivos = (await readdir(diretorio)).filter((nome) => /^\d{4}_.+\.sql$/u.test(nome)).sort();

  const pendentes = arquivos.filter((nome) => !aplicadas.has(nome));
  const desconhecidas = [...aplicadas.keys()].filter((id) => !arquivos.includes(id));

  /* Checksum: o executor recusa uma migração já aplicada cujo arquivo mudou, e
     recusa no meio da execução. Avisar aqui evita descobrir isso com metade da
     fila aplicada. As variantes de quebra de linha são as mesmas que o executor
     aceita — um clone no Windows não é uma migração alterada. */
  const alteradas = [];
  for (const nome of arquivos) {
    const registro = aplicadas.get(nome);
    if (!registro) continue;
    const fonte = (await readFile(join(diretorio, nome), "utf8")).replace(/\r\n/gu, "\n").trimEnd();
    const crlf = fonte.replace(/\n/gu, "\r\n");
    const compativeis = new Set([fonte, `${fonte}\n`, crlf, `${crlf}\r\n`]
      .map((texto) => createHash("sha256").update(texto).digest("hex")));
    if (!compativeis.has(String(registro.checksum))) alteradas.push(nome);
  }

  const data = (valor) => (valor ? new Date(valor).toLocaleString("pt-BR") : "");
  const ultima = [...aplicadas.values()].at(-1);
  console.log(`Aplicadas : ${aplicadas.size}`);
  if (ultima) console.log(`Última    : ${ultima.id} em ${data(ultima.applied_at)}`);
  console.log(`No clone  : ${arquivos.length}`);
  console.log(`Esperadas : ${expectedMigrations.length} (pelo manifesto desta versão do aplicativo)`);

  if (pendentes.length) {
    falhou = true;
    console.log(`\nPENDENTES (${pendentes.length}) — aplique com: npm run db:migrate`);
    for (const nome of pendentes) console.log(`  · ${nome}`);
  } else {
    console.log("\nNada pendente: o banco está na versão que o clone descreve.");
  }

  if (desconhecidas.length) {
    falhou = true;
    console.log(`\nAPLICADAS QUE NÃO EXISTEM NESTE CLONE (${desconhecidas.length})`);
    console.log("O banco está à frente do código que você tem em mãos. Atualize o clone antes de aplicar.");
    for (const nome of desconhecidas) console.log(`  · ${nome}`);
  }

  if (alteradas.length) {
    falhou = true;
    console.log(`\nARQUIVO ALTERADO DEPOIS DE APLICADO (${alteradas.length})`);
    console.log("O executor vai recusar. Migração aplicada não se edita: crie outra que corrija.");
    for (const nome of alteradas) console.log(`  · ${nome}`);
  }
} finally {
  await db.close();
}

process.exit(falhou ? 1 : 0);
