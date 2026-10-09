import type { Metadata, Viewport } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import { FieldApp } from "./FieldApp";
import { ServiceWorker } from "./ServiceWorker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Campo | Vinculato",
  description: "Entrega, devolução e troca de EPI no local de trabalho, com assinatura e evidência.",
  // A tela de campo não entra em índice: é área logada de operação.
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Vinculato Campo" },
};

/**
 * `themeColor` escuro aqui e não no layout raiz: a barra de status do aparelho
 * acompanha a casca do aplicativo, e o site público continua claro.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Sem `maximumScale`: travar o zoom é a forma mais comum de quebrar
  // acessibilidade em tela de celular, e quem opera de luva às vezes precisa
  // ampliar o CA impresso na etiqueta.
  viewportFit: "cover",
  // Mesma cor do `background_color` do manifesto: a barra de status do aparelho
  // encosta na superfície da tela em vez de criar uma faixa de outra cor.
  themeColor: "#07111f",
};

export default async function FieldPage() {
  const user = await requireChatGPTUser("/campo");

  return <>
    <ServiceWorker />
    <FieldApp
      user={{ displayName: user.displayName, email: user.email }}
      signOutPath={chatGPTSignOutPath("/")}
    />
  </>;
}
