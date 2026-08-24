import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { productBoundaries, productPositioning } from "@/lib/marketing";

export const metadata: Metadata = {
  alternates: { canonical: "/solucao" },
  title: "Solução | Vinculato",
  description: productPositioning.headline,
};

const layers = [
  { title: "Camada de integração", text: "Conectores, cofre de credenciais por cliente, mapeamentos versionados, execuções rastreáveis e conciliação." },
  { title: "Camada operacional", text: "Empresas, colaboradores, demandas, processos, movimentações, competências, fechamentos e obrigações." },
  { title: "Camada de controle", text: "Pendências, aprovações, qualidade de dado, conciliação e auditoria com antes e depois." },
  { title: "Camada de ação", text: "Exportação, sincronização, correção, aprovação, preparação de pagamento e notificação." },
];

export default function SolucaoPage() {
  return (
    <SiteShell active="/solucao">
      <SiteHero
        eyebrow="Solução"
        title="Uma camada que coordena o Departamento Pessoal entre os sistemas que você já usa"
        description={productPositioning.summary}
      >
        <div className={styles.heroActions}>
          <Link className={styles.primaryButton} href="/contato?assunto=demonstracao">Agendar demonstração</Link>
          <Link className={styles.ghostButton} href="/funcionalidades">Ver funcionalidades</Link>
        </div>
      </SiteHero>

      <section className={styles.section}>
        <h2>Como o produto se organiza</h2>
        <p>Da origem do dado até o destino, com rastreabilidade em cada passo.</p>
        <div className={styles.cardGrid}>
          {layers.map((layer) => (
            <article key={layer.title} className={styles.card}>
              <h3>{layer.title}</h3>
              <p>{layer.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>O que o Vinculato não é</h2>
        <p>Dizer o que o produto não faz evita implantação frustrada e é parte do contrato.</p>
        <div className={styles.cardGrid}>
          {productBoundaries.map((boundary) => (
            <article key={boundary.title} className={`${styles.card} ${styles.boundaryCard}`}>
              <h3>{boundary.title}</h3>
              <p>{boundary.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Perguntas que a operação passa a responder</h2>
        <div className={styles.cardGrid}>
          <article className={styles.card}><h3>De onde veio esse dado?</h3><p>Cada registro guarda origem, identificador externo, execução de sincronização e data da última atualização.</p></article>
          <article className={styles.card}><h3>Essa competência está fechada?</h3><p>O ciclo por empresa tem estado explícito e reabertura exige permissão e justificativa registrada.</p></article>
          <article className={styles.card}><h3>Quanto devo pagar?</h3><p>Psicólogos por consultas válidas da competência; prestadores PJ por valor devido, nota esperada e complemento.</p></article>
          <article className={styles.card}><h3>Quem alterou?</h3><p>A auditoria registra ator, ação, antes e depois, com identificador de requisição para correlação.</p></article>
        </div>
      </section>
    </SiteShell>
  );
}
