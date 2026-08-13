import { ApiError } from "../api-errors.ts";
import { validateIntegrationEndpoint } from "../integration-security.ts";
import type { SankhyaConfig } from "./types.ts";

const frequencies = new Set(["hourly", "daily", "weekly"]);
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseSankhyaConfig(value: unknown): SankhyaConfig {
  let source: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) source = value as Record<string, unknown>;
  else if (typeof value === "string") {
    try { source = JSON.parse(value) as Record<string, unknown>; } catch { source = {}; }
  }
  const frequency = frequencies.has(String(source.frequency)) ? String(source.frequency) as SankhyaConfig["frequency"] : "daily";
  const timeoutMs = Math.min(15 * 60_000, Math.max(30_000, Number(source.timeoutMs) || 5 * 60_000));
  return {
    endpoint: text(source.endpoint, 500),
    companyId: text(source.companyId, 120),
    companyContext: text(source.companyContext, 160),
    routine: "employees",
    routineName: text(source.routineName, 160) || "DP Explorer",
    automaticEnabled: source.automaticEnabled === true,
    frequency,
    scheduleTime: timePattern.test(String(source.scheduleTime ?? "")) ? String(source.scheduleTime) : "02:00",
    scheduleWeekday: Math.min(6, Math.max(0, Math.trunc(Number(source.scheduleWeekday) || 0))),
    timezone: text(source.timezone, 80) || "America/Sao_Paulo",
    timeoutMs,
    maxAttempts: Math.min(3, Math.max(1, Math.trunc(Number(source.maxAttempts) || 3))),
    downloadLimitBytes: Math.min(50 * 1024 * 1024, Math.max(1024, Math.trunc(Number(source.downloadLimitBytes) || 25 * 1024 * 1024))),
    diagnosticRetentionHours: Math.min(168, Math.max(1, Math.trunc(Number(source.diagnosticRetentionHours) || 24))),
  };
}

export function sanitizeSankhyaConfig(value: unknown) {
  const config = parseSankhyaConfig(value);
  if (!config.endpoint) throw ApiError.badRequest("Informe a URL HTTPS do ambiente Sankhya.", "SANKHYA_URL_REQUIRED");
  try {
    config.endpoint = validateIntegrationEndpoint(
      "sankhya_browser",
      config.endpoint,
      process.env.FDP_SANKHYA_BROWSER_ENDPOINT,
      process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS ?? "",
    );
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : "URL Sankhya inválida.", "SANKHYA_URL_UNSAFE");
  }
  return config;
}

export function assertRunnableSankhyaConfig(config: SankhyaConfig) {
  if (!config.endpoint || !config.companyId) {
    throw new ApiError(409, "SANKHYA_CONFIG_INCOMPLETE", "Configure a URL e a empresa de destino antes de executar o Sankhya.");
  }
}

export function nextSankhyaRunAt(config: SankhyaConfig, from = new Date()) {
  if (config.frequency === "hourly") return new Date(from.getTime() + 60 * 60_000).toISOString();
  const [hour, minute] = config.scheduleTime.split(":").map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(from).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  let days = config.frequency === "weekly" ? (config.scheduleWeekday - weekday + 7) % 7 : 0;
  if (days === 0 && (Number(parts.hour) > hour || (Number(parts.hour) === hour && Number(parts.minute) >= minute))) {
    days = config.frequency === "weekly" ? 7 : 1;
  }
  const localNoon = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days, hour, minute));
  const targetParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(localNoon).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const displayedAsUtc = Date.UTC(Number(targetParts.year), Number(targetParts.month) - 1, Number(targetParts.day), Number(targetParts.hour), Number(targetParts.minute), Number(targetParts.second));
  const offset = displayedAsUtc - localNoon.getTime();
  return new Date(localNoon.getTime() - offset).toISOString();
}
