import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";

export const metadata: Metadata = {
  title: "Política de privacidade | Fila DP",
  description: "Como o Fila DP trata dados pessoais, com bases legais, retenção, direitos do titular e resposta a incidentes conforme a LGPD.",
};

const UPDATED_AT = "9 de agosto de 2026";

export default function PrivacidadePage() {
  return (
    <SiteShell>
      <SiteHero
        eyebrow="Legal"
        title="Política de privacidade"
        description="Tratamento de dados pessoais na plataforma Fila DP, conforme a Lei nº 13.709/2018 (LGPD)."
      />

      <section className={`${styles.section} ${styles.legal}`}>
        <p className={styles.legalMeta}>
          Última atualização: {UPDATED_AT}. Em relação aos dados da operação de DP, o cliente é o <strong>controlador</strong>
          e o Fila DP atua como <strong>operador</strong>. Em relação aos dados de contato comercial e de usuários da própria
          plataforma, o Fila DP é o controlador.
        </p>

        <h2>1. Princípio de minimização</h2>
        <p>
          A plataforma armazena somente o necessário para operar, integrar, conferir, conciliar, controlar, auditar e rastrear.
          Alguns limites são impostos pelo próprio sistema:
        </p>
        <ul>
          <li>CPF é validado e persistido apenas como HMAC e quatro últimos dígitos; o número completo não é gravado, nem em log, histórico ou URL.</li>
          <li>Dados bancários e chave Pix são cifrados com AES-256-GCM e nunca retornam em claro para a interface.</li>
          <li>O módulo de Psicólogos recusa conteúdo clínico: diagnóstico, motivo, evolução e anotação terapêutica não são aceitos.</li>
          <li>Logs técnicos carregam identificadores de correlação, não dados pessoais.</li>
        </ul>

        <h2>2. Dados tratados</h2>
        <h3>2.1 Dados da operação do cliente</h3>
        <p>Identificação e vínculo de colaboradores, movimentações, competências, documentos anexados pelo cliente, pagamentos
          auxiliares e registros de integração. A finalidade é executar o serviço contratado, sob instrução do cliente.</p>
        <h3>2.2 Dados de usuários da plataforma</h3>
        <p>Nome, e-mail, papel, sessões ativas e trilha de auditoria das ações realizadas. A finalidade é autenticar, autorizar e
          permitir a prestação de contas.</p>
        <h3>2.3 Dados de contato comercial</h3>
        <p>Nome, e-mail, empresa, telefone e mensagem enviados pelo site, com consentimento explícito, para retorno do contato.</p>

        <h2>3. Bases legais</h2>
        <ul>
          <li><strong>Execução de contrato</strong>: acesso à plataforma e prestação do serviço.</li>
          <li><strong>Cumprimento de obrigação legal ou regulatória</strong>: registros exigidos da relação de trabalho, quando aplicável ao cliente.</li>
          <li><strong>Legítimo interesse</strong>: segurança, prevenção a fraude, registro de auditoria e melhoria do serviço, sempre com minimização.</li>
          <li><strong>Consentimento</strong>: contato comercial iniciado pelo próprio interessado no site.</li>
        </ul>

        <h2>4. Compartilhamento</h2>
        <p>
          Não vendemos dados. O compartilhamento se limita aos subprocessadores necessários para operar o serviço, listados em
          <Link href="/subprocessadores"> Subprocessadores e DPA</Link>, e às integrações que o próprio cliente configurar.
        </p>

        <h2>5. Retenção e eliminação</h2>
        <ul>
          <li>Dados da operação são mantidos enquanto durar o contrato.</li>
          <li>Após o encerramento, há período de recuperação de 30 dias para exportação; em seguida, os dados do workspace são eliminados ou anonimizados.</li>
          <li>Registros de auditoria e financeiros podem ser mantidos por prazo legal maior, em formato mínimo necessário.</li>
          <li>Contatos comerciais sem contrato são eliminados em até 24 meses ou antes, mediante pedido.</li>
        </ul>

        <h2>6. Direitos do titular</h2>
        <p>
          O titular pode solicitar confirmação de tratamento, acesso, correção, anonimização, portabilidade, informação sobre
          compartilhamento e revogação de consentimento.
        </p>
        <ul>
          <li>Titulares vinculados à operação de um cliente devem procurar o próprio empregador, que é o controlador; o Fila DP atende como operador, mediante instrução.</li>
          <li>Pedidos podem ser enviados pela página de <Link href="/contato">Contato</Link> e são respondidos em até 15 dias.</li>
        </ul>

        <h2>7. Segurança</h2>
        <ul>
          <li>Isolamento entre clientes imposto no banco por Row Level Security, além da validação na aplicação, com testes automatizados de acesso cruzado.</li>
          <li>Senhas com hash, sessões revogáveis, limitação de tentativas de login e proteção contra requisição forjada.</li>
          <li>Segredos de integração e de webhook cifrados por cliente, com versão de chave e rotação.</li>
          <li>Trilha de auditoria com ator, ação, antes e depois, preservada contra alteração.</li>
          <li>Acesso de suporte a dados do cliente é autorizado, temporário, justificado e auditado.</li>
        </ul>

        <h2>8. Incidentes de segurança</h2>
        <p>
          Em caso de incidente com risco relevante aos titulares, o cliente controlador é comunicado sem demora injustificada,
          com a descrição do que ocorreu, os dados envolvidos, as medidas adotadas e as recomendadas, para que possa cumprir
          seus deveres perante a ANPD e os titulares.
        </p>

        <h2>9. Transferência internacional</h2>
        <p>
          A infraestrutura pode envolver processamento fora do Brasil pelos subprocessadores listados. As transferências
          observam as garantias contratuais desses fornecedores e as hipóteses da LGPD.
        </p>

        <h2>10. Encarregado</h2>
        <p>
          O canal de contato com o encarregado pelo tratamento de dados é a página de <Link href="/contato">Contato</Link>,
          com o assunto de suporte. A identificação nominal do encarregado é informada no contrato e no DPA.
        </p>
      </section>
    </SiteShell>
  );
}
