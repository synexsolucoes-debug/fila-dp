import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const subject = text(body.subject, 180);
    const senderName = text(body.senderName, 120);
    if (!subject || !senderName) return Response.json({ error: "Informe solicitante e assunto." }, { status: 400 });
    const channel = ["manual", "email", "whatsapp", "teams"].includes(String(body.channel)) ? String(body.channel) : "manual";
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    await d1.prepare("INSERT INTO fdp_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')")
      .bind(crypto.randomUUID(), workspace.id, channel, senderName, subject, text(body.body))
      .run();
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
