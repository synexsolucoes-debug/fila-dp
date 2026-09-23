/**
 * Leitura da carga horária (CODCARGAHOR) exportada do Sankhya — diferente de
 * cargo, departamento e sindicato (`lib/sankhya-catalog-xlsx.ts`) porque ali
 * uma linha é um cadastro; aqui uma jornada inteira é várias linhas, uma por
 * dia da semana × turno (jornada com intervalo tem duas linhas por dia).
 *
 * ## Como as horas semanais são calculadas, e por que não é DURJORNADAESOCIAL
 *
 * A planilha traz uma coluna pronta (`DURJORNADAESOCIAL`), mas o valor dela
 * não bate com a diferença ENTRADA/SAÍDA do próprio turno — não dava pra
 * confirmar o que ela mede sem arriscar guardar um número errado. O que
 * confere: somar SAÍDA−ENTRADA (em minutos) de cada turno com horário
 * preenchido, por código. Testado contra a jornada nº 1 desta exportação
 * real — segunda a sexta 08:00–12:00 e 14:00–18:00, sábado 08:00–12:00 — a
 * soma dá 44h, o mesmo HORASSEM que aparece nos funcionários já cadastrados
 * que usam essa jornada. Bate exatamente porque é aritmética direta sobre o
 * que a ficha já mostra, não um campo cujo cálculo interno é opaco.
 *
 * ## Por que "nome" e "descrição" são gerados, não lidos
 *
 * O Sankhya não dá nome pra jornada, só o código. `name` vira as horas por
 * extenso ("44h semanais") — o jeito como quem confere já se refere a uma
 * jornada no dia a dia. `description` agrupa dias consecutivos com o mesmo
 * horário ("Seg a Sex: 08:00–12:00 e 14:00–18:00 · Sáb: 08:00–12:00"), pra
 * não escrever a mesma linha sete vezes.
 */
import ExcelJS from "exceljs";

export type SankhyaWorkScheduleRecord = {
  code: string;
  name: string;
  weeklyHours: number;
  description: string;
};

const REQUIRED_HEADERS = ["CODCARGAHOR", "DIASEM", "ENTRADA", "SAIDA"];

/** Domingo = 1 … Sábado = 7, como o Sankhya numera (DIASEM). */
const DAY_LABELS = ["", "Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const valueText = (value: ExcelJS.CellValue) => {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }
  return String(value).trim();
};

function hhmmToMinutes(value: ExcelJS.CellValue) {
  const text = valueText(value);
  if (!text) return null;
  const minutes = Number(text.replace(/\.0$/u, ""));
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.trunc(minutes / 100) * 60 + Math.trunc(minutes % 100);
}

function formatClock(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatHours(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h${String(minutes).padStart(2, "0")}` : `${hours}h`;
}

/** Agrupa dias consecutivos (na ordem da semana) com os mesmos turnos, para não repetir a mesma linha sete vezes. */
function describeSchedule(shiftsByDay: Map<number, Array<[number, number]>>) {
  const signature = (day: number) => JSON.stringify(shiftsByDay.get(day) ?? []);
  const segments: string[] = [];
  let runStart: number | null = null;
  let runSignature = "";
  const flush = (runEnd: number) => {
    if (runStart === null) return;
    const shifts = shiftsByDay.get(runStart) ?? [];
    if (!shifts.length) { runStart = null; return; }
    const label = runStart === runEnd ? DAY_LABELS[runStart] : `${DAY_LABELS[runStart]} a ${DAY_LABELS[runEnd]}`;
    const times = shifts.map(([start, end]) => `${formatClock(start)}–${formatClock(end)}`).join(" e ");
    segments.push(`${label}: ${times}`);
    runStart = null;
  };
  for (let day = 1; day <= 7; day += 1) {
    const current = signature(day);
    if (runStart !== null && current === runSignature) continue;
    flush(day - 1);
    runStart = day;
    runSignature = current;
  }
  flush(7);
  return segments.join(" · ") || "Sem horário definido";
}

export async function readSankhyaWorkScheduleWorkbook(buffer: ArrayBuffer) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("A planilha deve ter no máximo 10 MB.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("A planilha não possui nenhuma aba.");

  let headerRow = 0;
  let columns = new Map<string, number>();
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRow) return;
    const candidate = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, column) => candidate.set(valueText(cell.value).toUpperCase(), column));
    if (REQUIRED_HEADERS.every((key) => candidate.has(key))) { headerRow = rowNumber; columns = candidate; }
  });
  if (!headerRow) throw new Error(`Modelo Sankhya inválido: cabeçalhos ${REQUIRED_HEADERS.join(", ")} não encontrados.`);

  const cell = (row: ExcelJS.Row, name: string) => row.getCell(columns.get(name) ?? 0).value;
  const shiftsByCode = new Map<string, Map<number, Array<[number, number]>>>();
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const code = valueText(cell(row, "CODCARGAHOR")).replace(/\.0$/u, "");
    const day = Number(valueText(cell(row, "DIASEM")).replace(/\.0$/u, ""));
    if (!code || !Number.isInteger(day) || day < 1 || day > 7) continue;
    const start = hhmmToMinutes(cell(row, "ENTRADA"));
    const end = hhmmToMinutes(cell(row, "SAIDA"));
    if (start === null || end === null || end <= start) continue;
    if (!shiftsByCode.has(code)) shiftsByCode.set(code, new Map());
    const byDay = shiftsByCode.get(code)!;
    if (!byDay.has(day)) byDay.set(day, []);
    const shifts = byDay.get(day)!;
    if (!shifts.some(([s, e]) => s === start && e === end)) shifts.push([start, end]);
  }
  if (!shiftsByCode.size) throw new Error("Nenhuma jornada foi encontrada na planilha.");

  const records: SankhyaWorkScheduleRecord[] = [];
  for (const [code, byDay] of shiftsByCode) {
    for (const shifts of byDay.values()) shifts.sort((a, b) => a[0] - b[0]);
    let totalMinutes = 0;
    for (const shifts of byDay.values()) for (const [start, end] of shifts) totalMinutes += end - start;
    const weeklyHours = Math.min(Math.max(Math.round(totalMinutes / 60), 1), 60);
    records.push({ code, name: `${formatHours(totalMinutes)} semanais`, weeklyHours, description: describeSchedule(byDay) });
  }
  records.sort((a, b) => Number(a.code) - Number(b.code));
  return records;
}
