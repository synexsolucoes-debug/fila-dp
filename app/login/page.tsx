import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getChatGPTUser } from "../chatgpt-auth";
import { LoginForm } from "./LoginForm";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar | Vinculato",
  description: "Acesse seu ambiente de gestão de demandas do Departamento Pessoal.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // "Entrar em outra conta" chega aqui com a sessão já encerrada. Mesmo assim a
  // tela nunca deve oferecer "continuar": a intenção era trocar de identidade.
  const switching = query.trocar === "1";
  const user = switching ? null : await getChatGPTUser();

  /* A tela de entrada mostra só a marca e o acesso. Sem painel de vitrine e
     sem "voltar para o site": quem chega aqui veio para entrar. */
  return (
    <main className="auth-page auth-page-solo">
      <section className="auth-solo-card">
        <div className="auth-solo-logo">
          <VinculatoLogo size={52} tone="light" priority />
        </div>

        <div className="auth-form-card">
          {user ? (
            <>
              <span className="auth-status"><i /> Sessão ativa</span>
              <h2>Bem-vindo de volta.</h2>
              <p>Você está conectado como <strong>{user.displayName}</strong>.</p>
              <Link className="button auth-primary" href="/painel?modulos=1">Continuar para os módulos <ArrowRight aria-hidden="true" /></Link>
              <form method="post" action="/api/auth/logout">
                <input type="hidden" name="trocar" value="1" />
                <button type="submit" className="auth-secondary-link">Entrar em outra conta</button>
              </form>
            </>
          ) : <LoginForm />}
        </div>
      </section>
    </main>
  );
}
