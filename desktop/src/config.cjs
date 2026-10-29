/**
 * Configuração do aplicativo de mesa — sem Electron, para poder ser testada.
 *
 * O app não carrega o sistema de dentro do instalador: ele abre o mesmo
 * Vinculato da nuvem numa janela própria. Por isso a única coisa que ele
 * precisa saber é **qual servidor abrir**. A ordem é:
 *
 * 1. o que a pessoa configurou em "Arquivo → Configurar servidor" (gravado no
 *    perfil do Windows, sobrevive a atualização do instalador);
 * 2. a variável `VINCULATO_URL`, para TI apontar uma instalação para
 *    homologação sem mexer no perfil de ninguém;
 * 3. o endereço padrão de produção.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SERVER_URL = "https://fila-dp.synexsolucoes.chatgpt.site";

/**
 * Normaliza o endereço digitado.
 *
 * Aceita "vinculato.empresa.com.br" sem protocolo, porque é assim que as
 * pessoas escrevem. Só `https` é aceito — a exceção é `localhost`, para quem
 * desenvolve. Devolve só a origem: o app sempre entra pelo `/painel`.
 */
function normalizeServerUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, "vinculato-desktop.json");
}

function readSettings(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(userDataDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(userDataDir, patch) {
  const next = { ...readSettings(userDataDir), ...patch };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(next, null, 2));
  return next;
}

function resolveServerUrl(settings, env) {
  return normalizeServerUrl(settings.serverUrl)
    ?? normalizeServerUrl(env.VINCULATO_URL)
    ?? DEFAULT_SERVER_URL;
}

/**
 * Decide se um endereço fica dentro do app ou vai para o navegador.
 *
 * Fica dentro só o que é do próprio servidor. Link para a Receita, para o
 * eSocial ou para um PDF de terceiro abre no navegador padrão — uma janela do
 * Vinculato mostrando outro site seria o tipo de confusão que faz alguém
 * digitar a senha no lugar errado.
 */
function isInternalUrl(target, serverUrl) {
  try {
    return new URL(target).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** Limita a posição salva da janela a algo visível (monitor desconectado etc.). */
function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 800 || height < 560) return null;
  return { x, y, width, height };
}

/**
 * Módulos no menu, na ordem em que o DP trabalha.
 *
 * Os caminhos são os mesmos de `lib/panel-routes.ts`. Um módulo que o usuário
 * não tem liberado continua no menu: quem recusa é o servidor, com a mesma
 * mensagem do navegador — o app não guarda regra de acesso.
 */
const MODULES = [
  { label: "Visão geral", path: "/painel", accelerator: "CmdOrCtrl+1" },
  { label: "Meu trabalho", path: "/painel/trabalho", accelerator: "CmdOrCtrl+2" },
  { label: "Demandas", path: "/painel/demandas", accelerator: "CmdOrCtrl+3" },
  { label: "Cadastros", path: "/painel/cadastros", accelerator: "CmdOrCtrl+4" },
  { label: "Operação DP", path: "/painel/dp", accelerator: "CmdOrCtrl+5" },
  { label: "Folha", path: "/painel/folha", accelerator: "CmdOrCtrl+6" },
  { label: "Ponto", path: "/painel/ponto", accelerator: "CmdOrCtrl+7" },
  { label: "Pagamento PJ", path: "/painel/pj", accelerator: "CmdOrCtrl+8" },
  { label: "Indicadores", path: "/painel/indicadores", accelerator: "CmdOrCtrl+9" },
  { type: "separator" },
  { label: "Processos", path: "/painel/processos" },
  { label: "EPI", path: "/painel/epi" },
  { label: "Acidentes de trabalho", path: "/painel/acidentes" },
  { label: "Adiantamentos", path: "/painel/adiantamentos" },
  { label: "Integrações", path: "/painel/integracoes" },
  { label: "Histórico", path: "/painel/historico" },
];

module.exports = {
  DEFAULT_SERVER_URL,
  MODULES,
  isInternalUrl,
  normalizeServerUrl,
  readSettings,
  resolveServerUrl,
  sanitizeBounds,
  writeSettings,
};
