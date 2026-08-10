-- Módulo de usuários e permissões.
--
-- Administrar quem entra no próprio grupo não é recurso pago: entra em todos os
-- planos, inclusive no Starter. O que varia por plano é o limite de assentos,
-- que já é aplicado na criação do usuário.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "position") VALUES
  ('access', 'Usuários e permissões', 'Quem acessa o grupo, com qual papel e em quais empresas.', 'gestao', 'access', 'members.directory.read', 1250)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", 'access' FROM "fdp_saas_plans" p
ON CONFLICT DO NOTHING;
