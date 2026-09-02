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

/**
 * Chave de cofre do ensaio.
 *
 * A credencial Sankhya da semente é selada com a mesma função do produto, e
 * selar exige chave. Quando o ambiente não traz uma, a semente fixa esta — que
 * é determinística, está no repositório e vale só para banco descartável — e
 * **avisa**, porque o app precisa subir com a mesma: chaves diferentes gravam
 * um segredo que ninguém abre, e a tela passaria a mentir de outro jeito.
 */
const CHAVE_DE_ENSAIO = Buffer.alloc(32, 19).toString("base64");
if (!process.env.FDP_SANKHYA_VAULT_KEYS && !process.env.FDP_SANKHYA_VAULT_KEY) {
  process.env.FDP_SANKHYA_VAULT_KEY = CHAVE_DE_ENSAIO;
  process.env.FDP_SANKHYA_VAULT_KEY_VERSION ??= "1";
  console.log(`Cofre do ensaio: suba o app com FDP_SANKHYA_VAULT_KEY=${CHAVE_DE_ENSAIO}`);
}

const { credentialPublicHint, sealCredentials } = await import("../lib/integrations.ts");
const credenciaisDeEnsaio = { username: "robo.ensaio", password: "SenhaDeEnsaio!2026" };
const selada = sealCredentials("sankhya_browser", credenciaisDeEnsaio);

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

  /* Local de estoque padrão, como todo grupo real tem.
     Sem ele, qualquer movimentação de EPI é recusada — e a semente mediria um
     produto que nenhum cliente enxerga, porque o provisionamento e a migration
     `0045` dão esse local a todos os grupos de verdade. */
  await client.query(
    `INSERT INTO fdp_stock_locations (id, workspace_id, code, name, description, status, is_default, created_by, updated_by)
     VALUES ('ws-ui:stock:default', 'ws-ui', 'PRINCIPAL', 'Estoque principal', 'Local padrão da semente de interface.', 'active', 1, 'u-ui', 'u-ui')
     ON CONFLICT (workspace_id, code) DO NOTHING`,
  );

  /* Um segundo membro, que não é o dono.
     A ficha de membro só oferece papel, empresas, link de ativação, remoção e
     exceção de módulo quando `!member.isOwner` — e a semente tinha uma pessoa
     só, que era o dono. O efeito: nenhuma dessas interfaces era desenhada, e
     portanto nenhuma era medida pela conferência de contraste. É a mesma
     armadilha do rótulo de processo e do ciclo de fechamento. */
  /* O membro também entra pela tela, e por isso também precisa de senha.
     Sem ela não há como provar autorização de verdade: a recusa a quem não tem
     a permissão só vale se vier do servidor para uma sessão real, e não de um
     botão escondido. `journey-check.mjs` entra com esta conta e chama a API
     direto. A senha é a mesma da administradora de propósito — banco descartável,
     e uma variável a menos para o ensaio errar. */
  const memberSalt = randomBytes(16).toString("hex");
  const memberHash = (await scryptAsync(password, memberSalt, 64)).toString("hex");
  await client.query(
    `INSERT INTO fdp_users (id, email, name, password_hash, password_salt)
     VALUES ('u-ui-2', 'membro@vinculato.test', 'Membro do Ensaio', $1, $2)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt`,
    [memberHash, memberSalt],
  );
  await client.query(
    `INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-ui', 'u-ui-2', 'member')
     ON CONFLICT DO NOTHING`,
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

  /* Conectores em quatro estados. Um conector só, ou todos iguais, deixaria o
     diagrama de conexões com um traço só de tom — e a conferência de contraste
     mediria um estado dos quatro. É a mesma armadilha da competência acima. */
  /* O Sankhya da semente estava "connected" com `config_json` vazio — estado que
     não existe no produto: sem URL e sem empresa de destino o servidor recusa a
     execução. Fixture incoerente esconde defeito de dois lados, porque a tela
     que lê o estado nunca vê o estado real. */
  const configSankhya = JSON.stringify({
    endpoint: "https://piloto.sankhya.com.br/mge/", companyId: "co-ui", companyContext: "01",
    routine: "employees", routineName: "DP Explorer", automaticEnabled: false,
    frequency: "daily", scheduleTime: "02:00", scheduleWeekday: 1, timezone: "America/Sao_Paulo",
    timeoutMs: 300_000, maxAttempts: 3, downloadLimitBytes: 25 * 1024 * 1024, diagnosticRetentionHours: 24,
  });
  for (const [id, canal, nome, status, sync] of [
    // Os três agentes que o produto mostra, com o nome de produto. O Tangerino
    // de navegador faltava aqui — e a semente é o que o ensaio de navegador e a
    // auditoria de acessibilidade medem, então sem ele um terço da decisão de
    // produto ficava sem cobertura nenhuma.
    ["int-ui-1", "sankhya_browser", "Agente Sankhya", "connected", "now() - interval '8 minutes'"],
    ["int-ui-3", "teams", "Agente Teams", "needs_credentials", "null"],
    // Em erro de propósito: a tela operacional passou a mostrar só estes três, e
    // os quatro tons do diagrama de conexões precisam existir **entre eles**.
    // Antes o tom de erro vivia no conector Tangerino de API, que a decisão de
    // produto aposentou — e ao pausá-lo a auditoria de contraste deixaria de
    // medir o estado de erro em qualquer cartão visível.
    ["int-ui-5", "tangerino_browser", "Agente Tangerino", "error", "now() - interval '20 minutes'"],
    // Conectores aposentados, pausados: a semente precisa reproduzir o estado
    // real de um grupo migrado, inclusive para provar que eles não aparecem.
    ["int-ui-2", "solides", "Sólides", "paused", "now() - interval '3 hours'"],
    ["int-ui-4", "tangerino", "Sólides DP (Tangerino)", "paused", "now() - interval '2 days'"],
  ]) {
    await client.query(
      `INSERT INTO fdp_integrations (id, workspace_id, channel, display_name, status, last_sync_at, config_json)
       VALUES ($1, 'ws-ui', $2, $3, $4, ${sync}, $5) ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status, last_sync_at = EXCLUDED.last_sync_at, config_json = EXCLUDED.config_json`,
      [id, canal, nome, status, canal === "sankhya_browser" ? configSankhya : "{}"],
    );
  }

  /* Uma credencial de verdade para o conector Sankhya.
     Sem ela o conector ficava "connected" sem credencial nenhuma — outro estado
     que o produto não produz, e que fazia a conferência medir um cartão que o
     servidor recusaria. É selada com a mesma função do produto, então o que está
     no banco é abrível pelo mesmo cofre; um valor inventado à mão seria um
     segredo que não abre, e a tela mentiria de outro jeito. */
  await client.query(
    `INSERT INTO fdp_integration_credentials
       (id, workspace_id, integration_id, credential_type, encrypted_value, initialization_vector, auth_tag,
        key_version, fingerprint, public_hint, created_by)
     VALUES ('cred-ui-1', 'ws-ui', 'int-ui-1', 'provider_auth', $1, $2, $3, $4, $5, $6, 'u-ui')
     ON CONFLICT (id) DO NOTHING`,
    [selada.encryptedValue, selada.initializationVector, selada.authTag, selada.keyVersion, selada.fingerprint,
      credentialPublicHint("sankhya_browser", credenciaisDeEnsaio)],
  );

  /* O módulo `sankhya_browser` não entra em plano nenhum: a plataforma o libera
     workspace a workspace. Sem esta linha, *todo* workspace da semente fica no
     estado bloqueado — e uma conferência que só encontra um dos dois estados não
     distingue "a tela lê a liberação" de "a tela diz bloqueado sempre". O
     workspace criado durante a própria conferência continua sem liberação, então
     os dois estados ficam na mesma tela. */
  await client.query(
    `INSERT INTO fdp_workspace_module_grants (workspace_id, module_key, granted, reason, granted_by)
     VALUES ('ws-ui', 'sankhya_browser', 1, 'Semente de interface: exercitar o estado liberado do módulo.', 'u-ui')
     ON CONFLICT (workspace_id, module_key) DO UPDATE SET granted = 1`,
  );

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

  /* Segundo grupo, com a MESMA pessoa dentro e com dado próprio.
     Sem ele não há como provar isolamento entre grupos nem troca de contexto:
     `journey-check.mjs` compara as demandas e as empresas dos dois lados, e uma
     interseção vazia contra um grupo vazio não prova nada — é aritmética, não
     segurança. O grupo também é o que permite verificar que arquivar um não
     tranca a pessoa fora do outro. */
  await client.query("SELECT set_config('app.workspace_id', 'ws-ui-2', false)");
  await client.query(
    `INSERT INTO fdp_workspaces (id, name, slug, status, owner_user_id)
     VALUES ('ws-ui-2', 'Segundo Grupo', 'segundo-grupo', 'active', 'u-ui') ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ('ws-ui-2', 'u-ui', 'admin') ON CONFLICT DO NOTHING`,
  );
  await client.query(`INSERT INTO fdp_workspace_settings (workspace_id) VALUES ('ws-ui-2') ON CONFLICT DO NOTHING`);
  /* O segundo grupo também precisa do local de estoque padrão, pela mesma razão
     do primeiro: a migration `0045` e o provisionamento dão esse local a todo
     grupo real, e sem ele qualquer movimentação de EPI é recusada. Um grupo de
     ensaio sem o local mede um produto que nenhum cliente tem. */
  await client.query(
    `INSERT INTO fdp_stock_locations (id, workspace_id, code, name, description, status, is_default, created_by, updated_by)
     VALUES ('ws-ui-2:stock:default', 'ws-ui-2', 'PRINCIPAL', 'Estoque principal', 'Local padrão da semente de interface.', 'active', 1, 'u-ui', 'u-ui')
     ON CONFLICT (workspace_id, code) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO fdp_boards (id, workspace_id, name, board_type)
     VALUES ('b-ui-2', 'ws-ui-2', 'Demandas do Segundo Grupo', 'general') ON CONFLICT DO NOTHING`,
  );
  // Mesma resolução por `kind` do quadro principal: o id proposto pode colidir
  // com as colunas que o produto cria sozinho ao abrir um quadro.
  const segundaLista = {};
  for (const [index, [id, name, kind]] of [["l-ui-2-1", "Novas demandas", "new"], ["l-ui-2-2", "Concluído", "done"]].entries()) {
    await client.query(
      `INSERT INTO fdp_lists (id, board_id, workspace_id, name, kind, position)
       VALUES ($1, 'b-ui-2', 'ws-ui-2', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [id, name, kind, (index + 1) * 1000],
    );
    const { rows } = await client.query(`SELECT id FROM fdp_lists WHERE board_id = 'b-ui-2' AND kind = $1`, [kind]);
    if (!rows.length) throw new Error(`a coluna "${kind}" não existe no segundo quadro do ensaio`);
    segundaLista[id] = rows[0].id;
  }
  await client.query(
    `INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, is_principal)
     VALUES ('co-ui-3', 'ws-ui-2', 'Segundo Grupo LTDA', 'Segundo', '44555666000177', 1) ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO fdp_cards (id, board_id, workspace_id, list_id, title, description, company_id, company,
       process_type, priority, position, created_by, competence)
     VALUES ('c-ui-2-1', 'b-ui-2', 'ws-ui-2', $1, 'Demanda exclusiva do Segundo Grupo',
       'Existe para provar que não aparece no outro grupo.', 'co-ui-3', 'Segundo', 'OUTROS', 'normal', 1000, 'u-ui', '2026-08')
     ON CONFLICT DO NOTHING`,
    [segundaLista["l-ui-2-1"]],
  );
  if (plan.rows[0]) {
    await client.query(
      `INSERT INTO fdp_workspace_subscriptions (id, workspace_id, plan_id, status)
       VALUES ('sub-ui-2', 'ws-ui-2', $1, 'active') ON CONFLICT DO NOTHING`,
      [plan.rows[0].id],
    );
  }

  console.log(`Semente da interface pronta: ${email} nos grupos "Operação Piloto" e "Segundo Grupo".`);
} finally {
  await client.end();
}
