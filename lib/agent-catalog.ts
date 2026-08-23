/**
 * O catálogo de produto: os três agentes que o Vinculato mostra.
 *
 * A decisão de produto é curta — **Teams, Tangerino e Sankhya**, e nada mais na
 * experiência operacional. Este arquivo é onde ela mora, e é a única lista que
 * as telas consultam.
 *
 * ## Por que um catálogo, e não uma migration de nomes
 *
 * As chaves internas (`tangerino_browser`, `sankhya_browser`, `teams`) estão em
 * dado de cliente: em `fdp_integrations.channel`, em execuções, em eventos, em
 * auditoria e em propostas já gravadas. Renomeá-las por estética trocaria um
 * problema de vocabulário por um risco de integridade sobre histórico que
 * ninguém pode perder. Então o nome interno fica, e a tradução acontece aqui —
 * uma camada de alias, como manda o desenho.
 *
 * A regra que isso estabelece: **nome técnico não atravessa esta fronteira.**
 * Se `tangerino_browser` aparecer na tela, o defeito é aqui.
 *
 * ## O que "esconder" quer dizer
 *
 * Canal fora deste catálogo some da experiência operacional e **de mais nada**.
 * Continua no banco, continua com execuções, eventos, auditoria e propostas
 * intactos, e continua administrável pelo console da plataforma. Esconder é
 * decisão de produto; apagar seria decisão sobre o histórico de outra pessoa.
 */

/** A chave de produto — o que a tela e a URL usam. */
export const productAgentKeys = ["teams_agent", "tangerino_agent", "sankhya_agent"] as const;
export type ProductAgentKey = typeof productAgentKeys[number];

/** Como o agente conversa com a origem. A tela não precisa disso; o servidor sim. */
export type AgentMechanism = "browser" | "webhook";

/** O que o teste de conexão realmente faz para este agente (§23). */
export type AgentTestKind = "browser_login" | "webhook_receipt";

export type ProductAgent = {
  key: ProductAgentKey;
  /** O nome que a pessoa lê. Sempre "Agente X" — nunca a chave interna (§2, §4, §7). */
  label: string;
  /** O canal gravado em `fdp_integrations.channel`. Interno, nunca exibido. */
  channel: string;
  mechanism: AgentMechanism;
  testKind: AgentTestKind;
  /** O que ele faz, em uma frase que um operador entende. */
  summary: string;
  /** Ele lê a origem, ou só recebe dela? Governa quais ações a tela oferece. */
  reads: boolean;
  /** Aceita cadência própria? Nem todo agente tem o que executar periodicamente. */
  supportsSchedule: boolean;
  /** Campos de configuração, na ordem em que a tela pergunta. */
  fields: readonly AgentSetupField[];
  /**
   * Onde o acesso deste agente é preparado.
   *
   * Nem sempre é o painel do grupo. O Sankhya é preparado pela Plataforma
   * Global por decisão de segurança anterior — credencial de ERP não é dada por
   * quem opera. A tela precisa **dizer isso**, e não apenas não oferecer o
   * formulário: um card sem campos e sem explicação é o mesmo beco de antes,
   * com outra aparência.
   */
  setupBy: "workspace" | "platform";
  /** A frase que a tela mostra quando o setup não é do grupo. Vazia quando é. */
  setupNote: string;
  /** Os passos do setup, na ordem (§11, §12, §13). */
  steps: readonly string[];
};

export type AgentSetupField = {
  key: string;
  label: string;
  hint: string;
  kind: "text" | "password" | "url" | "select";
  required: boolean;
  /** Segredo nunca volta do servidor: o campo existe para gravar, não para ler (§2). */
  secret?: boolean;
};

/* -------------------------------------------------------------------------- *
 * Os três
 * -------------------------------------------------------------------------- */

const TANGERINO: ProductAgent = {
  key: "tangerino_agent",
  label: "Agente Tangerino",
  /* O canal interno é o do navegador, e essa escolha é o coração da mudança.
     A Central listava `tangerino` — a **API** — como se fosse o agente, e o
     agente de navegador real não aparecia em lugar nenhum. Quem configurava
     "o Tangerino" configurava um conector de API que a decisão de produto
     acabou de proibir (§1). */
  channel: "tangerino_browser",
  mechanism: "browser",
  testKind: "browser_login",
  summary: "Entra no Tangerino pelo navegador com usuário e senha e confere a situação das admissões pendentes. Só lê: não altera nada na origem.",
  reads: true,
  /* A varredura tem escopo definido: admissões pendentes de conferência —
     colaborador com vínculo no Tangerino cuja última leitura não terminou em
     desfecho e já passou da validade. A cadência é a mesma máquina dos demais
     agentes; o que muda é o que ela enfileira (`lib/tangerino/sweep.ts`). */
  supportsSchedule: true,
  fields: [
    { key: "username", label: "Usuário do Tangerino", kind: "text", required: true,
      hint: "A conta dedicada ao Vinculato. Use uma conta de leitura, não a de quem administra." },
    { key: "password", label: "Senha", kind: "password", required: true, secret: true,
      hint: "Guardada cifrada em cofre próprio do agente. Nunca volta para esta tela, para a API ou para os registros." },
    { key: "accountReference", label: "Referência da conta", kind: "text", required: false,
      hint: "Opcional. Como este cliente é identificado no Tangerino, para você reconhecer o agente na lista." },
  ],
  setupBy: "workspace",
  setupNote: "",
  steps: [
    "Configurar acesso",
    "Usuário e senha",
    "Testar login",
    "Definir frequência",
    "Ativar agente",
    "Executar agora",
  ],
};

const SANKHYA: ProductAgent = {
  key: "sankhya_agent",
  label: "Agente Sankhya",
  channel: "sankhya_browser",
  mechanism: "browser",
  testKind: "browser_login",
  summary: "Entra no Sankhya pelo navegador, confere o cadastro de colaboradores e traz as diferenças. O que é incerto vira proposta para alguém decidir.",
  reads: true,
  supportsSchedule: true,
  fields: [
    { key: "endpoint", label: "Endereço do ambiente", kind: "url", required: true,
      hint: "A URL de login do Sankhya deste cliente. Só domínios oficiais são aceitos." },
    { key: "username", label: "Usuário do Sankhya", kind: "text", required: true,
      hint: "A conta dedicada ao Vinculato. Use uma conta de leitura." },
    { key: "password", label: "Senha", kind: "password", required: true, secret: true,
      hint: "Guardada cifrada em cofre próprio do agente. Nunca volta para esta tela, para a API ou para os registros." },
    { key: "companyId", label: "Empresa de destino", kind: "select", required: true,
      hint: "A empresa do Vinculato a que os colaboradores lidos pertencem." },
    { key: "companyContext", label: "Empresa no Sankhya", kind: "text", required: false,
      hint: "Opcional. O código ou nome que aparece na tela de login, quando o ambiente pede." },
  ],
  setupBy: "platform",
  setupNote: "O acesso ao Sankhya é preparado pela Plataforma Global, e não aqui: credencial de ERP dá entrada no sistema onde a folha é fechada, e quem a grava responde por ela. Você continua acompanhando, testando, pausando e reprocessando este agente por esta tela.",
  steps: [
    "Configurar acesso",
    "Credenciais",
    "Testar login",
    "Definir frequência",
    "Ativar agente",
    "Executar agora",
  ],
};

const TEAMS: ProductAgent = {
  key: "teams_agent",
  label: "Agente Teams",
  channel: "teams",
  /* Internamente é webhook, e continua sendo: §8 diz que a experiência é
     uniforme, não a arquitetura. Forçar um navegador aqui seria construir um
     mecanismo pior para o mesmo resultado. */
  mechanism: "webhook",
  testKind: "webhook_receipt",
  summary: "Recebe avisos de movimentação vindos do Teams e abre a demanda correspondente no Vinculato.",
  reads: false,
  supportsSchedule: false,
  fields: [
    { key: "tenantId", label: "Tenant", kind: "text", required: false,
      hint: "Identificador do tenant Microsoft. Só é necessário quando o fluxo do cliente exige." },
    { key: "teamId", label: "Equipe", kind: "text", required: true,
      hint: "A equipe de onde os avisos vêm." },
    { key: "teamName", label: "Nome da equipe", kind: "text", required: false,
      hint: "Como a equipe aparece nos registros, para você reconhecê-la depois." },
    { key: "channelId", label: "Canal", kind: "text", required: true,
      hint: "O canal de onde os avisos vêm." },
    { key: "channelName", label: "Nome do canal", kind: "text", required: false,
      hint: "Como o canal aparece nos registros." },
    { key: "boardId", label: "Quadro de destino", kind: "select", required: false,
      hint: "Onde as demandas criadas por este agente nascem." },
    { key: "companyId", label: "Empresa de destino", kind: "select", required: false,
      hint: "A empresa a que os avisos recebidos pertencem." },
  ],
  setupBy: "workspace",
  setupNote: "",
  steps: [
    "Configurar canal",
    "Gerar webhook",
    "Configurar Power Automate",
    "Testar recebimento",
    "Ativar",
  ],
};

export const productAgents: readonly ProductAgent[] = [TEAMS, TANGERINO, SANKHYA];

/* -------------------------------------------------------------------------- *
 * Tradução entre os dois vocabulários
 * -------------------------------------------------------------------------- */

const BY_KEY = new Map<string, ProductAgent>(productAgents.map((agent) => [agent.key, agent]));
const BY_CHANNEL = new Map<string, ProductAgent>(productAgents.map((agent) => [agent.channel, agent]));

/**
 * Apelidos aceitos de fora, para a URL e as chaves já gravadas não quebrarem.
 *
 * `sankhya` está em `fdp_agent_proposals.agent_key` de propostas antigas, e
 * `tangerino_browser` está em execuções. Recusar essas chaves faria o histórico
 * deixar de abrir — o dado continuaria lá, e ninguém alcançaria.
 */
const ALIASES: Record<string, ProductAgentKey> = {
  teams: "teams_agent", teams_agent: "teams_agent",
  tangerino_browser: "tangerino_agent", tangerino_agent: "tangerino_agent",
  /* `tangerino` era a chave do conector de API, que a decisão de produto
     aposenta. Ele aponta para o agente porque as propostas e execuções antigas
     gravaram essa chave, e recusá-la faria o histórico do Tangerino deixar de
     abrir — o dado continuaria no banco e ninguém alcançaria (§17). O que ele
     **não** faz é ressuscitar a API: o canal de destino é o do navegador. */
  tangerino: "tangerino_agent",
  sankhya: "sankhya_agent", sankhya_browser: "sankhya_agent", sankhya_agent: "sankhya_agent",
};

/** O agente de produto de uma chave vinda de fora, ou `null` quando não é um dos três. */
export function resolveProductAgent(value: unknown): ProductAgent | null {
  if (typeof value !== "string") return null;
  const key = ALIASES[value.trim()];
  return key ? BY_KEY.get(key) ?? null : null;
}

export function productAgentByChannel(channel: unknown): ProductAgent | null {
  return typeof channel === "string" ? BY_CHANNEL.get(channel.trim()) ?? null : null;
}

/** Os canais que a experiência operacional mostra. Tudo fora daqui fica oculto. */
export const visibleChannels: readonly string[] = productAgents.map((agent) => agent.channel);

export function isVisibleChannel(channel: unknown): boolean {
  return typeof channel === "string" && visibleChannels.includes(channel.trim());
}

/* -------------------------------------------------------------------------- *
 * Estados, em português (§10)
 * -------------------------------------------------------------------------- */

export type AgentState =
  | "not_configured" | "credential_pending" | "test_pending"
  | "ready" | "active" | "paused" | "degraded" | "error";

export const agentStateLabels: Record<AgentState, { label: string; detail: string }> = {
  not_configured: { label: "Não configurado", detail: "Falta informar o acesso deste agente." },
  credential_pending: { label: "Credencial pendente", detail: "O acesso está descrito, mas usuário e senha ainda não foram gravados." },
  test_pending: { label: "Teste pendente", detail: "A credencial está guardada. Gravar não prova que ela funciona — falta um teste bem-sucedido." },
  ready: { label: "Pronto", detail: "Testado e conferido. Falta ativar para o agente passar a trabalhar." },
  active: { label: "Ativo", detail: "Trabalhando normalmente." },
  paused: { label: "Pausado", detail: "Alguém interrompeu de propósito. Nada é executado até retomar." },
  degraded: { label: "Degradado", detail: "Continua de pé, mas algo mudou na origem ou vem falhando. Precisa de conferência." },
  error: { label: "Erro", detail: "A última execução falhou e o agente não conseguiu se recuperar sozinho." },
};

/**
 * O estado do agente a partir do que o banco guarda.
 *
 * A ordem das perguntas é a ordem em que a pessoa resolve, e não é acidental:
 * pausado vence tudo porque foi decisão de alguém; depois vêm os degraus do
 * setup, do mais básico ao mais adiantado; só então o que pode dar errado.
 *
 * O degrau que costuma surpreender é `test_pending`. Gravar a senha **não**
 * conecta o agente — e a tela precisa dizer isso no estado, não numa recusa
 * depois do clique em "Executar" (§23).
 */
export function agentState(input: {
  paused?: boolean;
  configured?: boolean;
  hasCredential?: boolean;
  testedAt?: string | null;
  enabled?: boolean;
  consecutiveFailures?: number;
  degraded?: boolean;
  lastRunFailed?: boolean;
}): AgentState {
  if (input.paused) return "paused";
  if (!input.configured) return "not_configured";
  if (!input.hasCredential) return "credential_pending";
  if (!input.testedAt) return "test_pending";
  if (input.degraded || (input.consecutiveFailures ?? 0) >= 3) return "degraded";
  if (input.lastRunFailed) return "error";
  return input.enabled ? "active" : "ready";
}

/** "Executar agora" só existe quando há o que executar e o caminho está provado (§25). */
export function canRunNow(agent: ProductAgent, state: AgentState): boolean {
  if (!agent.reads || !agent.supportsSchedule) return false;
  return state === "active" || state === "ready";
}
