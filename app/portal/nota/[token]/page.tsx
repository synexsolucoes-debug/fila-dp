import type { Metadata } from "next";
import { PortalInvoiceForm } from "./PortalInvoiceForm";

/**
 * A página que o prestador abre para mandar a nota.
 *
 * Ela não é o painel: quem chega aqui não tem conta, não vai navegar e não
 * precisa aprender nada. É uma página só, com o que a mensagem de aviso já
 * dizia — para quem emitir, com que CNPJ, de que valor — e um formulário.
 *
 * O token fica na URL e nunca é renderizado no corpo: uma captura de tela do
 * pedido, que é coisa que se manda no grupo do trabalho, não deve carregar
 * junto a credencial que autoriza o envio.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Envio de nota fiscal | Vinculato",
  description: "Envie a nota fiscal da competência solicitada pela empresa contratante.",
  // O endereço é uma credencial. Indexá-lo colocaria links válidos em
  // resultado de busca, que é a forma mais barata de vazá-los em lote.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PortalInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PortalInvoiceForm token={token} />;
}
