import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";
import "./dashboard-modern.css";

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
    alternates: { canonical: origin },
    openGraph: {
      title: "Vinculato — Sua operação, conectada.",
      description: "Centralize processos, demandas, documentos e integrações do Departamento Pessoal em uma plataforma só.",
      siteName: "Vinculato",
      type: "website",
      locale: "pt_BR",
      images: [{ url: `${origin}/og.png`, width: 1792, height: 917, alt: "Vinculato — Sua operação, conectada." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Vinculato — Sua operação, conectada.",
      description: "Processos, demandas, documentos e integrações do DP em uma plataforma só.",
      images: [`${origin}/og.png`],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${interface_.variable} ${titles.variable}`}>
      <body>{children}</body>
    </html>
  );
}
