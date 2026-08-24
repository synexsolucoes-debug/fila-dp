import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { leadInterests, type LeadInterest } from "@/lib/marketing";
import { ContactForm } from "./ContactForm";

export const metadata: Metadata = {
  alternates: { canonical: "/contato" },
  title: "Contato | Vinculato",
  description: "Fale com a equipe do Vinculato sobre demonstração, planos, integrações ou suporte.",
};

export default async function ContatoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requested = Array.isArray(params.assunto) ? params.assunto[0] : params.assunto;
  const defaultInterest = leadInterests.includes(requested as LeadInterest) ? requested as LeadInterest : "demonstracao";

  return (
    <SiteShell active="/contato">
      <SiteHero
        eyebrow="Contato"
        title="Fale com a equipe"
        description="Respondemos em dias úteis. Para clientes com contrato ativo, o suporte também está disponível dentro do painel."
      />

      <section className={styles.section}>
        <ContactForm defaultInterest={defaultInterest} />
        <p className={styles.planNote}>
          Já é cliente e precisa de acesso? <Link href="/recuperar">Recupere sua senha</Link> ou peça ao administrador do
          seu workspace. Consulte também a <Link href="/privacidade">Política de privacidade</Link>.
        </p>
      </section>
    </SiteShell>
  );
}
