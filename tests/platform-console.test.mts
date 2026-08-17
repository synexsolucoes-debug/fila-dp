import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodePlatformCursor, encodePlatformCursor, platformListLimit, requiredPlatformReason, sanitizePlatformValue } from "../lib/platform-console.ts";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("a console possui nove áreas modulares e mantém o estado na URL", async () => {
  const [app, core] = await Promise.all([source("app/plataforma/PlatformApp.tsx"), source("app/plataforma/features/core.tsx")]);
  for (const area of ["overview", "clients", "users", "integrations", "operations", "billing", "security", "audit", "health"]) {
    assert.match(app, new RegExp(`\\["${area}"`), `área ${area} ausente`);
  }
  assert.match(app, /useSearchParams/u);
  assert.match(app, /router\.push/u);
  assert.match(core, /role="dialog"/u);
  assert.match(core, /Motivo obrigatório/u);
  assert.doesNotMatch(`${app}\n${core}`, /window\.(prompt|confirm)/u);
});

test("a página e todas as APIs globais aplicam autorização de plataforma no servidor", async () => {
  const paths = ["overview", "workspaces", "users", "integrations", "operations", "billing", "security", "audit", "health", "leads", "billing-readiness"];
  const routes = await Promise.all(paths.map((path) => source(`app/api/platform/${path}/route.ts`)));
  for (const [index, route] of routes.entries()) {
    assert.match(route, /getApiUser\(\)/u, `${paths[index]} sem 401 de autenticação`);
    assert.match(route, /requirePlatformAdmin\(auth\.user\)/u, `${paths[index]} sem 403 de plataforma`);
  }
  const page = await source("app/plataforma/page.tsx");
  assert.match(page, /requireChatGPTUser\("\/plataforma"\)/u);
  assert.match(page, /isPlatformAdmin\(user\)/u);
  assert.match(page, /redirect\("\/painel\?platform=forbidden"\)/u);
});

test("agregações tenant-aware usam contexto RLS explícito", async () => {
  const paths = ["integrations", "operations", "security", "health"];
  const routes = await Promise.all(paths.map((path) => source(`app/api/platform/${path}/route.ts`)));
  for (const [index, route] of routes.entries()) assert.match(route, /getPlatformScopedD1/u, `${paths[index]} não carrega o tenant na conexão`);
  // O detalhe do workspace lê `fdp_companies`, que tem RLS por workspace: sem
  // o tenant na conexão a consulta volta vazia.
  const workspaceDetail = await source("app/api/platform/workspaces/[id]/detail/route.ts");
  assert.match(workspaceDetail, /getPlatformScopedD1/u);

  // O detalhe do usuário deixou de precisar. Ele lê `fdp_workspace_members` e
  // `fdp_workspaces` (globais por desenho — o seletor de grupo depende disso),
  // `fdp_auth_sessions` (sem RLS) e `fdp_platform_audit_events`, cuja política
  // é por `app.platform_admin` e não por workspace. Abrir contexto de tenant
  // por cliente ali era uma ida ao banco por cliente sem nada a proteger.
  const userDetail = await source("app/api/platform/users/[id]/detail/route.ts");
  assert.doesNotMatch(userDetail, /getPlatformScopedD1/u);
  assert.match(userDetail, /FROM fdp_platform_audit_events/u);
});

test("listas globais usam cursor estável e índices correspondentes", async () => {
  const [workspaces, users, integrations, audit, migration] = await Promise.all([
    source("app/api/platform/workspaces/route.ts"), source("app/api/platform/users/route.ts"), source("app/api/platform/integrations/route.ts"),
    source("app/api/platform/audit/route.ts"), source("drizzle/postgres/0036_platform_console_indexes.sql"),
  ]);
  for (const route of [workspaces, users, audit]) {
    assert.match(route, /decodePlatformCursor/u);
    assert.match(route, /encodePlatformCursor/u);
    assert.match(route, /LIMIT \?/u);
  }
  assert.match(integrations, /decodePlatformCursor/u);
  assert.match(integrations, /encodePlatformCursor/u);
  assert.match(integrations, /slice\(0, limit\)/u);
  assert.match(migration, /fdp_users_created_id_idx/u);
  assert.match(migration, /fdp_workspaces_created_id_idx/u);
  assert.match(migration, /fdp_platform_audit_created_id_idx/u);
  const cursor = { createdAt: "2026-08-11T12:00:00.000Z", id: "abc" };
  assert.deepEqual(decodePlatformCursor(encodePlatformCursor(cursor)), cursor);
  assert.equal(platformListLimit("999", 25, 100), 100);
  assert.throws(() => decodePlatformCursor("não-é-base64"));
});

test("auditoria e respostas globais redigem segredos em profundidade", () => {
  const safe = sanitizePlatformValue({ token: "abc", nested: { clientSecret: "def", allowed: "ok" }, list: [{ password: "ghi" }] }) as Record<string, unknown>;
  assert.equal(safe.token, "[redigido]");
  assert.deepEqual(safe.nested, { clientSecret: "[redigido]", allowed: "ok" });
  assert.deepEqual(safe.list, [{ password: "[redigido]" }]);
  assert.equal(sanitizePlatformValue("falha: token=valor-super-secreto"), "[redigido]");
  assert.equal(requiredPlatformReason("  incidente confirmado  "), "incidente confirmado");
  assert.throws(() => requiredPlatformReason("curt"));
  assert.throws(() => requiredPlatformReason("revisar token=valor-super-secreto"));
});

test("ações críticas de integração exigem motivo, confirmação e auditoria dupla", async () => {
  const route = await source("app/api/platform/integrations/[id]/actions/route.ts");
  assert.match(route, /requiredPlatformReason/u);
  assert.match(route, /body\.confirmed !== true/u);
  assert.match(route, /PLATFORM_CONFIRMATION_MISMATCH/u);
  assert.match(route, /fdp_audit_events/u);
  assert.match(route, /fdp_platform_audit_events/u);
  assert.match(route, /requestId/u);
  assert.doesNotMatch(route, /return Response\.json\([^\n]*encryptedValue/u);
});

test("o painel é operacional e recebe o conector Sankhya pronto da Plataforma Global", async () => {
  const [panel, integrations, sankhya, integrationRoute, credentialsRoute, registrations] = await Promise.all([
    source("app/painel/WorkspaceApp.tsx"), source("app/painel/features/integrations/IntegrationsView.tsx"),
    source("app/painel/features/integrations/SankhyaConnectorPanel.tsx"), source("app/api/integrations/[id]/route.ts"),
    source("app/api/integrations/[id]/credentials/route.ts"), source("app/painel/features/registrations/RegistrationsView.tsx"),
  ]);
  assert.doesNotMatch(panel, /AccessView|SaasView|view === "access"|view === "saas"/u);
  assert.doesNotMatch(panel, /title="Configurações"/u);
  assert.match(integrations, /INTEGRAÇÕES DO WORKSPACE/u);
  assert.match(integrations, /SankhyaConnectorPanel/u);
  assert.match(integrations, /IntegrationDrawer/u);
  assert.match(integrations, /Configurar[\s\S]+Credencial[\s\S]+Testar conexão/u);
  assert.doesNotMatch(integrations, /type="password"/u);
  assert.match(sankhya, /Gerenciada pela Plataforma Global/u);
  assert.doesNotMatch(sankhya, /Alterar credenciais Sankhya|type="password"|Salvar configuração/u);
  assert.match(integrationRoute, /SANKHYA_PLATFORM_ADMIN_REQUIRED/u);
  assert.match(credentialsRoute, /SANKHYA_PLATFORM_ADMIN_REQUIRED/u);
  assert.match(registrations, /useState<RegistrationTab>\("employees"\)/u);
  assert.doesNotMatch(registrations, /onClick=\{\(\) => setTab\("companies"\)\}/u);
});

test("financeiro explicita fórmulas e indisponibilidade em vez de métricas decorativas", async () => {
  const [route, feature] = await Promise.all([source("app/api/platform/billing/route.ts"), source("app/plataforma/features/BillingFeature.tsx")]);
  for (const metric of ["mrrCents", "revenueAtRiskCents", "trialConversionRate", "arpaCents", "revenueChurn", "ltv"]) assert.match(route, new RegExp(metric));
  assert.match(route, /definitions/u);
  assert.match(route, /available: false/u);
  assert.match(feature, /Dados insuficientes/u);
});

test("clientes e usuários expõem as mutações globais existentes sem diálogos nativos", async () => {
  const [clients, users, workspaceRoute, userRoute, userDetail, userBulk, core] = await Promise.all([
    source("app/plataforma/features/ClientsFeature.tsx"), source("app/plataforma/features/UsersFeature.tsx"),
    source("app/api/platform/workspaces/route.ts"), source("app/api/platform/users/route.ts"),
    source("app/api/platform/users/[id]/route.ts"), source("app/api/platform/users/bulk/route.ts"), source("app/plataforma/features/core.tsx"),
  ]);
  for (const label of ["Novo workspace", "Transferir propriedade", "Excluir definitivamente", "Aplicar plano"]) assert.match(clients, new RegExp(label));
  for (const label of ["Nova identidade", "Vincular", "Desvincular", "Encerrar todas", "Revogar sessão"]) assert.match(users, new RegExp(label));
  assert.match(workspaceRoute, /PLATFORM_CONFIRMATION_REQUIRED/u);
  assert.match(workspaceRoute, /requiredPlatformReason/u);
  assert.match(userRoute, /platform\.user_created/u);
  assert.match(userRoute, /pg_advisory_xact_lock/u);
  assert.match(userDetail, /revokeSession/u);
  assert.match(userBulk, /requirePlatformAdmin/u);
  assert.match(userBulk, /preview/u);
  assert.match(userBulk, /requiredPlatformReason/u);
  assert.match(userBulk, /fdp_platform_audit_events/u);
  assert.match(users, /Bloquear em massa/u);
  assert.match(core, /extraInput/u);
  assert.doesNotMatch(`${clients}\n${users}`, /window\.(prompt|confirm)/u);
});

test("administrador global consegue gerar link de ativação auditado sem expor senha", async () => {
  const [feature, route] = await Promise.all([
    source("app/plataforma/features/UsersFeature.tsx"),
    source("app/api/platform/users/[id]/activation/route.ts"),
  ]);
  assert.match(feature, /Gerar link de ativação/u);
  assert.match(feature, /Link único de ativação/u);
  assert.match(feature, /\/api\/platform\/users\/\$\{encodeURIComponent\(id\)\}\/activation/u);
  assert.match(route, /requirePlatformAdmin\(auth\.user\)/u);
  assert.match(route, /body\.confirmed !== true/u);
  assert.match(route, /requiredPlatformReason/u);
  assert.match(route, /createRecoveryToken/u);
  assert.match(route, /fdp_access_recovery_tokens/u);
  assert.match(route, /platform\.user_activation_link_created/u);
  assert.match(route, /fdp_platform_audit_events/u);
  assert.match(route, /USER_ALREADY_ACTIVATED/u);
  assert.doesNotMatch(route, /SELECT[^\n]*password_hash(?![^\n]*IS NOT NULL)/u);
  assert.doesNotMatch(`${feature}\n${route}`, /senha provisória|passwordHash|token_hash:/iu);
});

test("financeiro liga planos e leads a APIs reais e auditadas", async () => {
  const [feature, plans, leads] = await Promise.all([
    source("app/plataforma/features/BillingFeature.tsx"), source("app/api/platform/plans/[id]/route.ts"), source("app/api/platform/leads/route.ts"),
  ]);
  assert.match(feature, /\/api\/platform\/plans\//u);
  assert.match(feature, /\/api\/platform\/leads/u);
  assert.match(feature, /Motivo da alteração/u);
  assert.match(plans, /platform\.plan_updated/u);
  assert.match(leads, /before_json/u);
  assert.match(leads, /request_id/u);
});

test("integrações globais oferecem todos os filtros operacionais solicitados", async () => {
  const [feature, route] = await Promise.all([source("app/plataforma/features/IntegrationsFeature.tsx"), source("app/api/platform/integrations/route.ts")]);
  for (const filter of ["workspaceId", "companyId", "connector", "status", "from", "to", "errors", "expiring", "stalled"]) assert.match(route, new RegExp(filter));
  for (const label of ["Filtrar workspace", "Filtrar empresa", "Credenciais vencendo", "Filas paradas"]) assert.match(feature, new RegExp(label));
});

test("detalhe global de integração mantém segredos omitidos e expõe configuração Sankhya auditada", async () => {
  const [feature, sankhya, detail, actions, core] = await Promise.all([
    source("app/plataforma/features/IntegrationsFeature.tsx"),
    source("app/plataforma/features/SankhyaPlatformConfiguration.tsx"),
    source("app/api/platform/integrations/[id]/detail/route.ts"),
    source("app/api/platform/integrations/[id]/actions/route.ts"),
    source("app/plataforma/features/core.tsx"),
  ]);
  assert.match(detail, /requirePlatformAdmin\(auth\.user\)/u);
  assert.match(detail, /getPlatformScopedD1/u);
  assert.match(detail, /publicCredentialFingerprint/u);
  assert.match(detail, /public_hint/u);
  assert.match(detail, /parseSankhyaConfig/u);
  assert.match(detail, /delete publicIntegration\.config_json/u);
  assert.match(detail, /FROM fdp_companies/u);
  assert.match(detail, /differences_json/u);
  assert.match(detail, /NULLIF\(integration\.config_json, ''\)::jsonb->>'companyId'/u);
  assert.doesNotMatch(detail, /integration\.company_id/u);
  assert.doesNotMatch(detail, /SELECT[^\n]*(?:encrypted_value|initialization_vector|auth_tag|mapping_json|resolution_note)/iu);
  for (const action of ["configure_sankhya", "test_connection"]) assert.match(actions, new RegExp(action));
  assert.match(actions, /sanitizeSankhyaConfig/u);
  assert.match(actions, /triggerType: "health_check"/u);
  assert.match(actions, /requireSankhyaWorkspaceEnabled/u);
  assert.match(feature, /SankhyaPlatformConfiguration/u);
  for (const label of ["Configuração Sankhya do workspace", "Criptografar e salvar", "Testar conexão", "Motivo administrativo"]) assert.match(sankhya, new RegExp(label));
  assert.match(sankhya, /type="password"/u);
  assert.doesNotMatch(sankhya, /password[^\n]*public_hint/iu);
  for (const action of ["create_mapping", "publish_mapping", "resolve_reconciliation"]) {
    assert.match(actions, new RegExp(action));
    assert.match(feature, new RegExp(action));
  }
  assert.match(actions, /sanitizeMapping/u);
  assert.match(actions, /fdp_audit_events/u);
  assert.match(actions, /fdp_platform_audit_events/u);
  assert.match(feature, /Diferenças mostram apenas nomes de campos/u);
  assert.match(feature, /Novo rascunho/u);
  assert.match(feature, /Resolver/u);
  assert.match(core, /jsonInput/u);
});

test("configuração operacional global é tenant-scoped, auditada e ligada à interface", async () => {
  const [route, feature, operations] = await Promise.all([
    source("app/api/platform/workspaces/[id]/configuration/route.ts"),
    source("app/plataforma/features/WorkspaceConfiguration.tsx"),
    source("app/plataforma/features/OperationsFeature.tsx"),
  ]);
  assert.match(route, /getApiUser\(\)/u);
  assert.match(route, /requirePlatformAdmin\(auth\.user\)/u);
  assert.match(route, /getPlatformScopedD1/u);
  assert.match(route, /body\.confirmed !== true/u);
  assert.match(route, /requiredPlatformReason/u);
  assert.match(route, /fdp_audit_events/u);
  assert.match(route, /fdp_platform_audit_events/u);
  assert.match(route, /request_id/u);
  assert.match(route, /OWNER_MUST_REMAIN_ADMIN/u);
  for (const action of ["workspace.update", "company.save", "board.save", "list.save", "label.save", "field.save", "template.save", "calendar.update", "holiday.save", "sla.save", "rule.save", "area.save", "area.archive", "module.set", "member.scope", "api_key.revoke", "webhook.status"]) {
    const pattern = new RegExp(action.replace(".", "\\."));
    assert.match(route, pattern, `ação ${action} ausente no servidor`);
    assert.match(feature, pattern, `ação ${action} sem interface`);
  }
  assert.match(route, /member\.module\.set/u);
  assert.match(route, /FROM fdp_areas/u);
  assert.match(route, /resolveMemberDepartmentAccess/u);
  assert.match(feature, /Áreas operacionais e módulos/u);
  assert.match(feature, /Departamento principal/u);
  assert.match(feature, /Módulos liberados neste departamento/u);
  assert.match(operations, /WorkspaceConfiguration/u);
  assert.match(operations, /params\.get\("workspace"\)/u);
  assert.match(feature, /AdminActionDialog/u);
  assert.doesNotMatch(feature, /window\.(prompt|confirm)/u);
  assert.doesNotMatch(route, /SELECT[^\n]*(?:secret|token_hash|credential_encrypted)/iu);
  assert.doesNotMatch(route, /Response\.json\([^\n]*(?:secret|token|hash)/iu);
});
