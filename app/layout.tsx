import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";
import "./dashboard-modern.css";
// Carregada por último de propósito: é a camada que corrige e refina o que as
// três folhas anteriores acumularam. Ver o cabeçalho do arquivo.
import "./interface-refresh.css";

/**
 * Tipografia do produto (§15): Manrope nos títulos, Inter na interface e nos
 * dados. Até aqui o CSS nomeava as duas famílias sem carregar nenhuma, então a
 * interface caía para a fonte do sistema — o que muda de máquina para máquina e
 * derruba a densidade que uma tela operacional precisa.
 *
 * `next/font` hospeda os arquivos no próprio deploy: nenhuma requisição a
 * terceiros em tempo de execução, o que mantém o CSP fechado e o carregamento
 * previsível. `display: swap` evita texto invisível enquanto a fonte chega.
 */
const interface_ = Inter({ subsets: ["latin"], display: "swap", variable: "--font-interface" });
const titles = Manrope({ subsets: ["latin"], display: "swap", weight: ["600", "700", "800"], variable: "--font-titles" });

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
  // Um tema só. Declarar `dark light` faria o navegador oferecer controles
  // nativos claros para quem tem o sistema no claro, dentro de uma interface
  // que é escura em todo o resto.
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${interface_.variable} ${titles.variable}`}>
      <body>{children}</body>
    </html>
  );
}
