import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { ApiError } from "./api-errors.ts";

function configuredPlatformAdmins() {
  return new Set(
    String(process.env.FDP_PLATFORM_ADMIN_EMAILS ?? "")
      .split(/[;,\s]+/u)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformAdmin(user: ChatGPTUser) {
  return Boolean(user.id && configuredPlatformAdmins().has(user.email.trim().toLowerCase()));
}

export function requirePlatformAdmin(user: ChatGPTUser) {
  if (!user.id || !isPlatformAdmin(user)) {
    throw ApiError.forbidden("A administração da plataforma exige uma identidade global autorizada.", "PLATFORM_ADMIN_REQUIRED");
  }
  return { userId: user.id, email: user.email.trim().toLowerCase() };
}
