/**
 * Consultas de demandas do snapshot do painel (`getWorkspaceSnapshot`).
 *
 * Moram aqui, fora de `lib/fila-dp-db.ts`, para que o ensaio de volume
 * (`scripts/measure-work-center.mjs`) meça exatamente o SQL que o produto
 * executa — importado, não copiado — sem precisar carregar a sessão e o banco.
 */

/**
 * Arquivadas no snapshot: só as mais recentes.
 *
 * O arquivo cresce para sempre e o painel recarrega o snapshot sempre que
 * alguém do grupo mexe em algo. A gaveta de arquivadas mostra as mais recentes
 * e diz quantas existem; as demais são encontradas pela busca, que já inclui
 * arquivadas. Sem este teto, o custo de cada recarga crescia com o histórico.
 */
export const SNAPSHOT_ARCHIVE_LIMIT = 100;

/** Demandas ativas do quadro. Parâmetros: board_id. */
export const SNAPSHOT_ACTIVE_CARDS_SQL =
  "SELECT * FROM fdp_cards WHERE board_id = ? AND archived = 0 ORDER BY list_id, position, created_at";

/**
 * Arquivadas mais recentes, já recortadas pelas empresas que a pessoa enxerga.
 * Parâmetros: board_id, acesso irrestrito (boolean), ids de empresa (text[]), limite.
 */
export const SNAPSHOT_RECENT_ARCHIVED_SQL = `SELECT * FROM fdp_cards
      WHERE board_id = ? AND archived = 1 AND (?::boolean OR company_id = ANY(?::text[]))
      ORDER BY archived_at DESC NULLS LAST, updated_at DESC
      LIMIT ?`;

/** Total de arquivadas no mesmo recorte. Parâmetros: board_id, irrestrito, ids de empresa. */
export const SNAPSHOT_ARCHIVED_TOTAL_SQL = `SELECT count(*)::int AS total FROM fdp_cards
      WHERE board_id = ? AND archived = 1 AND (?::boolean OR company_id = ANY(?::text[]))`;
