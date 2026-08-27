import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireProcessCompanyAccess } from "@/lib/process-access";
import { loadPublishedVersion } from "@/lib/process-instances";
import { durationLabel, summarizeSteps, type ProcessUsage } from "@/lib/process-usage";
import {
  summarizeAutomations, summarizeDocuments, summarizeRules, type StepAutomationRow,
} from "@/lib/process-sheet";
import { stepLabel } from "@/lib/bpmn-graph";

/**
 * A ficha do processo, com as seis abas da §31 (§39, §40, §43, §55).
 *
 * Responde o que quem opera precisa: **como é** o processo em texto, **quem
 * responde** por cada etapa, **o que ele exige**, **o que ele dispara sozinho**
 * e **o que ele produziu**. O diagrama continua disponível para quem modela;
 * esta rota existe porque exigir a leitura de um BPMN para saber quem trata a
 * etapa seguinte é transferir ao operador um trabalho que o produto deveria
 * fazer.
 *
 * As três abas novas — documentos, regras, automações — leem a configuração que
 * já estava gravada por etapa. Nenhuma tabela nova: o que faltava era onde ler,
 * não o que gravar.
 *
 * As outras duas abas da §31 — descrição e histórico de versões — continuam
 * vindo do catálogo, que já as carrega: pedi-las de novo aqui criaria uma
 * segunda fonte para o mesmo cadastro.
 *
 * O escopo por empresa é o mesmo do resto do módulo de processos: um processo
 * restrito a empresas fora do alcance da pessoa simplesmente não abre.
 */

type RouteContext = { params: Promise<{ id: string }> };

const text = (value: unknown) => (value == null ? "" : String(value));
const flag = (value: unknown) => Number(value) === 1;
const stringList = (value: unknown): string[] => {
  const raw = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.map(text).filter(Boolean) : [];
};

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return []; }
}

export async function GET(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.read", "consultar a ficha do processo");

    const definition = await d1.prepare(`SELECT d.id, d.name, d.code, d.category, d.status, d.lifecycle_status,
          d.is_corporate, d.allow_manual_start, d.allow_automatic_start, d.current_version_id,
          d.global_sla_value, d.global_sla_unit, d.default_priority, d.criticality
        FROM fdp_process_definitions d WHERE d.workspace_id = ? AND d.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!definition) throw ApiError.notFound("Processo não encontrado.", "PROCESS_NOT_FOUND");
    await requireProcessCompanyAccess(d1, workspace.id, user.id, workspace.role, id, Number(definition.is_corporate) === 1);

    const versionId = text(definition.current_version_id);
    if (!versionId) {
      // Processo sem versão publicada não tem ficha operacional — e dizer isso é
      // melhor do que devolver uma ficha vazia que parece defeito.
      return Response.json({
        process: { id, name: text(definition.name), code: text(definition.code) },
        published: false,
        detail: "Este processo ainda não tem versão publicada. Publique uma versão para que ele possa gerar demandas.",
        steps: [], usage: null, documents: [], rules: [], automations: [],
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const version = await loadPublishedVersion(d1, workspace.id, versionId);

    const [members, areas, totals, retention, automationRows] = await Promise.all([
      d1.prepare(`SELECT m.user_id, u.name FROM fdp_workspace_members m
          JOIN fdp_users u ON u.id = m.user_id WHERE m.workspace_id = ?`)
        .bind(workspace.id).all<{ user_id: string; name: string }>(),
      d1.prepare("SELECT id, name FROM fdp_areas WHERE workspace_id = ?")
        .bind(workspace.id).all<{ id: string; name: string }>(),
      /* As cinco contas que a §40 pede, e nenhuma a mais: "não criar BI
         complexo" é instrução operacional, não estética — um painel com quinze
         gráficos é um painel que ninguém lê antes de decidir. */
      d1.prepare(`SELECT
          count(*) FILTER (WHERE c.closed_at IS NULL)::int AS open,
          count(*) FILTER (WHERE c.closed_at IS NOT NULL)::int AS completed,
          count(*) FILTER (WHERE c.closed_at IS NULL AND c.due_at IS NOT NULL AND c.due_at < now())::int AS overdue,
          avg(EXTRACT(EPOCH FROM (c.closed_at - c.created_at)) / 3600)
            FILTER (WHERE c.closed_at IS NOT NULL) AS average_hours
        FROM fdp_cards c
        WHERE c.workspace_id = ? AND c.process_definition_id = ? AND c.archived = 0`)
        .bind(workspace.id, id).first<Record<string, unknown>>(),
      /* Onde as demandas estão paradas. É a pergunta que decide se o gargalo é
         de gente, de regra ou de desenho — e ela não se responde com o total. */
      d1.prepare(`SELECT c.current_step_id AS step_id,
          count(*)::int AS open,
          avg(EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600) AS average_age_hours
        FROM fdp_cards c
        WHERE c.workspace_id = ? AND c.process_definition_id = ? AND c.archived = 0
          AND c.closed_at IS NULL AND COALESCE(c.current_step_id, '') <> ''
        GROUP BY c.current_step_id ORDER BY 2 DESC LIMIT 5`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      /* As colunas de etapa que o motor não carrega, porque não decide com elas:
         a demanda que a etapa abre (§27) e o documento opcional (§26). Ler daqui
         evita engordar `ProcessStepConfig` com campo que a execução não usa. */
      d1.prepare(`SELECT bpmn_element_id, create_demand, demand_type, demand_priority,
            demand_sla_value, demand_sla_unit, requester_department_id, responsible_department_id,
            optional_documents_json
          FROM fdp_process_step_configs WHERE workspace_id = ? AND process_version_id = ?`)
        .bind(workspace.id, versionId).all<Record<string, unknown>>(),
    ]);

    const names = {
      users: new Map(members.results.map((row) => [row.user_id, row.name])),
      areas: new Map(areas.results.map((row) => [row.id, row.name])),
    };
    const steps = summarizeSteps(version, names);

    const automation = new Map<string, StepAutomationRow>(automationRows.results.map((row) => [
      text(row.bpmn_element_id),
      {
        bpmnElementId: text(row.bpmn_element_id),
        createDemand: flag(row.create_demand),
        demandType: text(row.demand_type),
        demandPriority: text(row.demand_priority) || "normal",
        demandSlaValue: Number(row.demand_sla_value ?? 0),
        demandSlaUnit: text(row.demand_sla_unit) || "hours",
        requesterDepartmentId: text(row.requester_department_id),
        responsibleDepartmentId: text(row.responsible_department_id),
        optionalDocuments: stringList(row.optional_documents_json),
      },
    ]));

    const averageHours = totals?.average_hours == null ? null : Number(totals.average_hours);
    const usage: ProcessUsage = {
      open: Number(totals?.open ?? 0),
      completed: Number(totals?.completed ?? 0),
      overdue: Number(totals?.overdue ?? 0),
      averageHours,
      retention: retention.results.map((row) => ({
        stepId: text(row.step_id),
        label: version.steps.get(text(row.step_id))?.name || stepLabel(version.graph, text(row.step_id)),
        open: Number(row.open ?? 0),
        averageAgeHours: Number(row.average_age_hours ?? 0),
      })),
    };

    return Response.json({
      process: {
        id,
        name: text(definition.name),
        code: text(definition.code),
        category: text(definition.category),
        lifecycleStatus: text(definition.lifecycle_status),
        isCorporate: Number(definition.is_corporate) === 1,
        allowManualStart: Number(definition.allow_manual_start) === 1,
        allowAutomaticStart: Number(definition.allow_automatic_start) === 1,
      },
      published: true,
      version: {
        id: version.versionId,
        number: version.versionNumber,
        name: version.definitionName,
      },
      steps,
      /* As três abas da §31 que não existiam: elas leem a configuração já
         gravada por etapa, sem avaliar nada — quem autoriza avanço continua
         sendo `process-instances`, chamado do zero a cada pedido. */
      documents: summarizeDocuments(version, automation),
      rules: summarizeRules(version, names),
      automations: summarizeAutomations(version, automation, names),
      usage,
      usageLabels: {
        averageDuration: durationLabel(averageHours),
        retention: usage.retention.map((item) => durationLabel(item.averageAgeHours)),
      },
      permissions: {
        /* Iniciar processo é escrever demanda, não ler processo: quem só
           consulta o desenho não abre trabalho para a operação (§41). */
        start: hasCapability(workspace, "cards.write") && Number(definition.allow_manual_start) === 1,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
