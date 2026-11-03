/**
 * Fila do que foi feito sem rede.
 *
 * A regra é a mesma do app de campo na web: **o que foi feito diante do
 * colaborador não se perde.** Toda gravação passa por aqui com uma chave de
 * idempotência que nasce uma vez e acompanha a operação em todas as tentativas;
 * o servidor deduplica por ela, então reenviar nunca cria uma segunda entrega.
 *
 * A fila mora no SQLite do aparelho (incluído no Expo Go). O anexo — assinatura
 * ou foto — é um arquivo na pasta de documentos do app, que sobrevive a fechar
 * o app; a fila guarda só o caminho.
 *
 * O anexo vai depois do registro, e não junto: o id do registro é gerado pelo
 * servidor. Quando só o anexo falha, o id fica guardado e a repetição envia
 * apenas o que falta — a tela diz "registrado, falta a evidência" em vez de
 * mandar colher a assinatura de novo.
 *
 * Higienização e descarte **não** entram aqui, de propósito: são decisões sobre
 * um registro que já existe, e o servidor recusa a segunda decisão. Uma decisão
 * enfileirada poderia chegar depois de alguém decidir o contrário no painel.
 */
import * as SQLite from "expo-sqlite";
import { File } from "expo-file-system";
import { api, isPermanent } from "./api";

export type QueuedKind = "delivery" | "return" | "damage" | "stock_entry" | "stock_transfer";

export type QueuedAttachment = {
  /** Arquivo local (`file://…`) na pasta de documentos do app. */
  uri: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg";
  /** `delivery_term` para assinatura, `photo` para foto do dano. */
  kind: "delivery_term" | "photo" | "evidence";
};

export type QueuedOperation = {
  id: string;
  kind: QueuedKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attachment: QueuedAttachment | null;
  /** Id devolvido pelo servidor quando o registro já foi aceito e só falta o anexo. */
  recordId: string;
  label: string;
  /** E-mail de quem registrou. Na troca de turno, o app avisa antes de sair. */
  owner: string;
  createdAt: number;
  attempts: number;
  lastError: string;
};

const endpoints: Record<QueuedKind, string> = {
  delivery: "/api/epi/deliveries",
  return: "/api/epi/returns",
  damage: "/api/epi/damages",
  stock_entry: "/api/epi/stock/entries",
  stock_transfer: "/api/epi/stock/transfers",
};

/** Só os registros que aceitam anexo. Movimentação de estoque não leva evidência. */
const entityTypes: Partial<Record<QueuedKind, string>> = { delivery: "delivery", return: "return", damage: "damage" };

let database: SQLite.SQLiteDatabase | null = null;

function db() {
  if (!database) {
    database = SQLite.openDatabaseSync("vinculato-campo.db");
    database.execSync(`CREATE TABLE IF NOT EXISTS fila (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL
    )`);
  }
  return database;
}

async function put(operation: QueuedOperation) {
  await db().runAsync("INSERT OR REPLACE INTO fila (id, created_at, body) VALUES (?, ?, ?)",
    operation.id, operation.createdAt, JSON.stringify(operation));
}

async function remove(id: string) {
  await db().runAsync("DELETE FROM fila WHERE id = ?", id);
}

export async function listQueue(): Promise<QueuedOperation[]> {
  try {
    const rows = await db().getAllAsync<{ body: string }>("SELECT body FROM fila ORDER BY created_at");
    return rows.map((row) => JSON.parse(row.body) as QueuedOperation);
  } catch {
    // Armazenamento indisponível: a fila deixa de existir e o app segue com rede.
    return [];
  }
}

/** Apaga o arquivo do anexo depois de enviado ou descartado. */
function dropFile(attachment: QueuedAttachment | null) {
  if (!attachment) return;
  try { const file = new File(attachment.uri); if (file.exists) file.delete(); } catch { /* já não existe */ }
}

function uuid() {
  // `crypto.randomUUID` existe no Hermes atual; a reserva cobre versões antigas.
  const native = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (native) return native.call((globalThis as { crypto: object }).crypto);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const r = (Math.random() * 16) | 0;
    return (char === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function sendAttachment(entityType: string, entityId: string, attachment: QueuedAttachment) {
  const form = new FormData();
  form.append("entityType", entityType);
  form.append("entityId", entityId);
  form.append("kind", attachment.kind);
  // O `File` do expo-file-system é um Blob com nome e tipo: é o que o servidor
  // confere (extensão e MIME) antes de aceitar.
  form.append("file", new File(attachment.uri) as unknown as Blob, attachment.filename);
  await api("/api/epi/attachments", { method: "POST", body: form });
}

/** Registro primeiro, anexo depois. Guarda o id assim que o servidor aceita o registro. */
async function dispatch(operation: QueuedOperation) {
  let id = operation.recordId;
  if (!id) {
    const result = await api<Record<string, { id?: string } | undefined>>(endpoints[operation.kind], {
      method: "POST",
      headers: { "idempotency-key": operation.idempotencyKey },
      body: JSON.stringify(operation.payload),
    });
    const created = result[operation.kind] ?? result.delivery ?? result.return ?? result.damage ?? result.movement;
    id = created && typeof created === "object" ? String(created.id ?? "") : "";
    operation.recordId = id;
  }
  const entityType = entityTypes[operation.kind];
  if (operation.attachment && id && entityType) await sendAttachment(entityType, id, operation.attachment);
  return id;
}

export type SubmitResult = { status: "sent" | "queued" | "partial"; id?: string; detail?: string };

/**
 * Envia agora; se a rede falhar, guarda.
 *
 * Três resultados, três frases na tela: "registrado", "guardado para enviar" e
 * "registrado, falta a evidência" não são a mesma notícia — e o terceiro é o
 * único em que a pessoa não precisa colher a assinatura de novo.
 */
export async function submitOperation(input: {
  kind: QueuedKind;
  payload: Record<string, unknown>;
  attachment?: QueuedAttachment | null;
  label: string;
  owner: string;
}): Promise<SubmitResult> {
  const operation: QueuedOperation = {
    id: uuid(),
    kind: input.kind,
    idempotencyKey: `campo-app:${input.kind}:${uuid()}`,
    payload: input.payload,
    attachment: input.attachment ?? null,
    recordId: "",
    label: input.label,
    owner: input.owner,
    createdAt: Date.now(),
    attempts: 0,
    lastError: "",
  };
  try {
    const id = await dispatch(operation);
    dropFile(operation.attachment);
    return { status: "sent", id };
  } catch (error) {
    // Recusa do servidor antes de gravar: a tela mostra o motivo e nada fica na fila.
    if (isPermanent(error) && !operation.recordId) throw error;
    operation.attempts = 1;
    operation.lastError = error instanceof Error ? error.message : "Falha de rede.";
    await put(operation);
    return { status: operation.recordId ? "partial" : "queued", id: operation.recordId || undefined, detail: operation.lastError };
  }
}

let flushing: Promise<{ sent: number; failed: number; remaining: number }> | null = null;

/**
 * Esvazia a fila, uma operação por vez e na ordem em que foram feitas.
 *
 * Em falha de rede, para: insistir nas seguintes só somaria tentativas. Recusa
 * do servidor marca a pendência com o motivo e segue para a próxima. Duas
 * chamadas ao mesmo tempo (timer + volta ao app) compartilham a mesma rodada.
 */
export function flushQueue() {
  if (!flushing) {
    flushing = (async () => {
      let sent = 0; let failed = 0;
      for (const operation of await listQueue()) {
        try {
          await dispatch(operation);
          await remove(operation.id);
          dropFile(operation.attachment);
          sent += 1;
        } catch (error) {
          await put({ ...operation, attempts: operation.attempts + 1,
            lastError: error instanceof Error ? error.message : "Falha de rede." });
          if (isPermanent(error)) { failed += 1; continue; }
          break;
        }
      }
      return { sent, failed, remaining: (await listQueue()).length };
    })().finally(() => { flushing = null; });
  }
  return flushing;
}

/** Descarta uma pendência — usado só para a que o servidor recusou. */
export async function discardOperation(id: string) {
  const operation = (await listQueue()).find((item) => item.id === id);
  await remove(id);
  dropFile(operation?.attachment ?? null);
}
