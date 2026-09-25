-- Portal do Gestor, passo 1 (§4.20): vincular a conta ao colaborador que ela é.
--
-- `fdp_employees.manager_employee_id` já existe desde a fundação dos
-- cadastros (0013) e já é usado como guarda de exclusão
-- (app/api/employees/[id]/route.ts) — mas nunca foi lido para responder "quem
-- essa pessoa gerencia". A pergunta que falta responder antes disso é outra:
-- uma conta de plataforma (fdp_users/fdp_workspace_members) e um colaborador
-- (fdp_employees) são dois cadastros hoje sem nenhuma ligação entre si — o
-- gestor loga com uma conta, mas o "quem ele gerencia" mora no cadastro do
-- colaborador que ele *é*.
--
-- `employee_id` fecha exatamente essa lacuna, e só essa: aponta para o
-- colaborador que a conta representa. Não infere por e-mail — o e-mail do
-- colaborador é opcional e não único (drizzle 0013), então um e-mail em
-- branco casaria com qualquer conta sem vínculo, um risco que uma coluna
-- explícita, preenchida por quem administra o grupo, não tem. Uma conta por
-- colaborador (índice único), e nula até alguém vincular — a maioria das
-- contas continua sem corresponder a nenhum colaborador (donos, DP, TI).
SELECT pg_advisory_xact_lock(hashtext('0104_manager_portal_link'));
--> statement-breakpoint

ALTER TABLE "fdp_workspace_members" ADD COLUMN "employee_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_members" ADD CONSTRAINT "fdp_workspace_members_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_members_workspace_employee_uq"
  ON "fdp_workspace_members" ("workspace_id", "employee_id") WHERE "employee_id" IS NOT NULL;
