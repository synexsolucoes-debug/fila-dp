import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  admissionIsComplete,
  admissionTaskDraft,
  isoToSolidesDate,
  normalizeSolidesAdmission,
  solidesAdmissionsUrl,
  solidesAuthorization,
  solidesDateToIso,
  solidesDocumentFields,
  validateSolidesEndpoint,
} from "../lib/solides.ts";
import { integrationResources, validateConnectorEndpoint } from "../lib/integrations.ts";

/** Colaborador no formato documentado em https://gestaoapidocs.solides.com.br/ */
const solidesEmployee = {
  id: 84213,
  name: "Marina Rocha",
  registration: "000512",
  dateAdmission: "03/02/2026",
  birthDate: "14/09/1994",
  salary: "4.250,00",
  typeContract: "CLT",
  dateContract: "03/02/2026",
  contractExpirationDate: "",
  workShift: "44h semanais",
  position: { id: 12, name: "Analista de Departamento Pessoal" },
  departament: { id: 3, name: "Departamento Pessoal" },
  unity: { name: "Matriz" },
  contact: { corporateEmail: "marina.rocha@empresa.com.br", cellPhone: "31999990000" },
  documents: { idNumber: "529.982.247-25", rg: "MG1234567", issuingBody: "SSP/MG", ctpsNum: "9988776", pis: "12345678901" },
  dependents: [{ name: "Ana Rocha", relationship: "Filha" }],
};

test("somente o recurso oficial da Sólides é aceito como endpoint", () => {
  assert.equal(validateSolidesEndpoint("https://app.solides.com/pt-BR/api/v1/colaboradores"), "https://app.solides.com/pt-BR/api/v1/colaboradores");
  assert.equal(validateSolidesEndpoint("https://app.solides.com/en/api/v1/colaboradores"), "https://app.solides.com/en/api/v1/colaboradores");
  // Host de terceiro, caminho inventado, HTTP puro e credencial embutida continuam recusados.
  assert.throws(() => validateSolidesEndpoint("https://example.com/pt-BR/api/v1/colaboradores"), /recurso oficial/u);
  assert.throws(() => validateSolidesEndpoint("https://app.solides.com/pt-BR/api/v1/admissoes"), /recurso oficial/u);
  assert.throws(() => validateSolidesEndpoint("http://app.solides.com/pt-BR/api/v1/colaboradores"), /HTTPS/u);
  assert.throws(() => validateSolidesEndpoint("https://user:senha@app.solides.com/pt-BR/api/v1/colaboradores"), /credenciais na URL/u);
  assert.throws(() => validateSolidesEndpoint(""), /recurso oficial/u);
  // O conector genérico delega a validação da Sólides a esta mesma regra.
  assert.equal(validateConnectorEndpoint("solides", "https://app.solides.com/pt-BR/api/v1/colaboradores"), "https://app.solides.com/pt-BR/api/v1/colaboradores");
});

test("a consulta de admissões usa o filtro e a paginação documentados", () => {
  const url = new URL(solidesAdmissionsUrl("https://app.solides.com/pt-BR/api/v1/colaboradores", { since: "2026-02-01", pageSize: 999 }));
  assert.equal(url.searchParams.get("data_admissao"), "01/02/2026");
  assert.equal(url.searchParams.get("page"), "1");
  // A documentação limita a página a 150 registros.
  assert.equal(url.searchParams.get("page_size"), "150");
  assert.equal(url.searchParams.get("status"), null);
  const withInactive = new URL(solidesAdmissionsUrl("https://app.solides.com/pt-BR/api/v1/colaboradores", { includeInactive: true }));
  assert.equal(withInactive.searchParams.get("status"), "todos");
  assert.equal(withInactive.searchParams.get("data_admissao"), null);
});

test("datas convertem entre o formato da Sólides e o ISO do Vinculato", () => {
  assert.equal(solidesDateToIso("03/02/2026"), "2026-02-03");
  assert.equal(solidesDateToIso("2026-02-03"), "2026-02-03");
  assert.equal(solidesDateToIso("32/13/2026"), "");
  assert.equal(solidesDateToIso("ontem"), "");
  assert.equal(isoToSolidesDate("2026-02-03"), "03/02/2026");
  assert.equal(isoToSolidesDate(""), "");
});

test("a Sólides autentica com Token token= e recusa credencial vazia", () => {
  assert.equal(solidesAuthorization("abc123"), "Token token=abc123");
  assert.throws(() => solidesAuthorization("   "), /token utilizável/u);
});

test("a ficha da Sólides é normalizada sem inventar campo", () => {
  const admission = normalizeSolidesAdmission(solidesEmployee);
  assert.equal(admission.externalId, "84213");
  assert.equal(admission.fullName, "Marina Rocha");
  assert.equal(admission.registrationNumber, "000512");
  assert.equal(admission.admissionDate, "2026-02-03");
  assert.equal(admission.positionName, "Analista de Departamento Pessoal");
  assert.equal(admission.departmentName, "Departamento Pessoal");
  assert.equal(admission.unityName, "Matriz");
  assert.equal(admission.contractType, "CLT");
  assert.equal(admission.salary, 4250);
  assert.equal(admission.dependents, 1);
  assert.equal(admission.email, "marina.rocha@empresa.com.br");
  // Os campos documentais viram presença/ausência, nunca uma lista de valores.
  assert.ok(admission.documentsPresent.includes("CPF"));
  assert.ok(admission.documentsMissing.includes("Título de eleitor"));
  assert.equal(admission.documentsPresent.length + admission.documentsMissing.length, solidesDocumentFields.length);
  assert.deepEqual(admissionIsComplete(admission), []);
});

test("registro sem identificador, nome ou data de admissão não vira tarefa", () => {
  assert.deepEqual(admissionIsComplete(normalizeSolidesAdmission({})), ["externalId", "fullName", "admissionDate"]);
  assert.deepEqual(admissionIsComplete(normalizeSolidesAdmission({ id: 7, name: "Sem data" })), ["admissionDate"]);
});

test("a tarefa aberta concilia a admissão sem copiar valor de documento", () => {
  const draft = admissionTaskDraft(normalizeSolidesAdmission(solidesEmployee));
  assert.equal(draft.title, "Conciliação cadastral — Marina Rocha");
  assert.match(draft.description, /admitido na Sólides em 2026-02-03/u);
  assert.match(draft.description, /Analista de Departamento Pessoal/u);
  // Nenhum número de documento entra no texto da tarefa.
  assert.doesNotMatch(draft.description, /529\.982\.247-25|MG1234567|9988776|12345678901/u);
  // O limite da API oficial fica declarado em vez de virar promessa de download.
  assert.match(draft.description, /não expõe download de anexos/u);
  assert.ok(draft.checklist.includes("Obter na Sólides: Título de eleitor"));
  assert.ok(draft.checklist.some((item) => /Baixar os arquivos dos documentos na Sólides/u.test(item)));
  assert.ok(draft.checklist.some((item) => /Vincular o registro da Sólides ao ERP/u.test(item)));
});

test("o executor trata a Sólides com o contrato dela e abre a conciliação", async () => {
  const engine = await readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8");
  // Autenticação própria: a Sólides não usa Bearer.
  assert.match(engine, /solides \? solidesAuthorization\(token\) : `Bearer \$\{token\}`/u);
  assert.match(engine, /solidesAdmissionsUrl\(endpoint/u);
  // A resposta da Sólides é um array na raiz.
  assert.match(engine, /Array\.isArray\(parsed\) \? \{ items: parsed \} : asRecord\(parsed\)/u);
  // A admissão vira cartão de conciliação, e não um fluxo de admissão digital.
  assert.match(engine, /const admissionProcessType = "CONCILIAÇÃO CADASTRAL"/u);
  assert.match(engine, /INSERT INTO fdp_cards/u);
  assert.doesNotMatch(engine, /process_type.*'ADMISSÃO'/u);
  // Admissão repetida reaproveita a tarefa existente em vez de duplicar.
  assert.match(engine, /target_type = 'card' AND COALESCE\(target_id, ''\) <> ''/u);
  assert.ok(integrationResources.includes("admissions"));
});

test("o recurso admissions está liberado no banco e no manifesto de migrations", async () => {
  const [schema, migration, manifest] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0028_solides_admission_connector.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/schema-manifest.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /'inbox', 'employees', 'hr_metrics', 'files', 'admissions'/u);
  assert.match(migration, /fdp_integration_mappings_resource_check/u);
  assert.match(migration, /'admissions'/u);
  assert.match(migration, /CONCILIAÇÃO CADASTRAL/u);
  assert.match(manifest, /0028_solides_admission_connector\.sql/u);
});
