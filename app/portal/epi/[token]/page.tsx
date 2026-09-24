import type { Metadata } from "next";
import { EpiAckForm } from "./EpiAckForm";

/**
 * A página que o colaborador abre para confirmar o recebimento do EPI.
 *
 * Mesmo raciocínio da página de envio de nota fiscal
 * (`app/portal/nota/[token]/page.tsx`): sem conta, uma tela só, o que a
 * mensagem já dizia — o EPI, a quantidade, a data — e uma confirmação.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirmar recebimento de EPI | Vinculato",
  description: "Confirme o recebimento do equipamento de proteção entregue pela empresa.",
  // O endereço é uma credencial — o mesmo motivo do portal de nota fiscal.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PortalEpiPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EpiAckForm token={token} />;
}
