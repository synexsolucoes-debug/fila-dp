import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Extração das consultas SQL escritas dentro do código TypeScript.
 *
 * O produto monta SQL à mão em `d1.prepare("...")`, e nada verificava esse SQL:
 * o TypeScript enxerga uma string, o ESLint enxerga uma string, e o banco só
 * reclama em produção. Foi assim que `JOIN fdp_workspace_module_grants grant`
 * chegou ao ar — `grant` é palavra reservada do PostgreSQL, a varredura das
 * integrações morria com `syntax error at or near "grant"` e a fila de todos os
 * clientes parava sem que nenhum teste percebesse.
 *
 * Este módulo é a base das duas verificações que fecham essa lacuna:
 * `tests/sql-reserved-identifiers.test.mts`, que roda sempre e não precisa de
 * banco, e `scripts/verify-inline-sql.mjs`, que prepara cada consulta contra o
 * schema real.
 */

/**
 * Palavras totalmente reservadas do PostgreSQL 16 (apêndice C do manual, coluna
 * "reserved"). Nenhuma delas pode ser identificador sem aspas — nem tabela, nem
 * coluna, nem apelido.
 */
export const RESERVED_KEYWORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "both", "case", "cast",
  "check", "collate", "column", "constraint", "create", "current_catalog", "current_date", "current_role",
  "current_time", "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct", "do",
  "else", "end", "except", "false", "fetch", "for", "foreign", "from", "grant", "group", "having", "in",
  "initially", "intersect", "into", "lateral", "leading", "limit", "localtime", "localtimestamp", "not",
  "null", "offset", "on", "only", "or", "order", "placing", "primary", "references", "returning", "select",
  "session_user", "some", "symmetric", "table", "then", "to", "trailing", "true", "union", "unique", "user",
  "using", "variadic", "when", "where", "window", "with",
]);

/**
 * Palavras que aparecem logo depois do nome de uma tabela sem serem apelido:
 * são o início da próxima cláusula. Sem esta lista o detector acusaria
 * `FROM fdp_cards WHERE ...` como apelido reservado "where".
 */
const CLAUSE_CONTINUATION = new Set([
  "where", "order", "group", "limit", "offset", "on", "using", "set", "having", "union", "except",
  "intersect", "for", "when", "then", "else", "end", "returning", "as", "window", "with", "values",
  "from", "and", "or", "not", "lateral", "only", "join", "left", "right", "inner", "outer", "cross",
  "natural", "full", "in", "select", "do", "default", "fetch", "to", "desc", "asc", "all", "distinct",
  "into", "primary", "foreign", "unique", "check", "constraint", "references", "column", "table", "create",
]);

/**
 * As duas reservadas que o PostgreSQL aceita logo depois de FROM/JOIN: elas
 * modificam a origem em vez de nomeá-la (`JOIN LATERAL (...)`, `FROM ONLY t`).
 */
const SOURCE_MODIFIERS = new Set(["lateral", "only"]);

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs)$/u;
// `tests` fica de fora: consulta escrita dentro de um teste é fixture — texto
// para o teste examinar —, não código que roda para cliente. Incluí-la
// misturava a contagem de cobertura do produto com a do próprio ensaio.
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel", "tests"]);

/** Percorre a árvore de fontes, ignorando o que não é código do produto. */
export function listSourceFiles(root, out = []) {
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (SOURCE_EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Lê o literal de string que começa em `start` e devolve o texto e onde ele
 * termina. Trata escapes e as três aspas do JavaScript; em template literal a
 * interpolação é preservada como `${...}` para quem chama decidir o que fazer.
 */
function readStringLiteral(source, start) {
  /* Pular espaço e quebra de linha entre `.prepare(` e o literal.
     Sem isto, a chamada escrita em duas linhas — `d1.prepare(` seguido da
     consulta na linha de baixo — não era coletada: a verificação não a
     reprovava nem a contava entre as "não verificadas"; ela simplesmente não
     existia para a ferramenta. Em `lib/process-instances.ts` eram 6 de 12. É o
     mesmo defeito que o comentário de `verify-inline-sql` descreve: dizer OK
     sobre o que não se olhou. */
  while (start < source.length && (source[start] === " " || source[start] === "\n"
    || source[start] === "\r" || source[start] === "\t")) start += 1;
  const quote = source[start];
  if (quote !== "`" && quote !== "'" && quote !== '"') return null;
  let text = "";
  let interpolated = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      // Escapes relevantes ao SQL extraído; os demais seguem literais.
      const next = source[index + 1];
      text += next === "n" ? "\n" : next === "t" ? "\t" : next;
      index += 1;
      continue;
    }
    if (character === quote) return { text, interpolated, end: index };
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      // Interpolação: consome equilibrando chaves e marca a consulta como dinâmica.
      interpolated = true;
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      text += "${...}";
      index = cursor - 1;
      continue;
    }
    if (quote !== "`" && character === "\n") return null;
    text += character;
  }
  return null;
}

const SQL_START = /^\s*(?:--[^\n]*\n\s*)*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu;

/**
 * Coleta as consultas de um arquivo. Só entra o que é passado a `.prepare(`,
 * que é como o produto fala com o banco — assim a verificação acompanha o
 * código real em vez de uma lista mantida à mão.
 */
export function extractQueries(file, source) {
  const queries = [];
  const marker = ".prepare(";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const literal = readStringLiteral(source, index + marker.length);
    if (literal && SQL_START.test(literal.text)) {
      queries.push({
        file,
        line: source.slice(0, index).split("\n").length,
        sql: literal.text,
        interpolated: literal.interpolated,
      });
    }
    index = source.indexOf(marker, index + marker.length);
  }
  return queries;
}

/** Todas as consultas do repositório, com caminho relativo para mensagens legíveis. */
export function collectQueries(root) {
  const queries = [];
  for (const file of listSourceFiles(root)) {
    queries.push(...extractQueries(relative(root, file), readFileSync(file, "utf8")));
  }
  return queries;
}

/**
 * Aponta apelidos e nomes de tabela que usam palavra reservada sem aspas.
 *
 * A varredura é textual de propósito: um analisador completo de SQL seria mais
 * preciso, mas esta verificação precisa rodar sem banco, em qualquer máquina, e
 * o erro que ela persegue é exatamente o que o olho não pega na revisão.
 */
export function findReservedIdentifiers(sql) {
  const findings = [];
  // Comentários e literais saem antes: 'grant' dentro de string não é apelido.
  const scrubbed = sql
    .replace(/--[^\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/'(?:[^']|'')*'/gu, "''")
    .replace(/"(?:[^"]|"")*"/gu, '"quoted"');
  const pattern = /\b(FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(?:(AS)\s+)?([A-Za-z_][A-Za-z0-9_]*)/giu;
  let match;
  while ((match = pattern.exec(scrubbed))) {
    const [, clause, table, explicitAs, candidate] = match;
    const alias = candidate.toLowerCase();
    // `JOIN LATERAL (...) apelido`: quem nomeia é o que vem depois do modificador.
    if (SOURCE_MODIFIERS.has(table.toLowerCase())) continue;
    // Sem `AS`, uma palavra de cláusula é continuação e não apelido.
    if (!explicitAs && CLAUSE_CONTINUATION.has(alias)) continue;
    if (RESERVED_KEYWORDS.has(alias)) {
      findings.push({ kind: "alias", clause, table, identifier: candidate });
    }
  }
  // Tabela com nome reservado quebra do mesmo jeito.
  const tablePattern = /\b(FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)\b/giu;
  while ((match = tablePattern.exec(scrubbed))) {
    const [, clause, table] = match;
    if (SOURCE_MODIFIERS.has(table.toLowerCase())) continue;
    if (RESERVED_KEYWORDS.has(table.toLowerCase())) {
      findings.push({ kind: "table", clause, table, identifier: table });
    }
  }
  return findings;
}
