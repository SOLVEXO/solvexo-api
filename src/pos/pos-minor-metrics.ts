/**
 * In-process counters for the minor-unit consistency checker (G1b step b). `record()` is called after every checked write;
 * a non-zero `mismatches` is also an audit event (`money_minor_mismatch`) and a `[pos-minor-mismatch]` log line, which is what the
 * flip-criteria report (scripts/pos-minor-flip-report.ts) reads from the database. These counters are the cheap live view
 * (per process, reset on restart) — logs/audit are the durable record.
 */
export class PosMinorMetrics {
  private static checks: Record<string, number> = {};
  private static mismatchedDocs: Record<string, number> = {};
  private static mismatchedFields: Record<string, number> = {};
  private static clientMismatches = 0;

  static record(kind: string, mismatchCount: number): void {
    this.checks[kind] = (this.checks[kind] ?? 0) + 1;
    if (mismatchCount > 0) {
      this.mismatchedDocs[kind] = (this.mismatchedDocs[kind] ?? 0) + 1;
      this.mismatchedFields[kind] = (this.mismatchedFields[kind] ?? 0) + mismatchCount;
    }
  }

  /** A client payload whose decimal and minor twin disagreed (the sale was accepted at the server's values). */
  static recordClient(n: number): void {
    this.clientMismatches += n;
  }

  static snapshot() {
    const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    return { checks: { ...this.checks }, mismatchedDocs: { ...this.mismatchedDocs }, mismatchedFields: { ...this.mismatchedFields }, clientPayloadMismatches: this.clientMismatches, totalChecks: total(this.checks), totalMismatchedDocs: total(this.mismatchedDocs) };
  }

  static reset(): void {
    this.checks = {};
    this.mismatchedDocs = {};
    this.mismatchedFields = {};
    this.clientMismatches = 0;
  }
}
