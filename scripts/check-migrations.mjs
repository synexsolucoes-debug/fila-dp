import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const migrationDirectory = join(root, "drizzle", "postgres");
const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
if (!files.length) throw new Error("Nenhuma migration PostgreSQL encontrada.");

const metadataDirectory = join(migrationDirectory, "meta");
const metadataFiles = (await readdir(metadataDirectory)).filter((file) => file.endsWith(".json")).sort();
for (const file of metadataFiles) {
  const source = await readFile(join(metadataDirectory, file), "utf8");
  try {
    JSON.parse(source);
  } catch (error) {
    throw new Error(`${file} contém metadados Drizzle inválidos: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const destructive = /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|ALTER\s+TABLE\s+[^;]+\s+DROP\s+COLUMN|DELETE\s+FROM)\b/i;
for (const file of files) {
  const sql = await readFile(join(migrationDirectory, file), "utf8");
  if (destructive.test(sql) && !sql.includes("allow-destructive-migration")) {
    throw new Error(`${file} contém uma operação destrutiva sem autorização explícita.`);
  }
}

const sourceFiles = ["db/index.ts", "lib/fila-dp-db.ts"];
for (const file of sourceFiles) {
  const source = await readFile(join(root, file), "utf8");
  for (const forbidden of [/\bPRAGMA\b/i, /INSERT\s+OR\s+(IGNORE|REPLACE)/i, /datetime\s*\(/i, /CREATE\s+TABLE/i]) {
    if (forbidden.test(source)) throw new Error(`${file} ainda contém SQL do bootstrap legado: ${forbidden}`);
  }
}

console.log(`${files.length} migrations e ${metadataFiles.length} metadados PostgreSQL validados; nenhum DDL foi encontrado no caminho HTTP.`);
