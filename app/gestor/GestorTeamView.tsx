"use client";

import { useEffect, useState } from "react";
import styles from "./gestor.module.css";

type TeamMember = {
  id: string;
  name: string;
  registrationNumber: string;
  positionName: string;
  companyName: string;
  admissionDate: string;
};

type TeamResponse = { linked: boolean; team: TeamMember[] };

function admissionLabel(value: string) {
  if (!value) return "Admissão não informada";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : `Desde ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date)}`;
}

function initials(name: string) {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

export function GestorTeamView({ userName, signOutPath }: { userName: string; signOutPath: string }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data: TeamResponse | null; error: string }>({
    status: "loading", data: null, error: "",
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/gestor/team", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Não foi possível carregar sua equipe.");
        return response.json() as Promise<TeamResponse>;
      })
      .then((data) => setState({ status: "ready", data, error: "" }))
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({ status: "error", data: null, error: cause instanceof Error ? cause.message : "Não foi possível carregar sua equipe." });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>PORTAL DO GESTOR</span>
            <h1>Minha equipe</h1>
          </div>
          <a href={signOutPath} className={styles.signOut}>Sair ({userName})</a>
        </header>

        {state.status === "loading" && <p className={styles.state}>Carregando sua equipe…</p>}
        {state.status === "error" && <p className={styles.stateError}>{state.error}</p>}

        {state.status === "ready" && state.data && !state.data.linked && (
          <p className={styles.state}>
            Sua conta ainda não está vinculada a um colaborador. Peça ao administrador do grupo para fazer esse vínculo em
            {" "}<strong>Configurações → Usuários e acessos</strong>.
          </p>
        )}

        {state.status === "ready" && state.data && state.data.linked && state.data.team.length === 0 && (
          <p className={styles.state}>Você não tem ninguém reportando para você no momento.</p>
        )}

        {state.status === "ready" && state.data && state.data.linked && state.data.team.length > 0 && (
          <ul className={styles.team}>
            {state.data.team.map((member) => (
              <li key={member.id} className={styles.member}>
                <span className={styles.avatar}>{initials(member.name)}</span>
                <div>
                  <strong>{member.name}</strong>
                  <small>{member.positionName || "Sem cargo"} · {member.companyName}</small>
                  <small>{admissionLabel(member.admissionDate)} · Matrícula {member.registrationNumber || "não informada"}</small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
