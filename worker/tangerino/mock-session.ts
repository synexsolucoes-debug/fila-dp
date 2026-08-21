import { tangerinoErrors } from "../../lib/tangerino/errors.ts";
import type {
  AdmissionSearchHit,
  AdmissionSnapshot,
  TangerinoBrowserSession,
} from "../../lib/tangerino/types.ts";

/**
 * Sessão falsa, para exercitar o agente sem navegador.
 *
 * Ela existe para que os testes cubram o que costuma quebrar — sessão expirada,
 * processo inexistente, dois processos, layout alterado, timeout — sem depender
 * de acesso ao Tangerino nem de Chromium instalado. O que ela **não** faz é
 * provar que os seletores funcionam: isso só a fixture com navegador de verdade
 * prova (`npm run tangerino:fixtures`), e mesmo ela só prova contra a fixture,
 * não contra a tela real.
 *
 * A distinção importa e está escrita aqui de propósito: um teste verde neste
 * arquivo diz que a *orquestração* está certa, e nada sobre o Tangerino.
 */
export type TangerinoMockScenario =
  | "success"
  | "session_expired"
  | "mfa"
  | "captcha"
  | "not_found"
  | "multiple_matches"
  | "ui_changed"
  | "timeout"
  | "missing_status";

const defaultSnapshot: AdmissionSnapshot = {
  externalAdmissionId: "ADM-4711",
  rawStatus: "Documentação em análise",
  stage: "Documentação",
  pendingReason: "Comprovante de residência ilegível",
  admissionDate: "01/09/2026",
  sourceUpdatedAt: "21/08/2026 14:30",
  displayName: "Maria de Souza",
};

export class MockTangerinoSession implements TangerinoBrowserSession {
  /** A ordem exata dos comandos executados, para o teste conferir o caminho. */
  readonly calls: string[] = [];
  private readonly scenario: TangerinoMockScenario;
  private readonly snapshot: AdmissionSnapshot;

  constructor(scenario: TangerinoMockScenario = "success", snapshot: AdmissionSnapshot = defaultSnapshot) {
    this.scenario = scenario;
    this.snapshot = snapshot;
  }

  async ensureAuthenticated() {
    this.calls.push("ensureAuthenticated");
    if (this.scenario === "session_expired") throw tangerinoErrors.authenticationRequired("A sessão do Tangerino expirou.");
    if (this.scenario === "mfa") throw tangerinoErrors.authenticationRequired("O Tangerino pediu o código de verificação em duas etapas.");
    if (this.scenario === "captcha") throw tangerinoErrors.authenticationRequired("O Tangerino apresentou um desafio de CAPTCHA.");
    if (this.scenario === "timeout") throw tangerinoErrors.timeout("login");
  }

  async openAdmissions() {
    this.calls.push("openAdmissions");
    if (this.scenario === "ui_changed") throw tangerinoErrors.uiChanged("abertura da Admissão", "menu de Admissão Digital");
  }

  async searchAdmission(term: string): Promise<AdmissionSearchHit[]> {
    this.calls.push(`searchAdmission:${term}`);
    if (this.scenario === "not_found") return [];
    if (this.scenario === "multiple_matches") {
      return [
        { id: "ADM-4711", label: "Maria de Souza — 01/09/2026" },
        { id: "ADM-4899", label: "Maria de Souza — 15/09/2026" },
      ];
    }
    return [{ id: "ADM-4711", label: "Maria de Souza — 01/09/2026" }];
  }

  async openAdmission(hit: AdmissionSearchHit) {
    this.calls.push(`openAdmission:${hit.id}`);
  }

  async readAdmission(): Promise<AdmissionSnapshot> {
    this.calls.push("readAdmission");
    // Situação ausente é o sintoma mais comum de layout alterado: o campo mudou
    // de nome ou saiu da tela. O parser transforma isso em `UI_CHANGED`, e o
    // cenário existe para provar que ele não devolve `UNKNOWN` no lugar.
    if (this.scenario === "missing_status") return { ...this.snapshot, rawStatus: undefined };
    return this.snapshot;
  }

  async back() {
    this.calls.push("back");
  }

  async close() {
    this.calls.push("close");
  }
}
