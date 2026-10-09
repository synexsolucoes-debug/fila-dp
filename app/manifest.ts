import type { MetadataRoute } from "next";

/**
 * Manifesto do aplicativo de campo.
 *
 * O Vinculato inteiro é um produto de mesa: telas densas, tabelas largas,
 * relatórios. O que precisa caber num celular é outra coisa — entregar um EPI
 * no galpão, colher a assinatura, fotografar um dano. Por isso o `start_url`
 * aponta para `/campo` e não para o painel: quem instala o ícone está
 * instalando a operação de campo, e abrir o painel num celular seria entregar a
 * tela errada a quem está de luva.
 *
 * `display: standalone` tira a barra do navegador, que é o que faz a diferença
 * entre "site no celular" e "aplicativo" para quem usa.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vinculato Campo — Controle de EPI",
    short_name: "Vinculato Campo",
    description: "Entrega, devolução e troca de EPI no local de trabalho, com assinatura e evidência.",
    start_url: "/campo",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "pt-BR",
    dir: "ltr",
    // As duas cores acompanham a superfície da central de comando. Um
    // `background_color` claro abriria a tela de abertura em branco e ela
    // piscaria para escuro ao montar — o tipo de detalhe que faz um aplicativo
    // instalado parecer uma página.
    background_color: "#07111f",
    theme_color: "#07111f",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Entregar EPI", short_name: "Entregar", url: "/campo?acao=entrega" },
      { name: "Receber devolução", short_name: "Devolver", url: "/campo?acao=devolucao" },
      { name: "Registrar dano", short_name: "Dano", url: "/campo?acao=dano" },
    ],
  };
}
