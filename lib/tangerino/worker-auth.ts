import { createHmac, timingSafeEqual } from "node:crypto";
import { currentVaultKey, vaultKeyByVersion } from "../integrations.ts";

const SIGNATURE_VERSION = "v1";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function derivedSigningKey(key: Buffer) {
  return createHmac("sha256", key).update("vinculato:tangerino-worker-attachments:v1", "utf8").digest();
}

function signature(key: Buffer, canonical: string) {
  return createHmac("sha256", derivedSigningKey(key)).update(canonical, "utf8").digest("hex");
}

function canonical(input: { timestamp: string; workspaceId: string; authorizationId: string; action: string; value: string }) {
  return [SIGNATURE_VERSION, input.timestamp, input.workspaceId, input.authorizationId, input.action, input.value].join("\n");
}

/** Assina uma operação estreita; a chave AES nunca sai do processo. */
export function signTangerinoWorkerRequest(input: { workspaceId: string; authorizationId: string; action: string; value: string; now?: Date }) {
  const active = currentVaultKey("tangerino_browser");
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  const signed = signature(active.key, canonical({ ...input, timestamp }));
  return {
    "x-vinculato-workspace-id": input.workspaceId,
    "x-vinculato-worker-key-version": String(active.version),
    "x-vinculato-worker-timestamp": timestamp,
    "x-vinculato-worker-signature": signed,
  };
}

export function verifyTangerinoWorkerRequest(input: {
  headers: Headers;
  workspaceId: string;
  authorizationId: string;
  action: string;
  value: string;
  now?: Date;
}) {
  const version = Number(input.headers.get("x-vinculato-worker-key-version") ?? 0);
  const timestamp = input.headers.get("x-vinculato-worker-timestamp") ?? "";
  const received = input.headers.get("x-vinculato-worker-signature") ?? "";
  const numericTimestamp = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isInteger(version) || version <= 0 || !Number.isInteger(numericTimestamp)
      || Math.abs(nowSeconds - numericTimestamp) > MAX_CLOCK_SKEW_SECONDS || !/^[0-9a-f]{64}$/u.test(received)) {
    return false;
  }
  const expected = signature(vaultKeyByVersion(version, "tangerino_browser"), canonical({
    timestamp, workspaceId: input.workspaceId, authorizationId: input.authorizationId,
    action: input.action, value: input.value,
  }));
  const left = Buffer.from(received, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
