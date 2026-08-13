import { SankhyaConnectorError } from "../../lib/sankhya/errors.ts";
import type { SankhyaBrowserSession, SankhyaExtraction, SankhyaRawData } from "../../lib/sankhya/types.ts";

export type SankhyaMockScenario = "success" | "invalid_login" | "mfa" | "captcha" | "timeout" | "selector_missing" | "invalid_file";

export class MockSankhyaSession implements SankhyaBrowserSession {
  readonly calls: string[] = [];
  private readonly scenario: SankhyaMockScenario;
  private readonly records: SankhyaRawData[];
  constructor(scenario: SankhyaMockScenario = "success", records: SankhyaRawData[] = []) { this.scenario = scenario; this.records = records; }
  async authenticate() {
    this.calls.push("authenticate");
    if (this.scenario === "invalid_login") throw new SankhyaConnectorError("SANKHYA_LOGIN_INVALID", "Login inválido.");
    if (this.scenario === "mfa") throw new SankhyaConnectorError("SANKHYA_MFA_REQUIRED", "Autenticação adicional necessária.", { requiresUserAction: true });
    if (this.scenario === "captcha") throw new SankhyaConnectorError("SANKHYA_CAPTCHA_REQUIRED", "CAPTCHA requer intervenção.", { requiresUserAction: true });
    if (this.scenario === "timeout") throw new SankhyaConnectorError("SANKHYA_LOGIN_TIMEOUT", "Timeout de login.", { retryable: true });
  }
  async openDpExplorer() {
    this.calls.push("openDpExplorer");
    if (this.scenario === "selector_missing") throw new SankhyaConnectorError("DP_EXPLORER_NOT_FOUND", "DP Explorer não localizado.", { layoutRelated: true });
  }
  async runRoutine() { this.calls.push("runRoutine"); }
  async extract(): Promise<SankhyaExtraction> {
    this.calls.push("extract");
    if (this.scenario === "invalid_file") throw new SankhyaConnectorError("SANKHYA_EXPORT_CONTENT_INVALID", "Arquivo inválido.");
    return { records: this.records, source: "table" };
  }
  async diagnosticScreenshot() { return null; }
  async logout() { this.calls.push("logout"); }
  async close() { this.calls.push("close"); }
}
