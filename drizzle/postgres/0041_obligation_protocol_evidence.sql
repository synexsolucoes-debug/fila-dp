-- Protocolo e evidência da obrigação (§24).
--
-- O Vinculato controla a obrigação e não transmite a portal oficial — decisão
-- do produto, dita por escrito nos Termos. A consequência é que o protocolo
-- devolvido pelo portal é a *única* prova de que a obrigação foi cumprida:
-- sem ele, "concluída" é a palavra de alguém.
--
-- Até aqui esse número cabia em `notes`, texto livre. Funciona para uma pessoa
-- e não serve para auditoria: não havia como perguntar "quais obrigações desta
-- competência estão concluídas sem protocolo registrado?", que é exatamente a
-- pergunta que a conferência de fechamento precisa fazer.
--
-- `evidence_url` é link, não arquivo. O comprovante costuma já existir no
-- ambiente do cliente — portal, drive, gestor de documentos — e copiá-lo para
-- cá criaria uma segunda via para manter, com custo de armazenamento e de
-- retenção, sem ganho: o que falta é o ponteiro auditável, não a cópia.
ALTER TABLE "fdp_compliance_obligations" ADD COLUMN IF NOT EXISTS "protocol" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD COLUMN IF NOT EXISTS "evidence_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Só http(s). Sem isto, `javascript:` gravado aqui viraria execução no clique
-- de quem abrisse a evidência a partir da lista.
ALTER TABLE "fdp_compliance_obligations" DROP CONSTRAINT IF EXISTS "fdp_compliance_obligations_evidence_check";
--> statement-breakpoint
ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_evidence_check"
  CHECK ("evidence_url" = '' OR "evidence_url" ~* '^https?://[^\s]+$');
--> statement-breakpoint
-- A pergunta da conferência: o que está concluído sem prova. O índice parcial
-- cobre só as linhas que interessam, que são poucas por competência.
CREATE INDEX IF NOT EXISTS "fdp_obligations_completed_without_proof_idx"
  ON "fdp_compliance_obligations" ("workspace_id", "payroll_cycle_id")
  WHERE "status" = 'completed' AND "protocol" = '' AND "evidence_url" = '';
