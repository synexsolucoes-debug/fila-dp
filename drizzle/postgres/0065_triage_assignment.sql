-- Encaminhar uma triagem para quem sabe resolvê-la (§16).
--
-- A lista de ações da triagem inclui "encaminhar para responsável", e essa era
-- a única das sete que não tinha onde ser gravada. As outras seis já existiam:
-- confirmar, escolher colaborador, escolher empresa, escolher processo, aceitar
-- e rejeitar terminam todas nas rotas de domínio que já validam essas decisões.
--
-- A saída errada seria criar uma fila de encaminhamento ao lado — outro objeto
-- de trabalho, outra tela, outro estado para sincronizar. A certa é a menor
-- possível: duas colunas na própria proposta, dizendo para quem ela foi
-- encaminhada e quando. O item continua sendo o mesmo item, na mesma fila, com
-- o mesmo ciclo de vida; o que muda é de quem a operação espera a decisão.
--
-- A chave composta com `fdp_workspace_members` é o que impede o encaminhamento
-- para alguém de outro grupo — a mesma garantia estrutural que o restante do
-- produto já usa para responsável de demanda e aprovador de etapa.
SELECT pg_advisory_xact_lock(hashtext('0065_triage_assignment'));
--> statement-breakpoint

ALTER TABLE "fdp_agent_proposals"
  ADD COLUMN IF NOT EXISTS "assigned_to" text;
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals"
  ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals"
  ADD COLUMN IF NOT EXISTS "assignment_note" text NOT NULL DEFAULT '';
--> statement-breakpoint

ALTER TABLE "fdp_agent_proposals" DROP CONSTRAINT IF EXISTS "fdp_agent_proposals_assignee_fk";
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals"
  ADD CONSTRAINT "fdp_agent_proposals_assignee_fk"
  FOREIGN KEY ("workspace_id", "assigned_to")
  REFERENCES "fdp_workspace_members" ("workspace_id", "user_id") ON DELETE SET NULL;
--> statement-breakpoint

-- Encaminhado sem data, ou data sem destinatário, é estado que mente para quem
-- lê a fila. Ou existem os dois, ou não existe nenhum.
ALTER TABLE "fdp_agent_proposals" DROP CONSTRAINT IF EXISTS "fdp_agent_proposals_assignment_check";
--> statement-breakpoint
ALTER TABLE "fdp_agent_proposals"
  ADD CONSTRAINT "fdp_agent_proposals_assignment_check"
  CHECK (("assigned_to" IS NULL AND "assigned_at" IS NULL) OR ("assigned_to" IS NOT NULL AND "assigned_at" IS NOT NULL));
--> statement-breakpoint

-- "O que foi encaminhado para mim" precisa ser uma consulta barata: é a
-- primeira pergunta de quem abre a triagem depois de receber a notificação.
CREATE INDEX IF NOT EXISTS "fdp_agent_proposals_assignee_idx"
  ON "fdp_agent_proposals" ("workspace_id", "assigned_to", "status")
  WHERE "assigned_to" IS NOT NULL;
