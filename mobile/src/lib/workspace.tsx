/**
 * Contexto de trabalho: empresa, local de estoque, permissões, fila e avisos.
 *
 * Carregado uma vez depois do login, pelo mesmo `/api/epi/overview` do painel.
 * As permissões vêm na resposta para a tela saber o que desenhar; o servidor
 * confere de novo em cada gravação — esconder um botão nunca foi proteção.
 */
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api } from "./api";
import { flushQueue, listQueue, type QueuedOperation } from "./queue";

type Row = Record<string, unknown>;

export type CompanyOption = { id: string; name: string; status: string };
export type StockLocation = { id: string; name: string; code: string };
export type Permissions = {
  view: boolean; deliver: boolean; receiveReturn: boolean; damage: boolean; dispose: boolean; stockAdjust: boolean;
};
export type Summary = { caExpired: number; caExpiring: number; pendingSanitizing: number; awaitingDisposal: number };

const noPermissions: Permissions = { view: false, deliver: false, receiveReturn: false, damage: false, dispose: false, stockAdjust: false };
const emptySummary: Summary = { caExpired: 0, caExpiring: 0, pendingSanitizing: 0, awaitingDisposal: 0 };
const KEYS = { company: "vinculato.company", location: "vinculato.location" } as const;

type WorkspaceValue = {
  loading: boolean;
  error: string;
  companies: CompanyOption[];
  locations: StockLocation[];
  company: CompanyOption | null;
  location: StockLocation | null;
  setCompanyId: (id: string) => void;
  setLocationId: (id: string) => void;
  permissions: Permissions;
  summary: Summary;
  reload: () => Promise<void>;
  refreshSummary: () => Promise<void>;
  queue: QueuedOperation[];
  refreshQueue: () => Promise<void>;
  flush: () => Promise<{ sent: number; failed: number; remaining: number }>;
  /** Aviso curto no rodapé — o mesmo papel do "toast" do app web. */
  toast: string;
  notify: (message: string) => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [companyId, setCompanyIdState] = useState("");
  const [locationId, setLocationIdState] = useState("");
  const [permissions, setPermissions] = useState<Permissions>(noPermissions);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4200);
  }, []);

  const refreshQueue = useCallback(async () => setQueue(await listQueue()), []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, stock, savedCompany, savedLocation] = await Promise.all([
        api<{ companies?: Row[]; permissions?: Record<string, boolean> }>("/api/epi/overview"),
        api<{ locations?: Row[] }>("/api/epi/stock/locations"),
        SecureStore.getItemAsync(KEYS.company).catch(() => null),
        SecureStore.getItemAsync(KEYS.location).catch(() => null),
      ]);
      const list = (overview.companies ?? []).map((row) => ({
        id: String(row.id), name: String(row.trade_name || row.legal_name || ""), status: String(row.status ?? "active"),
      }));
      const places = (stock.locations ?? []).map((row) => ({
        id: String(row.id), name: String(row.name ?? ""), code: String(row.code ?? ""),
      }));
      const granted = overview.permissions ?? {};
      setPermissions({
        view: Boolean(granted.view), deliver: Boolean(granted.deliver), receiveReturn: Boolean(granted.receiveReturn),
        damage: Boolean(granted.damage), dispose: Boolean(granted.dispose), stockAdjust: Boolean(granted.stockAdjust),
      });
      setCompanies(list);
      setLocations(places);
      // A escolha da última vez vale se ainda existir; senão, a primeira ativa.
      setCompanyIdState((current) => [current, savedCompany].find((id) => id && list.some((item) => item.id === id))
        ?? list.find((item) => item.status === "active")?.id ?? list[0]?.id ?? "");
      setLocationIdState((current) => [current, savedLocation].find((id) => id && places.some((item) => item.id === id))
        ?? places[0]?.id ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os dados do grupo.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    if (!companyId) return;
    try {
      const overview = await api<{ summary?: Partial<Summary> }>(`/api/epi/overview?companyId=${encodeURIComponent(companyId)}`);
      setSummary({ ...emptySummary, ...overview.summary });
    } catch { /* o cartão só deixa de mostrar o número */ }
  }, [companyId]);

  const flush = useCallback(async () => {
    const result = await flushQueue();
    await refreshQueue();
    return result;
  }, [refreshQueue]);

  useEffect(() => { void reload(); void refreshQueue(); }, [reload, refreshQueue]);
  useEffect(() => { void refreshSummary(); }, [refreshSummary]);

  // A fila escoa sozinha: ao voltar para o app e a cada minuto. Ela não pode
  // virar uma caixa que alguém precisa lembrar de despachar.
  useEffect(() => {
    const sync = async () => {
      if (!(await listQueue()).length) return;
      const result = await flush();
      if (result.sent) notify(`${result.sent} registro(s) enviado(s) da fila.`);
    };
    const subscription = AppState.addEventListener("change", (next) => { if (next === "active") void sync(); });
    const timer = setInterval(() => void sync(), 60_000);
    void sync();
    return () => { subscription.remove(); clearInterval(timer); };
  }, [flush, notify]);

  const setCompanyId = useCallback((id: string) => {
    setCompanyIdState(id);
    void SecureStore.setItemAsync(KEYS.company, id).catch(() => undefined);
  }, []);
  const setLocationId = useCallback((id: string) => {
    setLocationIdState(id);
    void SecureStore.setItemAsync(KEYS.location, id).catch(() => undefined);
  }, []);

  const company = companies.find((item) => item.id === companyId) ?? null;
  const location = locations.find((item) => item.id === locationId) ?? null;

  const value = useMemo<WorkspaceValue>(() => ({
    loading, error, companies, locations, company, location, setCompanyId, setLocationId, permissions, summary,
    reload, refreshSummary, queue, refreshQueue, flush, toast, notify,
  }), [loading, error, companies, locations, company, location, setCompanyId, setLocationId, permissions, summary,
    reload, refreshSummary, queue, refreshQueue, flush, toast, notify]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace fora do WorkspaceProvider.");
  return value;
}
