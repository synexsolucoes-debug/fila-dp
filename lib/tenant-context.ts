import { AsyncLocalStorage } from "node:async_hooks";

export type TenantContext = {
  workspaceId: string;
  userId?: string | null;
};

const storage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext() {
  return storage.getStore() ?? null;
}

export function setTenantContext(context: TenantContext) {
  storage.enterWith(context);
}

export function clearTenantContext() {
  storage.disable();
}

export async function withTenantContext<T>(context: TenantContext, callback: () => Promise<T>) {
  return storage.run(context, callback);
}
