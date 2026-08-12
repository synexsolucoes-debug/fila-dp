import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { isPlatformAdmin } from "@/lib/platform-authorization";
import { PlatformApp } from "./PlatformApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Console global | Vinculato",
  description: "Administração global de workspaces, assinaturas e planos do Vinculato.",
};

export default async function PlatformPage() {
  const user = await requireChatGPTUser("/plataforma");
  if (!isPlatformAdmin(user)) redirect("/painel?platform=forbidden");
  return <Suspense fallback={<main aria-busy="true">Abrindo console global…</main>}><PlatformApp /></Suspense>;
}
