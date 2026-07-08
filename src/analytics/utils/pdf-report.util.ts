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
      this.page.drawText(value, { x, y: this.y - 14, size: 13, font: this.boldFont, color: rgb(0.1, 0.1, 0.1) });
      col = col === 0 ? 1 : 0;
      if (col === 0) this.y -= 36;
    }
    if (col === 1) this.y -= 36;
    this.y -= 6;
  }

  addTable(headers: string[], rows: (string | number)[][]) {
    const colWidth = (this.pageWidth - this.margin * 2) / headers.length;
    this.ensureSpace(20);
    headers.forEach((h, i) => {
      this.page.drawText(h, { x: this.margin + i * colWidth, y: this.y, size: 9, font: this.boldFont, color: rgb(0.3, 0.3, 0.3) });
    });
    this.y -= 6;
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.pageWidth - this.margin, y: this.y },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
    this.y -= 14;

    for (const row of rows) {
      this.ensureSpace(16);
      row.forEach((cell, i) => {
        const text = String(cell ?? '');
        this.page.drawText(text.length > 40 ? text.slice(0, 37) + '...' : text, {
          x: this.margin + i * colWidth,
          y: this.y,
          size: 9,
          font: this.font,
          color: rgb(0.15, 0.15, 0.15),
        });
      });
      this.y -= 16;
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
