import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateEmployeeDossierPdf, type EmployeeDossier } from "../lib/employee-dossier-pdf.ts";

/**
 * Dossiê do colaborador, passo 1 (§4.18): EPI, ASO e treinamento juntos num
 * PDF só, sem acidente (§83: anonimizado, sem FK de colaborador).
 */

const baseDossier: EmployeeDossier = {
  workspaceName: "Grupo Acme", companyName: "Acme Indústria", employeeName: "Maria Souza",
  registrationNumber: "1001", positionName: "Operadora de produção", admissionDate: "2024-01-10",
  issuedAt: new Date("2026-09-25T12:00:00Z"),
  epiDeliveries: [
    { deliveredOn: "2026-01-05", productName: "Luva de raspa", caNumber: "12345", quantity: 2, status: "signed", signatureName: "Maria Souza" },
  ],
  exams: [
    { examDate: "2026-01-03", examType: "periodic", result: "fit", nextDueDate: "2027-01-03" },
  ],
  trainings: [
    { completedOn: "2026-02-01", trainingName: "NR-35 Trabalho em altura", validUntil: "2028-02-01", providerName: "Instituto Seguro" },
  ],
};

test("o PDF do dossiê nasce válido e com conteúdo", async () => {
  const pdf = await generateEmployeeDossierPdf(baseDossier);
  assert.equal(new TextDecoder().decode(pdf.slice(0, 4)), "%PDF");
  assert.ok(pdf.byteLength > 1_000);
});

test("uma seção sem permissão (null) não vira zero registros no PDF", async () => {
  const source = await readFile(new URL("../lib/employee-dossier-pdf.ts", import.meta.url), "utf8");
  assert.match(source, /items === null/u);
  assert.match(source, /permissão para consultar/u);
  assert.doesNotMatch(source, /count \?\? 0/u);
});

test("gera sem lançar tanto com listas vazias quanto com seções sem permissão (null)", async () => {
  await assert.doesNotReject(generateEmployeeDossierPdf({ ...baseDossier, epiDeliveries: [], exams: [], trainings: [] }));
  await assert.doesNotReject(generateEmployeeDossierPdf({ ...baseDossier, epiDeliveries: null, exams: null, trainings: null }));
});

test("muitos registros forçam continuação de página sem lançar", async () => {
  const many = Array.from({ length: 60 }, (_unused, index) => ({
    deliveredOn: "2026-01-05", productName: `Item ${index}`, caNumber: "12345", quantity: 1, status: "delivered", signatureName: "",
  }));
  const pdf = await generateEmployeeDossierPdf({ ...baseDossier, epiDeliveries: many });
  assert.equal(new TextDecoder().decode(pdf.slice(0, 4)), "%PDF");
});

/* ── a rota: cada seção respeita a própria capacidade ─────────────────────── */

test("a rota do dossiê consulta cada seção só com a capacidade dela, e devolve null sem ela", async () => {
  const source = await readFile(new URL("../app/api/employees/[id]/dossier/route.ts", import.meta.url), "utf8");
  assert.match(source, /hasCapability\(workspace, "epi\.view"\)/u);
  assert.match(source, /hasCapability\(workspace, "exams\.view"\)/u);
  assert.match(source, /hasCapability\(workspace, "trainings\.view"\)/u);
  assert.match(source, /: Promise\.resolve\(null\)/u);
  assert.match(source, /requireNamedCapability\(workspace, "employees\.read"/u);
  assert.match(source, /requireCompanyAccess/u);
});

test("a rota devolve o PDF como anexo, não inline, e nunca cacheia", async () => {
  const source = await readFile(new URL("../app/api/employees/[id]/dossier/route.ts", import.meta.url), "utf8");
  assert.match(source, /"Content-Type": "application\/pdf"/u);
  assert.match(source, /Content-Disposition.*attachment/u);
  assert.match(source, /"Cache-Control": "no-store"/u);
});

/* ── a tela: o botão existe e usa o mesmo padrão de download por blob ─────── */

test("a tela baixa o dossiê pelo mesmo padrão de blob usado pelo recibo PJ", async () => {
  const source = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/employees\/\$\{employee\.id\}\/dossier/u);
  assert.match(source, /URL\.createObjectURL\(blob\)/u);
  assert.match(source, /Baixar dossiê/u);
});
