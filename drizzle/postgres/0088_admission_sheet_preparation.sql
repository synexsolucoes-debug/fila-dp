-- Preparo automático da ficha: estado, tentativas e origem da leitura.
--
-- ## O que faltava
--
-- A ficha só nascia quando alguém abria a aba e clicava em "Ler a ficha". O
-- trabalho que o agente já tinha feito — entrar no Tangerino, baixar o PDF,
-- anexar à demanda — parava ali, esperando um clique que ninguém sabia que
-- precisava dar. Quem acompanha admissão via o anexo chegar e continuava
-- transcrevendo à mão.
--
-- Agora a conclusão da transferência enfileira o preparo. Isso exige guardar um
-- estado: entre "o PDF chegou" e "a ficha está pronta" existe um intervalo, e
-- durante ele a tela precisa dizer o que está acontecendo em vez de mostrar
-- "nenhuma ficha lida" — que é falso e manda a pessoa clicar de novo.
--
-- ## Por que o envelope passa a aceitar nulo
--
-- Uma ficha `pending` existe antes de haver o que cifrar. A alternativa seria
-- gravar um envelope vazio, e aí `ready` e `pending` teriam a mesma aparência no
-- banco — a diferença ficaria só na coluna de estado, sem nada que a sustente.
-- O CHECK abaixo amarra as duas coisas: **pronta implica envelope presente**.
-- Assim o banco recusa uma ficha que se diz pronta e não tem conteúdo.
ALTER TABLE "fdp_admission_sheets" ALTER COLUMN "encrypted_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ALTER COLUMN "initialization_vector" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ALTER COLUMN "auth_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ALTER COLUMN "key_version" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "error_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint

-- Como a ficha nasceu: enfileirada pela chegada do PDF, ou pedida por uma
-- pessoa. A distinção não é estética — ela decide se uma falha vira nova
-- tentativa automática ou fica esperando quem pediu.
ALTER TABLE "fdp_admission_sheets" ADD COLUMN IF NOT EXISTS "requested_by_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" DROP CONSTRAINT IF EXISTS "fdp_admission_sheets_state_check";--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_state_check"
  CHECK ("state" IN ('pending', 'ready', 'failed'));--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" DROP CONSTRAINT IF EXISTS "fdp_admission_sheets_requested_by_kind_check";--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_requested_by_kind_check"
  CHECK ("requested_by_kind" IN ('user', 'transfer'));--> statement-breakpoint

-- Pronta implica envelope completo. É isto que impede uma ficha vazia de se
-- apresentar como lida — e o que torna o estado uma garantia, não um rótulo.
ALTER TABLE "fdp_admission_sheets" DROP CONSTRAINT IF EXISTS "fdp_admission_sheets_ready_envelope_check";--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_ready_envelope_check"
  CHECK ("state" <> 'ready' OR ("encrypted_value" IS NOT NULL AND "initialization_vector" IS NOT NULL
    AND "auth_tag" IS NOT NULL AND "key_version" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "fdp_admission_sheets" DROP CONSTRAINT IF EXISTS "fdp_admission_sheets_attempts_check";--> statement-breakpoint
ALTER TABLE "fdp_admission_sheets" ADD CONSTRAINT "fdp_admission_sheets_attempts_check"
  CHECK ("attempts" >= 0 AND "attempts" <= 20);--> statement-breakpoint

-- A fila do preparo: quem está pendente, mais antigo primeiro. Índice parcial
-- porque a varredura só olha o que não terminou — e a esmagadora maioria das
-- fichas está pronta.
CREATE INDEX IF NOT EXISTS "fdp_admission_sheets_pending_idx"
  ON "fdp_admission_sheets" USING btree ("workspace_id", "last_attempt_at" NULLS FIRST)
  WHERE "state" = 'pending';
