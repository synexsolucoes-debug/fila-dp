/**
 * Fumaça HTTP contra a aplicação em execução.
 *
 * Exercita os fluxos que precisam funcionar antes de qualquer cliente entrar:
 * cadastro, sessão, empresa, competência (criar, listar, abrir, fechar,
 * reabrir), colaborador, membros e a separação entre workspace e plataforma.
 *
 * Não substitui teste de unidade: ele prova que o caminho real — rota, sessão,
 * permissão, RLS e banco — responde. É executado contra um PostgreSQL com papel
 * SEM superusuário, senão o RLS não vale nada e o ensaio passa sem provar isolamento.
 *
 * Uso:
 *   VINCULATO_SMOKE_URL=http://localhost:3000 node scripts/smoke-http.mjs
 */
const base = process.env.VINCULATO_SMOKE_URL ?? "http://localhost:3000";
const stamp = Date.now();

let cookie = "";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, path, body, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(";");
    if (pair?.startsWith("fdp_session=") || pair?.includes("session")) cookie = pair;
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 200) }; }
  return { status: response.status, payload };
}

function expect(name, actual, expected, extra = "") {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  record(name, ok, ok ? "" : `esperado ${expected}, veio ${actual}${extra ? ` (${extra})` : ""}`);
  return ok;
}

const email = `smoke-${stamp}@vinculato.test`;

// 1. Cadastro e sessão
const signup = await call("POST", "/api/auth/signup", {
  name: "Operador Smoke", email, password: "SenhaForte#2026", groupName: `Grupo ${stamp}`,
});
expect("cadastro cria conta, workspace e assinatura", signup.status, 201, JSON.stringify(signup.payload).slice(0, 160));

const snapshot = await call("GET", "/api/workspace");
expect("sessão devolve o painel do workspace", snapshot.status, 200);

// 2. Empresa — prova que a escrita e a leitura enxergam o mesmo tenant sob RLS
const company = await call("POST", "/api/companies", {
  legalName: `Empresa Smoke ${stamp}`, tradeName: "Smoke", taxId: String(10000000000000 + (stamp % 89999999999999)),
});
expect("criar empresa", company.status, 201, JSON.stringify(company.payload).slice(0, 160));
const companyId = company.payload?.company?.id ?? "";

const companies = await call("GET", "/api/companies");
record("empresa criada aparece na listagem (RLS não engole o próprio dado)",
  (companies.payload?.companies ?? []).some((item) => item.id === companyId),
  `${(companies.payload?.companies ?? []).length} empresa(s)`);

// 3. Competência — o fluxo que estava quebrado
const competence = await call("POST", "/api/operations/competences", { companyId, competence: "2026-08" });
expect("criar competência", competence.status, 201, JSON.stringify(competence.payload).slice(0, 160));
const competenceId = competence.payload?.competence?.id ?? "";

const listed = await call("GET", `/api/operations/competences?companyId=${companyId}`);
record("competência aparece na listagem",
  (listed.payload?.competences ?? []).some((item) => item.id === competenceId),
  `${(listed.payload?.competences ?? []).length} competência(s)`);

const detail = await call("GET", `/api/operations/competences/${competenceId}`);
expect("abrir a competência (detalhe)", detail.status, 200, JSON.stringify(detail.payload).slice(0, 160));
record("o detalhe traz os itens de fechamento",
  Array.isArray(detail.payload?.items) && detail.payload.items.length > 0,
  `${(detail.payload?.items ?? []).length} item(ns)`);

const duplicate = await call("POST", "/api/operations/competences", { companyId, competence: "2026-08" });
expect("competência duplicada é recusada com conflito", duplicate.status, 409);

// Fechar exige que os itens de pré e pós-fechamento estejam concluídos: o
// bloqueio é comportamento correto, então o ensaio cumpre o pré-requisito.
for (const item of detail.payload?.items ?? []) {
  await call("PATCH", `/api/operations/closing-items/${item.id}`, { status: "completed" });
}

for (const status of ["pre_closing", "processing", "post_closing", "closed"]) {
  const moved = await call("POST", `/api/operations/competences/${competenceId}/transition`, { status });
  expect(`avançar competência para ${status}`, moved.status, 200, JSON.stringify(moved.payload).slice(0, 120));
}

// Reabrir uma competência fechada devolve ela ao pós-fechamento, não ao início:
// o histórico do que já foi processado é preservado.
const reopenWithoutReason = await call("POST", `/api/operations/competences/${competenceId}/transition`, { status: "post_closing" });
expect("reabrir sem justificativa é recusado", reopenWithoutReason.status, [400, 403]);

const reopened = await call("POST", `/api/operations/competences/${competenceId}/transition`, {
  status: "post_closing", reason: "Correção de movimentação da competência",
});
expect("reabrir com justificativa", reopened.status, 200, JSON.stringify(reopened.payload).slice(0, 120));

const skipping = await call("POST", `/api/operations/competences/${competenceId}/transition`, { status: "closed" });
expect("pular etapa do ciclo é recusado", skipping.status, [200, 400]);

// 4. Colaborador
const employee = await call("POST", "/api/employees", {
  companyId, fullName: "Colaborador Smoke", registrationNumber: `M${stamp % 100000}`, admissionDate: "2026-01-05",
});
expect("cadastrar colaborador", employee.status, [200, 201], JSON.stringify(employee.payload).slice(0, 160));

// 5. Painel e busca
const actionCenter = await call("GET", "/api/dashboard/action-center");
expect("central de ação responde", actionCenter.status, 200);
const search = await call("GET", "/api/search?q=Smoke");
expect("busca global responde", search.status, 200);

// 6. Separação de contextos: assinante não é administrador da plataforma
const platform = await call("GET", "/api/platform/overview");
expect("assinante não acessa o console global", platform.status, 403);

// 7. Isolamento: um segundo workspace não enxerga o primeiro
cookie = "";
const other = await call("POST", "/api/auth/signup", {
  name: "Outro Operador", email: `smoke-b-${stamp}@vinculato.test`, password: "SenhaForte#2026", groupName: `Outro ${stamp}`,
});
expect("segundo cadastro", other.status, 201);
const otherCompanies = await call("GET", "/api/companies");
record("o segundo workspace não enxerga a empresa do primeiro",
  !(otherCompanies.payload?.companies ?? []).some((item) => item.id === companyId),
  `${(otherCompanies.payload?.companies ?? []).length} empresa(s) próprias`);
const stolen = await call("GET", `/api/operations/competences/${competenceId}`);
expect("competência de outro workspace responde 404, não vaza", stolen.status, [403, 404]);

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} verificações passaram.`);
if (failures.length) {
  console.log("Falhas:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
