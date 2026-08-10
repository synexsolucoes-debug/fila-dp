/**
 * Verificação de isolamento multi-tenant contra o banco de verdade.
 *
 * Este ensaio existe porque a correção do isolamento depende de um detalhe do
 * driver: `set_config('app.workspace_id', …, true)` e a consulta precisam cair
 * na MESMA transação. Isso foi validado com PostgreSQL local e com o driver HTTP
 * do Neon apontado para um banco de ensaio — mas o Neon de produção é outro
 * serviço, e a única prova que vale é rodar contra ele.
 *
 * O ensaio usa o mesmo adaptador da aplicação (`getScopedD1`), não SQL solto:
 * se o adaptador parar de enviar o tenant, aqui reprova.
 *
 * Uso (contra o Neon real, em banco de teste ou produção somente-leitura):
 *   DATABASE_URL="postgres://…neon.tech/…" node scripts/verify-tenant-isolation.mjs
 *
 * Cuidados:
 * - o ensaio NÃO escreve nada por padrão. Ele só lê, e usa dois workspaces já
 *   existentes para comparar o que cada contexto enxerga;
 * - se o banco tiver menos de dois workspaces, ele avisa e sai sem veredito, em
 *   vez de fingir que provou isolamento com um tenant só;
 * - o papel de conexão precisa ser SEM superusuário. Superusuário ignora RLS e
 *   faria o ensaio passar sem provar nada — isso é checado e reprovado.
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  console.error("Defina DATABASE_URL com a conexão do banco a verificar.");
  process.exit(2);
}

const { getScopedD1, getD1 } = await import("../db/index.ts");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const unscoped = getD1();

// 0. O papel precisa ser sem superusuário e sem BYPASSRLS. Este é o ensaio do
//    ensaio: sem ele, todo o resto passa sem significar nada.
const role = await unscoped.prepare(
  "SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
).first();
const isSuper = role?.superuser === true || role?.superuser === "t";
const bypasses = role?.bypass === true || role?.bypass === "t";
record(
  "o papel de conexão respeita RLS (sem superusuário, sem BYPASSRLS)",
  Boolean(role) && !isSuper && !bypasses,
  role ? `papel ${role.name}, superuser=${role.superuser}, bypassrls=${role.bypass}` : "papel não identificado",
);
if (!role || isSuper || bypasses) {
  console.error("\nO ensaio para aqui: com esse papel o PostgreSQL ignora RLS e nada seria provado.");
  process.exit(1);
}

// 1. Sem contexto de tenant, tabela protegida não devolve linha.
const withoutContext = await unscoped.prepare("SELECT count(*)::int AS total FROM fdp_companies").first();
record("sem contexto de tenant, nenhuma empresa é visível", Number(withoutContext?.total ?? -1) === 0,
  `${withoutContext?.total} linha(s)`);

// 2. Precisa haver dois workspaces para comparar. Com um só, não há isolamento
//    a provar — e afirmar que provou seria mentira.
const workspaces = await unscoped.prepare(
  "SELECT id, name FROM fdp_workspaces ORDER BY created_at LIMIT 2",
).all();
if (workspaces.results.length < 2) {
  console.log(`\n• O banco tem ${workspaces.results.length} workspace(s). São necessários 2 para comparar.`);
  console.log("  Ensaio encerrado SEM veredito de isolamento — nada foi provado nem negado.");
  process.exit(3);
}
const [first, second] = workspaces.results.map((row) => ({ id: String(row.id), name: String(row.name) }));

// 3. Cada contexto enxerga o próprio dado — prova que o tenant chega ao banco.
const counts = {};
for (const workspace of [first, second]) {
  const scoped = getScopedD1({ workspaceId: workspace.id, userId: null });
  const own = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_companies WHERE workspace_id = ?")
    .bind(workspace.id).first();
  const everything = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_companies").first();
  counts[workspace.id] = { own: Number(own?.total ?? 0), visible: Number(everything?.total ?? 0) };
  record(`o contexto de "${workspace.name}" enxerga apenas as próprias empresas`,
    counts[workspace.id].own === counts[workspace.id].visible,
    `próprias ${counts[workspace.id].own}, visíveis ${counts[workspace.id].visible}`);
}

// 4. A prova que importa: um contexto não alcança o dado do outro.
const scopedFirst = getScopedD1({ workspaceId: first.id, userId: null });
const leak = await scopedFirst.prepare("SELECT count(*)::int AS total FROM fdp_companies WHERE workspace_id = ?")
  .bind(second.id).first();
record(`"${first.name}" não alcança nenhuma empresa de "${second.name}"`, Number(leak?.total ?? -1) === 0,
  `${leak?.total} linha(s) alcançadas`);

// 5. O tenant chega ao banco na mesma transação da consulta — o detalhe que a
//    correção depende e que varia entre drivers.
const setting = await scopedFirst.prepare(
  "SELECT current_setting('app.workspace_id', true) AS workspace",
).first();
record("o adaptador entrega app.workspace_id junto da consulta",
  String(setting?.workspace ?? "") === first.id,
  `banco respondeu "${setting?.workspace ?? "(vazio)"}"`);

// 6. O mesmo vale para lote: o produto grava auditoria e negócio no mesmo batch.
const batch = await scopedFirst.batch([
  scopedFirst.prepare("SELECT current_setting('app.workspace_id', true) AS workspace"),
  scopedFirst.prepare("SELECT count(*)::int AS total FROM fdp_companies"),
]);
record("em lote, o tenant vale para todos os comandos",
  String(batch[0]?.results?.[0]?.workspace ?? "") === first.id
    && Number(batch[1]?.results?.[0]?.total ?? -1) === counts[first.id].visible,
  `lote respondeu "${batch[0]?.results?.[0]?.workspace ?? "(vazio)"}"`);

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} verificações passaram.`);
if (failures.length) {
  console.log("\nISOLAMENTO REPROVADO. Não libere o produto neste banco:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
console.log("\nISOLAMENTO APROVADO neste banco, com o driver que a aplicação usa em produção.");
