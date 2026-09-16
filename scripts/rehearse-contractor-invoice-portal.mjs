/**
 * Ensaio do portal do prestador contra um PostgreSQL real.
 *
 * O portal é a única porta do produto aberta a quem não tem conta, e o que a
 * protege não é uma permissão: é um segredo com prazo, guardado como hash, num
 * inquilino que sai do próprio token. Nada disso é verificável sem banco —
 * `tsc` aceita um INSERT que viola CHECK, e um teste de unidade aceita um
 * índice parcial que na prática não existe.
 *
 * O que este ensaio prova, e um teste de unidade não provaria:
 *
 * 1. a nota e o arquivo entram com `uploaded_by`/`created_by` nulos, porque
 *    quem enviou não é membro — e o CHECK continua exigindo pessoa no caminho
 *    do painel;
 * 2. o histórico aceita o ator do portal com o nome de quem enviou, e recusa
 *    ator de portal sem nome;
 * 3. só existe um link aberto por fechamento: o índice parcial recusa o
 *    segundo, e é por isso que gerar de novo revoga antes de inserir;
 * 4. revogar e entregar são fatos inteiros — o banco recusa meio fato;
 * 5. um token de outro inquilino não alcança o link, com a RLS ligada.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" FDP_DB_DRIVER=pg \
 *   node --experimental-strip-types scripts/rehearse-contractor-invoice-portal.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve fica
 * dentro de dois grupos próprios, criados e apagados por ele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getScopedD1 } from "../db/index.ts";
import { registerInvoice } from "../lib/contractor-invoice-service.ts";
import {
  createPortalToken,
  hashPortalToken,
  parsePortalToken,
  portalExpiryFromDays,
  portalLinkStatus,
} from "../lib/contractor-invoice-portal.ts";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}

const sufixo = randomUUID().slice(0, 8);
/* Dois grupos: o segundo existe só para provar que o token de um não alcança o
   link do outro. Sem vizinho, "não vazou" seria uma frase sobre um banco com um
   inquilino só. */
const grupos = ["a", "b"].map((letra) => {
  const workspaceId = `ws-portal-${letra}-${sufixo}`;
  return {
    workspaceId,
    userId: `${workspaceId}-user`,
    companyId: `${workspaceId}-co`,
    cycleId: `${workspaceId}-cy`,
    providerId: `${workspaceId}-pj`,
    closingId: `${workspaceId}-ccl`,
  };
});
const [alfa, beta] = grupos;
const competence = "2099-09";

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

/* A semente vai pelo driver direto, pelo mesmo motivo do ensaio de notas:
   `fdp_workspace_members` é uma das tabelas sem RLS e o produto garante o
   recorte dela pelo WHERE de cada consulta. O código sob ensaio continua
   sendo chamado pelo adaptador de verdade. */
async function comTenant(workspaceId, executar) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const resultado = await executar(client);
    await client.query("COMMIT");
    return resultado;
  } catch (erro) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

const falhas = [];
const conferir = (nome, condicao, detalhe = "") => {
  if (condicao) console.log(`✓ ${nome}`);
  else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ""}`);
    console.error(`✗ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};

/** Espera que o banco recuse. Passar aqui é a constraint fazendo o trabalho. */
async function recusa(nome, workspaceId, executar) {
  try {
    await comTenant(workspaceId, executar);
    conferir(nome, false, "o banco aceitou");
  } catch (erro) {
    conferir(nome, true, "");
    void erro;
  }
}

function semear(grupo) {
  const { workspaceId, userId, companyId, cycleId, providerId, closingId } = grupo;
  return comTenant(workspaceId, async (client) => {
    await client.query("INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Analista do ensaio')",
      [userId, `${workspaceId}@ensaio.test`]);
    await client.query("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)",
      [workspaceId, "Grupo do ensaio", workspaceId, userId]);
    await client.query("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, userId]);
    await client.query(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, city)
      VALUES ($1, $2, 'Empresa do ensaio', 'Ensaio', '11222333000181', 'Belo Horizonte')`, [companyId, workspaceId]);
    await client.query(`INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
      VALUES ($1, $2, $3, $4, 'open', $5)`, [cycleId, workspaceId, companyId, competence, userId]);
    await client.query(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, tax_id)
      VALUES ($1, $2, 'contractor', 'XPTO', 'Empresa XPTO LTDA', '26016500000105')`, [providerId, workspaceId]);
    await client.query(`INSERT INTO fdp_contractor_profiles
        (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
      VALUES ($1, $2, $3, 6000, 'caju_saldo_livre', $4)`, [providerId, workspaceId, companyId, userId]);
    await client.query(`INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id,
        competence, base_amount, net_amount, invoice_limit_amount, invoice_limit_source, invoice_expected_amount,
        complement_amount, complement_method, calc_version, created_by, invoice_review_status)
      VALUES ($1, $2, $3, $4, $5, $6, 6000, 6000, 6000, 'workspace', 6000, 0, 'caju_saldo_livre', 'ensaio', $7, 'awaiting_issue')`,
    [closingId, workspaceId, companyId, providerId, cycleId, competence, userId]);
  });
}

async function limpar() {
  await comTenant(alfa.workspaceId, async (client) => {
    await client.query("REVOKE ALL ON fdp_contractor_invoice_portal_links FROM fdp_portal_probe");
    await client.query("DROP ROLE IF EXISTS fdp_portal_probe");
  }).catch(() => undefined);
  for (const grupo of grupos) {
    await comTenant(grupo.workspaceId, async (client) => {
      await client.query("DELETE FROM fdp_workspaces WHERE id = $1", [grupo.workspaceId]);
      await client.query("DELETE FROM fdp_users WHERE id = $1", [grupo.userId]);
    }).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
}

function inserirLink(client, grupo, token, extras = {}) {
  const { expiresAt = portalExpiryFromDays(10).toISOString(), id = randomUUID() } = extras;
  return client.query(`INSERT INTO fdp_contractor_invoice_portal_links
      (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence,
       token_hash, expires_at, expected_amount, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 6000, $10) RETURNING id`,
  [id, grupo.workspaceId, grupo.companyId, grupo.providerId, grupo.cycleId, grupo.closingId,
    competence, token.hash, expiresAt, grupo.userId]);
}

async function main() {
  for (const grupo of grupos) await semear(grupo);

  /* 1. O link nasce e é encontrado pelo token — pelo caminho que a rota pública
        usa: hash do segredo, dentro do inquilino que o token declara. */
  const token = createPortalToken(alfa.workspaceId);
  const linkId = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await inserirLink(client, alfa, token);
    return rows[0].id;
  });

  const lido = parsePortalToken(token.token);
  conferir("o token devolve o inquilino de quem o gerou", lido?.workspaceId === alfa.workspaceId, String(lido?.workspaceId));

  const encontrado = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT id, expires_at, submitted_at, revoked_at FROM fdp_contractor_invoice_portal_links WHERE workspace_id = $1 AND token_hash = $2",
      [alfa.workspaceId, hashPortalToken(lido.workspaceId, lido.secret)]);
    return rows[0];
  });
  conferir("o hash do segredo encontra o link", encontrado?.id === linkId, String(encontrado?.id));
  conferir("o link nasce ativo", portalLinkStatus(encontrado) === "active", portalLinkStatus(encontrado ?? { expires_at: 0 }));

  /* 2. O segredo não está no banco em lugar nenhum. É a promessa que o hash
        existe para cumprir, e ela não se verifica lendo o código. */
  const vazou = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS total FROM fdp_contractor_invoice_portal_links WHERE workspace_id = $1 AND token_hash = $2",
      [alfa.workspaceId, token.secret]);
    return rows[0].total;
  });
  conferir("o segredo em claro não encontra nada no banco", vazou === 0, `linhas=${vazou}`);

  /* 3. Um link aberto por fechamento. O índice parcial é o que impede o
        prestador de receber dois endereços válidos e adivinhar qual usar. */
  await recusa("o segundo link aberto do mesmo fechamento é recusado", alfa.workspaceId,
    (client) => inserirLink(client, alfa, createPortalToken(alfa.workspaceId)));

  /* Depois de revogado, o lugar abre de novo: é isso que permite "gerar outro"
     sem apagar o histórico do anterior. */
  await comTenant(alfa.workspaceId, (client) => client.query(
    `UPDATE fdp_contractor_invoice_portal_links SET revoked_at = now(), revoked_by = $1, revoke_reason = 'ensaio'
     WHERE workspace_id = $2 AND id = $3`, [alfa.userId, alfa.workspaceId, linkId]));
  const token2 = createPortalToken(alfa.workspaceId);
  const link2 = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await inserirLink(client, alfa, token2);
    return rows[0].id;
  });
  conferir("revogado o primeiro, o segundo link entra", Boolean(link2), String(link2));

  /* 4. Meio fato é recusado: revogar sem autor, entregar sem nota. */
  await recusa("revogar sem dizer quem revogou é recusado", alfa.workspaceId,
    (client) => client.query(
      "UPDATE fdp_contractor_invoice_portal_links SET revoked_at = now() WHERE workspace_id = $1 AND id = $2",
      [alfa.workspaceId, link2]));
  await recusa("marcar como entregue sem a nota é recusado", alfa.workspaceId,
    (client) => client.query(
      "UPDATE fdp_contractor_invoice_portal_links SET submitted_at = now() WHERE workspace_id = $1 AND id = $2",
      [alfa.workspaceId, link2]));

  /* 5. O token do grupo A não alcança o link dentro do grupo B, com RLS ligada.
        É a prova do isolamento no caminho que o portal realmente percorre.

        A sonda troca de papel antes de consultar, e isso não é detalhe: o dono
        da tabela com FORCE RLS obedece às políticas, mas superusuário as
        ignora — e a maioria dos bancos de ensaio é aberta como superusuário.
        Sem o `SET LOCAL ROLE`, esta verificação passaria sempre, inclusive com
        a RLS desligada, que é o pior tipo de prova: a que não pode falhar. */
  const tokenBeta = createPortalToken(beta.workspaceId);
  await comTenant(beta.workspaceId, (client) => inserirLink(client, beta, tokenBeta));
  const cruzado = await comTenant(alfa.workspaceId, async (client) => {
    await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdp_portal_probe') THEN
          CREATE ROLE fdp_portal_probe NOLOGIN NOBYPASSRLS;
        END IF;
      END $$;`);
    await client.query("GRANT SELECT ON fdp_contractor_invoice_portal_links TO fdp_portal_probe");
    await client.query("SET LOCAL ROLE fdp_portal_probe");
    const { rows } = await client.query(
      "SELECT count(*)::int AS total FROM fdp_contractor_invoice_portal_links WHERE token_hash = $1",
      [tokenBeta.hash]);
    await client.query("RESET ROLE");
    return rows[0].total;
  });
  conferir("dentro do grupo A, o link do grupo B não existe", cruzado === 0, `linhas=${cruzado}`);

  /* E a sonda é conferida contra si mesma: sob o papel restrito, o link do
     próprio grupo continua visível. Sem isto, "0 linhas" poderia ser apenas
     falta de permissão, e não isolamento. */
  const proprio = await comTenant(alfa.workspaceId, async (client) => {
    await client.query("SET LOCAL ROLE fdp_portal_probe");
    const { rows } = await client.query(
      "SELECT count(*)::int AS total FROM fdp_contractor_invoice_portal_links WHERE workspace_id = $1",
      [alfa.workspaceId]);
    await client.query("RESET ROLE");
    return rows[0].total;
  });
  conferir("e o papel da sonda enxerga os links do próprio grupo", proprio > 0, `linhas=${proprio}`);
  // E o hash nem chega a bater: ele é calculado sobre inquilino + segredo.
  conferir("trocar o prefixo do token não reaproveita o segredo",
    hashPortalToken(alfa.workspaceId, tokenBeta.secret) !== tokenBeta.hash);

  /* 6. O envio do prestador: nota e arquivo sem pessoa, pelo mesmo
        `registerInvoice` da tela. É aqui que o CHECK novo é exercido de fato. */
  const d1Alfa = getScopedD1({ workspaceId: alfa.workspaceId });
  const documentId = randomUUID();
  await comTenant(alfa.workspaceId, (client) => client.query(
    `INSERT INTO fdp_contractor_documents (id, workspace_id, company_id, provider_id, closing_id, document_kind,
        competence, invoice_number, object_key, filename, content_type, size_bytes, created_by, created_via)
     VALUES ($1, $2, $3, $4, $5, 'invoice', $6, '9001', $7, 'nota.pdf', 'application/pdf', 1024, NULL, 'contractor_portal')`,
    [documentId, alfa.workspaceId, alfa.companyId, alfa.providerId, alfa.closingId, competence,
      `workspaces/${alfa.workspaceId}/ensaio/${documentId}`]));
  conferir("o arquivo do portal entra sem autor no workspace", true);

  const registrada = await registerInvoice(d1Alfa, {
    workspaceId: alfa.workspaceId,
    closing: {
      id: alfa.closingId, company_id: alfa.companyId, provider_id: alfa.providerId,
      payroll_cycle_id: alfa.cycleId, competence, invoice_expected_amount: 6000,
    },
    invoiceNumber: "9001", series: "1", issueDate: `${competence}-05`,
    issuerDocument: "26016500000105", issuerName: "Empresa XPTO LTDA",
    receiverDocument: "11222333000181", serviceDescription: "", amount: 6000, notes: "",
    documentId, duplicateAck: false, replacesInvoiceId: null,
    actor: { kind: "contractor_portal", name: "Empresa XPTO LTDA" },
    ip: "203.0.113.9", userAgent: "ensaio",
  });

  const nota = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT uploaded_by, uploaded_via, amount FROM fdp_contractor_invoices WHERE workspace_id = $1 AND id = $2",
      [alfa.workspaceId, registrada.invoiceId]);
    return rows[0];
  });
  conferir("a nota do portal fica sem pessoa que a enviou", nota?.uploaded_by === null, String(nota?.uploaded_by));
  conferir("e registra por onde entrou", nota?.uploaded_via === "contractor_portal", String(nota?.uploaded_via));

  const evento = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      `SELECT actor_user_id, actor_kind, actor_label, summary FROM fdp_contractor_invoice_events
       WHERE workspace_id = $1 AND invoice_id = $2 AND action = 'uploaded'`,
      [alfa.workspaceId, registrada.invoiceId]);
    return rows[0];
  });
  conferir("o histórico não atribui o envio a nenhuma pessoa", evento?.actor_user_id === null, String(evento?.actor_user_id));
  conferir("o histórico nomeia quem enviou", evento?.actor_label === "Empresa XPTO LTDA", String(evento?.actor_label));
  conferir("e diz que o ator é o portal", evento?.actor_kind === "contractor_portal", String(evento?.actor_kind));

  /* 7. O CHECK não afrouxou para o caminho do painel: nota sem pessoa por ali
        continua recusada, e ator de portal sem nome também. */
  await recusa("nota pelo painel sem pessoa continua recusada", alfa.workspaceId,
    (client) => client.query(
      `INSERT INTO fdp_contractor_invoices (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id,
          competence, invoice_number, issue_date, amount, expected_amount, difference_amount, uploaded_by, uploaded_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '9002', $8, 100, 100, 0, NULL, 'panel')`,
      [randomUUID(), alfa.workspaceId, alfa.companyId, alfa.providerId, alfa.cycleId, alfa.closingId,
        competence, `${competence}-06`]));

  await recusa("ator do portal sem nome é recusado no histórico", alfa.workspaceId,
    (client) => client.query(
      `INSERT INTO fdp_contractor_invoice_events (id, workspace_id, invoice_id, closing_id, provider_id,
          competence, action, actor_user_id, actor_kind, actor_label)
       VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', NULL, 'contractor_portal', '')`,
      [randomUUID(), alfa.workspaceId, registrada.invoiceId, alfa.closingId, alfa.providerId, competence]));

  /* 8. Fechado o link com a nota, ele para de aceitar envio — e a situação
        conta a história certa para quem abrir o endereço depois. */
  await comTenant(alfa.workspaceId, (client) => client.query(
    `UPDATE fdp_contractor_invoice_portal_links SET submitted_at = now(), submitted_invoice_id = $1
     WHERE workspace_id = $2 AND id = $3`, [registrada.invoiceId, alfa.workspaceId, link2]));
  const fechado = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT expires_at, submitted_at, revoked_at FROM fdp_contractor_invoice_portal_links WHERE workspace_id = $1 AND id = $2",
      [alfa.workspaceId, link2]);
    return rows[0];
  });
  conferir("o link entregue passa a 'nota recebida'", portalLinkStatus(fechado) === "submitted", portalLinkStatus(fechado));

  /* E com o lugar livre de novo, o próximo link do fechamento pode nascer: é o
     caminho da substituição pedida pela conferência. */
  const link3 = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await inserirLink(client, alfa, createPortalToken(alfa.workspaceId));
    return rows[0].id;
  });
  conferir("entregue o anterior, um link novo ainda pode ser gerado", Boolean(link3));
}

try {
  await main();
} finally {
  await limpar();
}

if (falhas.length) {
  console.error(`\n${falhas.length} verificação(ões) do portal reprovaram.`);
  process.exit(1);
}
console.log("\nEnsaio do portal do prestador aprovado: token, isolamento, ator sem pessoa e travas do link verificados contra o banco.");
