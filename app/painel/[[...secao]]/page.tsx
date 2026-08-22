import type { Metadata } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "../../chatgpt-auth";
import { WorkspaceApp } from "../WorkspaceApp";
import { panelPath, parsePanelPath } from "@/lib/panel-routes";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Painel | Vinculato",
  description: "Acompanhe e execute a fila de demandas do Departamento Pessoal.",
};

type PanelPageProps = {
  params: Promise<{ secao?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Rota coringa do painel (§43, §44).
 *
 * Ela existe para que os endereços do painel **sobrevivam ao F5**. Sem ela,
 * `/painel/demandas/abc` seria 404 no servidor: o painel troca de tela por
 * estado, e estado não tem rota. Com ela, todo endereço válido renderiza o
 * mesmo componente já posicionado na tela certa.
 *
 * O caminho vira estado inicial no servidor, e não em um `useEffect` depois da
 * hidratação. A diferença aparece na prática: com efeito, quem abre o link de
 * uma demanda vê a visão geral piscar antes da demanda.
 *
 * Autorização não muda de lugar. `requireChatGPTUser` continua sendo a porta, e
 * cada rota de dados continua recusando o que a pessoa não pode ver — um
 * endereço é um pedido, nunca uma permissão.
 */
export default async function DashboardPage({ params, searchParams }: PanelPageProps) {
  const { secao } = await params;
  const segments = (secao ?? []).map((part) => encodeURIComponent(part)).join("/");
  const pathname = segments ? `/painel/${segments}` : "/painel";

  const query = await searchParams;
  const empresa = typeof query.empresa === "string" ? query.empresa : "";
  const location = parsePanelPath(pathname, empresa ? `empresa=${encodeURIComponent(empresa)}` : "");

  const user = await requireChatGPTUser(panelPath(location));

  return (
    <WorkspaceApp
      user={{ displayName: user.displayName, email: user.email, fullName: user.fullName }}
      signOutPath={chatGPTSignOutPath("/")}
      initialLocation={location}
    />
  );
}
