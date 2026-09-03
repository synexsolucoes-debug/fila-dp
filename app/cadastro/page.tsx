import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { SignupForm } from "./SignupForm";

export const metadata: Metadata = {
  title: "Criar conta | Vinculato",
  description: "Crie um workspace Starter gratuito no Vinculato.",
};

export default function SignupPage() {
  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Link className="brand auth-brand" href="/#inicio" aria-label="Vinculato — início"><VinculatoLogo size={32} tone="light" priority /></Link>
        <div className="auth-message">
          <span className="auth-kicker">Sua operação, conectada</span>
          <h1>Organize o primeiro processo sem custo.</h1>
          <p>Comece no Starter e evolua quando a operação pedir mais capacidade.</p>
        </div>
        <div className="auth-security-note"><CheckCircle2 aria-hidden="true" /><p>O workspace só é ativado depois que você confirma o e-mail.</p></div>
      </section>
      <section className="auth-form-panel">
        <Link className="auth-back" href="/login"><ArrowLeft aria-hidden="true" /> Já tenho conta</Link>
        <div className="auth-form-card"><SignupForm /></div>
        <p className="auth-help">O CNPJ será solicitado na etapa de cadastro da empresa.</p>
      </section>
    </main>
  );
}
