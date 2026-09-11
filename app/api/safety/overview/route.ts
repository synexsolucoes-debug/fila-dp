import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/clean-text";
import { dateFromDatabase } from "@/lib/registrations";

/**
 * O que a tela precisa saber antes de desenhar qualquer gráfico.
 *
 * Empresas que a pessoa enxerga, permissões e os anos que existem na base. Os
 * anos vêm daqui, e não do conjunto já filtrado: os botões de período precisam
 * oferecer a saída do recorte atual, e um seletor montado a partir do que o
 * recorte deixou passar só ofereceria o ano em que a pessoa já está.
 *
 * As permissões vão na resposta porque a tela precisa saber quais ações
 * desenhar. Elas não substituem a verificação no servidor: cada rota de escrita
 * confere a sua, e esconder o botão nunca foi proteção.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.view", "abrir o dashboard de acidentes de trabalho");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const permissions = {
      view: true,
      manage: hasCapability(workspace, "safety.manage"),
      remove: hasCapability(workspace, "safety.delete"),
      export: hasCapability(workspace, "safety.export"),
    };

    /* O recorte é montado como condição **inteira**, e não como fragmento que
       começa em `AND`: `scripts/verify-inline-sql` prepara cada consulta contra
       o schema real substituindo o trecho interpolado, e um fragmento colado
       depois de `workspace_id = ?` não teria substituição válida. */
    const conditions = ["workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("company_id = ?"); values.push(companyId); }
    const scope = conditions.join(" AND ");

    const years = await d1.prepare(`SELECT DISTINCT EXTRACT(YEAR FROM occurred_on)::int AS year
      FROM fdp_work_accidents WHERE ${scope} ORDER BY year DESC`)
      .bind(...values).all<{ year: number }>();

    const totals = await d1.prepare(`SELECT COUNT(*)::int AS accidents,
        COALESCE(MAX(occurred_on), NULL) AS last_occurrence
      FROM fdp_work_accidents WHERE ${scope}`)
      .bind(...values).first<{ accidents: number; last_occurrence: string | null }>();

    const companyScope = ["c.workspace_id = ?"]; const companyValues: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { companyScope.push(`c.id IN (${ids.map(() => "?").join(",")})`); companyValues.push(...ids); }
      else companyScope.push("false");
    }
    const companies = await d1.prepare(`SELECT c.id, c.legal_name, c.trade_name, c.tax_id, c.status
      FROM fdp_companies c
      WHERE ${companyScope.join(" AND ")}
      ORDER BY c.status, COALESCE(NULLIF(c.trade_name, ''), c.legal_name)`)
      .bind(...companyValues).all<Record<string, unknown>>();

    return Response.json({
      permissions,
      companies: companies.results,
      years: years.results.map((row) => Number(row.year)).filter(Boolean),
      summary: {
        accidents: Number(totals?.accidents ?? 0),
        lastOccurrence: dateFromDatabase(totals?.last_occurrence, "Última ocorrência") ?? "",
      },
    });
  } catch (error) { return apiError(error); }
}
