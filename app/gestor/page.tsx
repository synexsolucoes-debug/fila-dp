import type { Metadata } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import { GestorTeamView } from "./GestorTeamView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Minha equipe | Vinculato",
  description: "Veja quem você gerencia, sem abrir o painel de Departamento Pessoal.",
};

/**
 * Portal do Gestor, passo 1 (§4.20).
 *
 * Endereço próprio, de propósito: quem abre esta tela não faz o trabalho do
 * DP — é um gestor de área querendo uma resposta rápida ("quem está no meu
 * time?"), não a ferramenta operacional inteira. A mesma sessão de sempre
 * (`requireChatGPTUser`) autentica; o que muda é a casca, não o login.
 */
export default async function GestorPortalPage() {
  const user = await requireChatGPTUser("/gestor");
  return <GestorTeamView userName={user.displayName} signOutPath={chatGPTSignOutPath("/gestor")} />;
}
