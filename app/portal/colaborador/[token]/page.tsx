import type { Metadata } from "next";
import { EmployeePortal } from "./EmployeePortal";

/**
 * O portal do colaborador (§4.37): holerites, férias e pedido de férias, sem
 * conta. Mesmo raciocínio dos portais de nota fiscal e de EPI.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meus holerites e férias | Vinculato",
  description: "Consulte seus holerites e suas férias e peça férias ao DP.",
  // O endereço é uma credencial.
  robots: { index: false, follow: false, nocache: true },
};

export default async function EmployeePortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EmployeePortal token={token} />;
}
