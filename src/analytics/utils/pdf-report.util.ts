/* eslint-disable prettier/prettier */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/**
 * Text/table PDF report builder built on `pdf-lib` (the only PDF dependency
 * already in this codebase — otherwise only used for stamping digital
 * downloads). This deliberately does NOT render chart images: doing that
 * properly needs a headless-browser or canvas rendering library (puppeteer /
 * chartjs-node-canvas), which isn't currently a project dependency and is
 * flagged as a follow-up rather than silently added here. Every number in
 * this report is still the real, fully-computed figure — just presented as
 * KPI text and tables instead of a rendered chart image.
 */
export class PdfReportBuilder {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private boldFont!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private readonly pageWidth = 595; // A4 portrait, points
  private readonly pageHeight = 842;
  private readonly margin = 48;

  static async create(title: string, subtitle: string): Promise<PdfReportBuilder> {
    const builder = new PdfReportBuilder();
    builder.doc = await PDFDocument.create();
    builder.font = await builder.doc.embedFont(StandardFonts.Helvetica);
    builder.boldFont = await builder.doc.embedFont(StandardFonts.HelveticaBold);
    builder.newPage();
    builder.addTitle(title, subtitle);
    return builder;
  }

  private newPage() {
    this.page = this.doc.addPage([this.pageWidth, this.pageHeight]);
    this.y = this.pageHeight - this.margin;
  }

  private ensureSpace(height: number) {
    if (this.y - height < this.margin) this.newPage();
  }

  private addTitle(title: string, subtitle: string) {
    this.page.drawText(title, { x: this.margin, y: this.y, size: 20, font: this.boldFont, color: rgb(0.05, 0.05, 0.05) });
    this.y -= 24;
    this.page.drawText(subtitle, { x: this.margin, y: this.y, size: 10, font: this.font, color: rgb(0.4, 0.4, 0.4) });
    this.y -= 28;
  }

  addSectionHeading(text: string) {
    this.ensureSpace(30);
    this.page.drawText(text, { x: this.margin, y: this.y, size: 13, font: this.boldFont, color: rgb(0.85, 0.47, 0.34) });
    this.y -= 18;
  }

  addKeyValueGrid(pairs: { label: string; value: string }[]) {
    const colWidth = (this.pageWidth - this.margin * 2) / 2;
    let col = 0;
    for (const { label, value } of pairs) {
      if (col === 0) this.ensureSpace(36);
      const x = this.margin + col * colWidth;
      this.page.drawText(label.toUpperCase(), { x, y: this.y, size: 8, font: this.font, color: rgb(0.5, 0.5, 0.5) });
      this.page.drawText(this.safe(value, this.boldFont), { x, y: this.y - 14, size: 13, font: this.boldFont, color: rgb(0.1, 0.1, 0.1) });
      col = col === 0 ? 1 : 0;
      if (col === 0) this.y -= 36;
    }
    if (col === 1) this.y -= 36;
    this.y -= 6;
  }

  /** Adds thousands commas to money-looking numbers ("1234.5" and "$ 12500" become "1,234.5" and "$ 12,500"); plain integers such as order numbers or years are left alone. */
  private groupThousands(text: string): string {
    const group = (int: string) => int.replace(/B(?=(d{3})+(?!d))/g, ',');
    return text
      .replace(/(^|[^d.,])(-?d{4,})(.d+)/g, (_m, pre, int, dec) => `${pre}${group(int)}${dec}`)
      .replace(/(^|[^w])([$€£]|Rs|[A-Z]{3}) (-?d{4,})(?![d.,])/g, (_m, pre, cur, int) => `${pre}${cur} ${group(int)}`);
  }

  /** The standard Helvetica font can only draw WinAnsi characters (Urdu, emoji, ... would throw), so anything it can't encode becomes "?". */
  private safe(text: string, font: PDFFont): string {
    let out = '';
    for (const ch of this.groupThousands(text.replace(/\s+/g, ' '))) {
      try { font.encodeText(ch); out += ch; } catch { out += '?'; }
    }
    return out;
  }

  /** Splits `text` into at most `maxLines` lines that fit `maxWidth`; the last line ends with "..." when text is cut. */
  private wrap(text: string, maxWidth: number, size: number, maxLines: number): string[] {
    const fits = (s: string) => this.font.widthOfTextAtSize(s, size) <= maxWidth;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) { line = next; continue; }
      if (line) { lines.push(line); line = ''; }
      // a single word wider than the whole column is split by characters
      let rest = word;
      while (rest && !fits(rest)) {
        let n = rest.length;
        while (n > 1 && !fits(rest.slice(0, n))) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines) return lines.length ? lines : [''];
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && !fits(`${last}...`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}...`;
    return kept;
  }

  addTable(headers: string[], rows: (string | number)[][]) {
    // The first column (names, dates, sources) gets more room than the number columns after it.
    const weights = headers.map((_, i) => (i === 0 && headers.length >= 3 ? 2.6 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const innerWidth = this.pageWidth - this.margin * 2;
    const colWidths = weights.map(w => (innerWidth * w) / totalWeight);
    const colX = colWidths.map((_, i) => this.margin + colWidths.slice(0, i).reduce((a, b) => a + b, 0));
    const gap = 8;
    this.ensureSpace(20);
    headers.forEach((h, i) => {
      this.page.drawText(this.safe(h, this.boldFont), { x: colX[i], y: this.y, size: 9, font: this.boldFont, color: rgb(0.3, 0.3, 0.3) });
    });
    this.y -= 6;
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.pageWidth - this.margin, y: this.y },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
    this.y -= 14;

    const lineHeight = 11;
    for (const row of rows) {
      // Long text wraps (max 2 lines) inside its own column instead of running into the next one.
      const cells = row.map((cell, i) => this.wrap(this.safe(String(cell ?? ''), this.font), colWidths[i] - gap, 9, 2));
      const rowLines = Math.max(...cells.map(c => c.length));
      this.ensureSpace(rowLines * lineHeight + 6);
      cells.forEach((lines, i) => {
        lines.forEach((text, n) => {
          this.page.drawText(text, {
            x: colX[i],
            y: this.y - n * lineHeight,
            size: 9,
            font: this.font,
            color: rgb(0.15, 0.15, 0.15),
          });
        });
      });
      this.y -= rowLines * lineHeight + 5;
    }
    this.y -= 10;
  }

  addEmptyNote(text: string) {
    this.ensureSpace(16);
    this.page.drawText(text, { x: this.margin, y: this.y, size: 9, font: this.font, color: rgb(0.55, 0.55, 0.55) });
    this.y -= 20;
  }

  async build(): Promise<Buffer> {
    const bytes = await this.doc.save();
    return Buffer.from(bytes);
  }
}
