import assert from "node:assert/strict";
import test from "node:test";
import { clearTenantContext, getTenantContext, setTenantContext, withTenantContext } from "../lib/tenant-context.ts";

test("tenant context is isolated to the current async execution", async () => {
  assert.equal(getTenantContext(), null);
  await withTenantContext({ workspaceId: "workspace-a", userId: "user-a" }, async () => {
    assert.deepEqual(getTenantContext(), { workspaceId: "workspace-a", userId: "user-a" });
  });
  assert.equal(getTenantContext(), null);
});

test("concurrent tenant executions do not cross-contaminate", async () => {
  const values = await Promise.all([
    withTenantContext({ workspaceId: "workspace-a" }, async () => {
      await Promise.resolve();
      return getTenantContext()?.workspaceId;
    }),
    withTenantContext({ workspaceId: "workspace-b" }, async () => {
      await Promise.resolve();
      return getTenantContext()?.workspaceId;
    }),
  ]);
  assert.deepEqual(values, ["workspace-a", "workspace-b"]);
  assert.equal(getTenantContext(), null);
});

test("verified workspace context can be attached for downstream queries", () => {
  setTenantContext({ workspaceId: "workspace-b", userId: "user-b" });
  assert.deepEqual(getTenantContext(), { workspaceId: "workspace-b", userId: "user-b" });
  clearTenantContext();
});
