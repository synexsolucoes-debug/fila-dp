/** Consulta: o que está em poder de quem. */
import { useState } from "react";
import type { EmployeeOption } from "@/app/painel/features/epi/epi.types";
import { useDossier } from "../components/ActiveDeliveries";
import { EmployeePicker } from "../components/Pickers";
import { Banner, Chosen, Hint, Row, Screen, SectionTitle, Stat, StatRow } from "../components/ui";
import { dateLabel } from "../lib/format";
import { useWorkspace } from "../lib/workspace";

export default function Lookup() {
  const ws = useWorkspace();
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const { dossier, loading, problem } = useDossier(employee?.id ?? null);

  if (!employee) return <Screen>
    <EmployeePicker companyId={ws.company?.id ?? ""} title="Quem você quer consultar?" onPick={setEmployee} />
  </Screen>;

  const held = dossier?.activeDeliveries ?? [];
  const units = held.reduce((sum, item) => sum + item.outstanding, 0);

  return <Screen refreshing={loading}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    {problem ? <Banner>{problem}</Banner> : null}
    {dossier && <>
      <StatRow>
        <Stat label="Em poder" value={units} />
        <Stat label="Itens" value={held.length} />
        <Stat label="Devoluções" value={dossier.returns.length} />
      </StatRow>
      <SectionTitle>EPIs em poder</SectionTitle>
      {held.length ? held.map((item) => <Row key={item.id} title={item.epiName}
        lines={[`CA ${item.caNumber || "—"} · ${item.size || "—"} · ${item.outstanding} un.`, `Desde ${dateLabel(item.deliveredOn)}`]} />)
        : <Hint>Nada em poder deste colaborador.</Hint>}
      {dossier.discounts.length > 0 && <>
        <SectionTitle>Análises de desconto</SectionTitle>
        {dossier.discounts.slice(0, 5).map((item) => <Row key={item.id} title={item.epiName} lines={[`${dateLabel(item.occurredOn)} · ${item.status}`]} />)}
      </>}
    </>}
  </Screen>;
}
