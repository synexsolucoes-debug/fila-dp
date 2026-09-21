-- Saúde do worker, origem de cada campo, conclusão no ERP e retenção da ficha.
--
-- ## 1. Saúde do worker é diferente de "habilitado"
--
-- O painel dizia se o agente estava configurado. Não dizia se o processo do
-- Windows está de pé, quando ele falou pela última vez, nem se está parado
-- esperando alguém resolver um CAPTCHA. São perguntas diferentes, e a primeira
-- não responde nenhuma das outras: um agente "habilitado" com o computador
-- desligado não vai consultar nada, e a tela não tinha como dizer isso.
--
-- O batimento é gravado pelo próprio worker. `pending_*` vem da contagem que
-- ele enxerga na fila, e é o que separa "o worker está bem, mas não tem o que
-- fazer" de "o worker está bem e a fila não chega" — sintomas de causas
-- opostas: o primeiro é normal, o segundo é falha do agendamento do backend.
CREATE TABLE IF NOT EXISTS "fdp_tangerino_worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	-- Identificador estável do processo, escolhido pelo worker. Não é o nome da
	-- máquina: hostname de estação costuma carregar nome de pessoa.
	"worker_id" text NOT NULL,
	"worker_version" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_consultation_at" timestamp with time zone,
	"pending_consultations" integer DEFAULT 0 NOT NULL,
	"pending_attachments" integer DEFAULT 0 NOT NULL,
	-- O worker parou e precisa de gente: CAPTCHA, MFA ou senha recusada.
	"needs_authentication" integer DEFAULT 0 NOT NULL,
	"last_error_code" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_tangerino_worker_heartbeats_pending_check"
	  CHECK ("pending_consultations" >= 0 AND "pending_attachments" >= 0),
	CONSTRAINT "fdp_tangerino_worker_heartbeats_needs_auth_check"
	  CHECK ("needs_authentication" IN (0, 1))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_worker_heartbeats_worker_uq"
  ON "fdp_tangerino_worker_heartbeats" USING btree ("workspace_id", "worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_worker_heartbeats_workspace_id_uq"
  ON "fdp_tangerino_worker_heartbeats" USING btree ("workspace_id", "id");--> statement-breakpoint
ALTER TABLE "fdp_tangerino_worker_heartbeats" ADD CONSTRAINT "fdp_tangerino_worker_heartbeats_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_tangerino_worker_heartbeats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_tangerino_worker_heartbeats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_tangerino_worker_heartbeats_workspace_isolation" ON "fdp_tangerino_worker_heartbeats"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint

-- ## 2. O que a pessoa completou à mão, e de onde veio cada campo
--
-- Dois envelopes na mesma linha, e não um só. O primeiro guarda o que o
-- documento disse; o segundo, o que uma pessoa corrigiu ou preencheu. Separá-los
-- é o que permite reler o PDF sem apagar a correção — e mostrar as duas coisas
-- lado a lado quando divergirem.
--
-- Juntar tudo num envelope só faria a releitura escolher entre perder a
-- correção ou ignorar o documento novo, sem terceira opção.
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "overrides_encrypted_value" text;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "overrides_initialization_vector" text;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "overrides_auth_tag" text;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "overrides_key_version" integer;--> statement-breakpoint

-- Metadado por campo: origem, quem mexeu e quando. NENHUM valor entra aqui —
-- é o que permite a coluna ficar aberta ao lado dos envelopes cifrados, e o que
-- torna a auditoria possível sem recriar o dado em texto claro.
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "field_meta_json" text DEFAULT '{}' NOT NULL;--> statement-breakpoint

-- ## 3. A demanda termina quando o DP confirma o cadastro
--
-- Baixar o documento, extrair os campos e copiar para a área de transferência
-- não provam cadastro nenhum. Quem sabe que o colaborador entrou no Sankhya é
-- quem o cadastrou — e o que registra isso é a matrícula que o ERP devolveu.
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "erp_registration" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "confirmed_by" text DEFAULT '' NOT NULL;--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" DROP CONSTRAINT IF EXISTS "fdp_admission_sheets_confirmation_check";--> statement-breakpoint
-- Confirmado implica matrícula e responsável. Uma confirmação sem os dois é uma
-- afirmação que ninguém consegue conferir depois.
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_confirmation_check"
  CHECK ("confirmed_at" IS NULL OR (length("erp_registration") > 0 AND length("confirmed_by") > 0));--> statement-breakpoint

-- ## 4. Retenção explícita, em vez de expurgo no ato
--
-- A versão anterior apagava a ficha no instante em que a demanda era concluída.
-- Parecia cuidadoso e era cedo demais: erro de digitação no ERP aparece no dia
-- seguinte, e a conferência posterior ficava sem o material que a sustentaria —
-- restava reabrir sessão de navegador e baixar tudo de novo.
--
-- Agora a conclusão marca uma data, e o expurgo acontece quando ela chega. A
-- janela é configurável por grupo; o padrão de 30 dias cobre a conferência sem
-- virar retenção indefinida. Nenhum dado existente é apagado por esta migration:
-- fichas já gravadas ficam sem data e continuam como estão até alguém decidir.
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "retention_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_admission_sheets_retention_idx"
  ON "fdp_admission_sheets" USING btree ("workspace_id", "retention_until")
  WHERE "retention_until" IS NOT NULL;
