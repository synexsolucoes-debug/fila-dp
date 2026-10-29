/** Ponte da tela "Configurar servidor" — a única que grava configuração. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vinculatoSetup", Object.freeze({
  save: (url) => ipcRenderer.invoke("vinculato:save-server", String(url ?? "")),
  reset: () => ipcRenderer.invoke("vinculato:reset-server"),
}));
