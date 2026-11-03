/** Data em dd/mm/aaaa: "10 de mar." não diz de que ano é a validade do CA. */
export const dateLabel = (value: string) => {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};

/** Hoje, no fuso do aparelho — "hoje" no galpão é o dia de quem está lá, não o de Greenwich. */
export const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
