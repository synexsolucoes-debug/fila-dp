import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";

/**
 * Portal do Gestor, passo 1 (§4.20): "minha equipe".
 *
 * Sem capacidade nova — é autosserviço, do mesmo jeito que "meu perfil"
 * seria: qualquer conta autenticada só enxerga o que `manager_employee_id`
 * (§0013) já aponta para o colaborador que ela representa
 * (`fdp_workspace_members.employee_id`, §4.20). Nenhum parâmetro de entrada
 * decide o recorte — é sempre "o meu".
 *
 * `linked: false` (conta sem colaborador vinculado) e `team: []` (vinculada,
 * mas sem ninguém reportando) são estados diferentes e a tela precisa
 * distingui-los: o primeiro é "fale com o administrador", o segundo é
 * "sua equipe está vazia agora".
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const self = await d1.prepare("SELECT employee_id FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(workspace.id, user.id).first<{ employee_id: string | null }>();
    const employeeId = self?.employee_id ?? null;
    if (!employeeId) return Response.json({ linked: false, team: [] });

    const team = await d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.registration_number, e.admission_date,
        c.legal_name AS company_name, COALESCE(pos.name, '') AS position_name
      FROM fdp_employees e
      JOIN fdp_companies c ON c.id = e.company_id AND c.workspace_id = e.workspace_id
      LEFT JOIN fdp_positions pos ON pos.id = e.position_id AND pos.workspace_id = e.workspace_id
      WHERE e.workspace_id = ? AND e.manager_employee_id = ? AND e.employment_status = 'active'
      ORDER BY COALESCE(NULLIF(e.social_name, ''), e.full_name)`)
      .bind(workspace.id, employeeId).all<Record<string, unknown>>();

    return Response.json({
      linked: true,
      team: team.results.map((row) => ({
        id: String(row.id),
        name: String(row.social_name || row.full_name),
        registrationNumber: String(row.registration_number),
        positionName: String(row.position_name),
        companyName: String(row.company_name),
        admissionDate: String(row.admission_date).slice(0, 10),
      })),
    });
  } catch (error) { return apiError(error); }
}
