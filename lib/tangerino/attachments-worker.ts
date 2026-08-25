import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Open, type Entry } from "unzipper";
import type { getD1 } from "../../db/index.ts";
import { MAX_CARD_ATTACHMENT_SIZE, safeAttachmentFilename, validateCardAttachment } from "../card-attachments.ts";
import { openCredentials } from "../integrations.ts";
import { log } from "../observability.ts";
import { tangerinoAgentConfig } from "./config.ts";
import { safeTangerinoError, tangerinoErrors } from "./errors.ts";
import { tangerinoBrowserLoginUrl } from "./hosts.ts";
import { admissionSearchTerm, chooseAdmission, legacyAdmissionNameFromCard } from "./parser.ts";
import type { TangerinoArtifactSession } from "./types.ts";
import { signTangerinoWorkerRequest } from "./worker-auth.ts";

type Database = ReturnType<typeof getD1>;

type ClaimedAuthorization = {
  id: string;
  card_id: string;
  company_id: string;
  employee_id: string | null;
  integration_id: string;
  external_admission_id: string;
  card_title: string;
  card_description: string;
  attempt: number;
};

type Credential = {
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
};

type TransferFile = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  read: () => Promise<Buffer>;
};

type PreparedTransferFile = TransferFile & {
  bytes: Buffer;
  digest: string;
};

const contentTypeByExtension: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  txt: "text/plain", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

class ArtifactTransferError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code);
    this.name = "ArtifactTransferError";
    this.code = code;
    this.retryable = retryable;
  }
}

function appBaseUrl() {
  const configured = String(process.env.FDP_APP_URL ?? "").trim();
  let url: URL;
  try { url = new URL(configured); } catch { throw new ArtifactTransferError("APP_URL_NOT_CONFIGURED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ArtifactTransferError("APP_URL_NOT_CONFIGURED");
  }
  return url.origin;
}

function uniqueFilenames(names: string[]) {
  const used = new Set<string>();
  return names.map((raw) => {
    const safe = safeAttachmentFilename(raw);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    let candidate = safe;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase("pt-BR"))) candidate = `${stem} (${suffix++})${extension}`;
    used.add(candidate.toLocaleLowerCase("pt-BR"));
    return candidate;
  });
}

async function filesFromDownloads(documentArchivePath: string, registrationFormPath: string): Promise<TransferFile[]> {
  const archive = await Open.file(documentArchivePath);
  const entries = archive.files.filter((entry) => entry.type === "File"
    && !entry.path.replace(/\\/gu, "/").split("/").some((part) => part === "__MACOSX" || part === ".DS_Store"));
  if (!entries.length || entries.length > 49) throw new ArtifactTransferError("SOLIDES_DOCUMENT_COUNT_INVALID");
  const formStats = await stat(registrationFormPath);
  const rawNames = [...entries.map((entry) => entry.path), "ficha-cadastral-solides.pdf"];
  const filenames = uniqueFilenames(rawNames);
  const totalBytes = entries.reduce((total, entry) => total + Number(entry.uncompressedSize || 0), 0) + formStats.size;
  if (totalBytes > 200 * 1024 * 1024) throw new ArtifactTransferError("SOLIDES_DOCUMENT_TOTAL_TOO_LARGE");

  const files = entries.map((entry: Entry, index): TransferFile => {
    const filename = filenames[index];
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const contentType = contentTypeByExtension[extension] ?? "";
    validateCardAttachment({ filename, contentType, sizeBytes: Number(entry.uncompressedSize || 0) });
    return {
      filename, contentType, sizeBytes: Number(entry.uncompressedSize),
      read: async () => {
        const buffer = await entry.buffer();
        if (buffer.byteLength !== Number(entry.uncompressedSize) || buffer.byteLength > MAX_CARD_ATTACHMENT_SIZE) {
          throw new ArtifactTransferError("SOLIDES_DOCUMENT_SIZE_MISMATCH");
        }
        return buffer;
      },
    };
  });
  const formFilename = filenames.at(-1) ?? "ficha-cadastral-solides.pdf";
  validateCardAttachment({ filename: formFilename, contentType: "application/pdf", sizeBytes: formStats.size });
  files.push({
    filename: formFilename, contentType: "application/pdf", sizeBytes: formStats.size,
    read: () => readFile(registrationFormPath),
  });
  return files;
}

/**
 * Usa a mesma identidade de conteúdo aplicada por `storeCardAttachment`.
 *
 * A Sólides pode incluir duas entradas com nomes diferentes e bytes idênticos
 * no ZIP. O armazenamento corretamente mantém uma só cópia; a conclusão deve
 * esperar essa mesma quantidade única, não o número bruto de nomes no arquivo.
 */
export async function deduplicateTransferFiles<T extends TransferFile>(files: T[]) {
  const seen = new Set<string>();
  const unique: Array<T & { bytes: Buffer; digest: string }> = [];
  for (const file of files) {
    const bytes = await file.read();
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(digest)) continue;
    seen.add(digest);
    unique.push({ ...file, bytes, digest });
  }
  return unique;
}

async function uploadFile(input: {
  baseUrl: string;
  workspaceId: string;
  authorizationId: string;
  file: PreparedTransferFile;
}) {
  const { bytes, digest } = input.file;
  const signatureValue = `${digest}:${bytes.byteLength}`;
  const form = new FormData();
  const fileBytes = new Uint8Array(bytes.byteLength);
  fileBytes.set(bytes);
  form.set("file", new File([fileBytes], input.file.filename, { type: input.file.contentType }));
  const response = await fetch(new URL(`/api/integrations/tangerino/attachments/${encodeURIComponent(input.authorizationId)}`, input.baseUrl), {
    method: "POST",
    headers: {
      // Compatibilidade com o proxy atualmente publicado: esta chamada é
      // servidor-a-servidor e autenticada por HMAC, mas o filtro de CSRF da
      // produção ainda exige a origem pública nas mutações fora de /api/v1.
      origin: new URL(input.baseUrl).origin,
      ...signTangerinoWorkerRequest({
        workspaceId: input.workspaceId, authorizationId: input.authorizationId, action: "UPLOAD", value: signatureValue,
      }),
    },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new ArtifactTransferError(`UPLOAD_HTTP_${response.status}`, response.status >= 500);
}

async function completeTransfer(input: { baseUrl: string; workspaceId: string; authorizationId: string; expectedCount: number }) {
  const response = await fetch(new URL(`/api/integrations/tangerino/attachments/${encodeURIComponent(input.authorizationId)}/complete`, input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(input.baseUrl).origin,
      ...signTangerinoWorkerRequest({
        workspaceId: input.workspaceId, authorizationId: input.authorizationId,
        action: "COMPLETE", value: String(input.expectedCount),
      }),
    },
    body: JSON.stringify({ expectedCount: input.expectedCount }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ArtifactTransferError(`COMPLETE_HTTP_${response.status}`, response.status >= 500);
}

export async function claimNextAttachmentAuthorization(d1: Database, workspaceId: string) {
  await d1.prepare(`UPDATE fdp_tangerino_attachment_authorizations
    SET state = 'FAILED', error_code = 'AUTHORIZATION_EXPIRED', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING') AND expires_at <= CURRENT_TIMESTAMP`)
    .bind(workspaceId).run();
  return d1.prepare(`WITH candidate AS (
      SELECT id FROM fdp_tangerino_attachment_authorizations
      WHERE workspace_id = ? AND expires_at > CURRENT_TIMESTAMP
        AND (state = 'QUEUED' OR (state = 'RUNNING' AND updated_at < CURRENT_TIMESTAMP - interval '30 minutes'))
      ORDER BY authorized_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE fdp_tangerino_attachment_authorizations AS auth_row
      SET state = 'RUNNING', error_code = '', started_at = COALESCE(auth_row.started_at, CURRENT_TIMESTAMP),
          attempt = auth_row.attempt + 1, updated_at = CURRENT_TIMESTAMP
      FROM candidate, fdp_cards card
      WHERE auth_row.id = candidate.id AND auth_row.workspace_id = ?
        AND card.workspace_id = auth_row.workspace_id AND card.id = auth_row.card_id
      RETURNING auth_row.id, auth_row.card_id, card.company_id,
        card.title AS card_title, card.description AS card_description,
        auth_row.employee_id, auth_row.integration_id, auth_row.external_admission_id, auth_row.attempt`)
    .bind(workspaceId, workspaceId).first<ClaimedAuthorization>();
}

export async function runNextAttachmentAuthorization(
  d1: Database,
  workspaceId: string,
  createSession: () => Promise<TangerinoArtifactSession>,
) {
  const claimed = await claimNextAttachmentAuthorization(d1, workspaceId);
  if (!claimed) return null;
  let session: TangerinoArtifactSession | null = null;
  let temporaryDirectory = "";
  try {
    const [employee, credential, integration] = await Promise.all([
      claimed.employee_id ? d1.prepare(`SELECT full_name, registration_number FROM fdp_employees
        WHERE workspace_id = ? AND id = ?`).bind(workspaceId, claimed.employee_id)
        .first<{ full_name: string; registration_number: string }>() : Promise.resolve(null),
      d1.prepare(`SELECT encrypted_value, initialization_vector, auth_tag, key_version
        FROM fdp_integration_credentials
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        ORDER BY created_at DESC LIMIT 1`).bind(workspaceId, claimed.integration_id).first<Credential>(),
      d1.prepare(`SELECT id FROM fdp_integrations
        WHERE workspace_id = ? AND id = ? AND channel = 'tangerino_browser'`)
        .bind(workspaceId, claimed.integration_id).first<{ id: string }>(),
    ]);
    if (!employee && !/^[1-9][0-9]{0,119}$/u.test(claimed.external_admission_id)) {
      throw tangerinoErrors.notFound();
    }
    if (!credential || !integration) throw tangerinoErrors.credentialRequired();
    const secrets = openCredentials("tangerino_browser", {
      encryptedValue: credential.encrypted_value, initializationVector: credential.initialization_vector,
      authTag: credential.auth_tag, keyVersion: Number(credential.key_version),
    });
    if (!secrets.username || !secrets.password) throw tangerinoErrors.credentialRequired();

    const config = tangerinoAgentConfig();
    session = await createSession();
    await session.ensureAuthenticated({
      endpoint: tangerinoBrowserLoginUrl, username: secrets.username, password: secrets.password, timeoutMs: config.timeoutMs,
    });
    await session.openAdmissions();
    const target = {
      workspaceId, companyId: claimed.company_id, employeeId: claimed.employee_id ?? `legacy:${claimed.card_id}`,
      externalAdmissionId: claimed.external_admission_id,
      registrationNumber: String(employee?.registration_number ?? ""),
      fullName: String(employee?.full_name ?? legacyAdmissionNameFromCard(claimed.card_title, claimed.card_description)),
    };
    const primaryTerm = admissionSearchTerm(target);
    let hits = await session.searchAdmission(primaryTerm);
    if (hits.length === 0 && target.fullName && target.fullName !== primaryTerm) {
      log("info", "tangerino.attachments_search_name_fallback", { workspaceId }, {
        authorizationId: claimed.id, cardId: claimed.card_id,
      });
      hits = await session.searchAdmission(target.fullName);
    }
    const hit = hits.length === 0 && /^[1-9][0-9]{0,19}$/u.test(claimed.external_admission_id)
      ? { id: claimed.external_admission_id, label: "ficha autorizada por identificador" }
      : chooseAdmission(hits, claimed.external_admission_id);
    if (hits.length === 0) {
      log("info", "tangerino.attachments_direct_admission_fallback", { workspaceId }, {
        authorizationId: claimed.id, cardId: claimed.card_id,
      });
    }
    await session.openAdmission(hit);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "vinculato-tangerino-"));
    const downloads = await session.downloadAdmissionArtifacts({
      externalAdmissionId: claimed.external_admission_id, targetDirectory: temporaryDirectory,
    });
    const downloadedFiles = await filesFromDownloads(downloads.documentArchivePath, downloads.registrationFormPath);
    const files = await deduplicateTransferFiles(downloadedFiles);
    if (files.length !== downloadedFiles.length) {
      log("info", "tangerino.attachments_duplicate_content_ignored", { workspaceId }, {
        authorizationId: claimed.id, duplicateCount: downloadedFiles.length - files.length,
      });
    }
    const baseUrl = appBaseUrl();
    for (const file of files) {
      await uploadFile({ baseUrl, workspaceId, authorizationId: claimed.id, file });
    }
    await completeTransfer({ baseUrl, workspaceId, authorizationId: claimed.id, expectedCount: files.length });
    log("info", "tangerino.attachments_completed", { workspaceId }, {
      authorizationId: claimed.id, cardId: claimed.card_id, uploadedCount: files.length,
    });
    return { authorizationId: claimed.id, state: "COMPLETED" as const, uploadedCount: files.length };
  } catch (error) {
    const browserFailure = safeTangerinoError(error);
    const artifactFailure = error instanceof ArtifactTransferError ? error : null;
    const errorCode = artifactFailure?.code ?? browserFailure.code;
    const retryable = artifactFailure ? artifactFailure.retryable : browserFailure.retryable && !browserFailure.requiresUserAction;
    const retry = retryable && claimed.attempt < 2;
    await d1.prepare(`UPDATE fdp_tangerino_attachment_authorizations
      SET state = ?, error_code = ?, started_at = CASE WHEN ? = 'QUEUED' THEN NULL ELSE started_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND state = 'RUNNING'`)
      .bind(retry ? "QUEUED" : "FAILED", errorCode.slice(0, 120), retry ? "QUEUED" : "FAILED", workspaceId, claimed.id).run();
    log(retry ? "warn" : "error", "tangerino.attachments_failed", { workspaceId }, {
      authorizationId: claimed.id, cardId: claimed.card_id, errorCode,
      errorMessage: browserFailure.message, retry,
    });
    return { authorizationId: claimed.id, state: retry ? "QUEUED" as const : "FAILED" as const, errorCode };
  } finally {
    await session?.close().catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
