export type FeatureFlag =
  | "aiBoardOrchestration"
  | "erpWriteback"
  | "automaticSensitiveChanges"
  | "reconciliationV2"
  | "sankhyaBrowserConnector";

const sensitiveFlags = new Set<FeatureFlag>(["erpWriteback", "automaticSensitiveChanges"]);

export function getEnabledFeatureFlags(environment = process.env): ReadonlySet<FeatureFlag> {
  const requested = new Set(String(environment.FDP_FEATURE_FLAGS ?? "").split(",").map((flag) => flag.trim()).filter(Boolean) as FeatureFlag[]);
  if (environment.NODE_ENV === "production" && environment.FDP_ALLOW_SENSITIVE_FEATURES !== "true") {
    for (const flag of sensitiveFlags) requested.delete(flag);
  }
  return requested;
}

export function isFeatureEnabled(flag: FeatureFlag, environment = process.env) {
  return getEnabledFeatureFlags(environment).has(flag);
}
