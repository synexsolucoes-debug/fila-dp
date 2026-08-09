import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { integrationCatalog, integrationStateLabels } from "@/lib/marketing";

export const metadata: Metadata = {
  title: "Integrações | Fila DP",
  description: "Estado real de cada integração: disponível, parcial ou apenas preparada. Logo de fornecedor não significa integração pronta.",
};

export default function IntegracoesPage() {
  return (
    <SiteShell active="/integracoes">
      <SiteHero
        eyebrow="Integrações"
        title="O estado real de cada integração, sem logo decorativo"
        description="Uma integração só é chamada de disponível quando existe conexão, autenticação, teste, mapeamento, tratamento de erro, log e repetição. O restante aparece como preparado — arquitetura pronta, aguardando documentação, credencial e homologação."
      />

      <section className={styles.section}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Catálogo de integrações e seu estado atual</caption>
            <thead>
              <tr>
                <th scope="col">Integração</th>
                <th scope="col">Categoria</th>
                <th scope="col">Estado</th>
                <th scope="col">Observação</th>
              </tr>
            </thead>
            <tbody>
              {integrationCatalog.map((item) => (
                <tr key={item.name}>
                  <th scope="row">{item.name}</th>
                  <td>{item.category}</td>
                  <td><span className={styles.badge} data-state={item.state}>{integrationStateLabels[item.state]}</span></td>
                  <td>{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Como integramos</h2>
        <div className={styles.cardGrid}>
          <article className={styles.card}><h3>Credenciais por cliente</h3><p>Cada workspace guarda a própria credencial cifrada, com versão de chave e rotação. Não existe segredo compartilhado entre clientes.</p></article>
          <article className={styles.card}><h3>Execução rastreável</h3><p>Sincronizações rodam fora da requisição, com fila, repetição com espera crescente, dead-letter e log por item.</p></article>
          <article className={styles.card}><h3>Mapeamento versionado</h3><p>O de-para de campos é publicado como versão imutável, e cada execução registra qual versão usou.</p></article>
          <article className={styles.card}><h3>API e webhooks</h3><p>API pública com escopos e idempotência, e webhooks de saída assinados com HMAC e log de entrega.</p></article>
        </div>
        <p className={styles.planNote}>
          Precisa de um ERP que ainda não está disponível? <Link href="/contato?assunto=integracoes">Fale com a equipe</Link> para avaliarmos a documentação oficial.
        </p>
      </section>
    </SiteShell>
  );
}
