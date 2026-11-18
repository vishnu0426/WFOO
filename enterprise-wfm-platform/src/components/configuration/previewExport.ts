/** Taking a preview table out of the screen: as a CSV file, or as a clean page to print or save as PDF (the browser's own "Save as PDF", so no extra library). */

const csvCell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);      // a leading = + - @ is neutralised so a spreadsheet never runs it as a formula

export function toCsv(head: string[], rows: string[][]): string {
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function downloadCsv(fileName: string, head: string[], rows: string[][]) {
  const url = URL.createObjectURL(new Blob(['﻿' + toCsv(head, rows)], { type: 'text/csv;charset=utf-8' }));      // the BOM keeps non-English names intact in Excel
  const a = document.createElement('a'); a.href = url; a.download = fileName; a.click(); URL.revokeObjectURL(url);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The page's HTML: a title, a few lines of context and the table. Everything from the data is escaped. */
export function printableHtml(title: string, lines: string[], head: string[], rows: string[][]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#171717;margin:24px}
    h1{font-size:18px;margin:0 0 4px}p{margin:2px 0;color:#525252}
    table{border-collapse:collapse;width:100%;margin-top:14px}th,td{border:1px solid #D6D6D0;padding:6px 8px;text-align:left;vertical-align:top}
    th{background:#F3F3F0;font-size:11px;text-transform:uppercase;letter-spacing:.04em}tr{break-inside:avoid}
  </style></head><body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
  <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

/** Opens the page in a new tab and starts the print dialog (choose "Save as PDF"). Returns false when the browser blocked the new tab. */
export function printPage(title: string, lines: string[], head: string[], rows: string[][]): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(printableHtml(title, lines, head, rows)); w.document.close();
  w.focus(); setTimeout(() => w.print(), 250);
  return true;
}
