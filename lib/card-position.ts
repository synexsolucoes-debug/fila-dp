import type { getD1 } from "../db/index.ts";

type Database = ReturnType<typeof getD1>;

/**
 * Posição de uma demanda dentro da coluna (§6 de docs/engenharia-reversa-trello.md).
 *
 * A ordem é um número em ponto flutuante, como o `pos` do Trello: soltar uma
 * demanda entre duas outras grava o meio-termo das duas, e nenhuma outra linha
 * precisa ser reescrita. O meio-termo esgota depois de umas cinquenta divisões
 * no mesmo ponto; quando a folga fica pequena demais, a coluna é renumerada
 * (`renumberList`) e a conta é refeita.
 */
export const POSITION_STEP = 1000;
const MIN_GAP = 1e-6;

/** O meio-termo entre os vizinhos, ou `null` quando não há folga entre eles. */
export function positionBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return after! / 2 > MIN_GAP ? after! / 2 : null;
  if (after === null) return before + POSITION_STEP;
  if (after - before <= MIN_GAP * 2) return null;
  return before + (after - before) / 2;
}

/** Renumera a coluna inteira em passos fixos, na ordem atual. */
async function renumberList(d1: Database, listId: string) {
  const rows = await d1.prepare("SELECT id FROM fdp_cards WHERE list_id = ? AND archived = 0 ORDER BY position, created_at")
    .bind(listId).all<{ id: string }>();
  await d1.batch(rows.results.map((row, index) => d1.prepare("UPDATE fdp_cards SET position = ? WHERE id = ?")
    .bind((index + 1) * POSITION_STEP, String(row.id))));
}

async function neighbourPositions(d1: Database, listId: string, cardId: string, beforeCardId: string, afterCardId: string) {
  const read = (id: string) => id
    ? d1.prepare("SELECT position FROM fdp_cards WHERE id = ? AND list_id = ? AND archived = 0 AND id <> ?")
      .bind(id, listId, cardId).first<{ position: number }>()
    : Promise.resolve(null);
  const [before, after] = await Promise.all([read(beforeCardId), read(afterCardId)]);
  return {
    before: before ? Number(before.position) : null,
    after: after ? Number(after.position) : null,
  };
}

/**
 * A posição para gravar a demanda entre `beforeCardId` e `afterCardId`.
 *
 * Os vizinhos são lidos do banco, nunca recebidos como número do navegador: o
 * quadro na tela pode estar desatualizado, e um número velho poria a demanda
 * num lugar que ninguém escolheu. Vizinho que não está mais na coluna é
 * ignorado; sem nenhum vizinho válido, a demanda vai para o fim.
 */
export async function resolveCardPosition(
  d1: Database,
  input: { listId: string; cardId: string; beforeCardId: string; afterCardId: string },
): Promise<number> {
  if (!input.beforeCardId && !input.afterCardId) return endOfList(d1, input.listId, input.cardId);
  let { before, after } = await neighbourPositions(d1, input.listId, input.cardId, input.beforeCardId, input.afterCardId);
  if (before === null && after === null) return endOfList(d1, input.listId, input.cardId);
  let position = positionBetween(before, after);
  if (position === null) {
    await renumberList(d1, input.listId);
    ({ before, after } = await neighbourPositions(d1, input.listId, input.cardId, input.beforeCardId, input.afterCardId));
    position = positionBetween(before, after) ?? (before ?? 0) + POSITION_STEP;
  }
  return position;
}

async function endOfList(d1: Database, listId: string, cardId: string) {
  const row = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0 AND id <> ?")
    .bind(listId, cardId).first<{ max_position: number }>();
  return Number(row?.max_position ?? 0) + POSITION_STEP;
}
