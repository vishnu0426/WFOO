/** Excel (.xlsx) helpers for import templates. exceljs is loaded on demand so it stays out of the main bundle. */

export async function downloadXlsx(fileName: string, sheetName: string, rows: (string | number)[][], notes?: string[]) {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = Math.max(14, ...rows.map((r) => String(r[i] ?? '').length + 2)); });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (notes?.length) { const n = wb.addWorksheet('Notes'); n.addRows(notes.map((t) => [t])); n.getColumn(1).width = 110; }
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const cell = (v: any): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((t: any) => t.text).join('') : ''));
  return String(v);
};
const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** First sheet of an .xlsx file as CSV text, so the same importer handles both formats. */
export async function xlsxToCsv(file: File): Promise<string> {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheets');
  const lines: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as any[]).slice(1);
    lines.push(vals.map((v) => q(cell(v))).join(','));
  });
  return lines.join('\n');
}
