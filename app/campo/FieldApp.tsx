"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Boxes, CalendarClock, Camera, Check, CloudOff, HardHat, LogOut, PackageCheck, RefreshCw,
  Search, Share, Sparkles, Trash2, Undo2, UploadCloud, Warehouse, X,
} from "lucide-react";
import {
  damageRouting, epiDamageDecisionLabels, epiDamageDecisions, epiDamageReasonLabels, epiDamageReasons,
  epiReturnConditionLabels, epiReturnConditions, returnRouting,
  type EpiDamageDecision, type EpiReturnCondition,
} from "@/lib/epi";
// Os normalizadores vêm do painel de propósito: as duas telas leem as mesmas
// rotas, e uma segunda cópia do mapeamento divergiria na primeira mudança de
// coluna — com a diferença aparecendo só no celular de quem está em campo.
import { normalizeDossier, type Row } from "@/app/painel/features/epi/epi.api";
import type { EmployeeEpiDossier, EmployeeOption, EpiDelivery, EpiProduct } from "@/app/painel/features/epi/epi.types";
import { availableAt, Chosen, EmployeePicker, ProductPicker, Stepper } from "./FieldPickers";
import { CareFlow, DueFlow, StockFlow } from "./SesmtFlows";
import { dueDeliveryReason, type DueEntry } from "./sesmt.logic";
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
type Screen = "home" | "delivery" | "return" | "damage" | "lookup" | "queue" | "due" | "stock" | "care";

type StockLocation = { id: string; name: string; code: string };
type CompanyOption = { id: string; name: string; taxId: string; status: string };
type Permissions = {
  deliver: boolean; receiveReturn: boolean; damage: boolean; view: boolean;
  dispose: boolean; stockAdjust: boolean;
};
const noPermissions: Permissions = { deliver: false, receiveReturn: false, damage: false, view: false, dispose: false, stockAdjust: false };

/** Contadores do resumo do módulo que a tela inicial mostra nos cartões do SESMT. */
type Summary = { caExpired: number; caExpiring: number; pendingSanitizing: number; awaitingDisposal: number; pendingSignature: number };
const emptySummary: Summary = { caExpired: 0, caExpiring: 0, pendingSanitizing: 0, awaitingDisposal: 0, pendingSignature: 0 };

/**
 * Entrega aberta a partir de uma pendência de vencimento.
 *
 * Carrega o colaborador e o EPI já escolhidos e, principalmente, o motivo: a
 * troca periódica precisa sair no termo como troca, não como primeira entrega.
 */
type DeliveryPreset = {
  employee: EmployeeOption;
  productId: string;
  productName: string;
  reason: "first_delivery" | "expiry_replacement" | "periodic_exchange";
};

const screenTitles: Record<Screen, string> = {
  home: "Vinculato Campo",
  delivery: "Entregar EPI",
  return: "Receber devolução",
  damage: "Registrar dano",
  lookup: "Consultar colaborador",
  queue: "Pendências de envio",
  due: "Vencimentos e trocas",
  stock: "Estoque",
  care: "Higienização e descarte",
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
  const [permissions, setPermissions] = useState<Permissions>(noPermissions);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [deliveryPreset, setDeliveryPreset] = useState<DeliveryPreset | null>(null);
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
        dispose: Boolean(granted.dispose), stockAdjust: Boolean(granted.stockAdjust),
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
        vencimentos: { screen: "due", allowed: allowed.view },
        estoque: { screen: "stock", allowed: allowed.view },
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

  // Contadores dos cartões do SESMT no recorte da empresa escolhida. Ficam fora
  // de `load` porque mudam com a empresa, e recarregar empresas e locais a cada
  // troca de empresa faria a tela inteira piscar. Falha aqui não é erro de
  // tela: o cartão só deixa de mostrar o número.
  const refreshSummary = useCallback(async () => {
    if (!companyId) return;
    try {
      const overview = await requestJson<{ summary?: Partial<Summary> }>(`/api/epi/overview?${new URLSearchParams({ companyId })}`);
      setSummary({ ...emptySummary, ...overview.summary });
    } catch { setSummary(emptySummary); }
  }, [companyId]);

  useEffect(() => {
    if (screen !== "home") return;
    const frame = window.requestAnimationFrame(() => void refreshSummary());
    return () => window.cancelAnimationFrame(frame);
  }, [refreshSummary, screen]);

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
    setDeliveryPreset(null);
    await refreshQueue();
    setScreen("home");
  }

  function goHome() {
    setDeliveryPreset(null);
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
      onBack={screen === "home" ? undefined : goHome}
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
      permissions={permissions} pending={queue.length} summary={summary}
      onPick={(next) => setScreen(next)} />}

    {screen === "delivery" && company && location && <DeliveryFlow
      key={deliveryPreset ? `preset:${deliveryPreset.employee.id}:${deliveryPreset.productId}` : "blank"}
      companyId={company.id} locationId={location.id} preset={deliveryPreset}
      onDone={afterWrite} onCancel={goHome} />}

    {screen === "due" && company && <DueFlow
      key={company.id} companyId={company.id} canDeliver={permissions.deliver}
      onDeliver={(entry: DueEntry) => {
        setDeliveryPreset({
          employee: {
            id: entry.employeeId, name: entry.employeeName, registrationNumber: entry.registrationNumber,
            positionName: entry.positionName, departmentName: entry.departmentName,
          },
          productId: entry.productId, productName: entry.productName, reason: dueDeliveryReason[entry.status],
        });
        setScreen("delivery");
      }} />}

    {screen === "stock" && location && <StockFlow
      key={location.id} locationId={location.id} locations={locations} canAdjust={permissions.stockAdjust}
      onDone={afterWrite} />}

    {screen === "care" && company && <CareFlow
      key={company.id} companyId={company.id} online={online}
      canSanitize={permissions.receiveReturn} canDispose={permissions.dispose}
      onToast={setToast} />}

    {screen === "return" && company && location && <ReturnFlow
      companyId={company.id} locationId={location.id}
      onDone={afterWrite} onCancel={goHome} />}

    {screen === "damage" && company && location && <DamageFlow
      companyId={company.id} locationId={location.id}
      onDone={afterWrite} onCancel={goHome} />}

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

type HomeAction = { id: Screen; label: string; hint: string; icon: typeof PackageCheck; allowed: boolean; badge?: number };

function Home({ company, companies, onCompany, location, locations, onLocation, permissions, pending, summary, onPick }: {
  company: CompanyOption | null; companies: CompanyOption[]; onCompany: (id: string) => void;
  location: StockLocation | null; locations: StockLocation[]; onLocation: (id: string) => void;
  permissions: Permissions; pending: number; summary: Summary; onPick: (screen: Screen) => void;
}) {
  const field: HomeAction[] = [
    { id: "delivery", label: "Entregar EPI", hint: "Sai do estoque e o colaborador assina", icon: PackageCheck, allowed: permissions.deliver },
    { id: "return", label: "Receber devolução", hint: "A condição decide o destino", icon: Undo2, allowed: permissions.receiveReturn },
    { id: "damage", label: "Registrar dano", hint: "Com foto da evidência", icon: Camera, allowed: permissions.damage },
    { id: "lookup", label: "Consultar colaborador", hint: "O que está em poder de quem", icon: Search, allowed: permissions.view },
  ];
  const caAlerts = summary.caExpired + summary.caExpiring;
  const careQueue = summary.pendingSanitizing + summary.awaitingDisposal;
  // Os três cartões do SESMT são de leitura para quem tem `epi.view`; o que
  // grava dentro deles confere a própria permissão na tela e no servidor.
  const sesmt: HomeAction[] = [
    { id: "due", label: "Vencimentos e trocas", icon: CalendarClock, allowed: permissions.view, badge: summary.caExpired,
      hint: caAlerts ? `${summary.caExpired} CA vencido(s), ${summary.caExpiring} vencendo` : "Quem está sem EPI, vencido ou com troca chegando" },
    { id: "stock", label: "Estoque", icon: Boxes, allowed: permissions.view,
      hint: permissions.stockAdjust ? "Saldo do local, entrada e transferência" : "Saldo deste local e dos outros" },
    { id: "care", label: "Higienização e descarte", icon: Sparkles, allowed: permissions.view, badge: careQueue,
      hint: careQueue ? `${summary.pendingSanitizing} para higienizar, ${summary.awaitingDisposal} para descartar` : "Nada parado agora" },
  ];
  const card = (action: HomeAction) => {
    const Icon = action.icon;
    return <button key={action.id} type="button" className={styles.actionCard}
      onClick={() => onPick(action.id)} disabled={!action.allowed}>
      <span className={styles.actionIcon}><Icon aria-hidden="true" /></span>
      {action.badge ? <span className={styles.countBadge} aria-label={`${action.badge} pendente(s)`}>{action.badge}</span> : null}
      <strong>{action.label}</strong>
      <small>{action.allowed ? action.hint : "Sem permissão para esta ação"}</small>
    </button>;
  };
  return <div className={styles.screen}>
    <InstallHint />
    <div className={styles.contextPickers}>
      <label>
        <span>Empresa</span>
        <select value={company?.id ?? ""} onChange={(event) => onCompany(event.target.value)}>
          {companies.map((item) => <option key={item.id} value={item.id}>
            {item.name}{item.status === "inactive" ? " (inativa)" : ""}
          </option>)}
        </select>
      </label>
      <label>
        <span>Local de estoque</span>
        <select value={location?.id ?? ""} onChange={(event) => onLocation(event.target.value)}>
          {locations.map((item) => <option key={item.id} value={item.id}>
            {item.name}{item.code ? ` · ${item.code}` : ""}
          </option>)}
        </select>
      </label>
    </div>

    <h2 className={styles.sectionTitle}>Operação</h2>
    <nav className={styles.actionGrid} aria-label="Ações de campo">{field.map(card)}</nav>

    <h2 className={styles.sectionTitle}>SESMT</h2>
    <nav className={styles.actionGrid} aria-label="Acompanhamento do SESMT">{sesmt.map(card)}</nav>

    {pending > 0 && <button type="button" className={styles.queueCallout} onClick={() => onPick("queue")}>
      <UploadCloud aria-hidden="true" />
      <span><strong>{pending} registro(s) aguardando envio</strong>
        <small>Feitos sem rede. Vão sozinhos quando a conexão voltar.</small></span>
    </button>}
  </div>;
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

const deliveryReasonLabels: Record<DeliveryPreset["reason"], string> = {
  first_delivery: "Primeira entrega",
  periodic_exchange: "Troca periódica",
  expiry_replacement: "Substituição por vencimento",
};

function DeliveryFlow({ companyId, locationId, preset, onDone, onCancel }: {
  companyId: string; locationId: string; preset: DeliveryPreset | null;
  onDone: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const [employee, setEmployee] = useState<EmployeeOption | null>(preset?.employee ?? null);
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signatureName, setSignatureName] = useState(preset?.employee.name ?? "");
  const reason = preset?.reason ?? "first_delivery";
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!employee) return <div className={styles.screen}><EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); setSignatureName(picked.name); }} /></div>;
  if (!product) return <div className={styles.screen}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <ProductPicker locationId={locationId} onPick={setProduct}
      initialTerm={preset?.productName ?? ""} preferId={preset?.productId ?? ""} />
  </div>;

  const here = availableAt(product, locationId);

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
          deliveryReason: reason,
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
    {preset && <p className={styles.hint}>Motivo no termo: <strong>{deliveryReasonLabels[reason]}</strong> — veio da lista de vencimentos.</p>}

    <section className={styles.step}>
      <h2>Quantidade</h2>
      <Stepper value={quantity} onChange={setQuantity} max={here} />
      <p className={styles.hint}>{here} disponível(is) neste local.</p>
    </section>

    <section className={styles.step}>
      <h2>Assinatura do colaborador</h2>
      <SignaturePad onChange={setSignature} disabled={busy} />
      <label className={styles.field}>
        <span>Quem assinou</span>
        <input value={signatureName} onChange={(event) => setSignatureName(event.target.value)}
          placeholder="Nome de quem assinou" autoComplete="off" />
      </label>
      {!signature && <p className={styles.hint}>
        Sem assinatura a entrega é gravada como <strong>pendente de assinatura</strong> e aparece no relatório de termos pendentes.
      </p>}
    </section>

    <label className={styles.field}>
      <span>Observação</span>
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
      <Stepper value={quantity} onChange={setQuantity} max={delivery.outstanding} />
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
      <span>Observação</span>
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
      <span>O que aconteceu</span>
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

/**
 * Como instalar no iPhone.
 *
 * O Safari não tem o aviso de instalação que o Android mostra sozinho: quem não
 * souber do "Adicionar à Tela de Início" usa o aplicativo pela aba do navegador
 * para sempre — sem tela cheia, e com a fila sem rede dependendo de a aba não
 * ser descartada. O aviso aparece só no iPhone/iPad, só fora do modo
 * instalado, e some de vez quando a pessoa fecha.
 *
 * O teste roda no efeito, não na renderização: `navigator` não existe no
 * servidor, e decidir lá desenharia o aviso para todo mundo por um instante.
 */
const INSTALL_HINT_KEY = "vinculato-campo:install-hint-dismissed";

function InstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
        // iPadOS se apresenta como Mac; o toque é o que denuncia.
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone = window.matchMedia("(display-mode: standalone)").matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      let dismissed = false;
      try { dismissed = window.localStorage.getItem(INSTALL_HINT_KEY) === "1"; } catch { /* armazenamento bloqueado */ }
      setVisible(ios && !standalone && !dismissed);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!visible) return null;
  return <aside className={styles.installHint} aria-label="Instalar no iPhone">
    <Share aria-hidden="true" />
    <p>
      <strong>Instale no iPhone, sem App Store</strong>
      Toque em <b>Compartilhar</b> na barra do Safari e depois em <b>Adicionar à Tela de Início</b>. O app abre em tela cheia e funciona sem rede.
    </p>
    <button type="button" className={styles.iconButton} aria-label="Fechar aviso de instalação" onClick={() => {
      setVisible(false);
      try { window.localStorage.setItem(INSTALL_HINT_KEY, "1"); } catch { /* segue sem lembrar */ }
    }}><X aria-hidden="true" /></button>
  </aside>;
}
