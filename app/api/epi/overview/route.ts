import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { caExpiryWindowDays } from "@/lib/epi";
import { cleanText } from "@/lib/registrations";

/**
 * Cartões do painel do módulo, numa consulta só.
 *
 * Sete contagens em sete requisições fariam a tela piscar sete vezes e
 * multiplicariam por sete a ida ao banco — que no driver HTTP é o custo real.
 * Aqui elas são subconsultas de uma instrução, com o mesmo recorte de empresa
 * aplicado a todas.
 *
 * As permissões vão na resposta porque a tela precisa saber quais ações
 * desenhar. Elas não substituem a verificação no servidor: cada rota de escrita
 * confere a sua, e esconder o botão nunca foi proteção.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "abrir o Controle de EPI");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const permissions = {
      view: true,
      create: hasCapability(workspace, "epi.create"),
      edit: hasCapability(workspace, "epi.edit"),
      remove: hasCapability(workspace, "epi.delete"),
      deliver: hasCapability(workspace, "epi.deliver"),
      receiveReturn: hasCapability(workspace, "epi.return"),
      damage: hasCapability(workspace, "epi.damage"),
      dispose: hasCapability(workspace, "epi.dispose"),
      analyzeDiscount: hasCapability(workspace, "epi.discount.analyze"),
      export: hasCapability(workspace, "epi.export"),
      audit: hasCapability(workspace, "epi.audit.view"),
    };

    if (!access.unrestricted && access.companyIds.size === 0) {
      return Response.json({
        permissions, companies: [],
        summary: {
          stock: 0, delivered: 0, pendingSignature: 0, pendingSanitizing: 0,
          awaitingDisposal: 0, discountsInAnalysis: 0, caExpiring: 0, caExpired: 0,
        },
        caWindowDays: caExpiryWindowDays,
      });
    }

    // O recorte é montado como condição **inteira**, não como um fragmento que
    // começa em `AND`. A diferença não é de estilo: `scripts/verify-inline-sql`
    // prepara cada consulta contra o schema real substituindo o trecho
    // interpolado, e um fragmento colado depois de `workspace_id = ?` não tem
    // substituição válida — a consulta sairia da cobertura sem ninguém notar.
    // Como condição completa, `true` no lugar dela é SQL legítimo e o
    // verificador confere o resto.
    const conditions = ["workspace_id = ?"]; const scopedValues: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      conditions.push(`company_id IN (${ids.map(() => "?").join(",")})`); scopedValues.push(...ids);
    }
    if (companyId) { conditions.push("company_id = ?"); scopedValues.push(companyId); }
    // A mesma cláusula vale para as sete subconsultas, e cada uma recebe a
    // mesma lista de valores, na mesma ordem.
    const scope = conditions.join(" AND ");
    const args = Array.from({ length: 7 }, () => scopedValues).flat();

    const summary = await d1.prepare(`SELECT
        (SELECT COALESCE(SUM(stock_quantity), 0) FROM fdp_epi_products
          WHERE ${scope} AND status NOT IN ('discarded', 'inactive')) AS stock,
        (SELECT COALESCE(SUM(quantity - settled_quantity), 0) FROM fdp_epi_deliveries
          WHERE ${scope} AND status <> 'canceled') AS delivered,
        (SELECT COUNT(*) FROM fdp_epi_deliveries
          WHERE ${scope} AND status = 'pending_signature') AS pending_signature,
        (SELECT COUNT(*) FROM fdp_epi_products
          WHERE ${scope} AND status = 'sanitizing') AS pending_sanitizing,
        (SELECT COUNT(*) FROM fdp_epi_disposals
          WHERE ${scope} AND status = 'awaiting_disposal') AS awaiting_disposal,
        (SELECT COUNT(*) FROM fdp_epi_discount_requests
          WHERE ${scope} AND status IN ('awaiting_dp_analysis', 'awaiting_approval')) AS discounts_in_analysis,
        (SELECT COUNT(*) FROM fdp_epi_products
          WHERE ${scope} AND ca_expires_on IS NOT NULL AND status NOT IN ('discarded', 'inactive')
            AND ca_expires_on < CURRENT_DATE) AS ca_expired`)
      .bind(...args).first<Record<string, string | number>>();

    // A janela vai como parâmetro, não interpolada: duas interpolações na mesma
    // instrução recebem a mesma substituição no verificador, e `CURRENT_DATE +
    // true` tiraria esta consulta da cobertura.
    const expiring = await d1.prepare(`SELECT COUNT(*) AS total FROM fdp_epi_products
      WHERE ${scope} AND ca_expires_on IS NOT NULL AND status NOT IN ('discarded', 'inactive')
        AND ca_expires_on >= CURRENT_DATE AND ca_expires_on <= CURRENT_DATE + ?::int`)
      .bind(...scopedValues, caExpiryWindowDays).first<{ total: string | number }>();

    const companyScope = ["c.workspace_id = ?"]; const companyValues: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      companyScope.push(`c.id IN (${ids.map(() => "?").join(",")})`); companyValues.push(...ids);
    }
    const companies = await d1.prepare(`SELECT c.id, c.legal_name, c.trade_name, c.tax_id, c.status
      FROM fdp_companies c
      WHERE ${companyScope.join(" AND ")}
      ORDER BY c.status, COALESCE(NULLIF(c.trade_name, ''), c.legal_name)`)
      .bind(...companyValues).all<Record<string, unknown>>();

    return Response.json({
      permissions,
      companies: companies.results,
      caWindowDays: caExpiryWindowDays,
      summary: {
        stock: Number(summary?.stock ?? 0),
        delivered: Number(summary?.delivered ?? 0),
        pendingSignature: Number(summary?.pending_signature ?? 0),
        pendingSanitizing: Number(summary?.pending_sanitizing ?? 0),
        awaitingDisposal: Number(summary?.awaiting_disposal ?? 0),
        discountsInAnalysis: Number(summary?.discounts_in_analysis ?? 0),
        caExpired: Number(summary?.ca_expired ?? 0),
        caExpiring: Number(expiring?.total ?? 0),
      },
    });
  } catch (error) { return apiError(error); }
}
