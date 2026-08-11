import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  admissionTaskDraft,
  isoToEpochMillis,
  normalizeTangerinoAdmission,
  tangerinoAuthorization,
  tangerinoDateToIso,
  tangerinoDocumentFields,
  tangerinoEmployeesUrl,
  tangerinoErpReadiness,
  tangerinoRecords,
  tangerinoSkipReason,
  validateTangerinoEndpoint,
} from "../lib/tangerino.ts";
import { admissionIsComplete } from "../lib/admissions.ts";
import { integrationChannels, validateConnectorEndpoint } from "../lib/integrations.ts";

const endpoint = "https://employer.tangerino.com.br/employee/find-all";

/** Colaborador no formato EmployeeReturnWithoutPinDTO da especificação oficial. */
const tangerinoEmployee = {
  id: 774512,
  externalId: "MAT-0042",
  name: "Marina Rocha",
  socialName: "",
  admissionDate: "2026-02-03T00:00:00.000Z",
  effectiveDate: "2026-02-03T00:00:00.000Z",
  birthDate: "1994-09-14T00:00:00.000Z",
  email: "marina.rocha@empresa.com.br",
  phone: "31999990000",
  cpf: "529.982.247-25",
  ctps: "9988776",
  series: "0012",
  pis: "",
  fired: false,
  resignationDate: null,
  jobRoleDTO: { id: 12, description: "Analista de Departamento Pessoal", salary: { value: 4250.5 } },
  currentWorkplaceDTO: { id: 3, name: "Matriz" },
  currentWorkSchedule: { id: 8, name: "44h semanais" },
  company: { id: 1, descriptionName: "Empresa Modelo LTDA", fantasyName: "Empresa Modelo" },
};

test("somente o recurso oficial do Tangerino é aceito como endpoint", () => {
  assert.equal(validateTangerinoEndpoint(endpoint), endpoint);
  assert.equal(validateTangerinoEndpoint("https://api.tangerino.com.br/api/employer/employee/find-all"), "https://api.tangerino.com.br/api/employer/employee/find-all");
  assert.throws(() => validateTangerinoEndpoint("https://example.com/employee/find-all"), /recurso oficial/u);
  assert.throws(() => validateTangerinoEndpoint("https://employer.tangerino.com.br/employee/admissoes"), /recurso oficial/u);
  assert.throws(() => validateTangerinoEndpoint("http://employer.tangerino.com.br/employee/find-all"), /HTTPS/u);
  assert.throws(() => validateTangerinoEndpoint("https://user:senha@employer.tangerino.com.br/employee/find-all"), /credenciais na URL/u);
  // O conector genérico delega a validação ao contrato do produto certo.
  assert.equal(validateConnectorEndpoint("tangerino", endpoint), endpoint);
  // Um produto não aceita o endpoint do outro.
  assert.throws(() => validateConnectorEndpoint("solides", endpoint), /recurso oficial/u);
  assert.throws(() => validateConnectorEndpoint("tangerino", "https://app.solides.com/pt-BR/api/v1/colaboradores"), /recurso oficial/u);
  assert.ok(integrationChannels.includes("tangerino"));
});

test("a consulta usa lastUpdate em milissegundos e a paginação do Spring", () => {
  const url = new URL(tangerinoEmployeesUrl(endpoint, { since: "2026-02-01", pageSize: 999 }));
  assert.equal(url.searchParams.get("lastUpdate"), String(Date.parse("2026-02-01T00:00:00.000Z")));
  // A paginação do Spring é indexada em zero.
  assert.equal(url.searchParams.get("page"), "0");
  assert.equal(url.searchParams.get("size"), "200");
  // Demitido não é admissão: o padrão não traz quem já saiu.
  assert.equal(url.searchParams.get("showFired"), "0");
  assert.equal(new URL(tangerinoEmployeesUrl(endpoint)).searchParams.get("lastUpdate"), null);
});

test("datas aceitam date-time, epoch e formato brasileiro", () => {
  assert.equal(tangerinoDateToIso("2026-02-03T00:00:00.000Z"), "2026-02-03");
  assert.equal(tangerinoDateToIso(Date.parse("2026-02-03T00:00:00.000Z")), "2026-02-03");
  assert.equal(tangerinoDateToIso("03/02/2026"), "2026-02-03");
  assert.equal(tangerinoDateToIso("ontem"), "");
  assert.equal(tangerinoDateToIso(null), "");
  assert.equal(isoToEpochMillis("2026-02-03"), Date.parse("2026-02-03T00:00:00.000Z"));
  assert.equal(isoToEpochMillis(""), 0);
});

test("a Sólides DP autentica com Basic e tolera o token já prefixado", () => {
  assert.equal(tangerinoAuthorization("abc123"), "Basic abc123");
  // Colar o valor inteiro da documentação não pode virar "Basic Basic abc123".
  assert.equal(tangerinoAuthorization("Basic abc123"), "Basic abc123");
  assert.throws(() => tangerinoAuthorization("  "), /token utilizável/u);
});

test("o envelope Page do Spring é desembrulhado", () => {
  assert.equal(tangerinoRecords({ content: [{ id: 1 }, { id: 2 }], totalPages: 3 }).length, 2);
  assert.deepEqual(tangerinoRecords({ content: [] }), []);
  assert.deepEqual(tangerinoRecords([{ id: 1 }]), []);
});

test("a ficha da Sólides DP é normalizada sem inventar campo", () => {
  const admission = normalizeTangerinoAdmission(tangerinoEmployee);
  assert.equal(admission.externalId, "774512");
  assert.equal(admission.registrationNumber, "MAT-0042");
  assert.equal(admission.fullName, "Marina Rocha");
  assert.equal(admission.admissionDate, "2026-02-03");
  assert.equal(admission.positionName, "Analista de Departamento Pessoal");
  assert.equal(admission.unityName, "Matriz");
  assert.equal(admission.workShift, "44h semanais");
  assert.equal(admission.departmentName, "Empresa Modelo LTDA");
  assert.equal(admission.salary, 4250.5);
  assert.deepEqual(admissionIsComplete(admission), []);
  // O DTO não traz tipo de contrato nem dependentes: o campo fica vazio em vez de inventado.
  assert.equal(admission.contractType, "");
  assert.equal(admission.dependents, 0);
  // Documentos viram presença/ausência; o PIS vazio aparece como pendência.
  assert.ok(admission.documentsPresent.includes("CPF"));
  assert.ok(admission.documentsMissing.includes("PIS/PASEP"));
  assert.equal(admission.documentsPresent.length + admission.documentsMissing.length, tangerinoDocumentFields.length);
});

test("a demanda só fica pronta quando os dados contratuais mínimos chegaram", () => {
  const ready = normalizeTangerinoAdmission(tangerinoEmployee);
  assert.deepEqual(tangerinoErpReadiness(ready), []);

  const waiting = normalizeTangerinoAdmission({
    ...tangerinoEmployee,
    cpf: "",
    currentWorkSchedule: null,
    jobRoleDTO: { id: 12, description: "", salary: { value: 0 } },
  });
  assert.deepEqual(tangerinoErpReadiness(waiting), ["CPF", "cargo", "jornada", "salário"]);
});

test("a janela de atualização não transforma desligamento nem cadastro antigo em admissão", () => {
  const admission = normalizeTangerinoAdmission(tangerinoEmployee);
  assert.equal(tangerinoSkipReason(tangerinoEmployee, admission, "2026-01-01"), "");
  // Demitido chega na mesma janela do filtro por atualização.
  assert.equal(tangerinoSkipReason({ ...tangerinoEmployee, fired: true }, admission, "2026-01-01"), "desligado");
  assert.equal(tangerinoSkipReason({ ...tangerinoEmployee, resignationDate: "2026-05-02T00:00:00.000Z" }, admission, "2026-01-01"), "desligado");
  // Corrigir o cadastro de quem foi admitido antes do corte não abre conciliação.
  assert.equal(tangerinoSkipReason(tangerinoEmployee, admission, "2026-06-01"), "admitido antes do corte");
});

test("a tarefa nomeia a Sólides DP e não copia valor de documento", () => {
  const draft = admissionTaskDraft(normalizeTangerinoAdmission(tangerinoEmployee));
  assert.equal(draft.title, "Admissão ERP — Marina Rocha");
  assert.match(draft.description, /Dados contratuais disponíveis na Sólides DP/u);
  assert.match(draft.description, /Salário contratual: R\$\s*4\.250,50/u);
  assert.doesNotMatch(draft.description, /529\.982\.247-25|9988776/u);
  assert.match(draft.description, /não expõe download de anexos/u);
  assert.ok(draft.checklist.includes("Conferir na Sólides DP: PIS/PASEP"));
  assert.ok(draft.checklist.includes("Realizar a admissão no ERP"));
  assert.ok(draft.checklist.includes("Concluir manualmente a demanda no Vinculato"));
});

test("o executor e o provisionamento conhecem o canal da Sólides DP", async () => {
  const [engine, seed, migration] = await Promise.all([
    readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0029_tangerino_connector.sql", import.meta.url), "utf8"),
  ]);
  assert.match(engine, /tangerinoAuthorization\(token\)/u);
  assert.match(engine, /tangerinoEmployeesUrl\(endpoint/u);
  // O recorte precisa rodar antes de abrir a tarefa.
  assert.match(engine, /tangerinoSkipReason\(input\.raw, admission, context\.since\)/u);
  assert.match(engine, /tangerinoErpReadiness\(admission\)/u);
  assert.match(engine, /aguardando dados contratuais para o ERP/u);
  assert.match(engine, /`\$\{admission\.externalId\}:\$\{admission\.admissionDate\}`/u);
  assert.match(seed, /\["tangerino", "Sólides DP \(Tangerino\)"\]/u);
  assert.match(migration, /'tangerino'/u);
});
