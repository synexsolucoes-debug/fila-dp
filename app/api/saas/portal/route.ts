import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { appBaseUrl } from "@/lib/saas";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "saas.manage");
    const subscription = await d1.prepare(`SELECT id, external_customer_id FROM fdp_workspace_subscriptions
      WHERE workspace_id = ?`).bind(workspace.id).first<{ id: string; external_customer_id: string }>();
    if (!subscription?.external_customer_id) {
      return Response.json({ error: "Ainda não existe um cliente de cobrança para este workspace." }, { status: 409 });
    }
    const session = await getStripe().billingPortal.sessions.create({
      customer: subscription.external_customer_id,
      return_url: `${appBaseUrl(request)}/painel?saas=portal-return`,
    });
    if (!session.url.startsWith("https://")) throw new Error("Stripe did not return a secure portal URL.");
    await d1.batch([
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: user.email, action: "saas.portal_opened", entityType: "subscription", entityId: subscription.id }),
    ]);
    return Response.json({ url: session.url });
  } catch (error) { return apiError(error); }
}
