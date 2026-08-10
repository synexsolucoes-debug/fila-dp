/**
 * Gera a lista de migrations que esta versão do aplicativo espera encontrar
 * aplicadas no banco.
 *
 * Em produção o código roda empacotado: não há diretório `drizzle/postgres` para
 * ler em tempo de execução. Sem essa lista embutida, a aplicação não tem como
 * responder "o banco está atrás da minha versão" — e o sintoma vira uma falha
 * genérica, que foi exatamente o problema relatado.
 *
 * O manifesto é gerado, não escrito à mão, e um teste reprova se ele divergir do
 * diretório de migrations.
 *
 * Uso: node scripts/generate-schema-manifest.mjs
 */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = join(process.cwd(), "drizzle", "postgres");
const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).sort();
if (!files.length) throw new Error("Nenhuma migration PostgreSQL foi encontrada.");

const body = `/**
 * ARQUIVO GERADO — não edite à mão.
 *
 * Lista das migrations que esta versão do aplicativo espera encontrar aplicadas.
 * Regenerar com: npm run schema:manifest
 */
export const expectedMigrations = [
${files.map((file) => `  "${file}",`).join("\n")}
] as const;

/** Última migration conhecida por esta versão. */
export const latestMigration = expectedMigrations[expectedMigrations.length - 1];
`;

await writeFile(join(process.cwd(), "lib", "schema-manifest.ts"), body, "utf8");
console.log(`manifesto atualizado com ${files.length} migrations (última: ${files.at(-1)})`);
