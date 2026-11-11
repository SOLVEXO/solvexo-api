/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PRINT_KINDS, PrintKind, REPRINT_DOCUMENT_TYPES, ReprintDocumentType } from './schemas/pos-reprint-event.schema';

type Req = any;
interface Tokens { employee?: string; approver?: string }

/**
 * G4.8 — reprinting a receipt, a tax invoice or a credit note is RECORDED: an append-only reprint event (who, which till, who approved, why) and the
 * document's reprint count, written together with the audit row in ONE transaction. When the store's "require PIN to reprint" is on, a cashier's reprint
 * needs a manager's approval token (`x-pos-approver-token`); managers and the owner reprint directly. The receipt prints "REPRINT #n".
 * G4.9: each event has a KIND. The first print of a tax invoice or credit note is the `original` (number 0, no PIN), from whichever screen; later prints are
 * `reprint` #n. Receipts are unchanged (every recorded print is a reprint). Nothing is backfilled: a document whose events predate G4.9 (no kind = reprint)
 * simply continues from its highest number.
 */
@Injectable()
export class PosReprintService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  async reprint(req: Req, storeId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const type = body?.documentType as ReprintDocumentType;
    if (!REPRINT_DOCUMENT_TYPES.includes(type)) throw new BadRequestException({ statusCode: 400, code: 'DOCUMENT_TYPE_INVALID', message: `documentType must be one of ${REPRINT_DOCUMENT_TYPES.join(', ')}` });
    const documentId = String(body?.documentId ?? '');
    if (!Types.ObjectId.isValid(documentId)) throw new NotFoundException({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : null;

    // the document, in this store
    let saleId: string;
    if (type === 'credit_note') {
      const cn: any = await this.r.posCreditNoteModel.findOne({ _id: documentId, storeId }).select('saleId').lean();
      if (!cn) throw new NotFoundException({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND', message: 'Credit note not found' });
      saleId = String(cn.saleId);
    } else {
      const sale: any = await this.r.saleModel.findOne({ _id: documentId, storeId }).select('invoice status').lean();
      if (!sale) throw new NotFoundException({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND', message: 'Sale not found' });
      if (type === 'invoice' && !sale.invoice) throw new BadRequestException({ statusCode: 400, code: 'NO_INVOICE', message: 'This sale has no tax invoice' });
      saleId = documentId;
    }

    const a = await this.auth.authorize(req, { storeId, action: 'sales.reprint', employeeToken: t.employee });
    const deviceId = req?.user?.posDevice?.deviceId ?? null;
    const asked = body?.kind === undefined || body?.kind === null ? null : String(body.kind);
    if (asked !== null && !PRINT_KINDS.includes(asked as PrintKind)) throw new BadRequestException({ statusCode: 400, code: 'PRINT_KIND_INVALID', message: `kind must be one of ${PRINT_KINDS.join(', ')}` });

    // G4.9: the SERVER decides original vs reprint (the client's `kind` is what it expects to print; the answer is what it must print). Two tills printing
    // the same document at once collide on the unique number: the loser decides again — and is then a reprint, with the PIN rule applied.
    let ev: any; let approvedBy: string | null = null;
    for (let attempt = 0; attempt < 3 && !ev; attempt++) {
      const last: any = await this.r.posReprintEventModel.findOne({ documentType: type, documentId }).sort({ reprintNumber: -1 }).select('reprintNumber').lean();
      // the first print of a tax invoice / credit note is the ORIGINAL (number 0), whichever screen it comes from; a receipt keeps G4.8 (every recorded print is a reprint)
      const kind: PrintKind = !last && type !== 'sale' ? 'original' : 'reprint';
      const number = kind === 'original' ? 0 : (last?.reprintNumber ?? 0) + 1;
      approvedBy = kind === 'reprint' ? await this.reprintApproval(storeId, a, t, documentId, type) : null;
      const write = (tx: ClientSession) => this.record(tx, { storeId, type, documentId, saleId, kind, number, employeeId: a.employeeId, role: a.role, approvedBy, deviceId, reason });
      try { ev = await this.r.posReprintEventModel.db.transaction(write); } catch (e: any) { if (e?.code !== 11000 || attempt === 2) throw e; }
    }
    return { success: true, data: { documentType: type, documentId, saleId, kind: ev.kind, requestedKind: asked, reprintNumber: ev.reprintNumber, reprintCount: ev.reprintNumber, approvedBy, createdAt: ev.createdAt } };
  }

  /** "Require a PIN to reprint": a cashier's REPRINT needs a manager's approver token; managers and the owner reprint directly. An original never asks. */
  private async reprintApproval(storeId: string, a: { role: string | null; employeeId: string | null }, t: Tokens, documentId: string, type: ReprintDocumentType): Promise<string | null> {
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('securityPrefs').lean();
    if (s?.securityPrefs?.requirePinForReprint !== true || a.role !== 'cashier') return null;
    const approver = await this.pos.verifyEmployeeToken(t.approver, storeId);
    if (!approver || approver.role !== 'manager') {
      await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'pos_approval_missing', targetId: documentId, targetType: 'sale', metadata: { action: 'sales.reprint', documentType: type } }]);
      throw new ForbiddenException({ statusCode: 403, code: 'POS_APPROVAL_REQUIRED', action: 'sales.reprint', approver: 'manager', reasons: ['reprint_pin'], message: 'A manager must approve this reprint' });
    }
    return approver.employeeId;
  }

  private async record(tx: ClientSession, x: { storeId: string; type: ReprintDocumentType; documentId: string; saleId: string; kind: PrintKind; number: number; employeeId: string | null; role: string | null; approvedBy: string | null; deviceId: string | null; reason: string | null }) {
    const n = x.number;
    const [ev] = await this.r.posReprintEventModel.create([{ storeId: x.storeId, documentType: x.type, documentId: x.documentId, saleId: x.saleId, kind: x.kind, reprintNumber: n, employeeId: x.employeeId, role: x.role, approvedBy: x.approvedBy, deviceId: x.deviceId, reason: x.reason }], { session: tx });
    if (x.type === 'sale') await this.r.saleModel.updateOne({ _id: x.documentId }, { $set: { reprintCount: n } }, { session: tx });
    await this.r.posAuditLogModel.create([{ storeId: x.storeId, employeeId: x.employeeId, action: x.kind === 'original' ? 'document_printed' : 'document_reprinted', targetId: x.documentId, targetType: 'sale', metadata: { documentType: x.type, kind: x.kind, reprintNumber: n, approvedBy: x.approvedBy, deviceId: x.deviceId, reason: x.reason } }], { session: tx });
    return ev.toObject();
  }
}
