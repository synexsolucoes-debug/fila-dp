import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";
import "./dashboard-modern.css";
// Carregada por último de propósito: é a camada que corrige e refina o que as
// três folhas anteriores acumularam. Ver o cabeçalho do arquivo.
import "./interface-refresh.css";

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
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
