import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { legalPendingFields } from "@/lib/marketing";

export const metadata: Metadata = {
  alternates: { canonical: "/subprocessadores" },
  title: "Subprocessadores e DPA | Vinculato",
  description: "Subprocessadores utilizados pela plataforma e as condições de tratamento de dados entre controlador e operador.",
};

const UPDATED_AT = "9 de agosto de 2026";

const subprocessors = [
  { name: "Vercel", purpose: "Hospedagem da aplicação e armazenamento privado de anexos", location: "Estados Unidos e regiões de borda" },
  { name: "Neon", purpose: "Banco de dados PostgreSQL gerenciado", location: "Conforme região contratada" },
  { name: "Stripe", purpose: "Processamento de pagamento da assinatura", location: "Estados Unidos" },
];

export default function SubprocessadoresPage() {
  return (
    <SiteShell>
      <SiteHero
        eyebrow="Legal"
        title="Subprocessadores e condições de tratamento"
        description="Quem processa dados a serviço da plataforma e sob quais compromissos. Alterações nesta lista são comunicadas aos clientes antes de entrarem em vigor."
      />

      <section className={`${styles.section} ${styles.legal}`}>
        <p className={styles.legalMeta}>
          Última atualização: {UPDATED_AT}. Esta página complementa os <Link href="/termos">Termos de uso</Link> e a
          <Link href="/privacidade"> Política de privacidade</Link>, e serve como anexo de processamento de dados (DPA)
          quando o contrato assim previr.
        </p>

        <h2>1. Subprocessadores atuais</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Lista de subprocessadores</caption>
            <thead>
              <tr><th scope="col">Fornecedor</th><th scope="col">Finalidade</th><th scope="col">Local de processamento</th></tr>
            </thead>
            <tbody>
              {subprocessors.map((item) => (
                <tr key={item.name}>
                  <th scope="row">{item.name}</th>
                  <td>{item.purpose}</td>
                  <td>{item.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Integrações que o cliente configurar por conta própria — ERP, ponto, plataformas de benefício, mensageria — não são
          subprocessadores do Vinculato: o envio ocorre por decisão e credencial do cliente, sob sua responsabilidade.
        </p>

        <h2>2. Papéis</h2>
        <p>
          Para os dados da operação de DP, o cliente é o controlador e o Vinculato é o operador, tratando dados apenas conforme
          instrução documentada — o uso da plataforma e as configurações escolhidas pelo cliente.
        </p>

        <h2>3. Compromissos do operador</h2>
        <ul>
          <li>Tratar dados pessoais somente para prestar o serviço contratado.</li>
          <li>Manter confidencialidade e restringir o acesso da própria equipe ao estritamente necessário, com registro.</li>
          <li>Aplicar as medidas técnicas descritas na Política de privacidade, incluindo isolamento entre clientes, cifragem de segredos e auditoria.</li>
          <li>Auxiliar o controlador no atendimento a pedidos de titulares e a autoridades.</li>
          <li>Comunicar incidentes de segurança relevantes sem demora injustificada.</li>
          <li>Eliminar ou devolver os dados ao término do contrato, respeitado o prazo de retenção informado.</li>
          <li>Não contratar novo subprocessador sem comunicação prévia ao cliente.</li>
        </ul>

        <h2>4. Obrigações do controlador</h2>
        <ul>
          <li>Garantir base legal para os dados inseridos ou importados na plataforma.</li>
          <li>Definir corretamente papéis, permissões e escopo de empresas dos seus usuários.</li>
          <li>Não inserir na plataforma dados sensíveis fora da finalidade do produto — em especial, dados clínicos, que o sistema recusa.</li>
          <li>Responder aos titulares vinculados à sua operação, com apoio do operador.</li>
        </ul>

        <h2>5. Medidas técnicas e organizacionais</h2>
        <ul>
          <li>Segregação lógica por workspace com Row Level Security no banco e testes automatizados de acesso cruzado.</li>
          <li>Cifragem em trânsito e cifragem de segredos em repouso, com versionamento e rotação de chave.</li>
          <li>Autenticação com senha protegida por hash, sessões revogáveis e limitação de tentativas.</li>
          <li>Trilha de auditoria preservada contra alteração, com identificador de requisição para correlação.</li>
          <li>Registro estruturado sem dados pessoais desnecessários.</li>
        </ul>

        <h2>6. Backups e continuidade</h2>
        <p>
          A cópia de segurança é fornecida pela infraestrutura gerenciada de banco de dados. Os procedimentos de restauração,
          bem como os objetivos de ponto e tempo de recuperação, são acordados em contrato e devem ser ensaiados antes de serem
          declarados válidos — não afirmamos restauração testada sem ensaio registrado.
        </p>

        <h2>7. Solicitações</h2>
        <p>
          Pedidos relacionados a este documento, incluindo cópia assinada do DPA, podem ser feitos pela página de
          <Link href="/contato?assunto=privacidade"> Contato</Link>.
        </p>

        <h2>8. Informações a completar antes da publicação</h2>
        <p>Os itens abaixo dependem do proprietário do Vinculato e ficam declarados como pendentes em vez de supostos:</p>
        <ul>
          {legalPendingFields.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </SiteShell>
  );
}
