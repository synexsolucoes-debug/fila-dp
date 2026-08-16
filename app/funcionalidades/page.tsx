import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { featureHighlights, productBoundaries } from "@/lib/marketing";

export const metadata: Metadata = {
  alternates: { canonical: "/funcionalidades" },
  title: "Funcionalidades | Vinculato",
  description: "Demandas, competências, movimentações, conferência, pagamento de psicólogos e prestadores PJ, com auditoria e permissões granulares.",
};

export default function FuncionalidadesPage() {
  return (
    <SiteShell active="/funcionalidades">
      <SiteHero
        eyebrow="Funcionalidades"
        title="O que já está implementado e em uso"
        description="Esta página lista apenas recursos existentes no produto. O que ainda está em construção aparece na página de integrações com o estado real."
      />

      <section className={styles.section}>
        <div className={styles.cardGrid}>
          {featureHighlights.map((feature) => (
            <article key={feature.title} className={styles.card}>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Controle de pagamentos auxiliares</h2>
        <p>Dois módulos dedicados, ambos administrativos e financeiros.</p>
        <div className={styles.cardGrid}>
          <article className={styles.card}>
            <h3>Psicólogos</h3>
            <p>
              Lançamento por colaborador com valor unitário congelado no registro, fechamento por profissional e competência,
              ajustes com motivo e autor, pagamento com nota opcional. Nenhum dado clínico é aceito pelo sistema.
            </p>
          </article>
          <article className={styles.card}>
            <h3>Prestadores PJ</h3>
            <p>
              O valor devido é apurado somando créditos e subtraindo descontos sobre o valor base. Só então o limite de nota
              configurado é aplicado, e o que excede vai para o meio complementar. Fechamentos concluídos guardam snapshot imutável.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Limites do produto</h2>
        <div className={styles.cardGrid}>
          {productBoundaries.map((boundary) => (
            <article key={boundary.title} className={`${styles.card} ${styles.boundaryCard}`}>
              <h3>{boundary.title}</h3>
              <p>{boundary.text}</p>
            </article>
          ))}
        </div>
        <p className={styles.planNote}>
          Precisa de algo que não está aqui? <Link href="/contato">Fale com a equipe</Link> antes de contratar.
        </p>
      </section>
    </SiteShell>
  );
}
