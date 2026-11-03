/**
 * Sessão do app: servidor, token e usuário.
 *
 * O token fica no SecureStore — o chaveiro do iPhone —, nunca em armazenamento
 * comum. É a sessão do Vinculato como qualquer outra: aparece em "Sessões" no
 * painel com o nome "Vinculato Campo · app" e é encerrada por lá.
 */
import Constants from "expo-constants";
import { secureDelete, secureGet, secureSet } from "./secure";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loginRequest, logoutRequest, normalizeServer, setCredentials, setUnauthorizedHandler } from "./api";

const KEYS = { server: "vinculato.server", token: "vinculato.token", user: "vinculato.user" } as const;

export const defaultServer = String((Constants.expoConfig?.extra as { defaultServer?: string } | undefined)?.defaultServer ?? "");

type User = { name: string; email: string };

type SessionState =
  | { status: "loading"; server: string; user: null }
  | { status: "signedOut"; server: string; user: null; notice?: string }
  | { status: "signedIn"; server: string; user: User; token: string };

type SessionContextValue = {
  state: SessionState;
  signIn: (server: string, email: string, password: string) => Promise<void>;
  signOut: (notice?: string) => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading", server: defaultServer, user: null });

  const forget = useCallback(async (server: string, notice?: string) => {
    setCredentials(null);
    await secureDelete(KEYS.token).catch(() => undefined);
    await secureDelete(KEYS.user).catch(() => undefined);
    setState({ status: "signedOut", server, user: null, notice });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [server, token, rawUser] = await Promise.all([
        secureGet(KEYS.server), secureGet(KEYS.token), secureGet(KEYS.user),
      ]).catch(() => [null, null, null] as const);
      if (!alive) return;
      const savedServer = server || defaultServer;
      let user: User | null = null;
      try { user = rawUser ? JSON.parse(rawUser) as User : null; } catch { user = null; }
      if (token && user) {
        setCredentials({ server: savedServer, token });
        setState({ status: "signedIn", server: savedServer, user, token });
      } else {
        setState({ status: "signedOut", server: savedServer, user: null });
      }
    })();
    return () => { alive = false; };
  }, []);

  // Token revogado no painel ou expirado: a próxima chamada volta 401 e o app
  // pede login de novo, em vez de mostrar erro em toda tela.
  useEffect(() => {
    setUnauthorizedHandler(() => { void forget(state.server, "A sessão terminou. Entre novamente."); });
    return () => setUnauthorizedHandler(null);
  }, [forget, state.server]);

  const signIn = useCallback(async (serverInput: string, email: string, password: string) => {
    const server = normalizeServer(serverInput);
    if (!server) throw new Error("Informe o endereço do Vinculato.");
    const result = await loginRequest(server, email.trim().toLowerCase(), password);
    await secureSet(KEYS.server, server);
    await secureSet(KEYS.token, result.token);
    await secureSet(KEYS.user, JSON.stringify(result.user));
    setCredentials({ server, token: result.token });
    setState({ status: "signedIn", server, user: result.user, token: result.token });
  }, []);

  const signOut = useCallback(async (notice?: string) => {
    if (state.status === "signedIn") await logoutRequest(state.server, state.token);
    await forget(state.server, notice);
  }, [forget, state]);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession fora do SessionProvider.");
  return value;
}

/** Usuário logado. Só chamar em telas protegidas. */
export function useUser() {
  const { state } = useSession();
  if (state.status !== "signedIn") throw new Error("Tela protegida aberta sem sessão.");
  return state.user;
}
