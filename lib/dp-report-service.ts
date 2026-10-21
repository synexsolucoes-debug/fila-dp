/**
 * DP Operacional, Fase 5 — envio do relatório mensal à gestão.
 *
 * O job diário chama `sendMonthlyDpReport` todo dia; ele só age nos primeiros
 * dias do mês, para a competência anterior, e só uma vez:
 * `fdp_dp_report_runs` é único por competência, e o registro é gravado antes
 * do envio — uma segunda execução no mesmo dia não manda de novo. Sem
 * destinatário configurado (DP Operacional › Painel), não envia nada.
 */
import type { getD1 } from "../db/index.ts";
import { dispatchTransactionalEmail } from "./email.ts";
import { previousCompetence } from "./dp-calendar.ts";
import { loadMonthlyReportData } from "./dp-dashboard-service.ts";
import { buildMonthlyReportPdf, monthlyReportEmailHtml, periodLabel } from "./dp-report.ts";

type Database = ReturnType<typeof getD1>;

/** Até o dia 5 o job tenta enviar o relatório do mês anterior. */
export const REPORT_SEND_UNTIL_DAY = 5;

export async function sendMonthlyDpReport(d1: Database, input: {
  workspaceId: string; today: string; actor: string; period?: string; force?: boolean;
}): Promise<{ sent: boolean; reason: string; recipients: number }> {
  const period = input.period ?? previousCompetence(input.today.slice(0, 7));
  if (!input.period && Number(input.today.slice(8, 10)) > REPORT_SEND_UNTIL_DAY) return { sent: false, reason: "fora da janela de envio", recipients: 0 };
  const settings = await d1.prepare("SELECT report_recipients FROM fdp_dp_settings WHERE workspace_id = ?")
    .bind(input.workspaceId).first<{ report_recipients: string }>();
  const recipients = String(settings?.report_recipients ?? "").split(",").map((email) => email.trim()).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "sem destinatários configurados", recipients: 0 };

  if (!input.force) {
    const done = await d1.prepare("SELECT 1 FROM fdp_dp_report_runs WHERE workspace_id = ? AND period = ?").bind(input.workspaceId, period).first();
    if (done) return { sent: false, reason: "relatório desta competência já enviado", recipients: 0 };
  }
  const data = await loadMonthlyReportData(d1, { workspaceId: input.workspaceId, period, today: input.today });
  const pdf = buildMonthlyReportPdf(data, input.today);
  const baseUrl = String(process.env.FDP_APP_URL ?? "").trim().replace(/\/$/u, "");
  const html = monthlyReportEmailHtml(data, baseUrl ? `${baseUrl}/painel/dp?aba=painel` : "");

  // Registra antes de enviar: com o índice único, duas execuções concorrentes
  // não mandam o mesmo relatório duas vezes.
  await d1.prepare(`INSERT INTO fdp_dp_report_runs (id, workspace_id, period, recipients_count, sent_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, period) DO UPDATE SET recipients_count = EXCLUDED.recipients_count, sent_by = EXCLUDED.sent_by, sent_at = now()`)
    .bind(crypto.randomUUID(), input.workspaceId, period, recipients.length, input.actor).run();
  for (const to of recipients) {
    await dispatchTransactionalEmail({
      to,
      subject: `Relatório do DP — ${periodLabel(period)} — ${data.workspaceName}`,
      html,
      idempotencyKey: `dp-report:${input.workspaceId}:${period}:${to}${input.force ? `:${Date.now()}` : ""}`,
      attachments: [{ filename: `relatorio-dp-${period}.pdf`, content: pdf.toString("base64") }],
    });
  }
  return { sent: true, reason: "", recipients: recipients.length };
}
