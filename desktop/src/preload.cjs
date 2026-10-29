/**
 * Ponte mínima para as páginas do Vinculato.
 *
 * Só informa que a página está rodando no app de mesa — o suficiente para a
 * interface esconder, se quiser, o aviso de "instale o aplicativo". Nenhuma
 * API do sistema operacional é exposta ao site.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("vinculatoDesktop", Object.freeze({
  isDesktop: true,
  platform: process.platform,
}));
