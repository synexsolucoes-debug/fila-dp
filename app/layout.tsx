import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./access.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "https://fila-dp.synexsolucoes.chatgpt.site";

  return {
    metadataBase: new URL(origin),
    title: "Fila DP | Gestão visual de demandas para Departamento Pessoal",
    description: "Centralize solicitações, responsáveis, documentos e SLAs em uma plataforma visual criada para a rotina de DP e RH.",
    openGraph: {
      title: "Organize toda a fila de demandas do seu DP",
      description: "Controle solicitações, processos e prazos em um quadro visual simples, rastreável e adaptado ao Departamento Pessoal.",
      type: "website",
      locale: "pt_BR",
      images: [{ url: `${origin}/og.png`, width: 1792, height: 917, alt: "Fila DP — toda demanda na fila certa" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Fila DP — toda demanda na fila certa",
      description: "Gestão visual de demandas, responsáveis e SLAs para DP e RH.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
