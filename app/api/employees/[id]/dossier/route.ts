import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { generateEmployeeDossierPdf, type EmployeeDossier } from "@/lib/employee-dossier-pdf";

type Context = { params: Promise<{ id: string }> };

/**
 * Dossiê do colaborador, passo 1 (§4.18): EPI, ASO e treinamento juntos num
 * PDF só — os subsídios que uma defesa trabalhista pede, hoje espalhados em
 * três telas.
 *
 * Cada seção é consultada só quando quem pede tem a capacidade dela, no mesmo
 * desenho de `lib/work-items.ts` para a Central de Trabalho: uma seção sem
 * capacidade não aparece como "nenhum registro" — aparece como "sem
 * permissão", porque as duas coisas significam algo diferente para quem vai
 * usar o documento numa defesa.
 */
export async function GET(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "employees.read", "gerar o dossiê de um colaborador");

    const employee = await d1.prepare(`SELECT e.registration_number, e.full_name, e.social_name, e.admission_date,
        e.company_id, c.trade_name AS company_name, c.legal_name, p.name AS position_name
      FROM fdp_employees e
      JOIN fdp_companies c ON c.workspace_id = e.workspace_id AND c.id = e.company_id
      LEFT JOIN fdp_positions p ON p.workspace_id = e.workspace_id AND p.id = e.position_id
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id)
      .first<{ registration_number: string; full_name: string; social_name: string; admission_date: string;
        company_id: string; company_name: string; legal_name: string; position_name: string | null }>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.company_id);

    const [epiDeliveries, exams, trainings] = await Promise.all([
      hasCapability(workspace, "epi.view")
        ? d1.prepare(`SELECT d.delivered_on, d.ca_number, d.quantity, d.status, d.signature_name, p.name AS product_name
            FROM fdp_epi_deliveries d JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
            WHERE d.workspace_id = ? AND d.employee_id = ? ORDER BY d.delivered_on DESC`)
          .bind(workspace.id, id).all<{ delivered_on: string; ca_number: string; quantity: number; status: string; signature_name: string; product_name: string }>()
          .then((result) => result.results)
        : Promise.resolve(null),
      hasCapability(workspace, "exams.view")
        ? d1.prepare(`SELECT exam_date, exam_type, result, next_due_date FROM fdp_occupational_exams
            WHERE workspace_id = ? AND employee_id = ? ORDER BY exam_date DESC`)
          .bind(workspace.id, id).all<{ exam_date: string; exam_type: string; result: string; next_due_date: string | null }>()
          .then((result) => result.results)
        : Promise.resolve(null),
      hasCapability(workspace, "trainings.view")
        ? d1.prepare(`SELECT completed_on, training_name, valid_until, provider_name FROM fdp_trainings
            WHERE workspace_id = ? AND employee_id = ? ORDER BY completed_on DESC`)
          .bind(workspace.id, id).all<{ completed_on: string; training_name: string; valid_until: string | null; provider_name: string }>()
          .then((result) => result.results)
        : Promise.resolve(null),
    ]);

    const dossier: EmployeeDossier = {
      workspaceName: workspace.name,
      companyName: employee.company_name || employee.legal_name,
      employeeName: employee.social_name || employee.full_name,
      registrationNumber: employee.registration_number,
      positionName: employee.position_name || "",
      admissionDate: employee.admission_date,
      issuedAt: new Date(),
      epiDeliveries: epiDeliveries?.map((row) => ({
        deliveredOn: row.delivered_on, productName: row.product_name, caNumber: row.ca_number,
        quantity: Number(row.quantity), status: row.status, signatureName: row.signature_name,
      })) ?? null,
      exams: exams?.map((row) => ({
        examDate: row.exam_date, examType: row.exam_type, result: row.result, nextDueDate: row.next_due_date,
      })) ?? null,
      trainings: trainings?.map((row) => ({
        completedOn: row.completed_on, trainingName: row.training_name, validUntil: row.valid_until, providerName: row.provider_name,
      })) ?? null,
    };

    const bytes = await generateEmployeeDossierPdf(dossier);
    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "employee.dossier_downloaded", entityType: "employee", entityId: id,
      metadata: {
        epiIncluded: epiDeliveries !== null, examsIncluded: exams !== null, trainingsIncluded: trainings !== null,
      },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })]);

    const filename = `dossie-${employee.registration_number || id}.pdf`.replace(/[^a-zA-Z0-9._-]/g, "-");
    const bodyBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(bodyBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return apiError(error); }
}
