import type { SessionUser } from "@/lib/auth/session";
import { ApiError } from "./api-errors.ts";

function configuredPlatformAdmins() {
  return new Set(
    String(process.env.FDP_PLATFORM_ADMIN_EMAILS ?? "")
      .split(/[;,\s]+/u)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformAdmin(user: SessionUser) {
  return Boolean(user.id && configuredPlatformAdmins().has(user.email.trim().toLowerCase()));
}

export function requirePlatformAdmin(user: SessionUser) {
  if (!user.id || !isPlatformAdmin(user)) {
    throw ApiError.forbidden("A administração da plataforma exige uma identidade global autorizada.", "PLATFORM_ADMIN_REQUIRED");
  }
  return { userId: user.id, email: user.email.trim().toLowerCase() };
}
