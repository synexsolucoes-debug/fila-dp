/**
 * Exportação dos dados de um grupo (§50).
 *
 * A página de privacidade diz, na seção de retenção: "após o encerramento, há
 * período de recuperação de 30 dias para exportação". O prazo existia — a
 * exclusão é reversível e o teste de ciclo de vida garante isso —, mas
 * exportação não existia. O cliente que encerrasse o contrato tinha trinta dias
 * para *restaurar* o grupo, e depois disso nada. Tirar os dados dependia de
 * juntar o CSV de demandas com a exportação do Caju e a do ponto, e ainda assim
 * faltariam empresas, colaboradores, obrigações e competências.
 *
 * A lista de tabelas vem do próprio schema, não de um inventário à mão: toda
 * tabela com `workspace_id` entra. Um inventário manual envelhece em silêncio —
 * alguém acrescenta uma tabela, ninguém lembra da exportação, e o arquivo passa
 * a estar incompleto sem avisar.
 */

export type ExportTable = { name: string; columns: string[] };

/**
 * Colunas que **não** saem no arquivo.
 *
 * Segredo cifrado continua sendo segredo: exportar o texto cifrado junto da
 * versão da chave transforma um vazamento futuro da chave em vazamento dos
 * segredos de integração de todos os clientes que já exportaram. Hashes de
 * correlação (CPF, payload, IP) são chave interna de junção, não dado do
 * cliente — o CPF do colaborador o controlador já tem, e é ele que importa.
 *
 * O arquivo declara o que omitiu. Um export silenciosamente incompleto é pior
 * que um incompleto declarado: o segundo se resolve pedindo o que falta.
 */
export const REDACTED_COLUMN = /(secret|token|credential|cipher|encrypted|_hash|password)/u;

/** Motivo por coluna, para o arquivo poder explicar a omissão a quem o abre. */
export function redactionReason(column: string) {
  if (/(secret|credential|encrypted|cipher)/u.test(column)) {
    return "segredo cifrado — exportá-lo transformaria um vazamento futuro da chave em vazamento do segredo";
  }
  if (/token/u.test(column)) return "credencial de acesso ou trava de execução";
  if (/password/u.test(column)) return "credencial de acesso";
  return "hash de correlação interna, não é dado do titular";
}

/**
 * Tabelas do grupo, lidas do catálogo do PostgreSQL.
 *
 * Só entra identificador que casa com `fdp_[a-z0-9_]+`, e ele vem do catálogo
 * do banco — não de entrada do usuário. A conferência existe porque o nome
 * entra na consulta por interpolação, que é o único jeito de percorrer tabelas
 * variáveis, e é o tipo de lugar onde um dia alguém liga isso a um parâmetro.
 */
export async function listExportTables(d1: {
  prepare: (query: string) => { bind: (...args: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } };
}): Promise<ExportTable[]> {
  const rows = await d1.prepare(`SELECT c.relname AS tabela, col.column_name AS coluna
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'fdp_%'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns w
        WHERE w.table_schema = n.nspname AND w.table_name = c.relname AND w.column_name = 'workspace_id')
    ORDER BY c.relname, col.ordinal_position`)
    .bind()
    .all<{ tabela: string; coluna: string }>();

  const byTable = new Map<string, string[]>();
  for (const row of rows.results) {
    const table = String(row.tabela);
    if (!/^fdp_[a-z0-9_]+$/u.test(table)) continue;
    const column = String(row.coluna);
    if (!/^[a-z0-9_]+$/u.test(column)) continue;
    if (REDACTED_COLUMN.test(column)) continue;
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  }
  return [...byTable].map(([name, columns]) => ({ name, columns }));
}

/** Colunas omitidas, com o motivo — vai dentro do arquivo. */
export async function listRedactions(d1: Parameters<typeof listExportTables>[0]) {
  const rows = await d1.prepare(`SELECT c.relname AS tabela, col.column_name AS coluna
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'fdp_%'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns w
        WHERE w.table_schema = n.nspname AND w.table_name = c.relname AND w.column_name = 'workspace_id')
    ORDER BY c.relname, col.ordinal_position`)
    .bind()
    .all<{ tabela: string; coluna: string }>();

  return rows.results
    .filter((row) => REDACTED_COLUMN.test(String(row.coluna)))
    .map((row) => ({ tabela: String(row.tabela), coluna: String(row.coluna), motivo: redactionReason(String(row.coluna)) }));
}

/** Lê o arquivo em páginas para não carregar um grupo inteiro na memória. */
export const EXPORT_PAGE_SIZE = 500;
