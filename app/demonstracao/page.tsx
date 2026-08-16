import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { ContactForm } from "../contato/ContactForm";

export const metadata: Metadata = {
  alternates: { canonical: "/demonstracao" },
  title: "Demonstração | Vinculato",
  description: "Agende uma demonstração conduzida com a operação real do seu Departamento Pessoal.",
};

const agenda = [
  { title: "Seu cenário", text: "Quantas empresas, quais sistemas de folha e ponto, e onde a operação perde tempo hoje." },
  { title: "Operação no produto", text: "Demandas, competência, movimentações e fechamento com os gates de conferência." },
  { title: "Pagamentos auxiliares", text: "Apuração de psicólogos e o cálculo PJ com limite de nota e complemento." },
  { title: "Integração e segurança", text: "Conectores, API, webhooks, isolamento entre clientes, auditoria e LGPD." },
];

export default function DemonstracaoPage() {
  return (
    <SiteShell>
      <SiteHero
        eyebrow="Demonstração"
        title="Uma conversa sobre a sua operação, não um vídeo genérico"
        description="A demonstração é conduzida sobre um ambiente de exemplo e focada nos processos que você precisa resolver. Não usamos dados reais do seu DP nessa etapa."
      />

      <section className={styles.section}>
        <h2>O que cobrimos</h2>
        <div className={styles.cardGrid}>
          {agenda.map((item) => (
            <article key={item.title} className={styles.card}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Agendar</h2>
        <ContactForm defaultInterest="demonstracao" />
        <p className={styles.planNote}>
          Prefere entender o produto antes? Veja <Link href="/funcionalidades">funcionalidades</Link> e o estado real das
          <Link href="/integracoes"> integrações</Link>.
        </p>
      </section>
    </SiteShell>
  );
}
