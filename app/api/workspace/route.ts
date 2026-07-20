import { getApiUser, apiError } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;

  try {
    const body = await request.json() as { name?: string };
    const name = body.name?.trim();
    if (!name || name.length < 2 || name.length > 60) {
      return Response.json({ error: "Informe um nome entre 2 e 60 caracteres." }, { status: 400 });
    }

    const { d1, workspace } = await getWorkspaceContext(auth.user);
    await d1.prepare("UPDATE fdp_workspaces SET name = ? WHERE id = ?")
      .bind(name, workspace.id)
      .run();

    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

