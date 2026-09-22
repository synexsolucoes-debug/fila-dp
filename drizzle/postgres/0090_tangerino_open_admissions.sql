-- Admissões abertas na Sólides que ainda não existem no ERP.
--
-- ## O buraco que esta tabela fecha
--
-- Até aqui o agente só conseguia olhar para quem **já estava** no Vinculato: a
-- varredura parte de `fdp_employees`, que nasce da importação do Sankhya, e a
-- consulta procura na Sólides por um nome que já se tem em mãos.
--
-- Só que o caso real do DP é o contrário. A pessoa que está em "Dados
-- contratuais" na Sólides é justamente a que **ainda não foi cadastrada no
-- ERP** — é para cadastrá-la que a ficha é pedida. Ela nunca esteve no Sankhya,
-- logo nunca esteve em `fdp_employees`, logo a varredura não tinha por onde
-- começar e a demanda não tinha a quem se prender. O agente subia, funcionava,
-- e não achava ninguém.
--
-- ## Por que uma tabela própria, e não um colaborador provisório
--
-- Criar a pessoa em `fdp_employees` resolveria o encaixe e estragaria o
-- significado: aquela lista é o espelho do ERP, e passaria a conter gente que
-- não está lá. Toda conferência que compara Vinculato e Sankhya começaria a
-- apontar divergência onde não há.
--
-- Aqui a admissão vive como o que ela é — um processo em aberto na origem —,
-- com um cartão na fila para o DP trabalhar. Quando o cadastro no ERP acontece
-- e a importação traz a pessoa, `employee_id` pode ser preenchido e os dois
-- lados se encontram sem nada ter sido inventado no meio.
CREATE TABLE IF NOT EXISTS "fdp_tangerino_open_admissions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	-- Identificador do processo na origem. É o que torna a descoberta
	-- idempotente: rodar a varredura de novo reencontra a mesma admissão em vez
	-- de abrir uma segunda demanda para a mesma pessoa.
	"external_admission_id" text NOT NULL,
	"display_name" text NOT NULL,
	"role_title" text DEFAULT '' NOT NULL,
	"raw_status" text DEFAULT '' NOT NULL,
	"normalized_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"stage" text DEFAULT '' NOT NULL,
	"admission_date" text DEFAULT '' NOT NULL,
	-- Cartão aberto para esta admissão, quando a etapa já pede cadastro no ERP.
	"card_id" text,
	-- Preenchido só quando o cadastro no ERP acontece e a importação traz a
	-- pessoa. Até lá é nulo de propósito: ninguém inventa colaborador aqui.
	"employee_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A admissão sumiu da origem (concluída ou cancelada lá). A linha fica: ela
	-- é a evidência de por que existe um cartão na fila.
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_tangerino_open_admissions_name_check" CHECK (length("display_name") > 0),
	CONSTRAINT "fdp_tangerino_open_admissions_external_check" CHECK (length("external_admission_id") > 0)
);--> statement-breakpoint

-- Uma linha por processo da origem, dentro do grupo. É esta restrição que faz
-- a descoberta poder rodar de hora em hora sem duplicar demanda.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_open_admissions_external_uq"
  ON "fdp_tangerino_open_admissions" USING btree ("workspace_id", "integration_id", "external_admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_open_admissions_workspace_id_uq"
  ON "fdp_tangerino_open_admissions" USING btree ("workspace_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_tangerino_open_admissions_pending_idx"
  ON "fdp_tangerino_open_admissions" USING btree ("workspace_id", "closed_at", "last_seen_at");--> statement-breakpoint

ALTER TABLE "fdp_tangerino_open_admissions" ADD CONSTRAINT "fdp_tangerino_open_admissions_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fdp_tangerino_open_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_tangerino_open_admissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_tangerino_open_admissions_workspace_isolation" ON "fdp_tangerino_open_admissions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
