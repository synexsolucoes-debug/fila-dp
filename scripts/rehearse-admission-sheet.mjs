/**
 * Ensaio da ficha de contratação contra um PostgreSQL real.
 *
 * A ficha é a única coisa no produto que guarda valor de documento, e tudo o
 * que a cerca é decidido pelo banco — não pela aplicação. Nada disso é
 * verificável sem banco: `tsc` aceita uma chave estrangeira que não existe, e
 * um teste de unidade aceita uma RLS que nunca foi ligada.
 *
 * O que este ensaio prova, e um teste de unidade não provaria:
 *
 * 1. a ficha de um grupo não é alcançável do outro, com a RLS forçada e um
 *    papel sem superusuário;
 * 2. apagar o anexo apaga a ficha lida dele — transcrição não sobrevive ao
 *    documento que alguém acreditou ter removido;
 * 3. apagar a demanda apaga a ficha junto;
 * 4. existe uma ficha por demanda: reler substitui, nunca acumula;
 * 5. o CHECK recusa contagem impossível (mais campos conferidos do que
 *    preenchidos), que é o sintoma de leitura corrompida;
 * 6. o ciclo inteiro fecha — selar, gravar, reler do banco e abrir devolve
 *    exatamente os campos que entraram, e o texto claro nunca está na coluna.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" FDP_DB_DRIVER=pg \
 *   node --experimental-strip-types scripts/rehearse-admission-sheet.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve fica
 * dentro de dois grupos próprios, criados e apagados por ele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { openSheet, sealSheet } from "../lib/admission-sheet.ts";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}
process.env.FDP_INTEGRATION_VAULT_KEY ??= Buffer.alloc(32, 9).toString("base64");

const sufixo = randomUUID().slice(0, 8);
/* Dois grupos: o segundo existe só para provar que a ficha de um não alcança o
   outro. Sem vizinho, "não vazou" seria uma frase sobre um banco com um
   inquilino só. */
const grupos = ["a", "b"].map((letra) => {
  const workspaceId = `ws-ficha-${letra}-${sufixo}`;
  return {
    workspaceId,
    userId: `${workspaceId}-user`,
    boardId: `${workspaceId}-board`,
    listId: `${workspaceId}-list`,
    cardId: `${workspaceId}-card`,
    attachmentId: `${workspaceId}-anexo`,
    sheetId: `${workspaceId}-ficha`,
  };
});
const [alfa, beta] = grupos;

/* Os documentos são fabricados com dígito verificador recalculado. Nenhum deles
   pertence a uma pessoa. */
const CAMPOS = {
  fullName: "FULANA DE TAL",
  taxId: "111.222.333-96",
  pisNumber: "123.45678.90-0",
  admissionDate: "13/10/2025",
};

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

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

/**
 * O ensaio recusa papel que ignora RLS.
 *
 * Com `postgres` — superusuário — o PostgreSQL passa por cima de toda política,
 * e a verificação de vazamento entre grupos imprimiria ✓ sem ter provado nada.
 * Foi exatamente o que aconteceu na primeira execução deste arquivo. Um ensaio
 * que mente é pior que ensaio nenhum: ele encerra a dúvida sem responder.
 *
 * Mesma guarda de `scripts/verify-tenant-isolation.mjs`, pelo mesmo motivo.
 */
async function exigirPapelComRls() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT current_user AS papel, rolsuper AS superusuario, rolbypassrls AS ignora FROM pg_roles WHERE rolname = current_user");
    const papel = rows[0];
    if (papel?.superusuario || papel?.ignora) {
      throw new Error(`O ensaio precisa de um papel sem superusuário e sem BYPASSRLS — ${papel.papel} `
        + `tem superuser=${papel.superusuario}, bypassrls=${papel.ignora}. Com ele a RLS é ignorada e nada seria provado.`);
    }
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
  const { workspaceId, userId, boardId, listId, cardId, attachmentId } = grupo;
  return comTenant(workspaceId, async (client) => {
    await client.query("INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Analista do ensaio')",
      [userId, `${workspaceId}@ensaio.test`]);
    await client.query("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)",
      [workspaceId, "Grupo do ensaio", workspaceId, userId]);
    await client.query("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, userId]);
    await client.query("INSERT INTO fdp_boards (id, workspace_id, name) VALUES ($1, $2, 'Quadro do ensaio')",
      [boardId, workspaceId]);
    await client.query("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position) VALUES ($1, $2, $3, 'Entrada', 'entry', 1)",
      [listId, workspaceId, boardId]);
    await client.query(`INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, position, created_by)
      VALUES ($1, $2, $3, $4, 'Admissão ERP — Fulana de Tal', 1, $5)`,
      [cardId, workspaceId, boardId, listId, userId]);
    await client.query(`INSERT INTO fdp_card_attachments
        (id, workspace_id, card_id, object_key, filename, content_type, size_bytes, uploaded_by)
      VALUES ($1, $2, $3, $4, 'ficha-cadastral-solides.pdf', 'application/pdf', 4096, $5)`,
      [attachmentId, workspaceId, cardId, `${workspaceId}/ficha.pdf`, userId]);
  });
}

function gravarFicha(grupo, { sheetId = grupo.sheetId, filled = 4, readable = 4 } = {}) {
  const selado = sealSheet(CAMPOS);
  return comTenant(grupo.workspaceId, (client) => client.query(
    `INSERT INTO fdp_admission_sheets
       (id, workspace_id, card_id, attachment_id, source_filename, encrypted_value, initialization_vector,
        auth_tag, key_version, filled_count, readable_count, warnings_json, created_by)
     VALUES ($1, $2, $3, $4, 'ficha-cadastral-solides.pdf', $5, $6, $7, $8, $9, $10, '[]', $11)
     ON CONFLICT (workspace_id, card_id) DO UPDATE SET
       encrypted_value = EXCLUDED.encrypted_value, initialization_vector = EXCLUDED.initialization_vector,
       auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version,
       filled_count = EXCLUDED.filled_count, readable_count = EXCLUDED.readable_count,
       updated_at = CURRENT_TIMESTAMP`,
    [sheetId, grupo.workspaceId, grupo.cardId, grupo.attachmentId, selado.encryptedValue,
      selado.initializationVector, selado.authTag, selado.keyVersion, filled, readable, grupo.userId],
  ));
}

const contar = (grupo) => comTenant(grupo.workspaceId, async (client) => {
  const { rows } = await client.query("SELECT count(*)::int AS total FROM fdp_admission_sheets WHERE card_id = $1", [grupo.cardId]);
  return rows[0].total;
});

async function limpar() {
  for (const grupo of grupos) {
    await comTenant(grupo.workspaceId, async (client) => {
      await client.query("DELETE FROM fdp_workspaces WHERE id = $1", [grupo.workspaceId]);
      await client.query("DELETE FROM fdp_users WHERE id = $1", [grupo.userId]);
    }).catch(() => undefined);
  }
}

try {
  await exigirPapelComRls();
  await limpar();
  for (const grupo of grupos) await semear(grupo);
  await gravarFicha(alfa);
  await gravarFicha(beta);

  // 1. O ciclo fecha, e o texto claro não está na coluna.
  const guardada = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, initialization_vector, auth_tag, key_version
       FROM fdp_admission_sheets WHERE card_id = $1`, [alfa.cardId]);
    return rows[0];
  });
  const aberta = openSheet({
    encryptedValue: guardada.encrypted_value,
    initializationVector: guardada.initialization_vector,
    authTag: guardada.auth_tag,
    keyVersion: guardada.key_version,
  });
  /* Comparação insensível à ordem das chaves: `sealSheet` ordena o texto claro
     de propósito, para que o mesmo conteúdo produza sempre o mesmo envelope. */
  const mesmosCampos = Object.keys(CAMPOS).length === Object.keys(aberta).length
    && Object.entries(CAMPOS).every(([chave, valor]) => aberta[chave] === valor);
  conferir("selar, gravar, reler e abrir devolve os mesmos campos", mesmosCampos, JSON.stringify(aberta));
  conferir("o texto claro não sobrevive na coluna",
    !guardada.encrypted_value.includes("FULANA") && !guardada.encrypted_value.includes("111.222"));

  // 2. Isolamento entre inquilinos, com RLS forçada.
  const vazamento = await comTenant(beta.workspaceId, async (client) => {
    const { rows } = await client.query("SELECT count(*)::int AS total FROM fdp_admission_sheets WHERE card_id = $1", [alfa.cardId]);
    return rows[0].total;
  });
  conferir("a ficha de um grupo não é alcançável do outro", vazamento === 0, `viu ${vazamento} linha(s)`);

  // 3. Uma ficha por demanda: reler substitui.
  await gravarFicha(alfa, { sheetId: `${alfa.sheetId}-2`, filled: 40, readable: 37 });
  const totalAlfa = await contar(alfa);
  conferir("reler a ficha substitui, nunca acumula", totalAlfa === 1, `${totalAlfa} linha(s)`);

  // 4. Contagem impossível é recusada pelo banco.
  await recusa("contagem impossível é recusada (conferidos > preenchidos)", alfa.workspaceId,
    (client) => client.query("UPDATE fdp_admission_sheets SET readable_count = filled_count + 1 WHERE card_id = $1", [alfa.cardId]));

  // 5. Apagar o anexo apaga a ficha lida dele.
  await comTenant(alfa.workspaceId, (client) =>
    client.query("DELETE FROM fdp_card_attachments WHERE id = $1", [alfa.attachmentId]));
  const aposAnexo = await contar(alfa);
  conferir("apagar o anexo apaga a ficha lida dele", aposAnexo === 0, `${aposAnexo} linha(s)`);

  // 6. Apagar a demanda apaga a ficha junto.
  const aposCartaoAntes = await contar(beta);
  await comTenant(beta.workspaceId, (client) => client.query("DELETE FROM fdp_cards WHERE id = $1", [beta.cardId]));
  const aposCartao = await contar(beta);
  conferir("apagar a demanda apaga a ficha junto", aposCartaoAntes === 1 && aposCartao === 0, `${aposCartao} linha(s)`);
} finally {
  await limpar();
  await pool.end();
}

if (falhas.length) {
  console.error(`\n${falhas.length} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nEnsaio da ficha de contratação aprovado.");
