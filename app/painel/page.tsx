import type { Metadata } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import { WorkspaceApp } from "./WorkspaceApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Painel | Fila DP",
  description: "Acompanhe e execute a fila de demandas do Departamento Pessoal.",
};

export default async function DashboardPage() {
  const user = await requireChatGPTUser("/painel");

  return (
    <WorkspaceApp
      user={{ displayName: user.displayName, email: user.email, fullName: user.fullName }}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
