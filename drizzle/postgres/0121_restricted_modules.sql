-- Módulos em construção, fechados por padrão.
--
-- O ERP DP, o DP Operacional, a Carteira e Agentes/Triagem estão em
-- construção. Até aqui eles não eram módulos: o ERP DP aparecia para quem lia
-- cadastro, DP Operacional e Carteira vinham junto com Cadastros, e Agentes e
-- Triagem junto com Integrações. Por isso não havia como liberar ou bloquear
-- nenhum deles por pessoa.
--
-- Agora cada um é um módulo próprio, governado por uma permissão que só o
-- administrador do grupo tem (`erp.access`, `dp_operations.access`,
-- `portfolio.access`, `agents.access`). Para qualquer outra pessoa o módulo
-- fica fechado até o administrador liberar, nominalmente, em Usuários e
-- acessos. Nada se vincula a eles por papel ou departamento.
--
-- `route` é a chave da visão do painel (`viewCatalog[...].module`), não a URL.
SELECT pg_advisory_xact_lock(hashtext('0121_restricted_modules'));
--> statement-breakpoint
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "depends_on", "position") VALUES
  ('erp_dp', 'ERP DP', 'Em construção. Cadastro, movimentações, folha, férias e obrigações na gramática do ERP de departamento pessoal.', 'folha', 'erpDp', 'erp.access', '', 1150),
  ('dp_operations', 'DP Operacional', 'Em construção. Calendário operacional do DP por empresa e competência.', 'operacao', 'dpOperations', 'dp_operations.access', '', 410),
  ('portfolio', 'Carteira', 'Em construção. Divisão das empresas do grupo entre a equipe do DP.', 'operacao', 'portfolio', 'portfolio.access', '', 420),
  ('agents', 'Agentes e Triagem', 'Em construção. Agentes automáticos e a triagem do que eles não conseguiram classificar.', 'gestao', 'agents', 'agents.access', '', 1030)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- No plano de todos: o que fecha estes módulos é a decisão do administrador
-- sobre cada pessoa, e não o contrato.
INSERT INTO "fdp_plan_modules" ("plan_id", "module_key")
SELECT p."id", m."key" FROM "fdp_saas_plans" p
CROSS JOIN (VALUES ('erp_dp'), ('dp_operations'), ('portfolio'), ('agents')) AS m("key")
ON CONFLICT DO NOTHING;
