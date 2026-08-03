import { getD1 } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const workspace = await getD1().prepare("SELECT id FROM fdp_workspaces LIMIT 1").first<{ id: string }>();
    return Response.json({ setupRequired: !workspace });
  } catch {
    return Response.json({ setupRequired: false });
  }
}
