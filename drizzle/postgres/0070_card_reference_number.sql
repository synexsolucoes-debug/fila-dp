-- O identificador da demanda (#DM-2471).
--
-- A especificação mostra o número em todo cartão e no detalhe: é como uma pessoa
-- fala de uma demanda por telefone, cola num e-mail e procura na busca. Hoje o
-- único identificador é o `id` interno — um texto opaco que ninguém dita em voz
-- alta.
--
-- ## Por que no banco, e não na aplicação
--
-- Existem **oito** caminhos que inserem em `fdp_cards`: a rota de criação, a
-- conversão de inbox, o motor de processo, o motor de integrações, o EPI, o
-- Teams, o Tangerino e as movimentações. Numerar na aplicação significaria
-- acertar os oito e confiar que o nono, escrito daqui a três meses, também
-- lembre. Demanda sem número não daria erro: nasceria silenciosamente sem
-- identificador, e só apareceria quando alguém precisasse citá-la.
--
-- Um gatilho BEFORE INSERT fecha a porta para todos, inclusive os futuros. A
-- tabela já tem gatilho (`fdp_cards_version_bump`), então o padrão não é novo
-- aqui.
--
-- ## Por que um contador, e não MAX+1
--
-- `MAX(reference_number)+1` lido dentro da transação não serializa: duas
-- demandas criadas no mesmo instante leem o mesmo máximo e recebem o mesmo
-- número. O contador por workspace resolve porque o `UPDATE ... RETURNING`
-- toma trava de linha — e a trava é **por workspace**, então a operação de um
-- cliente nunca espera pela de outro.
--
-- ## Por que a numeração é por workspace
--
-- O número é para leitura humana dentro de um cliente. Uma sequência global
-- vazaria volume entre clientes: ver "#DM-84212" na primeira demanda do seu
-- workspace diz quanto o vizinho trabalhou. Cada cliente começa em 1.
--
-- Formato: a interface apresenta `#DM-` + o número. O prefixo é da apresentação,
-- não do dado — guardar "DM-2471" como texto impediria ordenar por número e
-- travaria qualquer mudança futura de prefixo numa migration de dados.

SELECT pg_advisory_xact_lock(hashtext('0070_card_reference_number'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_card_reference_counters" (
  "workspace_id" text PRIMARY KEY,
  "next_value" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint

-- Carrega `workspace_id`, então o ensaio de isolamento a percorre e exige RLS
-- forçada como em toda tabela de cliente. O gatilho abaixo roda com a mesma
-- sessão do INSERT, que já tem `app.workspace_id` definido — a política não o
-- atrapalha, ela o confina ao workspace certo.
ALTER TABLE "fdp_card_reference_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_reference_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_card_reference_counters_workspace_isolation" ON "fdp_card_reference_counters";
--> statement-breakpoint
CREATE POLICY "fdp_card_reference_counters_workspace_isolation" ON "fdp_card_reference_counters"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "reference_number" integer;
--> statement-breakpoint

-- Demanda antiga também precisa de número: a §48 manda preservar o que já
-- existe, e uma demanda sem identificador seria exatamente a demanda antiga
-- valendo menos que a nova. A ordem é a de criação, que é a ordem em que a
-- operação as viveu; o `id` desempata para o resultado não depender de sorte.
WITH numeradas AS (
  SELECT "id", row_number() OVER (
           PARTITION BY "workspace_id" ORDER BY "created_at", "id"
         ) AS "n"
    FROM "fdp_cards"
   WHERE "reference_number" IS NULL
)
UPDATE "fdp_cards" c
   SET "reference_number" = numeradas."n"
  FROM numeradas
 WHERE c."id" = numeradas."id" AND c."reference_number" IS NULL;
--> statement-breakpoint

-- O contador começa depois do maior número já usado, senão a primeira demanda
-- nova colidiria com uma antiga.
INSERT INTO "fdp_card_reference_counters" ("workspace_id", "next_value")
SELECT "workspace_id", COALESCE(MAX("reference_number"), 0) + 1
  FROM "fdp_cards"
 WHERE "workspace_id" IS NOT NULL
 GROUP BY "workspace_id"
ON CONFLICT ("workspace_id") DO UPDATE
  SET "next_value" = GREATEST(
        "fdp_card_reference_counters"."next_value",
        EXCLUDED."next_value");
--> statement-breakpoint

-- Dois números iguais no mesmo cliente quebram a promessa que o número faz.
-- A restrição é o que transforma uma corrida perdida em erro alto, em vez de
-- duas demandas disputando a mesma identidade em silêncio.
DROP INDEX IF EXISTS "fdp_cards_workspace_reference_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_cards_workspace_reference_unique"
  ON "fdp_cards" ("workspace_id", "reference_number");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fdp_assign_card_reference"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  atribuido integer;
BEGIN
  -- Número informado explicitamente é respeitado: a restauração de um backup
  -- reinsere linhas que já tinham identidade, e renumerá-las trocaria a
  -- demanda que a operação conhece por outra.
  IF NEW."reference_number" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."workspace_id" IS NULL OR NEW."workspace_id" = '' THEN
    RAISE EXCEPTION 'demanda sem workspace nao pode receber numero de referencia';
  END IF;

  INSERT INTO "fdp_card_reference_counters" ("workspace_id", "next_value")
       VALUES (NEW."workspace_id", 1)
  ON CONFLICT ("workspace_id") DO NOTHING;

  -- `RETURNING` do valor anterior: a linha fica travada até o fim da
  -- transação, então duas inserções simultâneas no mesmo workspace são
  -- serializadas aqui e recebem números diferentes.
  UPDATE "fdp_card_reference_counters"
     SET "next_value" = "next_value" + 1
   WHERE "workspace_id" = NEW."workspace_id"
  RETURNING "next_value" - 1 INTO atribuido;

  -- Sem linha devolvida, a política de RLS barrou o contador — sessão sem
  -- `app.workspace_id`, ou apontando para outro cliente. Gravar NULL aqui
  -- criaria a demanda sem identidade e esconderia um furo de isolamento.
  IF atribuido IS NULL THEN
    RAISE EXCEPTION 'contador de referencia inacessivel para o workspace %', NEW."workspace_id";
  END IF;

  NEW."reference_number" := atribuido;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "fdp_cards_assign_reference" ON "fdp_cards";
--> statement-breakpoint
CREATE TRIGGER "fdp_cards_assign_reference" BEFORE INSERT ON "fdp_cards"
  FOR EACH ROW EXECUTE FUNCTION "fdp_assign_card_reference"();
