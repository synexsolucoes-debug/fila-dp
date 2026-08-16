/**
 * Semente mínima para auditar a interface contra o app rodando.
 *
 * `scripts/a11y-check.mjs` e `scripts/browser-check.mjs` entram no produto pela
 * tela de login e navegam pelas áreas reais. Os dois já existiam, mas não havia
 * como criar a conta que eles usam: cada execução dependia de alguém montar o
 * ambiente à mão, e por isso nenhum dos dois rodava com regularidade.
 *
 * O que esta semente cria é o mínimo para as telas abrirem — uma conta, um
 * grupo, um quadro com listas, uma empresa e uma assinatura. Deliberadamente
 * quase sem movimento: as telas abrem vazias, o que faz a auditoria passar
 * justamente pelos estados vazios, que são os mais fáceis de quebrar sem
 * ninguém perceber.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/seed-ui-fixture.mjs
 *
 * Aponte sempre para um banco descartável: a semente escreve dados fixos.
 */
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com um PostgreSQL descartável e com as migrations aplicadas.");
}

const email = process.env.A11Y_EMAIL ?? "admin@vinculato.test";
const password = process.env.A11Y_PASSWORD ?? "EnsaioLocal!2026";

// Mesmo algoritmo de `app/chatgpt-auth.ts`: scrypt com sal por usuário. Não é
// possível importar de lá porque aquele módulo depende do runtime do Next.
const salt = randomBytes(16).toString("hex");
const hash = (await scryptAsync(password, salt, 64)).toString("hex");

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  // As tabelas do tenant têm FORCE ROW LEVEL SECURITY: sem o contexto, toda
  // escrita é recusada em silêncio.
  await client.query("SELECT set_config('app.workspace_id', 'ws-ui', false)");

  await client.query(
    `INSERT INTO fdp_users (id, email, name, password_hash, password_salt)
     VALUES ('u-ui', $1, 'Administradora do ensaio', $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt`,
    [email, hash, salt],
  );
  await client.query(
    `INSERT INTO fdp_workspaces (id, name, slug, status, owner_user_id)
     VALUES ('ws-ui', 'Operação Piloto', 'operacao-piloto', 'active', 'u-ui') ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-ui', 'u-ui', 'admin') ON CONFLICT DO NOTHING`,
  );
  // Sem quadro o contexto do painel recusa a sessão com BOARD_NOT_FOUND.
  await client.query(
    `INSERT INTO fdp_boards (id, workspace_id, name, board_type)
     VALUES ('b-ui', 'ws-ui', 'Demandas do DP', 'general') ON CONFLICT DO NOTHING`,
  );
  // As colunas são resolvidas por `kind`, não pelo id que a semente propõe.
  //
  // `fdp_lists` tem UNIQUE (board_id, kind): num banco onde o quadro já ganhou
  // suas colunas padrão, o INSERT abaixo colide, o ON CONFLICT engole em
  // silêncio e o id proposto nunca passa a existir. As demandas seguintes então
  // falham por chave estrangeira — o que só não aparecia na CI porque lá o
  // banco nasce vazio a cada execução. Semente que só funciona em banco novo
  // não é semente, é sorte.
  // Os mesmos `kind` que o produto cria ao abrir um quadro — `new`, uma etapa
  // intermediária e `done`. A semente usava `todo`/`doing`/`done`, que o produto
  // nunca gera: o ensaio de ponta a ponta criava demanda num formato de quadro
  // que nenhum cliente tem, e o defeito real ficava escondido atrás do artificial.
  const lists = [["l-ui-1", "Novas demandas", "new"], ["l-ui-2", "Em análise", "analysis"], ["l-ui-3", "Concluído", "done"]];
  const listId = {};
  for (const [index, [id, name, kind]] of lists.entries()) {
    await client.query(
      `INSERT INTO fdp_lists (id, board_id, workspace_id, name, kind, position)
       VALUES ($1, 'b-ui', 'ws-ui', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [id, name, kind, (index + 1) * 1000],
    );
    const { rows } = await client.query(
      `SELECT id FROM fdp_lists WHERE board_id = 'b-ui' AND kind = $1`, [kind],
    );
    if (!rows.length) throw new Error(`a coluna "${kind}" não existe no quadro do ensaio`);
    listId[id] = rows[0].id;
  }
  await client.query(`INSERT INTO fdp_workspace_settings (workspace_id) VALUES ('ws-ui') ON CONFLICT DO NOTHING`);
  await client.query(
    `INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, is_principal)
     VALUES ('co-ui', 'ws-ui', 'Piloto Servicos LTDA', 'Piloto', '11222333000181', 1) ON CONFLICT DO NOTHING`,
  );
  // Uma segunda empresa, deliberadamente sem demanda.
  //
  // Com uma empresa só, o seletor de empresa da barra superior é indistinguível
  // de um seletor que não faz nada: escolher a única empresa devolve os mesmos
  // números. Foi assim que ele passou a existir em toda tela sem recortar a
  // visão geral, sem que ensaio nenhum acusasse. Esta empresa é a que torna o
  // recorte demonstrável — e de quebra exercita a tela de empresa sem demanda.
  await client.query(
    `INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, is_principal)
     VALUES ('co-ui-2', 'ws-ui', 'Filial Sem Demanda LTDA', 'Filial Vazia', '11222333000262', 0) ON CONFLICT DO NOTHING`,
  );

  /* Duas competências abertas, em estágios diferentes.
     Sem ciclo nenhum, o fluxo da competência na Visão geral só era exercitado
     no estado vazio — e a etapa concluída, a atual e a pendente nunca chegavam
     a ser pintadas. É a mesma armadilha do rótulo de processo logo abaixo:
     conferência que não alcança o pixel não mede o pixel.

     Estágios diferentes de propósito: com as duas iguais, o avanço "do ciclo
     menos adiantado" daria o mesmo resultado que "do primeiro ciclo", e o
     ensaio não distinguiria as duas regras. */
  const competencia = new Date().toISOString().slice(0, 7);
  for (const [id, companyId, status] of [
    ["cy-ui-1", "co-ui", "processing"],
    ["cy-ui-2", "co-ui-2", "pre_closing"],
  ]) {
    await client.query(
      `INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, notes, created_by)
       VALUES ($1, 'ws-ui', $2, $3, $4, '', 'u-ui') ON CONFLICT DO NOTHING`,
      [id, companyId, competencia, status],
    );
  }

  // Uma demanda por tipo de processo, e só.
  //
  // A semente era inteiramente vazia, para a auditoria passar pelos estados
  // vazios. O efeito colateral era grave: o rótulo de processo nunca chegava a
  // ser pintado, então a conferência de contraste nunca o media. Foi assim que
  // `.dashboard-task-labels .orange` ficou em 4.37:1 — abaixo do mínimo 4.5 da
  // WCAG — passando por uma auditoria que dizia "0 violações".
  //
  // Uma demanda de cada tipo cobre as cinco cores de rótulo sem encher as
  // telas: os estados vazios das outras áreas continuam sendo exercitados.
  const processos = [
    ["FÉRIAS", "normal", "l-ui-1"],
    ["RESCISÃO", "high", "l-ui-1"],
    ["BENEFÍCIOS", "normal", "l-ui-2"],
    ["FOLHA", "low", "l-ui-2"],
    ["OUTROS", "normal", "l-ui-3"],
  ];
  for (const [index, [processo, prioridade, lista]] of processos.entries()) {
    await client.query(
      `INSERT INTO fdp_cards (id, board_id, workspace_id, list_id, title, description, company_id, company,
         process_type, priority, position, created_by, competence)
       VALUES ($1, 'b-ui', 'ws-ui', $2, $3, 'Demanda do ensaio de interface.', 'co-ui', 'Piloto', $4, $5, $6, 'u-ui', '2026-08')
       ON CONFLICT DO NOTHING`,
      [`c-ui-${index + 1}`, listId[lista], `${processo[0]}${processo.slice(1).toLowerCase()} do ensaio`, processo, prioridade, (index + 1) * 1000],
    );
  }

  // Assinatura no plano mais amplo: sem ela os módulos ficam bloqueados por
  // plano e a auditoria não chegaria às telas que precisa medir.
  const plan = await client.query(`SELECT id FROM fdp_saas_plans WHERE code = 'enterprise' LIMIT 1`);
  if (plan.rows[0]) {
    await client.query(
      `INSERT INTO fdp_workspace_subscriptions (id, workspace_id, plan_id, status)
       VALUES ('sub-ui', 'ws-ui', $1, 'active') ON CONFLICT DO NOTHING`,
      [plan.rows[0].id],
    );
  }

  console.log(`Semente da interface pronta: ${email} no grupo "Operação Piloto".`);
} finally {
  await client.end();
}
