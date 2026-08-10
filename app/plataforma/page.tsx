import type { Metadata } from "next";
import { PlatformApp } from "./PlatformApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Console global | Vinculato",
  description: "Administração global de workspaces, assinaturas e planos do Vinculato.",
};

export default function PlatformPage() { return <PlatformApp />; }
