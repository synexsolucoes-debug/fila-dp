import { getApiUser, apiError } from "@/lib/fila-dp-api";
import { getWorkspaceSnapshot } from "@/lib/fila-dp-db";

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
