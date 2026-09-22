/**
 * Ensaio do OCR de fotos de documento contra um PostgreSQL real.
 *
 * Mesma razão de `rehearse-admission-sheet.mjs`, para a tabela irmã: o que
 * cerca `fdp_admission_sheet_photo_ocr` é decidido pelo banco, não pela
 * aplicação, e nada disso é verificável sem banco — `tsc` aceita uma FK
 * inexistente, e um teste de unidade aceita uma RLS que nunca foi ligada.
 *
 * O que este ensaio prova, e um teste de unidade não provaria:
 *
 * 1. a sugestão de um grupo não é alcançável do outro, com a RLS forçada e um
 *    papel sem superusuário;
 * 2. apagar o anexo apaga a sugestão lida dele — a sugestão não sobrevive à
 *    foto que alguém acreditou ter removido;
 * 3. apagar a demanda apaga a sugestão junto;
 * 4. um resultado por anexo: reenfileirar substitui, nunca acumula;
 * 5. reenfileirar uma sugestão já `ready` (via `enqueuePhotoOcr`) não a
 *    derruba — só um `attachment_id` novo abre um preparo novo;
 * 6. o CHECK recusa `ready` sem envelope cifrado;
 * 7. o ciclo inteiro fecha — selar, gravar, reler do banco e abrir devolve
 *    exatamente os campos que entraram, e o texto claro nunca está na coluna.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" FDP_DB_DRIVER=pg \
 *   node --experimental-strip-types scripts/rehearse-admission-sheet-photo-ocr.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve fica
 * dentro de dois grupos próprios, criados e apagados por ele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { openSheet, sealSheet } from "../lib/admission-sheet.ts";
import { getScopedD1 } from "../db/index.ts";
import { enqueuePhotoOcr } from "../lib/admission-sheet-photo-ocr-service.ts";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}
process.env.FDP_INTEGRATION_VAULT_KEY ??= Buffer.alloc(32, 9).toString("base64");

const sufixo = randomUUID().slice(0, 8);
/* Dois grupos, pela mesma razão do ensaio da ficha: sem vizinho, "não vazou" é
   uma frase sobre um banco com um inquilino só. */
const grupos = ["a", "b"].map((letra) => {
  const workspaceId = `ws-ocr-${letra}-${sufixo}`;
  return {
    workspaceId,
    userId: `${workspaceId}-user`,
    boardId: `${workspaceId}-board`,
    listId: `${workspaceId}-list`,
    cardId: `${workspaceId}-card`,
    attachmentId: `${workspaceId}-foto`,
    ocrId: `${workspaceId}-ocr`,
  };
});
const [alfa, beta] = grupos;

/* Documento fabricado com dígito verificador recalculado. Não pertence a ninguém. */
const CAMPOS = { taxId: "111.222.333-96", fullName: "FULANA DE TAL" };

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

/** Mesma guarda de `rehearse-admission-sheet.mjs`: um ensaio que ignora RLS mente. */
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
      VALUES ($1, $2, $3, $4, 'rg-frente.jpg', 'image/jpeg', 2048, $5)`,
      [attachmentId, workspaceId, cardId, `${workspaceId}/rg-frente.jpg`, userId]);
  });
}

function gravarOcr(grupo, { ocrId = grupo.ocrId, state = "ready" } = {}) {
  const selado = sealSheet(CAMPOS);
  return comTenant(grupo.workspaceId, (client) => client.query(
    `INSERT INTO fdp_admission_sheet_photo_ocr
       (id, workspace_id, card_id, attachment_id, source_filename, state, encrypted_value,
        initialization_vector, auth_tag, key_version, confidence_json)
     VALUES ($1, $2, $3, $4, 'rg-frente.jpg', $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, attachment_id) DO UPDATE SET
       id = EXCLUDED.id, state = EXCLUDED.state, encrypted_value = EXCLUDED.encrypted_value,
       initialization_vector = EXCLUDED.initialization_vector, auth_tag = EXCLUDED.auth_tag,
       key_version = EXCLUDED.key_version, confidence_json = EXCLUDED.confidence_json,
       updated_at = CURRENT_TIMESTAMP`,
    [ocrId, grupo.workspaceId, grupo.cardId, grupo.attachmentId, state, selado.encryptedValue,
      selado.initializationVector, selado.authTag, selado.keyVersion, JSON.stringify({ taxId: "ok", fullName: "low" })],
  ));
}

const contar = (grupo) => comTenant(grupo.workspaceId, async (client) => {
  const { rows } = await client.query(
    "SELECT count(*)::int AS total FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1", [grupo.attachmentId]);
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
  await gravarOcr(alfa);
  await gravarOcr(beta);

  // 1. O ciclo fecha, e o texto claro não está na coluna.
  const guardada = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_value, initialization_vector, auth_tag, key_version
       FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1`, [alfa.attachmentId]);
    return rows[0];
  });
  const aberta = openSheet({
    encryptedValue: guardada.encrypted_value,
    initializationVector: guardada.initialization_vector,
    authTag: guardada.auth_tag,
    keyVersion: guardada.key_version,
  });
  const mesmosCampos = Object.keys(CAMPOS).length === Object.keys(aberta).length
    && Object.entries(CAMPOS).every(([chave, valor]) => aberta[chave] === valor);
  conferir("selar, gravar, reler e abrir devolve os mesmos campos", mesmosCampos, JSON.stringify(aberta));
  conferir("o texto claro não sobrevive na coluna",
    !guardada.encrypted_value.includes("FULANA") && !guardada.encrypted_value.includes("111.222"));

  // 2. Isolamento entre inquilinos, com RLS forçada.
  const vazamento = await comTenant(beta.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS total FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1", [alfa.attachmentId]);
    return rows[0].total;
  });
  conferir("a sugestão de um grupo não é alcançável do outro", vazamento === 0, `viu ${vazamento} linha(s)`);

  // 3. Um resultado por anexo: reenfileirar substitui.
  await gravarOcr(alfa, { ocrId: `${alfa.ocrId}-2` });
  const totalAlfa = await contar(alfa);
  conferir("um resultado por anexo — reenfileirar substitui, nunca acumula", totalAlfa === 1, `${totalAlfa} linha(s)`);

  // 4. `enqueuePhotoOcr` não derruba uma sugestão já pronta do MESMO anexo.
  const escopado = getScopedD1({ workspaceId: alfa.workspaceId, userId: null });
  const reenfileirado = await enqueuePhotoOcr(escopado, {
    workspaceId: alfa.workspaceId, cardId: alfa.cardId,
    attachment: { id: alfa.attachmentId, filename: "rg-frente.jpg", contentType: "image/jpeg" },
  });
  conferir("reenfileirar o MESMO anexo não derruba a sugestão já pronta", reenfileirado.enqueued === false,
    `enqueued=${reenfileirado.enqueued}`);
  const aindaReady = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT state FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1", [alfa.attachmentId]);
    return rows[0]?.state;
  });
  conferir("a sugestão continua pronta depois da tentativa de reenfileirar", aindaReady === "ready", String(aindaReady));

  // 5. Anexo que não é foto (PDF) não enfileira OCR — `enqueuePhotoOcr` sai cedo.
  const naoEnfileirado = await enqueuePhotoOcr(escopado, {
    workspaceId: alfa.workspaceId, cardId: alfa.cardId,
    attachment: { id: `${alfa.attachmentId}-pdf`, filename: "ficha.pdf", contentType: "application/pdf" },
  });
  conferir("anexo que não é foto não enfileira OCR", naoEnfileirado.enqueued === false);

  // 6. `ready` sem envelope cifrado é recusado pelo banco.
  await comTenant(alfa.workspaceId, (client) => client.query(
    "DELETE FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1", [alfa.attachmentId]));
  await recusa("sugestão que se diz pronta sem envelope é recusada", alfa.workspaceId,
    (client) => client.query(
      `INSERT INTO fdp_admission_sheet_photo_ocr (id, workspace_id, card_id, attachment_id, state)
       VALUES ($1, $2, $3, $4, 'ready')`,
      [`${alfa.ocrId}-vazio`, alfa.workspaceId, alfa.cardId, alfa.attachmentId]));

  // 7. `pending` sem envelope é o estado normal de quem ainda não foi lido.
  await comTenant(alfa.workspaceId, (client) => client.query(
    `INSERT INTO fdp_admission_sheet_photo_ocr (id, workspace_id, card_id, attachment_id, state)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [`${alfa.ocrId}-p`, alfa.workspaceId, alfa.cardId, alfa.attachmentId]));
  const pendente = await comTenant(alfa.workspaceId, async (client) => {
    const { rows } = await client.query(
      "SELECT state, encrypted_value FROM fdp_admission_sheet_photo_ocr WHERE attachment_id = $1", [alfa.attachmentId]);
    return rows[0];
  });
  conferir("sugestão pendente existe antes de haver o que cifrar",
    pendente.state === "pending" && pendente.encrypted_value === null);

  // 8. Tentativas fora do intervalo aceito são recusadas.
  await recusa("tentativas acima do teto são recusadas", alfa.workspaceId,
    (client) => client.query(
      "UPDATE fdp_admission_sheet_photo_ocr SET attempts = 21 WHERE attachment_id = $1", [alfa.attachmentId]));

  // 9. Apagar o anexo apaga a sugestão lida dele.
  await comTenant(alfa.workspaceId, (client) =>
    client.query("DELETE FROM fdp_card_attachments WHERE id = $1", [alfa.attachmentId]));
  const aposAnexo = await contar(alfa);
  conferir("apagar o anexo apaga a sugestão lida dele", aposAnexo === 0, `${aposAnexo} linha(s)`);

  // 10. Apagar a demanda apaga a sugestão junto.
  const aposCartaoAntes = await contar(beta);
  await comTenant(beta.workspaceId, (client) => client.query("DELETE FROM fdp_cards WHERE id = $1", [beta.cardId]));
  const aposCartao = await contar(beta);
  conferir("apagar a demanda apaga a sugestão junto", aposCartaoAntes === 1 && aposCartao === 0, `${aposCartao} linha(s)`);
} finally {
  await limpar();
  await pool.end();
}

if (falhas.length) {
  console.error(`\n${falhas.length} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nEnsaio do OCR de fotos de documento aprovado.");
