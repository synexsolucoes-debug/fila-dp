import type { Metadata } from "next";
import { PlatformApp } from "./PlatformApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Console global | Fila DP",
  description: "Administração global de workspaces, assinaturas e planos do Fila DP.",
};

export default function PlatformPage() { return <PlatformApp />; }
