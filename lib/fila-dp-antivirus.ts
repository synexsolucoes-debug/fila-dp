import { validateIntegrationEndpoint } from "@/lib/integration-security";

export type AntivirusResult = { status: "clean" | "not_configured"; engine?: string };

export async function scanAttachment(contents: ArrayBuffer, filename: string, contentType: string): Promise<AntivirusResult> {
  const endpoint = process.env.FDP_ANTIVIRUS_ENDPOINT ?? "";
  if (!endpoint) {
    if (process.env.FDP_REQUIRE_ANTIVIRUS === "true") throw new Error("O antivírus obrigatório não está configurado.");
    return { status: "not_configured" };
  }
  const url = validateIntegrationEndpoint("antivirus", endpoint, endpoint, process.env.FDP_ANTIVIRUS_ALLOWED_HOSTS ?? "");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "X-Filename": encodeURIComponent(filename.slice(0, 220)),
      ...(process.env.FDP_ANTIVIRUS_TOKEN ? { Authorization: `Bearer ${process.env.FDP_ANTIVIRUS_TOKEN}` } : {}),
    },
    body: contents,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as { clean?: boolean; infected?: boolean; threat?: string; engine?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || `O antivírus respondeu com status ${response.status}.`);
  if (payload.clean !== true || payload.infected === true) throw new Error(`Arquivo bloqueado pelo antivírus${payload.threat ? `: ${payload.threat}` : "."}`);
  return { status: "clean", engine: payload.engine };
}
