import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string }> };

/**
 * Exclusão definitiva de um grupo.
 *
 * Arquivar é estado; isto é eliminação. As duas coisas são diferentes e a
 * segunda é irreversível, então ela exige quatro coisas antes de acontecer:
 *
 *   1. o grupo já estar arquivado ou cancelado — não se exclui um grupo em
 *      operação por engano;
 *   2. o identificador do grupo digitado por extenso, para que o clique não
 *      possa cair no grupo errado;
 *   3. um motivo com substância, que fica no registro de exclusão;
 *   4. permissão de administrador da plataforma.
 *
 * A contagem por tabela é feita **antes** de apagar e guardada no registro. É o
 * que transforma "excluí" em algo conferível meses depois, quando o dado que
 * comprovaria já não existe — que é exatamente o objetivo da exclusão.
 */

/** Tabelas com coluna `workspace_id`, descobertas no schema em vez de listadas. */
async function tenantTables(d1: ReturnType<typeof getD1>) {
  const rows = await d1.prepare(`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'workspace_id' AND table_name LIKE 'fdp_%'
    ORDER BY table_name`).all<{ table_name: string }>();
  // Uma lista escrita à mão envelheceria em silêncio: uma tabela nova ficaria
  // fora da contagem e ninguém perceberia até precisar do número.
  return rows.results.map((row) => String(row.table_name)).filter((name) => /^fdp_[a-z0-9_]+$/u.test(name));
}

export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const workspace = await d1.prepare(`SELECT w.id, w.name, w.slug, w.status, u.email AS owner_email, p.code AS plan_code
        FROM fdp_workspaces w
        LEFT JOIN fdp_users u ON u.id = w.owner_user_id
        LEFT JOIN fdp_workspace_subscriptions s ON s.workspace_id = w.id
        LEFT JOIN fdp_saas_plans p ON p.id = s.plan_id
        WHERE w.id = ?`).bind(id)
        .first<{ id: string; name: string; slug: string; status: string; owner_email: string | null; plan_code: string | null }>();
      if (!workspace) throw ApiError.notFound("Grupo não encontrado.", "WORKSPACE_NOT_FOUND");

      // Só se exclui o que já saiu de operação. Sem esta porta, um clique
      // errado apaga um cliente ativo, e não há desfazer.
      if (workspace.status !== "archived" && workspace.status !== "canceled") {
        throw new ApiError(409, "WORKSPACE_NOT_ARCHIVED",
          `"${workspace.name}" ainda está ${workspace.status === "active" ? "ativo" : "suspenso"}. `
          + "Arquive ou cancele antes de excluir — a exclusão não tem volta.");
      }

      const confirmation = cleanText(body.confirmation, 120);
      if (confirmation !== workspace.slug) {
        throw ApiError.badRequest(
          `Para confirmar, digite exatamente o identificador do grupo: ${workspace.slug}`,
          "WORKSPACE_CONFIRMATION_MISMATCH",
        );
      }

      const reason = cleanText(body.reason, 500);
      if (reason.length < 10) {
        throw ApiError.badRequest(
          "Explique o motivo da exclusão. Ele fica no registro permanente e é a única coisa que sobra depois.",
          "WORKSPACE_DELETE_REASON_REQUIRED",
        );
      }

      // Contagem antes de apagar: depois não há o que contar.
      //
      // Precisa rodar **dentro do escopo do tenant**. Contando pela conexão de
      // plataforma, a RLS esconde as linhas das tabelas do cliente e o COUNT
      // devolve zero sem erro nenhum: o registro anotaria 4 linhas onde havia 6,
      // e um número inventado é pior que número nenhum justamente num registro
      // que existe para servir de prova.
      const scoped = getPlatformScopedD1({ workspaceId: id, userId: platform.userId });
      const tables = await tenantTables(d1);
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const row = await scoped.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE workspace_id = ?`)
          .bind(id).first<{ total: string | number }>();
        const total = Number(row?.total ?? 0);
        if (total > 0) counts[table] = total;
      }
      // A trilha não tem `workspace_id` opcional: ela conta à parte porque é
      // apagada à parte, e o número dela é o que mais interessa numa auditoria.
      const auditRow = await scoped.prepare("SELECT COUNT(*) AS total FROM fdp_audit_events WHERE workspace_id = ?")
        .bind(id).first<{ total: string | number }>();
      if (Number(auditRow?.total ?? 0) > 0) counts.fdp_audit_events = Number(auditRow?.total ?? 0);
      const totalRows = Object.values(counts).reduce((sum, value) => sum + value, 0);

      // Quem só existia por causa deste grupo fica órfão: conta sem nenhuma
      // associação, guardando nome e e-mail de alguém que não é mais cliente.
      // Isso é o dado órfão que a exclusão precisa levar junto.
      //
      // Duas exceções, e as duas têm motivo: administrador da plataforma não é
      // apagado por exclusão de cliente, e quem aparece na auditoria de
      // plataforma fica, porque apagá-lo tornaria aquela trilha ilegível.
      const orphans = await d1.prepare(`SELECT u.id, u.email FROM fdp_users u
        WHERE EXISTS (SELECT 1 FROM fdp_workspace_members m WHERE m.user_id = u.id AND m.workspace_id = ?)
          AND NOT EXISTS (SELECT 1 FROM fdp_workspace_members m2 WHERE m2.user_id = u.id AND m2.workspace_id <> ?)
          AND NOT EXISTS (SELECT 1 FROM fdp_platform_audit_events p WHERE p.actor_user_id = u.id)`)
        .bind(id, id).all<{ id: string; email: string }>();
      const orphanIds = orphans.results
        .filter((row) => String(row.email).toLowerCase() !== auth.user!.email.trim().toLowerCase())
        .map((row) => String(row.id));
      if (orphanIds.length > 0) counts.fdp_users = orphanIds.length;

      const deletionId = crypto.randomUUID();
      await d1.batch([
        // Duas chaves precisam ser abertas dentro da transação para que a trilha
        // possa ser removida: o escopo do tenant, sem o qual a RLS esconde as
        // linhas e o DELETE apagaria zero em silêncio; e a válvula de manutenção
        // que o gatilho append-only já previa para este caso. As duas são locais
        // à transação — fora dela a trilha volta a ser imutável.
        d1.prepare("SELECT set_config('app.workspace_id', ?, true), set_config('app.audit_maintenance', 'on', true)").bind(id),
        // O registro de exclusão é gravado ANTES: se a remoção falhar no meio, a
        // transação inteira volta atrás e não sobra registro de algo que não
        // aconteceu; se der certo, ele já está lá.
        d1.prepare(`INSERT INTO fdp_workspace_deletions
            (id, workspace_id, workspace_name, workspace_slug, owner_email, plan_code, status_before,
             reason, row_counts_json, deleted_by, deleted_by_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`)
          .bind(deletionId, workspace.id, workspace.name, workspace.slug, workspace.owner_email ?? "",
            workspace.plan_code ?? "", workspace.status, reason, JSON.stringify(counts),
            platform.userId ?? auth.user.email, auth.user.email),
        // A trilha do grupo é apagada explicitamente, e não por CASCADE: uma
        // exclusão de auditoria precisa estar escrita no código de quem a fez,
        // não escondida numa constraint.
        d1.prepare("DELETE FROM fdp_audit_events WHERE workspace_id = ?").bind(id),
        // O resto sai em cascata a partir daqui.
        d1.prepare("DELETE FROM fdp_workspaces WHERE id = ?").bind(id),
        // As contas órfãs saem depois do grupo: enquanto ele existir, elas ainda
        // têm associação.
        ...(orphanIds.length > 0
          ? [d1.prepare(`DELETE FROM fdp_users WHERE id IN (${orphanIds.map(() => "?").join(", ")})`).bind(...orphanIds)]
          : []),
      ]);

      return Response.json({
        deleted: {
          id: deletionId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          tables: Object.keys(counts).length,
          rows: totalRows + orphanIds.length,
          orphanUsers: orphanIds.length,
          counts,
        },
      });
    });
  } catch (error) {
    return apiError(error);
  }
}
