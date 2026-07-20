import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export type ChatGPTUser = {
  id?: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const SESSION_COOKIE = "fila_dp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/login";
const SIGN_OUT_PATH = "/api/auth/logout";
const CALLBACK_PATH = "/callback";

type SessionPayload = { email: string; displayName: string; fullName: string | null; exp: number };

function authSecret() {
  return process.env.FDP_AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "fila-dp-local-secret-change-me");
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  const secret = authSecret();
  if (!secret) return "";
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function createSessionToken(user: ChatGPTUser) {
  const payload: SessionPayload = {
    email: user.email.trim().toLowerCase(),
    displayName: user.displayName.trim().slice(0, 160),
    fullName: user.fullName?.trim().slice(0, 160) ?? null,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function readSessionToken(token: string | undefined): ChatGPTUser | null {
  if (!token || !authSecret()) return null;
  const [encoded, signature] = token.split(".");
  const expectedSignature = encoded ? sign(encoded) : "";
  if (!encoded || !signature || signature.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  try {
    const payload = JSON.parse(decodeBase64url(encoded)) as SessionPayload;
    if (!payload.email || !payload.displayName || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { email: payload.email, displayName: payload.displayName, fullName: payload.fullName ?? null };
  } catch {
    return null;
  }
}

export async function setAuthSession(user: ChatGPTUser) {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearAuthSession() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  try {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestCookies = await cookies();
  const sessionUser = readSessionToken(requestCookies.get(SESSION_COOKIE)?.value);
  if (sessionUser) return sessionUser;

  // Keep compatibility with the original Sites runtime while the migration is deployed.
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

function safeRelativeReturnPath(value: string): string {
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
