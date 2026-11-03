/**
 * A report table as a PDF: the organisation's logo and name, the report title and dates, then the table with its header repeated on every page
 * and "Page n of m" at the foot. Pure: a table goes in, bytes come out, so it is tested without a database.
 * Wide tables (more than six columns) get landscape pages. Text is set in the built-in Helvetica, so letters outside Latin-1 are shown as "?".
 */
import PDFDocument from 'pdfkit';

export interface PdfInput {
  title: string; subtitle: string; orgName: string; logo: Buffer | null; columns: string[]; rows: (string | number)[][]; generatedAt: string;
  /** Rows beyond this are left out of the PDF (the CSV has them all) and the page says so. */
  maxRows?: number;
}

const latin = (v: unknown) => String(v ?? '').replace(/[^ -~ -ÿ]/g, '?');
const MARGIN = 36, ROW_H = 16, FONT = 8;

export function toPdf(input: PdfInput): Promise<Buffer> {
  const max = input.maxRows ?? 2000, rows = input.rows.slice(0, max);
  const landscape = input.columns.length > 6;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true, info: { Title: latin(input.title), Author: latin(input.orgName) } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const width = doc.page.width - MARGIN * 2, bottom = doc.page.height - MARGIN - 18;

  // column widths: what the longest of the first rows needs, squeezed or stretched to the page
  doc.font('Helvetica').fontSize(FONT);
  const want = input.columns.map((h, c) => {
    let w = doc.font('Helvetica-Bold').widthOfString(latin(h));
    doc.font('Helvetica');
    for (const r of rows.slice(0, 200)) w = Math.max(w, doc.widthOfString(latin(r[c])));
    return Math.min(220, Math.max(36, w + 10));
  });
  const total = want.reduce((a, b) => a + b, 0), scale = Math.min(1.4, width / total);
  const cols = want.map((w) => w * scale);
  const x0 = MARGIN;

  const fit = (text: string, w: number) => {
    if (doc.widthOfString(text) <= w - 8) return text;
    let t = text;
    while (t.length > 1 && doc.widthOfString(t + '…') > w - 8) t = t.slice(0, -1);
    return t + '…';
  };

  const pageHeader = () => {
    let textX = MARGIN;
    if (input.logo) {
      try { doc.image(input.logo, MARGIN, 26, { fit: [110, 38] }); textX = MARGIN + 124; } catch { /* a logo that cannot be drawn is left out */ }
    }
    doc.fillColor('#171717').font('Helvetica-Bold').fontSize(12).text(latin(input.orgName), textX, 28, { width: width - (textX - MARGIN), lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(14).text(latin(input.title), textX, 44, { width: width - (textX - MARGIN), lineBreak: false });
    doc.fillColor('#737373').font('Helvetica').fontSize(9).text(latin(input.subtitle), textX, 62, { width: width - (textX - MARGIN), lineBreak: false });
    doc.moveTo(MARGIN, 78).lineTo(MARGIN + width, 78).strokeColor('#E5E5E0').lineWidth(0.5).stroke();
    return 86;
  };
  const tableHeader = (y: number) => {
    doc.rect(x0, y, width, ROW_H).fill('#FAFAF8');
    doc.fillColor('#525252').font('Helvetica-Bold').fontSize(FONT);
    let x = x0;
    input.columns.forEach((h, c) => { doc.text(fit(latin(h), cols[c]), x + 4, y + 4, { width: cols[c] - 6, lineBreak: false }); x += cols[c]; });
    doc.moveTo(x0, y + ROW_H).lineTo(x0 + width, y + ROW_H).strokeColor('#E5E5E0').lineWidth(0.5).stroke();
    return y + ROW_H;
  };

  let y = tableHeader(pageHeader());
  if (!rows.length) doc.fillColor('#737373').font('Helvetica').fontSize(10).text('No rows for these dates.', x0, y + 10, { lineBreak: false });
  rows.forEach((r, i) => {
    if (y + ROW_H > bottom) { doc.addPage(); y = tableHeader(pageHeader()); }
    if (i % 2 === 1) doc.rect(x0, y, width, ROW_H).fill('#FBFBF9');
    doc.fillColor('#171717').font('Helvetica').fontSize(FONT);
    let x = x0;
    r.forEach((v, c) => {
      const num = typeof v === 'number';
      const t = fit(latin(v), cols[c]);
      doc.text(t, x + 4, y + 4, { width: cols[c] - 8, align: num ? 'right' : 'left', lineBreak: false });
      x += cols[c];
    });
    y += ROW_H;
  });
  if (input.rows.length > max) {
    if (y + ROW_H * 2 > bottom) { doc.addPage(); y = pageHeader(); }
    doc.fillColor('#B7791F').font('Helvetica').fontSize(9).text(`Showing the first ${max} of ${input.rows.length} rows. The CSV file has all of them.`, x0, y + 8, { lineBreak: false });
  }

  // "Page n of m" and the time it was made, on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;                                  // otherwise writing below the bottom margin would add a page
    doc.fillColor('#737373').font('Helvetica').fontSize(8);
    doc.text(`Made ${latin(input.generatedAt)}`, MARGIN, doc.page.height - 28, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + width / 2, doc.page.height - 28, { width: width / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
