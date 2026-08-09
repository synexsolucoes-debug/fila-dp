import Link from "next/link";
import type { Metadata } from "next";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";

export const metadata: Metadata = {
  title: "Termos de uso | Fila DP",
  description: "Condições de uso da plataforma Fila DP, incluindo escopo do serviço, responsabilidades e limites do produto.",
};

const UPDATED_AT = "9 de agosto de 2026";

export default function TermosPage() {
  return (
    <SiteShell>
      <SiteHero eyebrow="Legal" title="Termos de uso" description="Condições que regem o uso da plataforma Fila DP." />

      <section className={`${styles.section} ${styles.legal}`}>
        <p className={styles.legalMeta}>
          Última atualização: {UPDATED_AT}. Este documento descreve o serviço como ele existe hoje. Alterações relevantes
          são comunicadas aos administradores do workspace antes de entrar em vigor.
        </p>

        <h2>1. O que é o serviço</h2>
        <p>
          O Fila DP é uma plataforma de gestão, integração e conferência operacional para Departamento Pessoal, fornecida
          como software como serviço. O cliente contrata acesso a um workspace isolado, com usuários, empresas e dados próprios.
        </p>

        <h2>2. O que o serviço não faz</h2>
        <ul>
          <li>Não calcula nem processa a folha de pagamento oficial, que permanece no ERP do cliente.</li>
          <li>Não executa admissão digital. Esse processo permanece integralmente na Sólides ou em sistema equivalente do cliente.</li>
          <li>Não armazena prontuário, diagnóstico, evolução ou qualquer conteúdo clínico. O módulo de Psicólogos trata apenas do pagamento das consultas.</li>
          <li>Não emite nota fiscal, não realiza apuração tributária e não substitui contador ou assessoria fiscal.</li>
          <li>Não registra marcações oficiais de ponto nem transmite obrigações a órgãos públicos.</li>
        </ul>
        <p>
          Cálculos apresentados pela plataforma são apurações administrativas baseadas nos parâmetros configurados pelo
          cliente. A conferência final e a responsabilidade legal permanecem do cliente e de seus assessores.
        </p>

        <h2>3. Conta, acesso e responsabilidades do cliente</h2>
        <ul>
          <li>O cliente é responsável pelos usuários que convida, pelos papéis que atribui e pelo escopo de empresas que concede.</li>
          <li>Credenciais são pessoais e intransferíveis. Sessões podem ser revogadas pelo próprio usuário ou por um administrador.</li>
          <li>O cliente é responsável pela veracidade dos dados que insere ou importa e pela base legal para tratá-los.</li>
          <li>Chaves de API e segredos de webhook são de responsabilidade de quem os gera; a revogação é imediata pelo painel.</li>
        </ul>

        <h2>4. Uso aceitável</h2>
        <p>É vedado usar a plataforma para armazenar dados clínicos, para tentar acessar dados de outro cliente, para
          contornar limites técnicos, para automatizar abuso de terceiros ou para qualquer finalidade ilícita.</p>

        <h2>5. Disponibilidade e suporte</h2>
        <p>
          O serviço é fornecido em regime de melhores esforços, com janelas de manutenção comunicadas quando previsíveis.
          O acesso da equipe de suporte a dados do cliente é autorizado, temporário, justificado e auditado.
        </p>

        <h2>6. Planos, cobrança e cancelamento</h2>
        <ul>
          <li>As condições comerciais são as publicadas em <Link href="/planos">Planos</Link> ou as acordadas em contrato.</li>
          <li>O cancelamento encerra a renovação seguinte e mantém o acesso até o fim do período contratado.</li>
          <li>Inadimplência pode suspender o acesso após comunicação; a suspensão não apaga dados dentro do prazo de retenção.</li>
        </ul>

        <h2>7. Dados do cliente</h2>
        <p>
          Os dados inseridos permanecem do cliente. O tratamento é regido pela <Link href="/privacidade">Política de privacidade</Link>
          e pelas condições de processamento descritas na página de <Link href="/subprocessadores">Subprocessadores e DPA</Link>.
          O cliente pode exportar seus dados enquanto o contrato estiver ativo.
        </p>

        <h2>8. Propriedade intelectual</h2>
        <p>A plataforma, seu código e sua marca pertencem ao fornecedor. O contrato concede direito de uso, não de propriedade.</p>

        <h2>9. Limitação de responsabilidade</h2>
        <p>
          O fornecedor não responde por decisões operacionais, trabalhistas, fiscais ou financeiras tomadas pelo cliente com
          base nas informações apresentadas, nem por indisponibilidade de sistemas de terceiros integrados.
        </p>

        <h2>10. Vigência e foro</h2>
        <p>
          Estes termos vigoram enquanto houver contrato ativo. Aplica-se a legislação brasileira, incluindo a Lei nº 13.709/2018 (LGPD).
        </p>

        <h2>11. Contato</h2>
        <p>Dúvidas sobre estes termos podem ser enviadas pela página de <Link href="/contato">Contato</Link>.</p>
      </section>
    </SiteShell>
  );
}
