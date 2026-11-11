/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { REPRINT_DOCUMENT_TYPES, ReprintDocumentType } from './schemas/pos-reprint-event.schema';

type Req = any;
interface Tokens { employee?: string; approver?: string }

/**
 * G4.8 — reprinting a receipt, a tax invoice or a credit note is RECORDED: an append-only reprint event (who, which till, who approved, why) and the
 * document's reprint count, written together with the audit row in ONE transaction. When the store's "require PIN to reprint" is on, a cashier's reprint
 * needs a manager's approval token (`x-pos-approver-token`); managers and the owner reprint directly. The receipt prints "REPRINT #n".
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
    let approvedBy: string | null = null;
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('securityPrefs').lean();
    if (s?.securityPrefs?.requirePinForReprint === true && a.role === 'cashier') {
      const approver = await this.pos.verifyEmployeeToken(t.approver, storeId);
      if (!approver || approver.role !== 'manager') {
        await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'pos_approval_missing', targetId: documentId, targetType: 'sale', metadata: { action: 'sales.reprint', documentType: type } }]);
        throw new ForbiddenException({ statusCode: 403, code: 'POS_APPROVAL_REQUIRED', action: 'sales.reprint', approver: 'manager', reasons: ['reprint_pin'], message: 'A manager must approve this reprint' });
      }
      approvedBy = approver.employeeId;
    }

    const deviceId = req?.user?.posDevice?.deviceId ?? null;
    const write = (tx: ClientSession) => this.record(tx, { storeId, type, documentId, saleId, employeeId: a.employeeId, role: a.role, approvedBy, deviceId, reason });
    // two tills reprinting the same document at once: the unique reprint number makes one of them retry with the next number
    let ev: any;
    for (let attempt = 0; attempt < 3 && !ev; attempt++) {
      try { ev = await this.r.posReprintEventModel.db.transaction(write); } catch (e: any) { if (e?.code !== 11000 || attempt === 2) throw e; }
    }
    return { success: true, data: { documentType: type, documentId, saleId, reprintNumber: ev.reprintNumber, reprintCount: ev.reprintNumber, approvedBy, createdAt: ev.createdAt } };
  }

  private async record(tx: ClientSession, x: { storeId: string; type: ReprintDocumentType; documentId: string; saleId: string; employeeId: string | null; role: string | null; approvedBy: string | null; deviceId: string | null; reason: string | null }) {
    const n = (await this.r.posReprintEventModel.countDocuments({ documentType: x.type, documentId: x.documentId }).session(tx)) + 1;
    const [ev] = await this.r.posReprintEventModel.create([{ storeId: x.storeId, documentType: x.type, documentId: x.documentId, saleId: x.saleId, reprintNumber: n, employeeId: x.employeeId, role: x.role, approvedBy: x.approvedBy, deviceId: x.deviceId, reason: x.reason }], { session: tx });
    if (x.type === 'sale') await this.r.saleModel.updateOne({ _id: x.documentId }, { $set: { reprintCount: n } }, { session: tx });
    await this.r.posAuditLogModel.create([{ storeId: x.storeId, employeeId: x.employeeId, action: 'document_reprinted', targetId: x.documentId, targetType: 'sale', metadata: { documentType: x.type, reprintNumber: n, approvedBy: x.approvedBy, deviceId: x.deviceId, reason: x.reason } }], { session: tx });
    return ev.toObject();
  }
}
