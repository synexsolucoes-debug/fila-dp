import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter, Manrope } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";
import "./dashboard-modern.css";
// Carregada por último de propósito: é a camada que corrige e refina o que as
// três folhas anteriores acumularam. Ver o cabeçalho do arquivo.
import "./interface-refresh.css";

/**
 * Tipografia do produto (§89).
 *
 * Três papéis, três escolhas, e a razão de cada uma:
 *
 * **Inter na interface.** É a pedida do §89 e é a fonte certa para densidade
 * operacional: altura de x grande, formas abertas e ótima legibilidade em 12–14
 * px, que é o tamanho em que esta tela vive. Uma tabela de demandas passa o dia
 * inteiro nesse corpo.
 *
 * **Manrope nos títulos.** Também do §89. Ela dá ao cabeçalho um contorno
 * próprio sem trocar de família mentalmente — os terminais mais retos separam
 * seção de conteúdo numa tela densa, que é o trabalho que o título tem aqui.
 *
 * **IBM Plex Mono nos dados.** Este papel fica: todo número, código, CNPJ,
 * prazo e competência é monoespaçado e tabular. Numa tela em que valores são
 * comparados linha a linha, isso não é estética — é o que faz a coluna alinhar
 * e o olho encontrar a diferença. O §89 fala da tipografia da interface e não
 * pede que se abra mão disso.
 *
 * `next/font` hospeda os arquivos no próprio deploy: nenhuma requisição a
 * terceiros em tempo de execução, o que mantém o CSP fechado e o carregamento
 * previsível. `display: swap` evita texto invisível enquanto a fonte chega.
 */
const interface_ = Inter({
  subsets: ["latin"], display: "swap",
  weight: ["400", "500", "600", "700"], variable: "--font-interface",
});
const titles = Manrope({
  subsets: ["latin"], display: "swap",
  weight: ["600", "700", "800"], variable: "--font-titles",
});
/** Dados: número da demanda, CNPJ, prazo, competência, contagem. */
const data = IBM_Plex_Mono({
  subsets: ["latin"], display: "swap",
  weight: ["400", "500", "600"], variable: "--font-data",
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "https://fila-dp.synexsolucoes.chatgpt.site";

  return {
    metadataBase: new URL(origin),
    title: "Vinculato | Sua operação, conectada.",
    description: "Centralize processos, demandas, documentos e integrações em uma plataforma criada para organizar a operação do seu Departamento Pessoal.",
    applicationName: "Vinculato",
    // Sem canônica global.
    //
    // `alternates: { canonical: origin }` no layout fazia *toda* página
    // declarar a home como sua canônica: /planos, /faq, /privacidade e /termos
    // diziam ao buscador "eu sou uma cópia da home". A consequência normal
    // disso é a página sair do índice — e /planos e /funcionalidades são
    // justamente as comerciais. Cada página declara a si mesma.
    openGraph: {
      title: "Vinculato — Sua operação, conectada.",
      description: "Centralize processos, demandas, documentos e integrações do Departamento Pessoal em uma plataforma só.",
      siteName: "Vinculato",
      type: "website",
      locale: "pt_BR",
      // Cartão de compartilhamento: gerado por `npm run og:generate` a partir
      // do logotipo oficial, das cores de `--vin-*` e de `VINCULATO_TAGLINE`.
      //
      // O anterior era a marca antiga inteira — dizia "Fila DP", em verde, com
      // o posicionamento antigo — enquanto este `alt` ao lado já dizia
      // "Vinculato". O texto certo e a figura contradizendo o texto, em todo
      // link enviado no WhatsApp, no LinkedIn ou no Slack. Nenhuma conferência
      // pegava: a imagem é binária e ninguém a renderiza.
      //
      // Endereço novo de propósito: plataformas guardam o cartão em cache pela
      // URL, então manter `/og.png` continuaria servindo "Fila DP" dos caches
      // delas mesmo com o arquivo trocado.
      images: [{ url: `${origin}/og-vinculato.jpg`, width: 1200, height: 630, alt: "Vinculato — Sua operação, conectada." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Vinculato — Sua operação, conectada.",
      description: "Processos, demandas, documentos e integrações do DP em uma plataforma só.",
      images: [`${origin}/og-vinculato.jpg`],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /* O documento não declara esquema de cor, e cada casca declara o seu.
   *
   * `colorScheme: "dark"` aqui era herdado de quando só existia o painel. Ele
   * vale para o documento inteiro — inclusive para as onze páginas públicas,
   * que são claras — e o produto passou a afirmar duas coisas contraditórias:
   * a raiz dizendo "esta página é escura" e o conteúdo pintando branco.
   *
   * A consequência apareceu de dois jeitos. O visível: campo, caixa de seleção
   * e barra de rolagem nativos do formulário de contato desenhados no esquema
   * escuro sobre superfície branca. O caro: a auditoria WCAG da CI reprovando
   * quatro elementos das páginas públicas que aqui mediam 5,24:1 — o relatório
   * acusou branco sobre `rgb(185, 200, 255)` e âmbar sobre `rgb(36, 44, 53)`,
   * tons do tema escuro do painel, num navegador ajustando por conta própria
   * uma página que se declarava escura e não era.
   *
   * As duas cascas já declaram o que são — `.dashboard-shell` claro,
   * `.dashboard-shell.theme-dark` escuro, `.site`/`.home`/`.auth-page` claras.
   * Esta linha só podia contradizê-las. */
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-scroll-behavior="smooth" className={`${interface_.variable} ${titles.variable} ${data.variable}`}>
      <body>{children}</body>
    </html>
  );
}
