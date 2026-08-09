import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getD1 } from "@/db";

export type ChatGPTUser = {
  id?: string;
  sessionId?: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const SESSION_COOKIE = "fila_dp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/login";
const SIGN_OUT_PATH = "/api/auth/logout";
const CALLBACK_PATH = "/callback";

const scryptAsync = promisify(scrypt);

function authSecret() {
  return process.env.FDP_AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "fila-dp-local-secret-change-me");
}

function hashSessionToken(value: string) {
  const secret = authSecret();
  if (!secret) return "";
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function hashSessionAddress(value: string) {
  const secret = authSecret();
  if (!secret || !value || value === "unknown") return "";
  return createHmac("sha256", secret).update(`session-address:${value}`).digest("base64url");
}

export function sessionDeviceLabel(userAgent: string) {
  const source = userAgent.slice(0, 512);
  const browser = /Edg\//.test(source) ? "Edge"
    : /OPR\//.test(source) ? "Opera"
      : /Firefox\//.test(source) ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(source) ? "Chrome"
          : /Safari\//.test(source) ? "Safari"
            : "Navegador";
  const system = /(?:iPhone|iPad|iPod)/.test(source) ? "iOS"
    : /Android/.test(source) ? "Android"
      : /Windows/.test(source) ? "Windows"
        : /Macintosh|Mac OS X/.test(source) ? "macOS"
          : /Linux/.test(source) ? "Linux"
            : "dispositivo desconhecido";
  return `${browser} · ${system}`;
}

async function readSessionToken(token: string | undefined): Promise<ChatGPTUser | null> {
  if (!token || token.length < 32 || !authSecret()) return null;
  const d1 = getD1();
  const session = await d1.prepare(`SELECT u.id, u.email, u.name,
      s.id AS session_id, s.last_seen_at
    FROM fdp_auth_sessions s
    JOIN fdp_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > CURRENT_TIMESTAMP`)
    .bind(hashSessionToken(token))
    .first<{ id: string; email: string; name: string; session_id: string; last_seen_at: string | Date }>();
  if (!session) return null;
  const lastSeenAt = new Date(session.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    await d1.prepare(`UPDATE fdp_auth_sessions
      SET last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
      .bind(session.session_id)
      .run();
  }
  return { id: session.id, sessionId: session.session_id, email: session.email, displayName: session.name, fullName: session.name };
}

export async function setAuthSession(user: ChatGPTUser, metadata: { address?: string; userAgent?: string } = {}) {
  if (!user.id) throw new Error("Não foi possível criar uma sessão sem usuário persistido.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await getD1().prepare(`INSERT INTO fdp_auth_sessions
    (id, user_id, token_hash, expires_at, device_label, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      user.id,
      hashSessionToken(token),
      expiresAt,
      sessionDeviceLabel(metadata.userAgent ?? ""),
      hashSessionAddress(metadata.address ?? ""),
    )
    .run();
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearAuthSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token && authSecret()) {
    await getD1().prepare(`UPDATE fdp_auth_sessions
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND revoked_at IS NULL`)
      .bind(hashSessionToken(token))
      .run();
  }
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64) as Buffer).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  try {
    const actual = await scryptAsync(password, salt, 64) as Buffer;
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestCookies = await cookies();
  const sessionUser = await readSessionToken(requestCookies.get(SESSION_COOKIE)?.value);
  if (sessionUser) return sessionUser;

  // OpenAI Sites authenticates and replaces these headers at its dispatcher.
  // Vercel does not provide that trust boundary, so never accept a caller-
  // supplied identity header there.
  if (process.env.VERCEL) return null;

  const requestHeaders = await headers();
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!email) return null;
  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName = encodedFullName && requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
    ? safeDecodeURIComponent(encodedFullName)
    : null;
  return { displayName: fullName ?? email, email, fullName };
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(`${chatGPTSignInPath(returnTo)}`);
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  let url: URL;
  try { url = new URL(value, "https://app.local"); } catch { return "/"; }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string) {
  return pathname === SIGN_IN_PATH || pathname === SIGN_OUT_PATH || pathname === CALLBACK_PATH;
}

function safeDecodeURIComponent(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}
