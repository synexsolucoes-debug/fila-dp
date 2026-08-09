import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedRequestOrigin, requiresSameOrigin } from "../lib/request-security.ts";

test("requires same-origin for browser mutations", () => {
  assert.equal(requiresSameOrigin("POST", "/api/cards"), true);
  assert.equal(requiresSameOrigin("PATCH", "/api/cards/card-1"), true);
  assert.equal(requiresSameOrigin("DELETE", "/api/auth/sessions/session-1"), true);
  assert.equal(requiresSameOrigin("GET", "/api/cards"), false);
});

test("accepts only the request origin for protected mutations", () => {
  const base = { method: "POST", pathname: "/api/cards", requestOrigin: "https://fila.example.com" };
  assert.equal(isAllowedRequestOrigin({ ...base, origin: "https://fila.example.com" }), true);
  assert.equal(isAllowedRequestOrigin({ ...base, origin: "https://attacker.example" }), false);
  assert.equal(isAllowedRequestOrigin({ ...base, origin: null }), false);
  assert.equal(isAllowedRequestOrigin({ ...base, origin: "null" }), false);
});

test("keeps signed provider webhooks outside browser-origin enforcement", () => {
  assert.equal(isAllowedRequestOrigin({
    method: "POST",
    pathname: "/api/integrations/webhook/workspace-1",
    origin: null,
    requestOrigin: "https://fila.example.com",
  }), true);
  assert.equal(requiresSameOrigin("POST", "/api/saas/webhook/stripe"), false);
  assert.equal(requiresSameOrigin("POST", "/api/saas/webhook/stripe-fake"), true);
});
