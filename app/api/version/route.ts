export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  }, { headers: { "Cache-Control": "no-store" } });
}
