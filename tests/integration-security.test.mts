import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkspaceWebhookSecrets,
  validateIntegrationEndpoint,
} from "../lib/integration-security.ts";

test("allows only the official provider endpoint by default", () => {
  assert.equal(
    validateIntegrationEndpoint("teams", "https://graph.microsoft.com/v1.0/teams/example/messages"),
    "https://graph.microsoft.com/v1.0/teams/example/messages",
  );
  assert.throws(
    () => validateIntegrationEndpoint("teams", "https://attacker.example/collect"),
    /não está autorizado/,
  );
});

test("blocks insecure, local and credential-bearing endpoints", () => {
  assert.throws(
    () => validateIntegrationEndpoint("whatsapp", "http://graph.facebook.com/messages"),
    /não seguro/,
  );
  assert.throws(
    () => validateIntegrationEndpoint("erp", "https://127.0.0.1/internal"),
    /não seguro/,
  );
  assert.throws(
    () => validateIntegrationEndpoint("teams", "https://graph.microsoft.com/v1.0/me?access_token=secret"),
    /Credenciais não podem/,
  );
});

test("accepts an operations-configured origin without trusting other origins", () => {
  const configured = "https://connector.example.com/api/messages";
  assert.equal(
    validateIntegrationEndpoint("email", "https://connector.example.com/api/inbox", configured),
    "https://connector.example.com/api/inbox",
  );
  assert.throws(
    () => validateIntegrationEndpoint("email", "https://other.example.com/api/inbox", configured),
    /não está autorizado/,
  );
});

test("parses only strong workspace webhook secrets", () => {
  assert.deepEqual(
    parseWorkspaceWebhookSecrets(JSON.stringify({
      "workspace-a": "a".repeat(32),
      "workspace-b": "short",
      "workspace-c": 123,
    })),
    { "workspace-a": "a".repeat(32) },
  );
  assert.deepEqual(parseWorkspaceWebhookSecrets("invalid-json"), {});
});

