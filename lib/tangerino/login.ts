import { tangerinoBrowserLoginUrl } from "./hosts.ts";
import type { TangerinoBrowserSession } from "./types.ts";

/** A única ação de provedor permitida no teste de conexão: autenticar. */
export async function verifyTangerinoBrowserLogin(session: TangerinoBrowserSession, input: {
  username: string;
  password: string;
  timeoutMs: number;
}) {
  await session.ensureAuthenticated({
    endpoint: tangerinoBrowserLoginUrl,
    username: input.username,
    password: input.password,
    timeoutMs: input.timeoutMs,
  });
}
