-- RLS na tabela de acesso por empresa (§8).
--
-- `fdp_member_company_access` carrega `workspace_id` e decide quais empresas um
-- membro enxerga — é dado de cliente e é autorização. Estava sem RLS, sozinha
-- entre as 91 tabelas com `workspace_id`: as outras que ficam de fora ficam por
-- um motivo estrutural (a tabela de membros precisa ser lida entre workspaces
-- para o seletor de grupo funcionar antes de existir contexto), e esta não tem
-- nenhum.
--
-- Não havia vazamento: conferi as catorze consultas do produto contra ela e
-- todas correlacionam por `workspace_id`. Mas a proteção era só disciplina —
-- uma única consulta escrita sem o filtro atravessaria clientes em silêncio, e
-- é exatamente esse silêncio que a RLS existe para impedir.
--
-- A política segue a mesma forma das outras 87: o contexto do tenant é a única
-- chave. As rotas da plataforma que leem esta tabela já entram com o contexto
-- do workspace que estão administrando.
ALTER TABLE "fdp_member_company_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_member_company_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_member_company_access_workspace_isolation" ON "fdp_member_company_access";
--> statement-breakpoint
CREATE POLICY "fdp_member_company_access_workspace_isolation" ON "fdp_member_company_access"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
