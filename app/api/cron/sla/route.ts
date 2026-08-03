import { runSlaSweep } from "@/lib/fila-dp-sla-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Não autorizado." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await runSlaSweep();
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[fila-dp][cron] sla", { error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "Falha ao processar SLAs." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

