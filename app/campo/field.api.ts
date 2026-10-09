"use client";

/**
 * Rede e fila do aplicativo de campo.
 *
 * O galpão tem rede ruim. A diferença entre um aplicativo que serve e um que
 * irrita está aqui: o que a pessoa fez diante do colaborador não pode se perder
 * porque o sinal caiu no momento do envio.
 *
 * A fila guarda a operação inteira no IndexedDB — inclusive a assinatura e a
 * foto, que são Blobs e sobrevivem à gravação — e a reenvia quando a rede
 * volta. O reenvio é seguro porque cada operação nasce com uma **chave de
 * idempotência** estável: o servidor já deduplica por ela e devolve o registro
 * existente em vez de criar um segundo. Sem essa chave a fila seria um gerador
 * de entregas duplicadas, que no estoque significa unidade a menos sem motivo.
 *
 * O anexo vai depois do registro, e não junto: o id do registro é gerado pelo
 * servidor. Como a resposta de repetição também carrega o `id`, uma entrega
 * reenviada ainda consegue receber a assinatura.
 */

export type QueuedKind = "delivery" | "return" | "damage";

export type QueuedAttachment = {
  blob: Blob;
  filename: string;
  /** `delivery_term` para assinatura, `photo` para foto do dano. */
  kind: "delivery_term" | "photo" | "evidence";
};

export type QueuedOperation = {
  id: string;
  kind: QueuedKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attachment: QueuedAttachment | null;
  /**
   * Id devolvido pelo servidor quando o registro já foi aceito.
   *
   * Existe para o caso que apareceu no ensaio de ponta a ponta: a entrega foi
   * gravada e só o anexo falhou. Com o id guardado, a repetição envia apenas o
   * que falta. A chave de idempotência cobriria o reenvio do registro, mas
   * repetir uma gravação já aceita para descobrir que ela já existe é uma ida
   * ao servidor a mais justamente onde a rede é ruim.
   */
  recordId: string;
  /** Rótulo curto que a tela mostra na lista de pendências. */
  label: string;
  createdAt: number;
  attempts: number;
  lastError: string;
};

const DB_NAME = "vinculato-campo";
const STORE = "fila";
const DB_VERSION = 1;

const endpoints: Record<QueuedKind, string> = {
  delivery: "/api/epi/deliveries",
  return: "/api/epi/returns",
  damage: "/api/epi/damages",
};

const entityTypes: Record<QueuedKind, string> = {
  delivery: "delivery",
  return: "return",
  damage: "damage",
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB indisponível."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Falha ao acessar a fila local."));
    });
  } finally {
    database.close();
  }
}

export async function listQueue(): Promise<QueuedOperation[]> {
  try {
    const all = await withStore<QueuedOperation[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedOperation[]>);
    return all.sort((left, right) => left.createdAt - right.createdAt);
  } catch {
    // Navegação privada, armazenamento bloqueado: a fila deixa de existir, e o
    // aplicativo continua funcionando com rede. Melhor isso do que tela branca.
    return [];
  }
}

async function putOperation(operation: QueuedOperation) {
  await withStore("readwrite", (store) => store.put(operation) as IDBRequest<IDBValidKey>);
}

async function removeOperation(id: string) {
  await withStore("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
}

export async function queueSize() {
  return (await listQueue()).length;
}

/** Erro que carrega a mensagem do servidor, para a tela mostrar o motivo real. */
export class FieldRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "FieldRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: init?.body instanceof FormData
      ? { ...(init?.headers ?? {}) }
      : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new FieldRequestError(response.status, String(payload.code ?? ""), payload.error ?? "Não foi possível concluir a operação.");
  }
  return payload;
}

/**
 * Recusa definitiva do servidor — não adianta reenviar.
 *
 * Distinguir isso de falha de rede é o que impede a fila de girar para sempre
 * sobre uma operação inválida: 4xx que não seja 408/429 é decisão, não tropeço.
 */
function isPermanent(error: unknown) {
  if (!(error instanceof FieldRequestError)) return false;
  if (error.status === 408 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

async function sendAttachment(entityType: string, entityId: string, attachment: QueuedAttachment) {
  const form = new FormData();
  form.set("entityType", entityType);
  form.set("entityId", entityId);
  form.set("kind", attachment.kind);
  form.set("file", attachment.blob, attachment.filename);
  await requestJson<{ attachment: { id: string } }>("/api/epi/attachments", { method: "POST", body: form });
}

/**
 * Envia a operação agora; se a rede falhar, deixa na fila.
 *
 * Devolve o que aconteceu, para a tela dizer a verdade: "registrado" e
 * "guardado para enviar" são resultados diferentes, e tratar os dois como
 * sucesso faria a pessoa ir embora achando que o termo está gravado.
 */
export async function submitOperation(input: {
  kind: QueuedKind;
  payload: Record<string, unknown>;
  attachment?: QueuedAttachment | null;
  label: string;
}): Promise<{ status: "sent" | "queued" | "partial"; id?: string; detail?: string }> {
  const operation: QueuedOperation = {
    id: crypto.randomUUID(),
    kind: input.kind,
    // A chave nasce aqui, uma vez, e acompanha a operação por todas as
    // tentativas. Gerá-la no envio criaria uma chave nova por tentativa, que é
    // o mesmo que não ter chave.
    idempotencyKey: `campo:${input.kind}:${crypto.randomUUID()}`,
    payload: input.payload,
    attachment: input.attachment ?? null,
    recordId: "",
    label: input.label,
    createdAt: Date.now(),
    attempts: 0,
    lastError: "",
  };

  if (!navigator.onLine) {
    await putOperation(operation);
    return { status: "queued" };
  }
  try {
    const id = await dispatch(operation);
    return { status: "sent", id };
  } catch (error) {
    if (isPermanent(error) && !operation.recordId) throw error;
    operation.attempts = 1;
    operation.lastError = error instanceof Error ? error.message : "Falha de rede.";
    await putOperation(operation);
    // "Registrado, falta o anexo" e "nada foi registrado" são situações
    // diferentes, e a tela precisa poder dizer qual é: quem está diante do
    // colaborador decide se repete a assinatura ou se pode seguir.
    return { status: operation.recordId ? "partial" : "queued", id: operation.recordId || undefined, detail: operation.lastError };
  }
}

/**
 * Faz o envio de uma operação: registro primeiro, anexo depois.
 *
 * Grava o id no próprio item da fila assim que o servidor aceita o registro.
 * Isso é o que mantém a repetição honesta quando só o anexo falha: a segunda
 * tentativa não refaz a gravação, e quem chamou sabe que a entrega existe.
 */
async function dispatch(operation: QueuedOperation) {
  let id = operation.recordId;
  if (!id) {
    const result = await requestJson<Record<string, { id?: string } | undefined>>(endpoints[operation.kind], {
      method: "POST",
      headers: { "idempotency-key": operation.idempotencyKey },
      body: JSON.stringify(operation.payload),
    });
    // A resposta nomeia o registro conforme a rota (`delivery`, `return`,
    // `damage`); o `id` é a única parte de que o anexo depende.
    const created = result[operation.kind] ?? result.delivery ?? result.return ?? result.damage;
    id = created && typeof created === "object" ? String(created.id ?? "") : "";
    operation.recordId = id;
  }
  if (operation.attachment && id) {
    await sendAttachment(entityTypes[operation.kind], id, operation.attachment);
  }
  return id;
}

/**
 * Esvazia a fila, uma operação por vez e na ordem em que foram feitas.
 *
 * A ordem importa: duas entregas do mesmo EPI saindo fora de ordem dariam o
 * mesmo saldo, mas o histórico do colaborador contaria a sequência errada.
 * Em caso de falha de rede, para — insistir nas seguintes com a rede caída só
 * incrementaria tentativas sem chance de sucesso.
 */
export async function flushQueue(): Promise<{ sent: number; failed: number; remaining: number }> {
  if (!navigator.onLine) {
    return { sent: 0, failed: 0, remaining: await queueSize() };
  }
  const pending = await listQueue();
  let sent = 0;
  let failed = 0;
  for (const operation of pending) {
    try {
      await dispatch(operation);
      await removeOperation(operation.id);
      sent += 1;
    } catch (error) {
      if (isPermanent(error)) {
        // Recusa do servidor: sai da fila e fica registrada como falha, porque
        // reenviar o inválido para sempre esconderia o problema real.
        await putOperation({
          ...operation,
          attempts: operation.attempts + 1,
          lastError: error instanceof Error ? error.message : "Recusado pelo servidor.",
        });
        failed += 1;
        continue;
      }
      await putOperation({
        ...operation,
        attempts: operation.attempts + 1,
        lastError: error instanceof Error ? error.message : "Falha de rede.",
      });
      break;
    }
  }
  return { sent, failed, remaining: await queueSize() };
}

/** Descarta uma pendência — usado só para a que o servidor recusou. */
export async function discardOperation(id: string) {
  await removeOperation(id);
}

/**
 * Apaga a casca guardada pelo service worker.
 *
 * Chamado na saída. O cache existe para o aplicativo abrir sem rede, e a casca
 * guardada é o HTML já renderizado — com o nome de quem estava logado. Num
 * aparelho de almoxarifado, que troca de mão a cada turno, abrir o ícone no modo
 * avião depois da troca mostraria o nome da pessoa anterior.
 *
 * A fila **não** é apagada aqui, de propósito: ela guarda entrega assinada e
 * foto de dano que ainda não subiram, e perder isso é perder a evidência de algo
 * que aconteceu de verdade. Quem sai com pendência é avisado antes.
 */
export async function clearShellCache() {
  if (typeof window === "undefined" || !("caches" in window)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("vinculato-campo")).map((key) => caches.delete(key)));
  } catch {
    // Armazenamento bloqueado: não há cache para limpar, e travar a saída por
    // causa disso seria pior do que a casca velha.
  }
}

export const currency = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

export const dateLabel = (value: string) => {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(parsed);
};

export const today = () => new Date().toISOString().slice(0, 10);
