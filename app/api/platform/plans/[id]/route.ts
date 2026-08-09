import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

type Body = Record<string, unknown>;

function integer(value: unknown, min: number, max: number, name: string) {
  const result = Math.trunc(Number(value));
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} fora do intervalo permitido.`);
  return result;
}

function priceId(value: unknown) {
  const result = typeof value === "string" ? value.trim() : "";
  if (result && !/^price_[A-Za-z0-9]+$/u.test(result)) throw new Error("Identificador de preço Stripe inválido.");
  return result;
}

function features(value: unknown) {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Lista de recursos inválida.");
  const result = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z][a-z0-9_]{1,49}$/u.test(item)))];
  if (result.length !== value.length) throw new Error("A lista de recursos contém valores inválidos.");
  return result;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;
    const body = await request.json() as Body;
    const status = String(body.status ?? "");
    if (!new Set(["draft", "active", "archived"]).has(status)) throw new Error("Status de plano inválido.");
    const after = {
      status,
      monthlyPriceCents: integer(body.monthlyPriceCents, 0, 100_000_000, "Preço mensal"),
      annualPriceCents: integer(body.annualPriceCents, 0, 1_000_000_000, "Preço anual"),
      trialDays: integer(body.trialDays, 0, 90, "Período de teste"),
      includedSeats: integer(body.includedSeats, 1, 10_000, "Assentos"),
      companyLimit: integer(body.companyLimit, 1, 100_000, "Limite de empresas"),
      integrationLimit: integer(body.integrationLimit, 0, 10_000, "Limite de integrações"),
      storageLimitMb: integer(body.storageLimitMb, 1, 10_000_000, "Armazenamento"),
      features: features(body.features),
      stripeMonthlyPriceId: priceId(body.stripeMonthlyPriceId),
      stripeAnnualPriceId: priceId(body.stripeAnnualPriceId),
    };
    if (status === "active" && after.monthlyPriceCents > 0 && !after.stripeMonthlyPriceId) throw new Error("Plano mensal pago exige um preço Stripe.");
    if (status === "active" && after.annualPriceCents > 0 && !after.stripeAnnualPriceId) throw new Error("Plano anual pago exige um preço Stripe.");

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const before = await d1.prepare("SELECT id, code, status, monthly_price_cents, annual_price_cents, updated_at FROM fdp_saas_plans WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (!before) return Response.json({ error: "Plano não encontrado." }, { status: 404 });
      await d1.batch([
        d1.prepare(`UPDATE fdp_saas_plans SET status = ?, monthly_price_cents = ?, annual_price_cents = ?, trial_days = ?, included_seats = ?,
            company_limit = ?, integration_limit = ?, storage_limit_mb = ?, features_json = ?::jsonb,
            stripe_monthly_price_id = ?, stripe_annual_price_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(status, after.monthlyPriceCents, after.annualPriceCents, after.trialDays, after.includedSeats, after.companyLimit,
            after.integrationLimit, after.storageLimitMb, JSON.stringify(after.features), after.stripeMonthlyPriceId, after.stripeAnnualPriceId, id),
        d1.prepare(`INSERT INTO fdp_platform_audit_events
            (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
          VALUES (?, ?, ?, 'platform.plan_updated', 'saas_plan', ?, ?::jsonb, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), platform.userId, platform.email, id, JSON.stringify(before), JSON.stringify(after), request.headers.get("x-fila-dp-request-id") ?? ""),
      ]);
      return Response.json({ ok: true, plan: { id, ...after } });
    });
  } catch (error) {
    if (error instanceof Error && /inválid|intervalo|exige|contém/u.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    return apiError(error);
  }
}
