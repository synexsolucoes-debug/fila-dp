"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Camera, Check, CloudOff, HardHat, LogOut, PackageCheck, RefreshCw,
  ScanLine, Search, Trash2, Undo2, UploadCloud, UserRound, Warehouse,
} from "lucide-react";
import {
  damageRouting, epiDamageDecisionLabels, epiDamageDecisions, epiDamageReasonLabels, epiDamageReasons,
  epiReturnConditionLabels, epiReturnConditions, returnRouting,
  type EpiDamageDecision, type EpiReturnCondition,
} from "@/lib/epi";
// Os normalizadores vêm do painel de propósito: as duas telas leem as mesmas
// rotas, e uma segunda cópia do mapeamento divergiria na primeira mudança de
// coluna — com a diferença aparecendo só no celular de quem está em campo.
import {
  normalizeDossier, normalizeEmployeeOption, normalizeProduct, type Row,
} from "@/app/painel/features/epi/epi.api";
import type { EmployeeEpiDossier, EmployeeOption, EpiDelivery, EpiProduct } from "@/app/painel/features/epi/epi.types";
import { CodeScanner } from "./CodeScanner";
import { SignaturePad } from "./SignaturePad";
import {
  clearShellCache, dateLabel, discardOperation, flushQueue, listQueue, requestJson, submitOperation, today,
  type QueuedOperation,
} from "./field.api";
import styles from "./field.module.css";

/**
 * Vinculato Campo.
 *
 * O painel é feito para a mesa: tabela larga, filtro, relatório. Esta tela é
 * feita para o galpão — uma coisa por vez, alvo grande, e nada que exija as
 * duas mãos. Por isso ela não é o painel responsivo: é um fluxo próprio, com
 * quatro ações e um passo por tela.
 *
 * Duas regras moldam o resto:
 *
 *  - **o que foi feito diante do colaborador não se perde.** Toda gravação passa
 *    pela fila com chave de idempotência; sem rede, fica guardada e vai quando a
 *    rede volta. A tela diz qual dos três resultados aconteceu, porque
 *    "registrado", "guardado para enviar" e "registrado, falta a evidência" não
 *    são a mesma notícia — e o terceiro é o único em que a pessoa não precisa
 *    colher a assinatura de novo.
 *  - **a consequência aparece antes de gravar.** Devolução e dano calculam o
 *    destino com `returnRouting`/`damageRouting`, as mesmas funções que o
 *    servidor usa, de modo que a pessoa veja "abre demanda para o DP" enquanto
 *    ainda pode mudar de ideia.
 */
type Screen = "home" | "delivery" | "return" | "damage" | "lookup" | "queue";

type StockLocation = { id: string; name: string; code: string };
type CompanyOption = { id: string; name: string; taxId: string; status: string };
type Permissions = { deliver: boolean; receiveReturn: boolean; damage: boolean; view: boolean };

const screenTitles: Record<Screen, string> = {
  home: "Vinculato Campo",
  delivery: "Entregar EPI",
  return: "Receber devolução",
  damage: "Registrar dano",
  lookup: "Consultar colaborador",
  queue: "Pendências de envio",
};

export function FieldApp({ user, signOutPath }: {
  user: { displayName: string; email: string };
  signOutPath: string;
}) {
  const [screen, setScreen] = useState<Screen>("home");
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState("");
  const [permissions, setPermissions] = useState<Permissions>({ deliver: false, receiveReturn: false, damage: false, view: false });
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  // `navigator` não existe no servidor, então o valor inicial é otimista e o
  // efeito corrige na montagem. Ler isso dentro do corpo do efeito encadeava
  // renderizações sem necessidade.
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const refreshQueue = useCallback(async () => setQueue(await listQueue()), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const overview = await requestJson<{
        companies?: Row[]; permissions?: Record<string, boolean>;
      }>("/api/epi/overview");
      const list = (overview.companies ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.trade_name || row.legal_name || ""),
        taxId: String(row.tax_id ?? ""),
        status: String(row.status ?? "active"),
      }));
      setCompanies(list);
      setCompanyId((current) => list.some((item) => item.id === current)
        ? current
        : (list.find((item) => item.status === "active")?.id ?? list[0]?.id ?? ""));
      const granted = overview.permissions ?? {};
      const allowed: Permissions = {
        view: Boolean(granted.view), deliver: Boolean(granted.deliver),
        receiveReturn: Boolean(granted.receiveReturn), damage: Boolean(granted.damage),
      };
      setPermissions(allowed);

      // Atalho do ícone instalado (`?acao=…` no manifesto). Só abre o fluxo
      // depois das permissões carregadas: levar alguém direto a uma tela que ela
      // não pode usar seria pior do que não ter atalho. E só na abertura — não
      // vale sequestrar a navegação de quem já está trabalhando.
      const pedido = new URLSearchParams(window.location.search).get("acao");
      const atalho: Record<string, { screen: Screen; allowed: boolean }> = {
        entrega: { screen: "delivery", allowed: allowed.deliver },
        devolucao: { screen: "return", allowed: allowed.receiveReturn },
        dano: { screen: "damage", allowed: allowed.damage },
      };
      const destino = pedido ? atalho[pedido] : undefined;
      if (destino?.allowed) setScreen(destino.screen);

      const stock = await requestJson<{ locations?: Row[] }>("/api/epi/stock/locations");
      const places = (stock.locations ?? []).map((row) => ({
        id: String(row.id), name: String(row.name ?? ""), code: String(row.code ?? ""),
      }));
      setLocations(places);
      setLocationId((current) => places.some((item) => item.id === current) ? current : places[0]?.id ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os dados do grupo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); void refreshQueue(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load, refreshQueue]);

  // A fila escoa quando a rede volta, sem a pessoa pedir. É o comportamento que
  // justifica a fila existir: ela não deve virar uma caixa que alguém precisa
  // lembrar de despachar.
  useEffect(() => {
    const sync = async () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) return;
      const result = await flushQueue();
      if (result.sent) setToast(`${result.sent} registro(s) enviado(s) da fila.`);
      await refreshQueue();
    };
    // As duas referências são estáveis de propósito: uma função inline no
    // `addEventListener` e outra no `removeEventListener` são identidades
    // diferentes, e o ouvinte nunca sairia — acumulando um por remontagem.
    const onOnline = () => void sync();
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const timer = window.setInterval(() => void sync(), 60_000);
    // Primeira sincronização adiada para depois da pintura, pelo mesmo motivo
    // pelo qual o restante do painel usa `requestAnimationFrame`.
    const frame = window.requestAnimationFrame(() => void sync());
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [refreshQueue]);

  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(""), 4200); return () => window.clearTimeout(t); }, [toast]);

  const company = companies.find((item) => item.id === companyId) ?? null;
  const location = locations.find((item) => item.id === locationId) ?? null;

  async function afterWrite(message: string) {
    setToast(message);
    await refreshQueue();
    setScreen("home");
  }

  if (loading) {
    return <main className={styles.app}>
      <div className={styles.loading} role="status" aria-live="polite">
        <RefreshCw className={styles.spin} aria-hidden="true" />
        <strong>Abrindo o Vinculato Campo</strong>
        <span>Carregando empresas, locais de estoque e pendências…</span>
      </div>
    </main>;
  }

  if (!permissions.view) {
    return <main className={styles.app}>
      <Header title="Sem acesso" user={user} signOutPath={signOutPath} online={online} pending={queue.length} />
      <div className={styles.emptyState}>
        <AlertTriangle aria-hidden="true" />
        <strong>Você não tem acesso ao Controle de EPI</strong>
        <p>Peça ao administrador do grupo a permissão <code>epi.view</code>. O aplicativo de campo usa exatamente as mesmas permissões do painel.</p>
      </div>
    </main>;
  }

  if (!companies.length || !locations.length) {
    return <main className={styles.app}>
      <Header title="Configuração pendente" user={user} signOutPath={signOutPath} online={online} pending={queue.length} />
      <div className={styles.emptyState}>
        <Warehouse aria-hidden="true" />
        <strong>{!companies.length ? "Nenhuma empresa disponível" : "Nenhum local de estoque"}</strong>
        <p>{!companies.length
          ? "O Controle de EPI é organizado por empresa. Cadastre uma empresa ativa, ou peça acesso a uma, no painel."
          : "O estoque é controlado por local. Crie um local de estoque no painel, em Controle de EPI, antes de entregar pelo celular."}</p>
        <button type="button" className={styles.secondaryButton} onClick={() => void load()}>
          <RefreshCw aria-hidden="true" /> Tentar novamente
        </button>
      </div>
    </main>;
  }

  return <main className={styles.app}>
    <Header
      title={screenTitles[screen]}
      user={user}
      signOutPath={signOutPath}
      online={online}
      pending={queue.length}
      onBack={screen === "home" ? undefined : () => setScreen("home")}
      onQueue={() => setScreen("queue")}
    />

    {error && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}

    {!online && <p className={styles.offlineBanner}>
      <CloudOff aria-hidden="true" />
      Sem rede. O que você registrar fica guardado no aparelho e vai sozinho quando a conexão voltar.
    </p>}

    {screen === "home" && <Home
      company={company} companies={companies} onCompany={setCompanyId}
      location={location} locations={locations} onLocation={setLocationId}
      permissions={permissions} pending={queue.length}
      onPick={(next) => setScreen(next)} />}

    {screen === "delivery" && company && location && <DeliveryFlow
      companyId={company.id} locationId={location.id}
      onDone={afterWrite} onCancel={() => setScreen("home")} />}

    {screen === "return" && company && location && <ReturnFlow
      companyId={company.id} locationId={location.id}
      onDone={afterWrite} onCancel={() => setScreen("home")} />}

    {screen === "damage" && company && location && <DamageFlow
      companyId={company.id} locationId={location.id}
      onDone={afterWrite} onCancel={() => setScreen("home")} />}

    {screen === "lookup" && company && <LookupFlow companyId={company.id} />}

    {screen === "queue" && <QueuePanel
      queue={queue} online={online}
      onFlush={async () => {
        const result = await flushQueue();
        // Três desfechos, três frases. Dizer "a rede continua indisponível"
        // quando o servidor recusou mandaria a pessoa esperar por uma conexão
        // que já existe, em vez de ler o motivo que está na própria pendência.
        setToast(
          result.sent > 0 ? `${result.sent} enviado(s).`
            : result.failed > 0 ? `${result.failed} recusado(s) pelo servidor — veja o motivo na pendência.`
              : "Nada foi enviado — a rede continua indisponível.",
        );
        await refreshQueue();
      }}
      onDiscard={async (id) => { await discardOperation(id); await refreshQueue(); }} />}

    {toast && <div className={styles.toast} role="status"><Check aria-hidden="true" />{toast}</div>}
  </main>;
}

function Header({ title, user, signOutPath, online, pending, onBack, onQueue }: {
  title: string; user: { displayName: string }; signOutPath: string;
  online: boolean; pending: number; onBack?: () => void; onQueue?: () => void;
}) {
  /**
   * Saída do turno.
   *
   * Duas coisas acontecem antes de sair, e as duas existem porque o aparelho é
   * de uso compartilhado:
   *
   *  - avisa se há pendência. Operação enviada depois da troca de login iria ao
   *    servidor no nome de quem entrou, não de quem registrou — e quem registrou
   *    é a informação que o termo precisa carregar;
   *  - apaga a casca guardada, para o próximo a abrir sem rede não ver o nome de
   *    quem saiu.
   */
  async function signOut(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (pending > 0 && !window.confirm(
      `Há ${pending} registro(s) aguardando envio. Se sair agora, eles subirão no nome de quem entrar depois. Sair mesmo assim?`,
    )) return;
    // Um limite de tempo para a limpeza: sem rede ou com armazenamento travado,
    // ninguém pode ficar preso dentro do aplicativo.
    await Promise.race([clearShellCache(), new Promise((resolve) => window.setTimeout(resolve, 1500))]);
    window.location.href = signOutPath;
  }

  return <header className={styles.header}>
    {onBack
      ? <button type="button" className={styles.iconButton} onClick={onBack} aria-label="Voltar"><ArrowLeft aria-hidden="true" /></button>
      : <span className={styles.headerIcon} aria-hidden="true"><HardHat /></span>}
    <div className={styles.headerTitle}>
      <strong>{title}</strong>
      <small>{user.displayName}</small>
    </div>
    {onQueue && pending > 0 && <button type="button" className={styles.pendingBadge} onClick={onQueue}
      aria-label={`${pending} registro(s) aguardando envio`}>
      <UploadCloud aria-hidden="true" />{pending}
    </button>}
    <span className={styles.networkDot} data-online={online} aria-label={online ? "Com rede" : "Sem rede"} />
    <a className={styles.iconButton} href={signOutPath} aria-label="Sair"
      onClick={(event) => void signOut(event)}><LogOut aria-hidden="true" /></a>
  </header>;
}

function Home({ company, companies, onCompany, location, locations, onLocation, permissions, pending, onPick }: {
  company: CompanyOption | null; companies: CompanyOption[]; onCompany: (id: string) => void;
  location: StockLocation | null; locations: StockLocation[]; onLocation: (id: string) => void;
  permissions: Permissions; pending: number; onPick: (screen: Screen) => void;
}) {
  const actions: Array<{ id: Screen; label: string; hint: string; icon: typeof PackageCheck; allowed: boolean }> = [
    { id: "delivery", label: "Entregar EPI", hint: "Sai do estoque e o colaborador assina", icon: PackageCheck, allowed: permissions.deliver },
    { id: "return", label: "Receber devolução", hint: "A condição decide o destino", icon: Undo2, allowed: permissions.receiveReturn },
    { id: "damage", label: "Registrar dano", hint: "Com foto da evidência", icon: Camera, allowed: permissions.damage },
    { id: "lookup", label: "Consultar colaborador", hint: "O que está em poder de quem", icon: Search, allowed: permissions.view },
  ];
  return <div className={styles.screen}>
    <div className={styles.contextPickers}>
      <label>
        <span>EMPRESA</span>
        <select value={company?.id ?? ""} onChange={(event) => onCompany(event.target.value)}>
          {companies.map((item) => <option key={item.id} value={item.id}>
            {item.name}{item.status === "inactive" ? " (inativa)" : ""}
          </option>)}
        </select>
      </label>
      <label>
        <span>LOCAL DE ESTOQUE</span>
        <select value={location?.id ?? ""} onChange={(event) => onLocation(event.target.value)}>
          {locations.map((item) => <option key={item.id} value={item.id}>
            {item.name}{item.code ? ` · ${item.code}` : ""}
          </option>)}
        </select>
      </label>
    </div>

    <nav className={styles.actionGrid} aria-label="Ações de campo">
      {actions.map((action) => {
        const Icon = action.icon;
        return <button key={action.id} type="button" className={styles.actionCard}
          onClick={() => onPick(action.id)} disabled={!action.allowed}>
          <span className={styles.actionIcon}><Icon aria-hidden="true" /></span>
          <strong>{action.label}</strong>
          <small>{action.allowed ? action.hint : "Sem permissão para esta ação"}</small>
        </button>;
      })}
    </nav>

    {pending > 0 && <button type="button" className={styles.queueCallout} onClick={() => onPick("queue")}>
      <UploadCloud aria-hidden="true" />
      <span><strong>{pending} registro(s) aguardando envio</strong>
        <small>Feitos sem rede. Vão sozinhos quando a conexão voltar.</small></span>
    </button>}
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Busca de colaborador e de EPI, compartilhada pelos fluxos                  */
/* -------------------------------------------------------------------------- */

function EmployeePicker({ companyId, onPick }: { companyId: string; onPick: (employee: EmployeeOption) => void }) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<EmployeeOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const search = useCallback(async (value: string) => {
    const query = value.trim();
    if (!query) { setResults([]); return; }
    setBusy(true);
    try {
      const params = new URLSearchParams({ companyId, status: "active", limit: "25", search: query });
      const payload = await requestJson<{ employees?: Row[] }>(`/api/employees?${params}`);
      const list = (payload.employees ?? []).map(normalizeEmployeeOption);
      setResults(list);
      setProblem(list.length ? "" : "Nenhum colaborador encontrado com esse nome ou matrícula.");
      // Leitura de código que acha um só: segue direto, que é o ganho do scanner.
      if (list.length === 1) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar colaborador.");
    } finally { setBusy(false); }
  }, [companyId, onPick]);

  return <section className={styles.step}>
    <h2>Quem vai receber?</h2>
    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(term); } }}
        placeholder="Nome ou matrícula" autoComplete="off" enterKeyHint="search" aria-label="Buscar colaborador" />
      {/* O ícone é a única coisa dentro do botão, e `aria-hidden` o esconde do
          leitor de tela — sem rótulo o botão não tem nome nenhum. A varredura
          WCAG apontou isto nas quatro telas de campo. */}
      <button type="button" className={styles.secondaryButton} onClick={() => void search(term)}
        disabled={busy} aria-label="Procurar com o nome digitado">
        <Search aria-hidden="true" />
      </button>
      <button type="button" className={styles.secondaryButton} onClick={() => setScanning(true)} aria-label="Ler crachá">
        <ScanLine aria-hidden="true" />
      </button>
    </div>
    {problem && <p className={styles.hint} role="alert">{problem}</p>}
    <ul className={styles.pickList}>
      {results.map((employee) => <li key={employee.id}>
        <button type="button" onClick={() => onPick(employee)}>
          <UserRound aria-hidden="true" />
          <span><strong>{employee.name}</strong><small>{employee.registrationNumber} · {employee.positionName || "Sem cargo"}</small></span>
        </button>
      </li>)}
    </ul>
    {scanning && <CodeScanner label="Ler crachá do colaborador"
      onCode={(code) => { setScanning(false); setTerm(code); void search(code); }}
      onClose={() => setScanning(false)} />}
  </section>;
}

/**
 * Saldo do EPI **no local escolhido**.
 *
 * `stockQuantity` é o disponível somado de todos os locais, e a entrega debita
 * um local só. Mostrar o total faria a tela oferecer doze unidades onde há
 * zero: a pessoa entregaria, e a recusa chegaria depois — longe do colaborador
 * que já assinou.
 */
const availableAt = (product: EpiProduct, locationId: string) =>
  product.stockLocations.find((place) => place.id === locationId)?.quantity ?? 0;

function ProductPicker({ locationId, onPick }: { locationId: string; onPick: (product: EpiProduct) => void }) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<EpiProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const search = useCallback(async (value: string) => {
    const query = value.trim();
    setBusy(true);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (query) params.set("search", query);
      const payload = await requestJson<{ products?: Row[] }>(`/api/epi/products?${params}`);
      const list = (payload.products ?? []).map(normalizeProduct)
        .filter((item) => !["discarded", "lost", "inactive"].includes(item.status));
      setResults(list);
      setProblem(list.length ? "" : "Nenhum EPI encontrado por nome, código interno ou CA.");
      if (query && list.length === 1 && availableAt(list[0], locationId) > 0) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar EPI.");
    } finally { setBusy(false); }
  }, [locationId, onPick]);

  useEffect(() => { const frame = window.requestAnimationFrame(() => void search("")); return () => window.cancelAnimationFrame(frame); }, [search]);

  return <section className={styles.step}>
    <h2>Qual EPI?</h2>
    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(term); } }}
        placeholder="Nome, código interno ou CA" autoComplete="off" enterKeyHint="search" aria-label="Buscar EPI" />
      <button type="button" className={styles.secondaryButton} onClick={() => void search(term)}
        disabled={busy} aria-label="Procurar com o código digitado">
        <Search aria-hidden="true" />
      </button>
      <button type="button" className={styles.secondaryButton} onClick={() => setScanning(true)} aria-label="Ler código do EPI">
        <ScanLine aria-hidden="true" />
      </button>
    </div>
    {problem && <p className={styles.hint} role="alert">{problem}</p>}
    <ul className={styles.pickList}>
      {results.map((product) => {
        const here = availableAt(product, locationId);
        return <li key={product.id}>
          <button type="button" onClick={() => onPick(product)} disabled={here <= 0}>
            <HardHat aria-hidden="true" />
            <span>
              <strong>{product.name}</strong>
              <small>CA {product.caNumber || "—"} · {product.size || "—"} · {here > 0
                ? `${here} neste local`
                : `sem saldo aqui${product.stockQuantity > 0 ? ` (${product.stockQuantity} em outros locais)` : ""}`}</small>
            </span>
          </button>
        </li>;
      })}
    </ul>
    {scanning && <CodeScanner label="Ler código do EPI"
      onCode={(code) => { setScanning(false); setTerm(code); void search(code); }}
      onClose={() => setScanning(false)} />}
  </section>;
}

/**
 * O que dizer depois do envio.
 *
 * Três resultados diferentes, três frases diferentes. `partial` é o que o
 * ensaio de ponta a ponta trouxe à tona: o registro foi aceito e só a evidência
 * ficou para trás. Chamar isso de "sem rede" mandaria a pessoa colher a
 * assinatura de novo sem necessidade; chamar de "registrado" esconderia que o
 * termo ainda não está guardado.
 */
const outcome = (
  result: { status: "sent" | "queued" | "partial" },
  messages: { sent: string; queued: string; partial: string },
) => messages[result.status];

/* -------------------------------------------------------------------------- */
/* Entrega                                                                    */
/* -------------------------------------------------------------------------- */

function DeliveryFlow({ companyId, locationId, onDone, onCancel }: {
  companyId: string; locationId: string;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signatureName, setSignatureName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!employee) return <div className={styles.screen}><EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); setSignatureName(picked.name); }} /></div>;
  if (!product) return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <ProductPicker locationId={locationId} onPick={setProduct} />
  </div>;

  const here = availableAt(product, locationId);
  const maximum = Math.max(here, 1);

  async function submit() {
    if (!employee || !product) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "delivery",
        label: `Entrega · ${product.name} · ${employee.name}`,
        payload: {
          companyId, productId: product.id, employeeId: employee.id, stockLocationId: locationId,
          deliveredOn: today(), quantity, caNumber: product.caNumber, size: product.size,
          positionName: employee.positionName, departmentName: employee.departmentName,
          deliveryReason: "first_delivery",
          // A assinatura colhida na tela é o que torna o termo assinado; sem
          // ela o registro nasce pendente, e o relatório de termos sem
          // assinatura é justamente o que cobra isso depois.
          status: signature ? "signed" : "pending_signature",
          signatureName: signature ? signatureName : "",
          notes,
        },
        attachment: signature
          ? { blob: signature, filename: `assinatura-${Date.now()}.png`, kind: "delivery_term" }
          : null,
      });
      await onDone(outcome(result, {
        sent: "Entrega registrada e estoque atualizado.",
        queued: "Sem rede: entrega guardada no aparelho e será enviada sozinha.",
        partial: "Entrega registrada e estoque atualizado. O termo assinado ainda não subiu e vai sozinho — não precisa assinar de novo.",
      }));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a entrega.");
    } finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />

    <section className={styles.step}>
      <h2>Quantidade</h2>
      <div className={styles.stepper}>
        <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Diminuir">−</button>
        <output aria-live="polite">{quantity}</output>
        <button type="button" onClick={() => setQuantity((value) => Math.min(maximum, value + 1))} aria-label="Aumentar">+</button>
      </div>
      <p className={styles.hint}>{here} disponível(is) neste local.</p>
    </section>

    <section className={styles.step}>
      <h2>Assinatura do colaborador</h2>
      <SignaturePad onChange={setSignature} disabled={busy} />
      <label className={styles.field}>
        <span>QUEM ASSINOU</span>
        <input value={signatureName} onChange={(event) => setSignatureName(event.target.value)}
          placeholder="Nome de quem assinou" autoComplete="off" />
      </label>
      {!signature && <p className={styles.hint}>
        Sem assinatura a entrega é gravada como <strong>pendente de assinatura</strong> e aparece no relatório de termos pendentes.
      </p>}
    </section>

    <label className={styles.field}>
      <span>OBSERVAÇÃO</span>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Opcional" />
    </label>

    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy}>
        {busy ? "Gravando…" : "Confirmar entrega"}
      </button>
    </div>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Devolução                                                                  */
/* -------------------------------------------------------------------------- */

function ReturnFlow({ companyId, locationId, onDone, onCancel }: {
  companyId: string; locationId: string;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [active, setActive] = useState<EpiDelivery[]>([]);
  const [delivery, setDelivery] = useState<EpiDelivery | null>(null);
  const [condition, setCondition] = useState<EpiReturnCondition>("returned_sanitized");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const routing = useMemo(() => returnRouting(condition), [condition]);

  const loadActive = useCallback(async (employeeId: string) => {
    setLoading(true);
    try {
      const dossier = normalizeDossier(await requestJson<Row>(`/api/epi/employees/${employeeId}`));
      setActive(dossier.activeDeliveries);
      setProblem(dossier.activeDeliveries.length ? "" : "Este colaborador não tem EPI em poder para devolver.");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao carregar os EPIs do colaborador.");
    } finally { setLoading(false); }
  }, []);

  if (!employee) {
    return <div className={styles.screen}>
      <EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); void loadActive(picked.id); }} />
    </div>;
  }

  if (!delivery) {
    return <div className={styles.screen}>
      <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setActive([]); }} />
      <section className={styles.step}>
        <h2>O que está sendo devolvido?</h2>
        {loading && <p className={styles.hint} role="status">Carregando…</p>}
        {problem && <p className={styles.hint} role="alert">{problem}</p>}
        <ul className={styles.pickList}>
          {active.map((item) => <li key={item.id}>
            <button type="button" onClick={() => { setDelivery(item); setQuantity(item.outstanding); }}>
              <HardHat aria-hidden="true" />
              <span><strong>{item.epiName}</strong>
                <small>CA {item.caNumber || "—"} · {item.outstanding} em poder · entregue {dateLabel(item.deliveredOn)}</small></span>
            </button>
          </li>)}
        </ul>
      </section>
    </div>;
  }

  async function submit() {
    if (!employee || !delivery) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "return",
        label: `Devolução · ${delivery.epiName} · ${employee.name}`,
        payload: {
          deliveryId: delivery.id, stockLocationId: locationId, returnedOn: today(),
          quantity, epiCondition: condition, notes,
        },
      });
      await onDone(outcome(result, {
        sent: "Devolução registrada.",
        queued: "Sem rede: devolução guardada no aparelho e será enviada sozinha.",
        // A devolução não leva anexo; o caso fica coberto para não depender
        // disso continuar verdade.
        partial: "Devolução registrada. Um envio pendente ficou na fila e vai sozinho.",
      }));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a devolução.");
    } finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setDelivery(null); }} />
    <Chosen label="EPI" value={delivery.epiName} onClear={() => setDelivery(null)} />

    <section className={styles.step}>
      <h2>Quantidade devolvida</h2>
      <div className={styles.stepper}>
        <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Diminuir">−</button>
        <output aria-live="polite">{quantity}</output>
        <button type="button" onClick={() => setQuantity((value) => Math.min(delivery.outstanding, value + 1))} aria-label="Aumentar">+</button>
      </div>
      <p className={styles.hint}>{delivery.outstanding} em poder do colaborador.</p>
    </section>

    <section className={styles.step}>
      <h2>Condição do EPI</h2>
      <div className={styles.choiceList} role="radiogroup" aria-label="Condição do EPI">
        {epiReturnConditions.map((item) => <button key={item} type="button" role="radio"
          aria-checked={condition === item} className={condition === item ? styles.choiceActive : ""}
          onClick={() => setCondition(item)}>{epiReturnConditionLabels[item]}</button>)}
      </div>
    </section>

    <div className={styles.consequence}>
      <strong>O que acontece ao confirmar</strong>
      <ul>
        <li>{routing.backToStock ? "Volta ao estoque deste local." : "Não volta ao estoque."}</li>
        {routing.needsSanitizing && <li>Segue para higienização.</li>}
        {routing.sendToDisposal && <li data-alert="true">Entra na fila de descarte.</li>}
        {routing.generateDpDemand && <li data-alert="true">Abre demanda para o DP analisar possível desconto. Nenhum valor é descontado aqui.</li>}
      </ul>
    </div>

    <label className={styles.field}>
      <span>OBSERVAÇÃO</span>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Opcional" />
    </label>

    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy}>
        {busy ? "Gravando…" : "Confirmar devolução"}
      </button>
    </div>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Dano                                                                       */
/* -------------------------------------------------------------------------- */

function DamageFlow({ companyId, locationId, onDone, onCancel }: {
  companyId: string; locationId: string;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [active, setActive] = useState<EpiDelivery[]>([]);
  const [delivery, setDelivery] = useState<EpiDelivery | null>(null);
  const [reason, setReason] = useState<typeof epiDamageReasons[number]>("natural_wear");
  const [decision, setDecision] = useState<EpiDamageDecision>("exchange_without_discount");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const routing = useMemo(() => damageRouting(decision), [decision]);

  const loadActive = useCallback(async (employeeId: string) => {
    setLoading(true);
    try {
      const dossier = normalizeDossier(await requestJson<Row>(`/api/epi/employees/${employeeId}`));
      setActive(dossier.activeDeliveries);
      setProblem(dossier.activeDeliveries.length ? "" : "Este colaborador não tem EPI em poder para registrar dano.");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao carregar os EPIs do colaborador.");
    } finally { setLoading(false); }
  }, []);

  if (!employee) {
    return <div className={styles.screen}>
      <EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); void loadActive(picked.id); }} />
    </div>;
  }

  if (!delivery) {
    return <div className={styles.screen}>
      <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setActive([]); }} />
      <section className={styles.step}>
        <h2>Qual EPI foi danificado?</h2>
        {loading && <p className={styles.hint} role="status">Carregando…</p>}
        {problem && <p className={styles.hint} role="alert">{problem}</p>}
        <ul className={styles.pickList}>
          {active.map((item) => <li key={item.id}>
            <button type="button" onClick={() => setDelivery(item)}>
              <HardHat aria-hidden="true" />
              <span><strong>{item.epiName}</strong><small>CA {item.caNumber || "—"} · {item.outstanding} em poder</small></span>
            </button>
          </li>)}
        </ul>
      </section>
    </div>;
  }

  async function submit() {
    if (!employee || !delivery) return;
    if (!description.trim()) { setProblem("Descreva o que aconteceu — é a evidência escrita da ocorrência."); return; }
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "damage",
        label: `Dano · ${delivery.epiName} · ${employee.name}`,
        payload: {
          // O local vai explícito. Sem ele o servidor cai no local padrão do
          // grupo, e as consequências da decisão — descarte, higienização,
          // reposição — lançariam no estoque errado para quem está em outro
          // almoxarifado. É o mesmo cuidado do saldo exibido na entrega.
          companyId, employeeId: employee.id, productId: delivery.productId, deliveryId: delivery.id,
          stockLocationId: locationId,
          occurredOn: today(), quantity: 1, damageReason: reason, decision, description,
        },
        attachment: photo ? { blob: photo, filename: photo.name || `dano-${Date.now()}.jpg`, kind: "photo" } : null,
      });
      await onDone(outcome(result, {
        sent: "Dano registrado com a decisão tomada.",
        queued: "Sem rede: ocorrência guardada no aparelho e será enviada sozinha.",
        partial: "Dano registrado com a decisão tomada. A foto ainda não subiu e vai sozinha — não precisa fotografar de novo.",
      }));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar o dano.");
    } finally { setBusy(false); }
  }

  return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setDelivery(null); }} />
    <Chosen label="EPI" value={delivery.epiName} onClear={() => setDelivery(null)} />

    <section className={styles.step}>
      <h2>Foto da evidência</h2>
      {/* `capture="environment"` abre a câmera traseira direto, sem passar pela
          galeria. Um `<input type="file">` é mais confiável que `getUserMedia`
          aqui: funciona no iPhone, respeita a permissão do sistema e devolve o
          arquivo já comprimido pelo aparelho. */}
      <label className={styles.photoPicker}>
        <input type="file" accept="image/*" capture="environment"
          onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} />
        <Camera aria-hidden="true" />
        <span>{photo ? photo.name : "Tirar foto do equipamento"}</span>
      </label>
      {photo && <p className={styles.hint}>Foto anexada à ocorrência como evidência.</p>}
    </section>

    <section className={styles.step}>
      <h2>Motivo</h2>
      <div className={styles.choiceList} role="radiogroup" aria-label="Motivo da danificação">
        {epiDamageReasons.map((item) => <button key={item} type="button" role="radio"
          aria-checked={reason === item} className={reason === item ? styles.choiceActive : ""}
          onClick={() => setReason(item)}>{epiDamageReasonLabels[item]}</button>)}
      </div>
    </section>

    <label className={styles.field}>
      <span>O QUE ACONTECEU</span>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3}
        placeholder="Quando, como e em que circunstância." />
    </label>

    <section className={styles.step}>
      <h2>Decisão</h2>
      <div className={styles.choiceList} role="radiogroup" aria-label="Decisão da análise">
        {epiDamageDecisions.map((item) => <button key={item} type="button" role="radio"
          aria-checked={decision === item} className={decision === item ? styles.choiceActive : ""}
          onClick={() => setDecision(item)}>{epiDamageDecisionLabels[item]}</button>)}
      </div>
    </section>

    <div className={styles.consequence}>
      <strong>O que esta decisão provoca</strong>
      <ul>
        {routing.settleOldDelivery && <li>Baixa do equipamento na entrega do colaborador.</li>}
        {routing.createDisposal && <li data-alert="true">Abre registro na fila de descarte.</li>}
        {routing.productStatus === "sanitizing" && <li>O EPI passa para higienização.</li>}
        {routing.discountTrigger && <li data-alert="true">Abre demanda para o DP analisar possível desconto. Nenhum valor é descontado aqui.</li>}
        {!routing.settleOldDelivery && !routing.createDisposal && !routing.discountTrigger
          && <li>Somente o registro da ocorrência, com a evidência.</li>}
      </ul>
      {routing.deliverReplacement && <p className={styles.hint}>
        A entrega do substituto é feita no painel ou por uma nova entrega aqui, depois de registrar o dano.
      </p>}
    </div>

    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    <div className={styles.actionBar}>
      <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
      <button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy}>
        {busy ? "Gravando…" : "Registrar dano"}
      </button>
    </div>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Consulta                                                                   */
/* -------------------------------------------------------------------------- */

function LookupFlow({ companyId }: { companyId: string }) {
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [dossier, setDossier] = useState<EmployeeEpiDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");

  const load = useCallback(async (employeeId: string) => {
    setLoading(true);
    try {
      setDossier(normalizeDossier(await requestJson<Row>(`/api/epi/employees/${employeeId}`)));
      setProblem("");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao carregar os EPIs do colaborador.");
    } finally { setLoading(false); }
  }, []);

  if (!employee) {
    return <div className={styles.screen}>
      <EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); void load(picked.id); }} />
    </div>;
  }

  const held = dossier?.activeDeliveries ?? [];
  const units = held.reduce((sum, item) => sum + item.outstanding, 0);

  return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setDossier(null); }} />
    {loading && <p className={styles.hint} role="status">Carregando…</p>}
    {problem && <p className={styles.errorBanner} role="alert"><AlertTriangle aria-hidden="true" />{problem}</p>}

    {dossier && <>
      <div className={styles.summaryRow}>
        <article><small>Em poder</small><strong>{units}</strong></article>
        <article><small>Itens</small><strong>{held.length}</strong></article>
        <article><small>Devoluções</small><strong>{dossier.returns.length}</strong></article>
      </div>

      <section className={styles.step}>
        <h2>EPIs em poder</h2>
        {held.length ? <ul className={styles.plainList}>
          {held.map((item) => <li key={item.id}>
            <strong>{item.epiName}</strong>
            <small>CA {item.caNumber || "—"} · {item.size || "—"} · {item.outstanding} un. · desde {dateLabel(item.deliveredOn)}</small>
          </li>)}
        </ul> : <p className={styles.hint}>Nada em poder deste colaborador.</p>}
      </section>

      {dossier.discounts.length > 0 && <section className={styles.step}>
        <h2>Análises de desconto</h2>
        <ul className={styles.plainList}>
          {dossier.discounts.slice(0, 5).map((item) => <li key={item.id}>
            <strong>{item.epiName}</strong>
            <small>{dateLabel(item.occurredOn)} · {item.status}</small>
          </li>)}
        </ul>
      </section>}
    </>}
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Fila                                                                       */
/* -------------------------------------------------------------------------- */

function QueuePanel({ queue, online, onFlush, onDiscard }: {
  queue: QueuedOperation[]; online: boolean;
  onFlush: () => Promise<void>; onDiscard: (id: string) => Promise<void>;
}) {
  if (!queue.length) {
    return <div className={styles.screen}>
      <div className={styles.emptyState}>
        <Check aria-hidden="true" />
        <strong>Nada pendente</strong>
        <p>Tudo o que você registrou já está no servidor.</p>
      </div>
    </div>;
  }
  return <div className={styles.screen}>
    <p className={styles.hint}>
      O que ficou para enviar. Vai sozinho quando a conexão voltar — a chave de idempotência garante que reenviar
      não duplica a entrega.
    </p>
    <ul className={styles.plainList}>
      {queue.map((item) => <li key={item.id}>
        <strong>{item.label}</strong>
        <small>{new Date(item.createdAt).toLocaleString("pt-BR")} · {item.attempts} tentativa(s)</small>
        {/* Dizer qual parte está pendente evita o pior engano possível aqui:
            descartar achando que nada foi registrado, quando a entrega já
            debitou o estoque e só a evidência ficou na fila. */}
        {item.recordId
          ? <small className={styles.queuePartial}>Registro já gravado no servidor · falta só a evidência</small>
          : <small>Registro ainda não enviado</small>}
        {item.lastError && <small className={styles.queueError}>{item.lastError}</small>}
        {item.attempts > 0 && item.lastError && <button type="button" className={styles.ghostButton}
          onClick={() => void onDiscard(item.id)}>
          <Trash2 aria-hidden="true" /> {item.recordId ? "Descartar a evidência" : "Descartar"}
        </button>}
      </li>)}
    </ul>
    <div className={styles.actionBar}>
      <button type="button" className={styles.primaryButton} onClick={() => void onFlush()} disabled={!online}>
        <UploadCloud aria-hidden="true" /> {online ? "Enviar agora" : "Sem rede"}
      </button>
    </div>
  </div>;
}

function Chosen({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return <div className={styles.chosen}>
    <span><small>{label}</small><strong>{value}</strong></span>
    <button type="button" className={styles.ghostButton} onClick={onClear}>Trocar</button>
  </div>;
}
