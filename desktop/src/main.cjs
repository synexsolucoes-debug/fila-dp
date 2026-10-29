/**
 * Vinculato para Windows.
 *
 * O instalador entrega o sistema como programa: ícone na área de trabalho,
 * janela própria, menu de módulos e atalhos de teclado — o jeito como o DP
 * está acostumado a trabalhar com a Domínio. Os dados continuam no servidor;
 * o app é a "casca" que abre o mesmo Vinculato que o navegador abre, então
 * toda correção publicada na nuvem já chega aqui sem reinstalar.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const {
  MODULES,
  isInternalUrl,
  normalizeServerUrl,
  readSettings,
  resolveServerUrl,
  sanitizeBounds,
  writeSettings,
} = require("./config.cjs");

const ICON = path.join(__dirname, "icon.png");
let serverUrl = "";
let setupWindow = null;
let splashWindow = null;

if (!app.requestSingleInstanceLock()) {
  // Duplo clique no ícone com o app aberto traz a janela para frente, em vez
  // de abrir um segundo processo com outra sessão.
  app.quit();
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows().find((candidate) => candidate !== setupWindow);
  if (!win) return createMainWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

function userDataDir() {
  return app.getPath("userData");
}

function createMainWindow(startPath = "/painel") {
  const settings = readSettings(userDataDir());
  const isFirst = BrowserWindow.getAllWindows().filter((w) => w !== setupWindow).length === 0;
  const saved = isFirst ? sanitizeBounds(settings.bounds) : null;

  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1024,
    minHeight: 640,
    title: "Vinculato",
    icon: ICON,
    backgroundColor: "#07111f",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (isFirst && settings.maximized !== false) win.maximize();
  win.once("ready-to-show", () => {
    win.show();
    closeSplash();
  });

  if (isFirst) {
    const persist = () => {
      if (win.isDestroyed()) return;
      writeSettings(userDataDir(), {
        bounds: win.isMaximized() ? settings.bounds : win.getBounds(),
        maximized: win.isMaximized(),
      });
    };
    win.on("close", persist);
  }

  guardNavigation(win);
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 é navegação cancelada (troca de página no meio do carregamento); não é queda.
    if (!isMainFrame || code === -3) return;
    win.loadFile(path.join(__dirname, "offline.html"), {
      query: { url: url || serverUrl + startPath, motivo: description },
    });
  });

  win.loadURL(serverUrl + startPath);
  return win;
}

/**
 * Mantém a janela dentro do Vinculato.
 *
 * Link interno com "abrir em nova aba" vira uma nova janela do app — é assim
 * que se compara duas competências lado a lado. Link externo vai para o
 * navegador padrão.
 */
function guardNavigation(win) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url, serverUrl)) {
      const target = new URL(url);
      createMainWindow(target.pathname + target.search + target.hash);
    } else if (/^https?:|^mailto:/u.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url, serverUrl) || url.startsWith("file:")) return;
    event.preventDefault();
    if (/^https?:|^mailto:/u.test(url)) shell.openExternal(url);
  });
}

/**
 * Tela de abertura enquanto o servidor responde.
 *
 * Sem ela, o duplo clique no ícone não dá sinal nenhum por alguns segundos —
 * e quem está acostumado com programa instalado clica de novo.
 */
function showSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: ICON,
    backgroundColor: "#07111f",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"), {
    query: { versao: app.getVersion(), servidor: new URL(serverUrl).host },
  });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
}

function navigate(win, pathname) {
  if (!win) return createMainWindow(pathname);
  win.loadURL(serverUrl + pathname);
}

function openSetup() {
  if (setupWindow) return setupWindow.focus();
  setupWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Configurar servidor — Vinculato",
    icon: ICON,
    backgroundColor: "#07111f",
    parent: BrowserWindow.getFocusedWindow() ?? undefined,
    modal: Boolean(BrowserWindow.getFocusedWindow()),
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setupWindow.setMenu(null);
  setupWindow.loadFile(path.join(__dirname, "setup.html"), { query: { atual: serverUrl } });
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}

ipcMain.handle("vinculato:save-server", (_event, input) => {
  const normalized = normalizeServerUrl(input);
  if (!normalized) {
    return { ok: false, error: "Endereço inválido. Use https:// e o domínio do Vinculato." };
  }
  writeSettings(userDataDir(), { serverUrl: normalized });
  serverUrl = normalized;
  setupWindow?.close();
  for (const win of BrowserWindow.getAllWindows()) win.loadURL(serverUrl + "/painel");
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  return { ok: true, serverUrl: normalized };
});

ipcMain.handle("vinculato:reset-server", () => {
  writeSettings(userDataDir(), { serverUrl: null });
  serverUrl = resolveServerUrl({}, process.env);
  return { ok: true, serverUrl };
});

function buildMenu() {
  const focused = () => BrowserWindow.getFocusedWindow();
  const template = [
    {
      label: "&Arquivo",
      submenu: [
        { label: "Nova janela", accelerator: "CmdOrCtrl+N", click: () => createMainWindow() },
        { type: "separator" },
        { label: "Imprimir…", accelerator: "CmdOrCtrl+P", click: () => focused()?.webContents.print() },
        { type: "separator" },
        { label: "Configurar servidor…", click: openSetup },
        { type: "separator" },
        { label: "Sair", role: "quit" },
      ],
    },
    { label: "&Editar", role: "editMenu" },
    {
      label: "&Módulos",
      submenu: MODULES.map((item) => (item.type === "separator"
        ? item
        : { label: item.label, accelerator: item.accelerator, click: () => navigate(focused(), item.path) })),
    },
    {
      label: "E&xibir",
      submenu: [
        { label: "Voltar", accelerator: "Alt+Left", click: () => focused()?.webContents.navigationHistory.goBack() },
        { label: "Avançar", accelerator: "Alt+Right", click: () => focused()?.webContents.navigationHistory.goForward() },
        { label: "Atualizar", accelerator: "F5", click: () => focused()?.webContents.reload() },
        { type: "separator" },
        { label: "Aumentar zoom", role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { label: "Diminuir zoom", role: "zoomOut" },
        { label: "Zoom padrão", role: "resetZoom" },
        { type: "separator" },
        { label: "Tela cheia", role: "togglefullscreen", accelerator: "F11" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }]),
      ],
    },
    { label: "&Janela", role: "windowMenu" },
    {
      label: "Aj&uda",
      submenu: [
        {
          label: "Abrir no navegador",
          click: () => shell.openExternal(focused()?.webContents.getURL() || serverUrl),
        },
        { label: "Central de ajuda", click: () => shell.openExternal(serverUrl + "/faq") },
        { type: "separator" },
        {
          label: "Sobre o Vinculato",
          click: () => dialog.showMessageBox(focused() ?? undefined, {
            type: "info",
            title: "Sobre o Vinculato",
            message: `Vinculato ${app.getVersion()}`,
            detail: `Servidor: ${serverUrl}\nElectron ${process.versions.electron}`,
            icon: ICON,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setAppUserModelId("br.com.synex.vinculato");
  serverUrl = resolveServerUrl(readSettings(userDataDir()), process.env);

  // Câmera (foto de documento, OCR) e notificações só para o próprio servidor.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = ["media", "notifications", "clipboard-sanitized-write", "fullscreen"];
    callback(allowed.includes(permission) && isInternalUrl(contents.getURL(), serverUrl));
  });

  buildMenu();
  showSplash();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("web-contents-created", (_event, contents) => {
  // Nenhuma página carrega <webview> — fecha a porta antes que alguém tente.
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
