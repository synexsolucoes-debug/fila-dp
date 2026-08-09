import { AsyncLocalStorage } from "node:async_hooks";

export type PlatformContext = {
  userId: string;
  email: string;
};

const storage = new AsyncLocalStorage<PlatformContext>();

export function getPlatformContext() {
  return storage.getStore() ?? null;
}

export async function withPlatformContext<T>(context: PlatformContext, callback: () => Promise<T>) {
  return storage.run(context, callback);
}
