import test from "node:test";
import assert from "node:assert/strict";
import { isoTimestamp } from "../lib/iso-timestamp.ts";

test("prazo vindo do banco como Date vira ISO, e o Planner agrupa pelo dia certo", () => {
  const due = new Date("2026-11-03T18:00:00Z");
  assert.equal(isoTimestamp(due).slice(0, 10), "2026-11-03");
  // String(date) era o que chegava antes: "Tue Nov 03 2026 …", e o dia virava "Tue Nov 03".
  assert.equal(isoTimestamp(String(due)).slice(0, 10), "2026-11-03");
  assert.equal(isoTimestamp("2026-11-03 18:00:00+00"), "2026-11-03 18:00:00+00");
});
