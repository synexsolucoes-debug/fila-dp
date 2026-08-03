import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { businessMinutesBetween, evaluateSla, type SlaCalendar } from "../lib/fila-dp-sla.ts";
import { decryptSecret, encryptSecret } from "../lib/fila-dp-secrets.ts";

const calendar: SlaCalendar = {
  businessDays: [1, 2, 3, 4, 5],
  holidays: new Set(),
  dayStart: "08:00",
  dayEnd: "18:00",
  timezone: "America/Sao_Paulo",
};

test("calcula minutos úteis no fuso do workspace e ignora a noite", () => {
  assert.equal(businessMinutesBetween("2026-08-03T11:00:00Z", "2026-08-03T23:00:00Z", calendar), 600);
  assert.equal(businessMinutesBetween("2026-08-03T23:00:00Z", "2026-08-04T11:00:00Z", calendar), 0);
});

test("persiste níveis previsíveis de escalonamento do SLA", () => {
  const input = { behavior: "running", activePause: false, dueAt: null, targetMinutes: 600, startedAt: "2026-08-03T11:00:00Z", pausedMinutes: 0, warningBusinessDays: 0 };
  assert.deepEqual(evaluateSla(input, calendar, new Date("2026-08-03T20:00:00Z")), { status: "safe", elapsedMinutes: 540, overdueMinutes: 0, escalationLevel: 0 });
  assert.equal(evaluateSla(input, calendar, new Date("2026-08-04T15:00:00Z")).escalationLevel, 1);
  assert.equal(evaluateSla(input, calendar, new Date("2026-08-05T15:00:00Z")).escalationLevel, 2);
  assert.equal(evaluateSla({ ...input, activePause: true }, calendar, new Date("2026-08-05T15:00:00Z")).status, "paused");
});

test("protege credenciais OAuth com criptografia autenticada", () => {
  const previous = process.env.FDP_INTEGRATION_ENCRYPTION_KEY;
  process.env.FDP_INTEGRATION_ENCRYPTION_KEY = "test-key-with-at-least-thirty-two-bytes";
  try {
    const encrypted = encryptSecret({ accessToken: "secret", refreshToken: "refresh" });
    assert.doesNotMatch(encrypted, /secret|refresh/);
    assert.deepEqual(decryptSecret(encrypted), { accessToken: "secret", refreshToken: "refresh" });
    const tampered = encrypted.split(".");
    tampered[2] = `${tampered[2][0] === "A" ? "B" : "A"}${tampered[2].slice(1)}`;
    assert.throws(() => decryptSecret(tampered.join(".")));
  } finally {
    if (previous === undefined) delete process.env.FDP_INTEGRATION_ENCRYPTION_KEY;
    else process.env.FDP_INTEGRATION_ENCRYPTION_KEY = previous;
  }
});

test("mantém detalhamento Sankhya e protege tarefas agendadas", async () => {
  const [sync, cron, migration, webhook] = await Promise.all([
    readFile(new URL("../app/api/integrations/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cron/sla/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0003_operational_hardening.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/webhook/[channel]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sync, /base_salary = excluded\.base_salary/);
  assert.doesNotMatch(sync, /base_salary = 0/);
  assert.match(cron, /Bearer \$\{cronSecret\}/);
  assert.match(migration, /fdp_auth_rate_limits/);
  assert.match(migration, /fdp_calendar_credentials/);
  assert.match(migration, /fdp_inbox_workspace_channel_external_uq/);
  assert.match(webhook, /x-hub-signature-256/);
  assert.match(webhook, /phone_number_id/);
  assert.match(webhook, /metaWhatsappMessages/);
  assert.match(webhook, /ON CONFLICT \(workspace_id, channel, external_id\) DO NOTHING/);
});
