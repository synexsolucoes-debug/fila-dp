/**
 * Quem pode aparecer como responsável de demanda.
 *
 * O quadro "por responsável" abria uma coluna para todo admin e membro do
 * Workspace, e o seletor de responsáveis listava os mesmos nomes — inclusive
 * gente de outro departamento que nunca teve o módulo Demandas liberado. A
 * pessoa via a colega sem acesso como alvo de atribuição, e uma demanda
 * atribuída a ela ia para alguém que não consegue abrir o quadro.
 *
 * A regra é a mesma que `loadMemberModuleGrants` aplica ao montar o menu
 * (lib/fila-dp-db.ts), escrita em SQL para valer para a equipe inteira numa
 * consulta só:
 *
 *  1. Uma exceção individual do módulo `board` decide — liberado ou negado.
 *  2. Sem exceção, o proprietário e quem ainda não tem departamento principal
 *     ativo seguem o acesso legado (liberado).
 *  3. Sem exceção, quem tem departamento segue os módulos do departamento.
 *
 * `wm` é o alias de `fdp_workspace_members` e `w` o de `fdp_workspaces` na
 * consulta que usa o fragmento.
 */
export const MEMBER_HAS_BOARD_ACCESS_SQL = `COALESCE(
    (SELECT board_grant.granted FROM fdp_member_module_grants board_grant
      WHERE board_grant.workspace_id = wm.workspace_id AND board_grant.user_id = wm.user_id
        AND board_grant.module_key = 'board'),
    CASE
      WHEN w.owner_user_id = wm.user_id THEN TRUE
      WHEN NOT EXISTS (SELECT 1 FROM fdp_area_members board_am
        JOIN fdp_areas board_area ON board_area.workspace_id = board_am.workspace_id AND board_area.id = board_am.area_id
        WHERE board_am.workspace_id = wm.workspace_id AND board_am.user_id = wm.user_id
          AND board_am.is_primary = 1 AND board_area.status = 'active') THEN TRUE
      ELSE EXISTS (SELECT 1 FROM fdp_area_members board_am
        JOIN fdp_areas board_area ON board_area.workspace_id = board_am.workspace_id AND board_area.id = board_am.area_id
        JOIN fdp_area_module_assignments board_assignment ON board_assignment.workspace_id = board_am.workspace_id
          AND board_assignment.area_id = board_am.area_id AND board_assignment.module_key = 'board'
        WHERE board_am.workspace_id = wm.workspace_id AND board_am.user_id = wm.user_id
          AND board_am.is_primary = 1 AND board_area.status = 'active')
    END)`;
