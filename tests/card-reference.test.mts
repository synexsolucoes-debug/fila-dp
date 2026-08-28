import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O identificador da demanda (#DM-2471).
 *
 * Estes testes protegem as três decisões que fazem o número valer alguma coisa:
 * ele é atribuído no banco (e não em cada rota), é único por cliente, e começa
 * em 1 para cada cliente. Se qualquer uma cair, o número continua aparecendo na
 * tela — e passa a mentir.
 */

const migration = await readFile(
  new URL("../drizzle/postgres/0070_card_reference_number.sql", import.meta.url), "utf8");

test("o número é atribuído por gatilho, não por cada rota que insere demanda", async () => {
  /* Existem oito caminhos que inserem em `fdp_cards`. Numerar na aplicação
     exigiria acertar os oito e confiar que o nono também lembre — e demanda sem
     número não daria erro, nasceria muda. O gatilho fecha a porta para todos,
     inclusive os que ainda não foram escritos. */
  assert.match(migration, /CREATE TRIGGER "fdp_cards_assign_reference" BEFORE INSERT ON "fdp_cards"/u);
  assert.match(migration, /EXECUTE FUNCTION "fdp_assign_card_reference"\(\)/u);
});

test("duas demandas simultâneas no mesmo cliente não disputam o mesmo número", async () => {
  /* `MAX+1` lido na transação não serializa: duas inserções no mesmo instante
     leem o mesmo máximo. O `UPDATE ... RETURNING` no contador toma trava de
     linha, e a trava é por workspace — a operação de um cliente nunca espera
     pela de outro. */
  assert.match(migration, /UPDATE "fdp_card_reference_counters"/u);
  assert.match(migration, /SET "next_value" = "next_value" \+ 1/u);
  assert.match(migration, /RETURNING "next_value" - 1 INTO atribuido/u);
  assert.ok(!/COALESCE\(MAX\("reference_number"\), 0\) \+ 1[\s\S]{0,200}NEW\./u.test(migration),
    "atribuir com MAX+1 dentro do gatilho traria de volta a corrida que o contador existe para evitar");
});

test("número repetido no mesmo cliente é erro alto, não duas demandas com a mesma identidade", async () => {
  assert.match(migration, /CREATE UNIQUE INDEX "fdp_cards_workspace_reference_unique"\s*\n?\s*ON "fdp_cards" \("workspace_id", "reference_number"\)/u);
});

test("a numeração é por cliente, e não global", async () => {
  /* Sequência global vazaria volume entre clientes: ver "#DM-84212" na primeira
     demanda do seu workspace diz quanto o vizinho trabalhou. */
  assert.match(migration, /PARTITION BY "workspace_id"/u,
    "o backfill precisa numerar dentro de cada cliente");
  assert.match(migration, /"workspace_id" text PRIMARY KEY/u,
    "o contador é por cliente, então workspace_id é a chave");
});

test("o contador carrega workspace_id, então tem RLS forçada como toda tabela de cliente", async () => {
  /* O ensaio de isolamento percorre TODA tabela com `workspace_id` e reprova as
     que não têm RLS forçada. Sem isto, `verify:isolation` quebra na CI — e,
     pior, um cliente poderia mexer no contador do outro. */
  assert.match(migration, /ALTER TABLE "fdp_card_reference_counters" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_card_reference_counters" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration,
    /CREATE POLICY "fdp_card_reference_counters_workspace_isolation"[\s\S]*?USING \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
});

test("contador inalcançável falha alto, em vez de gravar demanda sem identidade", async () => {
  /* Se a RLS barrou o contador — sessão sem `app.workspace_id`, ou apontando
     para outro cliente —, o UPDATE não devolve linha. Gravar NULL ali criaria a
     demanda sem número e esconderia um furo de isolamento atrás de um campo
     vazio na tela. */
  assert.match(migration, /IF atribuido IS NULL THEN\s*\n\s*RAISE EXCEPTION/u);
  assert.match(migration, /RAISE EXCEPTION 'demanda sem workspace nao pode receber numero de referencia'/u);
});

test("demanda restaurada de backup mantém o número que a operação conhece", async () => {
  /* A restauração reinsere linhas que já tinham identidade. Renumerá-las
     trocaria a demanda que as pessoas citam por outra — e o ensaio de
     restauração compara contagens, não identidades, então isso passaria batido. */
  assert.match(migration, /IF NEW\."reference_number" IS NOT NULL THEN\s*\n\s*RETURN NEW;/u);
});

test("demanda anterior à migration também recebe número (§48)", async () => {
  /* Preservar o que já existe é regra do briefing. Demanda antiga sem
     identificador seria a demanda antiga valendo menos que a nova. */
  assert.match(migration, /row_number\(\) OVER \(\s*\n?\s*PARTITION BY "workspace_id" ORDER BY "created_at", "id"/u);
  assert.match(migration, /INSERT INTO "fdp_card_reference_counters"[\s\S]*?COALESCE\(MAX\("reference_number"\), 0\) \+ 1/u,
    "o contador precisa começar depois do maior número já usado, senão a primeira demanda nova colide com uma antiga");
});

test("o prefixo DM- vive na apresentação, não no banco", async () => {
  /* Guardar "DM-2471" como texto impediria ordenar por número e transformaria
     qualquer mudança de prefixo numa migration de dados. */
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "reference_number" integer/u);
  const tela = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(tela, /return card\.referenceNumber == null \? "" : `#DM-\$\{card\.referenceNumber\}`/u);
});

test("demanda sem número não vira #DM-0 na tela", async () => {
  /* Banco anterior à 0070 devolve null. Exibir "#DM-0" seria inventar uma
     demanda que ninguém encontra. */
  const tela = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(tela, /referenceLabel\(card\) && <span className="dashboard-card-reference">/u,
    "o cartão só mostra o número quando ele existe");
  const tipos = await readFile(new URL("../lib/fila-dp-types.ts", import.meta.url), "utf8");
  assert.match(tipos, /referenceNumber: number \| null;/u,
    "o tipo precisa admitir a ausência, senão a tela confia num número que pode não existir");
});
