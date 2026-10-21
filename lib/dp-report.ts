/**
 * DP Operacional, Fase 5 — relatório mensal da gestão (PDF e e-mail).
 *
 * Quatro perguntas, uma por seção: quanto o DP entregou, quanto chegou fora do
 * prazo e de onde, quais riscos vencem nos próximos 30 dias, e como está a
 * carga de cada analista. Os números vêm de `loadMonthlyReportData`; aqui só a
 * forma. Sem dado pessoal além do nome no título do alerta — CPF e salário não
 * entram no relatório.
 */
import { A4, PdfPage, buildPdf } from "./pdf-document.ts";
import { escapeHtml } from "./email.ts";
import type { MonthlyReportData } from "./dp-dashboard-service.ts";

const MARGIN = 42;
const severityText: Record<string, string> = { overdue: "vencido", urgent: "urgente", warning: "no radar" };

export const periodLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;
const day = (value: string | null) => value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : "—";

class ReportBuilder {
  readonly pages: PdfPage[] = [];
  private page!: PdfPage;
  private y = 0;

  constructor() { this.newPage(); }

  private newPage() {
    this.page = new PdfPage(A4.width, A4.height);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN;
  }

  private ensure(height: number) {
    if (this.y - height < MARGIN + 20) this.newPage();
  }

  title(text: string, subtitle: string) {
    this.page.text(text, MARGIN, this.y, { font: "helvetica-bold", size: 15 });
    this.y -= 18;
    this.page.text(subtitle, MARGIN, this.y, { size: 9 });
    this.y -= 10;
    this.page.line(MARGIN, this.y, A4.width - MARGIN, this.y, 0.8);
    this.y -= 18;
  }

  section(text: string) {
    this.ensure(40);
    this.y -= 6;
    this.page.text(text.toUpperCase(), MARGIN, this.y, { font: "helvetica-bold", size: 10 });
    this.y -= 14;
  }

  line(text: string, options: { bold?: boolean; right?: string } = {}) {
    this.ensure(14);
    this.page.text(text.slice(0, 110), MARGIN + 6, this.y, { font: options.bold ? "helvetica-bold" : "helvetica", size: 9 });
    if (options.right) this.page.textRight(options.right, A4.width - MARGIN, this.y, { size: 9 });
    this.y -= 13;
  }

  table(headers: string[], rows: string[][], widths: number[]) {
    const columnsX = widths.reduce<number[]>((acc, width, index) => [...acc, index ? acc[index - 1] + widths[index - 1] : MARGIN + 6], []);
    this.ensure(30);
    headers.forEach((header, index) => this.page.text(header, columnsX[index], this.y, { font: "helvetica-bold", size: 8 }));
    this.y -= 4;
    this.page.line(MARGIN, this.y, A4.width - MARGIN, this.y, 0.4);
    this.y -= 11;
    for (const row of rows) {
      this.ensure(13);
      row.forEach((cell, index) => this.page.text(cell.slice(0, Math.max(6, Math.floor(widths[index] / 4.6))), columnsX[index], this.y, { size: 8 }));
      this.y -= 12;
    }
    this.y -= 4;
  }

  footer(text: string) {
    this.pages.forEach((page, index) => {
      page.text(`${text} · página ${index + 1} de ${this.pages.length}`, MARGIN, MARGIN - 14, { size: 7 });
    });
  }
}

export function buildMonthlyReportPdf(data: MonthlyReportData, generatedOn: string) {
  const builder = new ReportBuilder();
  builder.title(`Relatório do DP — ${periodLabel(data.period)}`, `${data.workspaceName} · gerado em ${day(generatedOn)}`);

  builder.section("Volume entregue");
  builder.line("Demandas concluídas no mês", { right: String(data.delivered) });
  builder.line("Concluídas depois do prazo", { right: String(data.deliveredLate) });
  builder.line("Demandas abertas no mês", { right: String(data.createdInPeriod) });

  builder.section("Fora do prazo de corte, por área");
  if (data.outsideCutoff.length) {
    builder.table(["Área", "Total", "Em aberto", "Fora do corte", "% fora"],
      data.outsideCutoff.map((row) => [row.area, String(row.total), String(row.open), String(row.outside), `${row.outsidePercent.toLocaleString("pt-BR")}%`]),
      [200, 60, 70, 90, 60]);
  } else builder.line("Nenhuma demanda com regra de corte no mês.");

  builder.section("Ocorrências registradas (origem dos atrasos)");
  if (data.occurrencesByArea.length) {
    builder.table(["Área", "Ocorrências", "Dias de atraso somados"],
      data.occurrencesByArea.map((row) => [row.area, String(row.total), String(row.daysLate)]), [240, 90, 150]);
  } else builder.line("Nenhuma ocorrência no mês.");

  builder.section("Riscos nos próximos 30 dias (experiência e férias)");
  if (data.risks.length) {
    builder.table(["Alerta", "Vence em", "Situação"],
      data.risks.map((risk) => [risk.title, day(risk.dueDate), severityText[risk.severity] ?? risk.severity]), [360, 70, 70]);
  } else builder.line("Nenhuma experiência ou férias vencendo nos próximos 30 dias.");

  builder.section("Carga por titular");
  if (data.holders.length) {
    builder.table(["Titular", "Empresas", "Ativos", "PJ", "Abertas", "Atrasadas", "Alertas"],
      data.holders.map((holder) => [holder.name, String(holder.companies), String(holder.employeesClt), String(holder.contractorsPj),
        String(holder.openCards), String(holder.overdueCards), String(holder.alerts)]),
      [150, 55, 55, 45, 55, 60, 50]);
  } else builder.line("Carteira do DP sem titulares cadastrados.");

  builder.footer(`Vinculato · DP Operacional · ${periodLabel(data.period)}`);
  return buildPdf(builder.pages, `Relatório do DP ${periodLabel(data.period)}`);
}

export function monthlyReportEmailHtml(data: MonthlyReportData, panelUrl: string) {
  const outside = data.outsideCutoff.reduce((sum, row) => sum + row.outside, 0);
  const rows = [
    ["Demandas concluídas", data.delivered],
    ["Concluídas depois do prazo", data.deliveredLate],
    ["Fora do prazo de corte", outside],
    ["Ocorrências", data.occurrencesByArea.reduce((sum, row) => sum + row.total, 0)],
    ["Riscos nos próximos 30 dias", data.risks.length],
  ].map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(String(label))}</td><td style="padding:4px 0;font-weight:600">${value}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;color:#1f2937">
    <h2 style="margin:0 0 4px">Relatório do DP — ${escapeHtml(periodLabel(data.period))}</h2>
    <p style="margin:0 0 16px;color:#4b5563">${escapeHtml(data.workspaceName)}</p>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="margin:16px 0 0">O relatório completo está no PDF anexo.${panelUrl ? ` O painel ao vivo fica em <a href="${escapeHtml(panelUrl)}">DP Operacional</a>.` : ""}</p>
  </div>`;
}
