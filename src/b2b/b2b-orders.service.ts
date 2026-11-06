/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { pageOf } from '../common/paging';
import { OrdersService } from '../orders/orders.service';
import { outstandingBalance, paymentStatusOf, round2, validateInstallment } from './b2b-pricing.util';
import { notifyB2BOrderChanged, receivableOf } from './b2b-order.util';

const isOid = (v: any) => typeof v === 'string' && Types.ObjectId.isValid(v);
const DEAD = ['cancelled', 'refunded'];
const csvCell = (v: any) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Seller-side wholesale receivables: company orders, installments recorded by the seller, outstanding report. Records only: no money moves through Solvexo. */
@Injectable()
export class B2BOrdersService {
  private readonly log = new Logger(B2BOrdersService.name);
  constructor(private readonly db: DatabaseService, private readonly activity: ActivityLogService, private readonly moduleRef: ModuleRef) {}

  private get orders() { return this.db.repositories.orderModel as any; }

  private audit(storeId: string, actor: { id: string; role: string }, action: string, description: string, targetId: string) {
    return this.activity.log({ storeId, category: 'b2b', action, description, actorId: actor.id, actorRole: actor.role, targetId, targetType: 'order' } as any).catch(() => undefined);
  }

  async listOrders(storeId: string, q: { page?: any; limit?: any; companyId?: string; status?: string; overdue?: string }) {
    const { page, limit, skip } = pageOf(q.page, q.limit);
    const filter: any = { isDelete: false, 'sellerOrders.storeId': storeId, 'b2b.companyId': { $exists: true, $ne: null } };
    if (q.companyId) { if (!isOid(q.companyId)) throw new BadRequestException('Invalid company'); filter['b2b.companyId'] = q.companyId; }
    if (q.status && ['unpaid', 'partial', 'paid'].includes(q.status)) { filter['b2b.terms'] = { $ne: null }; filter['b2b.status'] = q.status; }
    if (q.overdue === 'true') { filter['b2b.terms'] = { $ne: null }; filter['b2b.status'] = { $ne: 'paid' }; filter['b2b.dueDate'] = { $lt: new Date() }; filter.orderStatus = { $nin: DEAD }; }
    const [rows, total] = await Promise.all([
      this.orders.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('orderNumber createdAt orderStatus isPaid paymentType totalAmount currency b2b updatedAt').lean(),
      this.orders.countDocuments(filter),
    ]);
    return { items: rows.map((o: any) => ({ ...o, receivable: receivableOf(o) })), total, page, limit };
  }

  private async findOrder(storeId: string, orderId: string) {
    if (!isOid(orderId)) throw new NotFoundException('Order not found');
    const o = await this.orders.findOne({ _id: orderId, isDelete: false, 'sellerOrders.storeId': storeId, 'b2b.terms': { $ne: null } }).lean();
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  /** Records one installment. The overpayment guard is part of the atomic update, so two parallel requests can never pay more than is owed. */
  async recordPayment(storeId: string, sellerId: string, actor: { id: string; role: string }, orderId: string, body: any) {
    const order: any = await this.findOrder(storeId, orderId);
    if (DEAD.includes(order.orderStatus)) throw new BadRequestException('A cancelled or refunded order cannot receive payments');
    const amount = typeof body?.amount === 'number' ? round2(body.amount) : NaN;
    const live = (order.b2b.payments ?? []).filter((p: any) => !p.voided);
    const err = validateInstallment(amount, order.b2b.total, live);
    if (err) throw new BadRequestException(err);
    const method = typeof body?.method === 'string' && body.method.trim() ? body.method.trim().slice(0, 40) : null;
    if (!method) throw new BadRequestException('Payment method is required (e.g. bank transfer, cash, cheque)');
    const date = body?.date ? new Date(body.date) : new Date();
    if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 86_400_000) throw new BadRequestException('Invalid payment date');
    const payment = { _id: new Types.ObjectId(), amount, method, reference: typeof body?.reference === 'string' ? body.reference.trim().slice(0, 100) || null : null, date, recordedBy: actor.id, voided: false };

    const res = await this.orders.updateOne(
      { _id: orderId, 'b2b.terms': { $ne: null }, orderStatus: { $nin: DEAD }, 'b2b.paidTotal': { $lte: round2(order.b2b.total - amount) + 0.004 } },
      { $push: { 'b2b.payments': payment }, $inc: { 'b2b.paidTotal': amount } },
    );
    if (res.modifiedCount === 0) throw new ConflictException('The order balance changed while you were saving. Refresh and try again.');
    const status = await this.syncStatus(orderId);
    await notifyB2BOrderChanged(orderId);
    await this.audit(storeId, actor, 'b2b_payment_recorded', `${amount} ${order.currency} recorded (${method}) on order ${order.orderNumber}`, orderId);

    let markedPaid = false; let markError: string | undefined;
    if (status === 'paid' && !order.isPaid) {
      try {
        await this.moduleRef.get(OrdersService, { strict: false }).markPaid(sellerId, storeId, orderId, { actorId: actor.id, actorRole: actor.role === 'staff' ? 'staff' : 'seller' });
        markedPaid = true;
      } catch (e: any) { markError = e?.message; this.log.warn(`Order ${orderId} fully paid but markPaid failed: ${e?.message}`); }
    }
    return { payment, status, markedPaid, markError };
  }

  async voidPayment(storeId: string, actor: { id: string; role: string }, orderId: string, paymentId: string) {
    const order: any = await this.findOrder(storeId, orderId);
    if (!isOid(paymentId)) throw new NotFoundException('Payment not found');
    if (order.isPaid) throw new BadRequestException('This order is already marked paid. Refund it from the order instead of voiding a payment.');
    const p = (order.b2b.payments ?? []).find((x: any) => String(x._id) === paymentId && !x.voided);
    if (!p) throw new NotFoundException('Payment not found or already voided');
    const res = await this.orders.updateOne(
      { _id: orderId, isPaid: false, 'b2b.payments': { $elemMatch: { _id: new Types.ObjectId(paymentId), voided: { $ne: true } } } },
      { $set: { 'b2b.payments.$.voided': true }, $inc: { 'b2b.paidTotal': -p.amount } },
    );
    if (res.modifiedCount === 0) throw new ConflictException('Payment was already voided');
    const status = await this.syncStatus(orderId);
    await notifyB2BOrderChanged(orderId);
    await this.audit(storeId, actor, 'b2b_payment_voided', `Payment of ${p.amount} voided on order ${order.orderNumber}`, orderId);
    return { status };
  }

  private async syncStatus(orderId: string) {
    const o: any = await this.orders.findById(orderId).select('b2b').lean();
    const live = (o.b2b.payments ?? []).filter((p: any) => !p.voided);
    const status = paymentStatusOf(o.b2b.total, live);
    await this.orders.updateOne({ _id: orderId }, { $set: { 'b2b.status': status, 'b2b.paidTotal': round2(live.reduce((s: number, p: any) => s + p.amount, 0)) } });
    return status;
  }

  /** What each company owes (per currency) with the overdue part. `csv: true` returns a spreadsheet-safe CSV string. */
  async outstandingReport(storeId: string, opts: { csv?: boolean } = {}) {
    const rows: any[] = await this.orders.aggregate([
      { $match: { isDelete: false, 'sellerOrders.storeId': storeId, 'b2b.terms': { $ne: null }, 'b2b.status': { $ne: 'paid' }, orderStatus: { $nin: DEAD } } },
      { $addFields: { owed: { $subtract: ['$b2b.total', { $ifNull: ['$b2b.paidTotal', 0] }] }, isOverdue: { $and: [{ $ne: ['$b2b.dueDate', null] }, { $lt: ['$b2b.dueDate', '$$NOW'] }] } } },
      { $group: { _id: { companyId: '$b2b.companyId', currency: '$currency' }, companyName: { $first: '$b2b.companyName' }, orders: { $sum: 1 }, outstanding: { $sum: '$owed' },
          overdue: { $sum: { $cond: ['$isOverdue', '$owed', 0] } }, oldestDue: { $min: '$b2b.dueDate' } } },
      { $sort: { outstanding: -1 } },
      { $limit: 1000 },
    ]);
    const items = rows.map((r) => ({ companyId: r._id.companyId, companyName: r.companyName, currency: r._id.currency, orders: r.orders, outstanding: round2(r.outstanding), overdue: round2(r.overdue), oldestDue: r.oldestDue }));
    if (!opts.csv) return { items };
    const head = ['Company', 'Currency', 'Open orders', 'Outstanding', 'Overdue', 'Oldest due date'];
    const lines = items.map((i) => [i.companyName, i.currency, i.orders, i.outstanding, i.overdue, i.oldestDue ? new Date(i.oldestDue).toISOString().slice(0, 10) : ''].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // exported for tests
  static outstanding(total: number, payments: any[]) { return outstandingBalance(total, payments); }
}
