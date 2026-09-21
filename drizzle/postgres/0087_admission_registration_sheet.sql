-- Ficha de contratação: os campos do Registro de Empregado, cifrados.
--
-- ## Por que esta tabela existe, contra a regra que o produto tinha
--
-- Até aqui o Vinculato NUNCA guardou valor de documento. `protectCpf` grava
-- HMAC e os últimos quatro dígitos; os conectores da Sólides leem o bloco
-- documental e descartam o valor, guardando só quais campos vieram. A regra
-- está escrita no código e na documentação, e foi deliberada.
--
-- A ficha de contratação inverte isso, e a inversão precisa ser declarada em
-- vez de disfarçada. O trabalho que ela elimina é a transcrição manual do
-- Registro de Empregado para o ERP — e não há como oferecer "copiar o CPF" sem
-- ter o CPF. O que dá para fazer é cercar:
--
--   * o valor é cifrado em AES-256-GCM com o cofre que já existe, e não em
--     coluna aberta;
--   * a leitura exige capability própria (`admission.sheet.read`), que não vem
--     junto de `attachments.read` — ver o arquivo e ler o documento
--     transcrito não são o mesmo risco;
--   * a auditoria registra o ACESSO, nunca o conteúdo. Auditar o conteúdo
--     recriaria em texto aberto, no histórico, exatamente o que a cifra existe
--     para proteger;
--   * a linha é APAGADA quando a demanda é concluída. O dado existe durante a
--     transcrição e some depois. Uma coluna `purged_at` deixaria o valor no
--     banco com um carimbo dizendo que não deveria estar lá; apagar não deixa.
--
-- ## A chave estrangeira para o anexo não é enfeite
--
-- A ficha é derivada de um arquivo. Se o arquivo é removido da demanda, a
-- transcrição dele não pode sobreviver — seria uma cópia do documento que
-- alguém acreditou ter apagado. `ON DELETE CASCADE` garante isso no banco, e
-- não na aplicação, porque a tela não é o único caminho de exclusão.
--
-- O índice único abaixo existe para tornar essa FK possível: `fdp_card_attachments`
-- tinha índice comum em (workspace_id, card_id), mas nenhum único em
-- (workspace_id, id), que é o alvo que a chave composta exige.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_card_attachments_workspace_id_uq"
  ON "fdp_card_attachments" USING btree ("workspace_id", "id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_admission_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"card_id" text NOT NULL,
	-- O anexo de onde a ficha foi lida. Guardar a origem é o que permite
	-- reprocessar quando o layout mudar, sem abrir sessão de navegador de novo.
	"attachment_id" text NOT NULL,
	"source_filename" text DEFAULT '' NOT NULL,
	-- Envelope AES-256-GCM. Mesmo formato do cofre de credenciais.
	"encrypted_value" text NOT NULL,
	"initialization_vector" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	-- Contagens e avisos são metadado de qualidade da leitura: quantos campos o
	-- documento trazia, quantos passaram na conferência, e o nome dos rótulos
	-- que falharam. NENHUM valor de documento entra aqui — é o que permite
	-- mostrar "37 de 44 prontos" sem abrir o envelope.
	"filled_count" integer DEFAULT 0 NOT NULL,
	"readable_count" integer DEFAULT 0 NOT NULL,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_admission_sheets_counts_check" CHECK ("readable_count" <= "filled_count"),
	CONSTRAINT "fdp_admission_sheets_key_version_check" CHECK ("key_version" > 0)
);
--> statement-breakpoint

-- Uma ficha por demanda. Reprocessar substitui, nunca acumula: duas
-- transcrições da mesma pessoa seriam duas respostas para a mesma pergunta, e
-- a tela teria de escolher uma sem critério.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_admission_sheets_card_uq"
  ON "fdp_admission_sheets" USING btree ("workspace_id", "card_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_admission_sheets_workspace_id_uq"
  ON "fdp_admission_sheets" USING btree ("workspace_id", "id");--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_card_fk"
  FOREIGN KEY ("workspace_id","card_id") REFERENCES "public"."fdp_cards"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_attachment_fk"
  FOREIGN KEY ("workspace_id","attachment_id") REFERENCES "public"."fdp_card_attachments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_admission_sheets_workspace_isolation" ON "fdp_admission_sheets"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
