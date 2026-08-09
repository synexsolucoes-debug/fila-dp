import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { faqEntries } from "@/lib/marketing";

export const metadata: Metadata = {
  title: "Perguntas frequentes | Fila DP",
  description: "Fronteiras do produto, isolamento entre clientes, módulos de pagamento, API e suporte.",
};

export default function FaqPage() {
  return (
    <SiteShell active="/faq">
      <SiteHero
        eyebrow="FAQ"
        title="Perguntas frequentes"
        description="As respostas abaixo descrevem o produto como ele é hoje."
      />
      <section className={styles.section}>
        <div className={styles.faqList}>
          {faqEntries.map((entry) => (
            <article key={entry.question} className={styles.faqItem}>
              <h3>{entry.question}</h3>
              <p>{entry.answer}</p>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
