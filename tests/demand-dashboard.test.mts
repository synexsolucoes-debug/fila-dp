import assert from "node:assert/strict";
import test from "node:test";
import type { Card } from "../lib/fila-dp-types.ts";
import { demandAssigneeWorkload, demandCalendarDays, demandDeadlineDay, demandNextAction, localDayKey, prioritizeDemands, summarizeDemands } from "../lib/demand-dashboard.ts";

const card = (id: string, patch: Partial<Card> = {}): Card => ({
  id, boardId: "board", listId: "running", referenceNumber: null, title: id, description: "", companyId: "company", company: "Empresa",
  employeeId: null, requesterUserId: null, requesterAreaId: null, responsibleAreaId: null, processType: "Férias", priority: "normal",
  assigneeName: "", dueAt: null, slaStatus: "safe", position: 0, sourceType: "manual", archived: false, createdAt: "", updatedAt: "",
  checklist: [], comments: [], activities: [], assignees: [], labels: [], customValues: {}, attachments: [], solidesAttachments: null,
  slaPausedReason: "", slaTargetMinutes: 0, slaPausedMinutes: 0, slaEscalationLevel: 0, competence: "", legalDueAt: null,
  processTemplateId: null, closedAt: null, cancelledAt: null, cancellationReason: "", nextStep: "", ...patch,
});

test("vence hoje conta a data, inclusive em espera, sem confundir janela de SLA com vencimento", () => {
  const summary = summarizeDemands([
    card("today", { dueAt: "2026-09-18T17:00:00", slaStatus: "safe" }),
    card("warning-tomorrow", { dueAt: "2026-09-19T17:00:00", slaStatus: "warning" }),
    card("waiting", { dueAt: "2026-09-18", slaStatus: "paused", listId: "waiting" }),
    card("done", { dueAt: "2026-09-18", slaStatus: "completed" }),
    card("cancelled", { dueAt: "2026-09-18", slaStatus: "completed", cancelledAt: "2026-09-18" }),
    card("archive", { dueAt: "2026-09-18", archived: true }),
    card("late", { dueAt: "2026-09-17", slaStatus: "overdue" }),
  ], [{ id: "waiting", slaBehavior: "paused" }], new Date(2026, 8, 18, 10));
  assert.deepEqual(summary, { open: 4, overdue: 1, dueToday: 2, waiting: 1, completed: 1 });
});

test("a central prioriza atrasos, desempata por prazo e não altera a ordem do quadro", () => {
  const cards = [card("done", { slaStatus: "completed", priority: "urgent" }), card("urgent", { priority: "urgent" }),
    card("late", { slaStatus: "overdue", priority: "low" }), card("later", { dueAt: "2026-09-21" }), card("earlier", { dueAt: "2026-09-18" })];
  assert.deepEqual(prioritizeDemands(cards).map((item) => item.id), ["late", "urgent", "earlier", "later", "done"]);
  assert.equal(cards[0].id, "done");
});

test("demandas compartilhadas contam uma vez por pessoa e não misturam homônimos", () => {
  const ana = { userId: "ana-1", name: "Ana", email: "ana@example.test" };
  const anotherAna = { userId: "ana-2", name: "Ana", email: "ana2@example.test" };
  const workload = demandAssigneeWorkload([
    card("shared", { assignees: [ana, anotherAna, ana], slaStatus: "paused" }),
    card("solo", { assignees: [ana] }), card("no-owner"),
    card("finished", { assignees: [ana], slaStatus: "completed" }),
  ]);
  assert.deepEqual(workload.find((entry) => entry.id === ana.userId), { id: "ana-1", name: "Ana", open: 2, waiting: 1 });
  assert.equal(workload.find((entry) => entry.id === anotherAna.userId)?.open, 1);
  assert.equal(workload.find((entry) => entry.id === "unassigned")?.open, 1);
});

test("o calendário mantém sábado, domingo e a virada de ano alcançáveis", () => {
  const days = demandCalendarDays(new Date(2027, 0, 1, 12), "week").map(localDayKey);
  assert.deepEqual(days, ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  const leapMonth = demandCalendarDays(new Date(2028, 1, 15), "month");
  assert.ok(leapMonth.some((day) => localDayKey(day) === "2028-02-29"));
  assert.equal(leapMonth[0].getDay(), 1);
  assert.equal(leapMonth.at(-1)?.getDay(), 0);
});

test("datas sem hora preservam o dia e prazos ausentes ou inválidos ficam fora da grade", () => {
  assert.equal(demandDeadlineDay("2026-09-18"), "2026-09-18");
  assert.equal(demandDeadlineDay("2026-09-18T17:00:00"), "2026-09-18");
  assert.equal(demandDeadlineDay(null), null);
  assert.equal(demandDeadlineDay("inválida"), null);
});

test("próximo passo usa a pendência registrada e não inventa uma transição de processo", () => {
  const demand = card("docs", { checklist: [
    { id: "a", cardId: "docs", title: "Cadastro", completed: true, position: 0, completedAt: "2026-09-17" },
    { id: "b", cardId: "docs", title: "Conferir comprovante", completed: false, position: 1, completedAt: null },
  ] });
  assert.equal(demandNextAction(demand), "Conferir comprovante");
  assert.equal(demandNextAction({ ...demand, slaPausedReason: "Aguardar confirmação do gestor" }), "Aguardar confirmação do gestor");
  assert.equal(demandNextAction({ ...demand, slaStatus: "completed" }), "Processo finalizado");
});
