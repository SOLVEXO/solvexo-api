/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { pageOf } from '../common/paging';
import {
  B2BApplication, B2BApplicationDocument, B2BBuyer, B2BBuyerDocument, B2BCatalog, B2BCatalogDocument, B2BCatalogItem, B2BCatalogItemDocument,
  B2BCompany, B2BCompanyDocument, B2BLocation, B2BLocationDocument,
} from './b2b.schema';
import { BUYER_ROLES, validatePaymentTerms, validatePriceBreaks, validateQuantityRuleDefinition } from './b2b-pricing.util';

const isOid = (v: any) => typeof v === 'string' && Types.ObjectId.isValid(v);
/** Whitelists: client objects never reach a Mongo filter or `$set` as-is. */
const pick = <T extends object>(src: any, keys: (keyof T)[]): Partial<T> => { const out: any = {}; for (const k of keys) if (src && src[k] !== undefined) out[k] = src[k]; return out; };
const str = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : v === null ? null : undefined);
const numOrNull = (v: any) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Seller-side B2B administration: companies, locations, buyers, catalogs, wholesale applications. Every query is pinned to `storeId`. */
@Injectable()
export class B2BAdminService {
  constructor(
    @InjectModel(B2BCompany.name) private readonly companies: Model<B2BCompanyDocument>,
    @InjectModel(B2BLocation.name) private readonly locations: Model<B2BLocationDocument>,
    @InjectModel(B2BBuyer.name) private readonly buyers: Model<B2BBuyerDocument>,
    @InjectModel(B2BApplication.name) private readonly applications: Model<B2BApplicationDocument>,
    @InjectModel(B2BCatalog.name) private readonly catalogs: Model<B2BCatalogDocument>,
    @InjectModel(B2BCatalogItem.name) private readonly items: Model<B2BCatalogItemDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private audit(storeId: string, actor: { id: string; role: string }, action: string, description: string, targetId?: string, targetType = 'b2b') {
    return this.activity.log({ storeId, category: 'b2b', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType } as any).catch(() => undefined);
  }

  // ── companies ─────────────────────────────────────────────────────────────
  private companyInput(body: any, partial = false) {
    const data: any = pick<B2BCompany>(body, ['name', 'taxId', 'taxExempt', 'catalogId', 'paymentTerms', 'allowedPaymentMethods', 'creditLimit', 'depositPercent', 'note', 'status']);
    if (data.name !== undefined) { data.name = str(data.name, 120); if (!data.name) throw new BadRequestException('Company name is required'); }
    else if (!partial) throw new BadRequestException('Company name is required');
    if (data.status !== undefined && !['pending', 'approved', 'rejected', 'suspended'].includes(data.status)) throw new BadRequestException('Unknown status');
    if (data.taxId !== undefined) data.taxId = str(data.taxId, 60);
    if (data.note !== undefined) data.note = str(data.note, 500);
    if (data.taxExempt !== undefined) data.taxExempt = data.taxExempt === true;
    if (data.paymentTerms) { data.paymentTerms = pick<any>(data.paymentTerms, ['type', 'netDays']); const e = validatePaymentTerms(data.paymentTerms); if (e) throw new BadRequestException(e); }
    if (data.allowedPaymentMethods !== undefined) {
      if (!Array.isArray(data.allowedPaymentMethods) || data.allowedPaymentMethods.some((m: any) => typeof m !== 'string' || m.length > 60)) throw new BadRequestException('Invalid payment methods');
      data.allowedPaymentMethods = [...new Set(data.allowedPaymentMethods as string[])].slice(0, 20);
    }
    if (data.creditLimit !== undefined) { const n = numOrNull(data.creditLimit); if (n === undefined || (n !== null && n < 0)) throw new BadRequestException('Invalid credit limit'); data.creditLimit = n; }
    if (data.depositPercent !== undefined && !(typeof data.depositPercent === 'number' && data.depositPercent >= 0 && data.depositPercent <= 100)) throw new BadRequestException('Deposit must be 0-100');
    if (data.catalogId) data.catalogId = String(data.catalogId);
    return data;
  }

  private async assertCatalog(storeId: string, catalogId?: string | null) {
    if (!catalogId) return;
    if (!isOid(catalogId) || !(await this.catalogs.exists({ _id: catalogId, storeId, isDelete: false }))) throw new BadRequestException('Catalog not found in this store');
  }

  async listCompanies(storeId: string, q: { page?: any; limit?: any; status?: string; search?: string }) {
    const { page, limit, skip } = pageOf(q.page, q.limit);
    const filter: any = { storeId, isDelete: false };
    if (typeof q.status === 'string' && ['pending', 'approved', 'rejected', 'suspended'].includes(q.status)) filter.status = q.status;
    if (typeof q.search === 'string' && q.search.trim()) filter.name = { $regex: q.search.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [rows, total] = await Promise.all([this.companies.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), this.companies.countDocuments(filter)]);
    return { items: rows, total, page, limit };
  }

  async getCompany(storeId: string, id: string) {
    const company = await this.findCompany(storeId, id);
    const [locations, buyers] = await Promise.all([
      this.locations.find({ storeId, companyId: id, isDelete: false }).lean(),
      this.buyers.find({ storeId, companyId: id }).lean(),
    ]);
    return { company, locations, buyers };
  }

  private async findCompany(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Company not found');
    const c = await this.companies.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!c) throw new NotFoundException('Company not found');
    return c;
  }

  async createCompany(storeId: string, actor: { id: string; role: string }, body: any) {
    const data = this.companyInput(body);
    await this.assertCatalog(storeId, data.catalogId);
    try {
      const c = await this.companies.create({ ...data, storeId, status: data.status ?? 'approved' });
      await this.locations.create({ storeId, companyId: String(c._id), name: 'Main location' });
      await this.audit(storeId, actor, 'b2b_company_created', `Company "${c.name}" created`, String(c._id), 'b2b_company');
      return c.toObject();
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('A company with this name already exists');
      throw e;
    }
  }

  async updateCompany(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    await this.findCompany(storeId, id);
    const data = this.companyInput(body, true);
    await this.assertCatalog(storeId, data.catalogId);
    try {
      const c = await this.companies.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: data }, { new: true }).lean();
      await this.audit(storeId, actor, 'b2b_company_updated', `Company "${(c as any)?.name}" updated (${Object.keys(data).join(', ')})`, id, 'b2b_company');
      return c;
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('A company with this name already exists');
      throw e;
    }
  }

  async deleteCompany(storeId: string, actor: { id: string; role: string }, id: string) {
    await this.findCompany(storeId, id);
    await this.companies.updateOne({ _id: id, storeId }, { $set: { isDelete: true } });
    await this.locations.updateMany({ storeId, companyId: id }, { $set: { isDelete: true } });
    await this.buyers.deleteMany({ storeId, companyId: id });
    await this.audit(storeId, actor, 'b2b_company_deleted', 'Company deleted', id, 'b2b_company');
    return { success: true };
  }

  // ── locations ─────────────────────────────────────────────────────────────
  async createLocation(storeId: string, actor: { id: string; role: string }, companyId: string, body: any) {
    await this.findCompany(storeId, companyId);
    const data: any = pick<B2BLocation>(body, ['name', 'shippingAddress', 'billingAddress', 'catalogId', 'paymentTerms', 'allowedPaymentMethods', 'creditLimit']);
    data.name = str(data.name, 120);
    if (!data.name) throw new BadRequestException('Location name is required');
    this.locationOverrides(data);
    await this.assertCatalog(storeId, data.catalogId);
    const l = await this.locations.create({ ...data, storeId, companyId });
    await this.audit(storeId, actor, 'b2b_location_created', `Location "${data.name}" added`, String(l._id), 'b2b_location');
    return l.toObject();
  }

  async updateLocation(storeId: string, actor: { id: string; role: string }, locationId: string, body: any) {
    const loc = await this.findLocation(storeId, locationId);
    const data: any = pick<B2BLocation>(body, ['name', 'shippingAddress', 'billingAddress', 'catalogId', 'paymentTerms', 'allowedPaymentMethods', 'creditLimit']);
    if (data.name !== undefined) { data.name = str(data.name, 120); if (!data.name) throw new BadRequestException('Location name is required'); }
    this.locationOverrides(data);
    await this.assertCatalog(storeId, data.catalogId);
    const l = await this.locations.findOneAndUpdate({ _id: locationId, storeId, isDelete: false }, { $set: data }, { new: true }).lean();
    await this.audit(storeId, actor, 'b2b_location_updated', `Location "${(loc as any).name}" updated`, locationId, 'b2b_location');
    return l;
  }

  private locationOverrides(data: any) {
    for (const k of ['shippingAddress', 'billingAddress']) if (data[k]) data[k] = pick<any>(data[k], ['recipientName', 'phoneNumber', 'addressLine1', 'addressLine2', 'city', 'state', 'zipCode', 'country']);
    if (data.paymentTerms) { data.paymentTerms = pick<any>(data.paymentTerms, ['type', 'netDays']); const e = validatePaymentTerms(data.paymentTerms); if (e) throw new BadRequestException(e); }
    if (data.allowedPaymentMethods !== undefined) {
      if (!Array.isArray(data.allowedPaymentMethods) || data.allowedPaymentMethods.some((m: any) => typeof m !== 'string' || m.length > 60)) throw new BadRequestException('Invalid payment methods');
      data.allowedPaymentMethods = [...new Set(data.allowedPaymentMethods as string[])].slice(0, 20);
    }
    if (data.creditLimit !== undefined) { const n = numOrNull(data.creditLimit); if (n === undefined || (n !== null && n < 0)) throw new BadRequestException('Invalid credit limit'); data.creditLimit = n; }
    if (data.catalogId) data.catalogId = String(data.catalogId);
  }

  private async findLocation(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Location not found');
    const l = await this.locations.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!l) throw new NotFoundException('Location not found');
    return l;
  }

  async deleteLocation(storeId: string, actor: { id: string; role: string }, locationId: string) {
    const loc: any = await this.findLocation(storeId, locationId);
    const remaining = await this.locations.countDocuments({ storeId, companyId: loc.companyId, isDelete: false });
    if (remaining <= 1) throw new BadRequestException('A company needs at least one location');
    if (await this.buyers.exists({ storeId, locationId })) throw new BadRequestException('Move or remove this location\'s buyers first');
    await this.locations.updateOne({ _id: locationId, storeId }, { $set: { isDelete: true } });
    await this.audit(storeId, actor, 'b2b_location_deleted', `Location "${loc.name}" deleted`, locationId, 'b2b_location');
    return { success: true };
  }

  // ── buyers ────────────────────────────────────────────────────────────────
  /** Links an existing customer of THIS store (by email) to a company location. */
  async addBuyer(storeId: string, actor: { id: string; role: string }, locationId: string, body: any) {
    const loc: any = await this.findLocation(storeId, locationId);
    const email = str(body?.email, 200)?.toLowerCase();
    const role = body?.role ?? 'ordering';
    if (!email) throw new BadRequestException('Customer email is required');
    if (!(BUYER_ROLES as readonly string[]).includes(role)) throw new BadRequestException('Unknown buyer role');
    const user: any = await (this.db.repositories.userModel as any).findOne({ storeId, email, isDelete: { $ne: true } }).select('_id email').lean();
    if (!user) throw new NotFoundException('No customer with this email in this store. They must register on the storefront first.');
    try {
      const b = await this.buyers.create({ storeId, companyId: loc.companyId, locationId, userId: String(user._id), email, role });
      await this.tagB2B(storeId, String(user._id));
      await this.audit(storeId, actor, 'b2b_buyer_added', `${email} added as ${role}`, String(b._id), 'b2b_buyer');
      return b.toObject();
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('This customer already belongs to a company location');
      throw e;
    }
  }

  async updateBuyer(storeId: string, actor: { id: string; role: string }, buyerId: string, body: any) {
    if (!isOid(buyerId)) throw new NotFoundException('Buyer not found');
    const data: any = pick<B2BBuyer>(body, ['role', 'status']);
    if (data.role !== undefined && !(BUYER_ROLES as readonly string[]).includes(data.role)) throw new BadRequestException('Unknown buyer role');
    if (data.status !== undefined && !['active', 'disabled'].includes(data.status)) throw new BadRequestException('Unknown status');
    const b = await this.buyers.findOneAndUpdate({ _id: buyerId, storeId }, { $set: data }, { new: true }).lean();
    if (!b) throw new NotFoundException('Buyer not found');
    await this.audit(storeId, actor, 'b2b_buyer_updated', `${(b as any).email} updated`, buyerId, 'b2b_buyer');
    return b;
  }

  async removeBuyer(storeId: string, actor: { id: string; role: string }, buyerId: string) {
    if (!isOid(buyerId)) throw new NotFoundException('Buyer not found');
    const b: any = await this.buyers.findOneAndDelete({ _id: buyerId, storeId }).lean();
    if (!b) throw new NotFoundException('Buyer not found');
    await this.untagB2B(storeId, b.userId);
    await this.audit(storeId, actor, 'b2b_buyer_removed', `${b.email} removed`, buyerId, 'b2b_buyer');
    return { success: true };
  }

  /** Approved buyers carry the "b2b" customer tag, so segments and campaigns can target them. */
  private async tagB2B(storeId: string, userId: string) {
    await (this.db.repositories.userModel as any).updateOne({ _id: userId, storeId }, { $addToSet: { tags: 'b2b' } }).catch(() => undefined);
  }
  private async untagB2B(storeId: string, userId: string) {
    if (await this.buyers.exists({ storeId, userId })) return;
    await (this.db.repositories.userModel as any).updateOne({ _id: userId, storeId }, { $pull: { tags: 'b2b' } }).catch(() => undefined);
  }

  // ── wholesale applications ────────────────────────────────────────────────
  async listApplications(storeId: string, q: { page?: any; limit?: any; status?: string }) {
    const { page, limit, skip } = pageOf(q.page, q.limit);
    const filter: any = { storeId };
    if (typeof q.status === 'string' && ['pending', 'approved', 'rejected'].includes(q.status)) filter.status = q.status;
    const [rows, total] = await Promise.all([this.applications.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), this.applications.countDocuments(filter)]);
    return { items: rows, total, page, limit };
  }

  /** Approve: creates the company (+ main location) and links the applicant as its first location admin. Atomic claim, so a double click approves once. */
  async approveApplication(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Application not found');
    const app: any = await this.applications.findOneAndUpdate({ _id: id, storeId, status: 'pending' }, { $set: { status: 'approved', decidedAt: new Date(), decisionNote: str(body?.note, 500) ?? null } }, { new: true }).lean();
    if (!app) throw new ConflictException('Application not found or already decided');
    try {
      const catalogId = typeof body?.catalogId === 'string' && body.catalogId ? body.catalogId : null;
      await this.assertCatalog(storeId, catalogId);
      const terms = body?.paymentTerms ? pick<any>(body.paymentTerms, ['type', 'netDays']) : null;
      const termsErr = validatePaymentTerms(terms as any);
      if (termsErr) throw new BadRequestException(termsErr);
      const base = app.companyName;
      let company: any;
      for (let n = 0; !company && n < 5; n++) {
        try { company = await this.companies.create({ storeId, name: n === 0 ? base : `${base} (${n + 1})`, taxId: app.taxId, status: 'approved', catalogId, paymentTerms: terms }); }
        catch (e: any) { if (e?.code !== 11000) throw e; }
      }
      if (!company) throw new ConflictException('Could not create the company');
      const location = await this.locations.create({ storeId, companyId: String(company._id), name: 'Main location' });
      await this.buyers.create({ storeId, companyId: String(company._id), locationId: String(location._id), userId: app.userId, email: app.email, role: 'location_admin' });
      await this.tagB2B(storeId, app.userId);
      await this.applications.updateOne({ _id: id }, { $set: { companyId: String(company._id) } });
      await this.audit(storeId, actor, 'b2b_application_approved', `Wholesale application from ${app.email} approved`, id, 'b2b_application');
      await this.notifyDecision(storeId, app, 'b2b_application_approved');
      return { companyId: String(company._id) };
    } catch (e) {
      await this.applications.updateOne({ _id: id, storeId }, { $set: { status: 'pending', decidedAt: null } }).catch(() => undefined);
      throw e;
    }
  }

  async rejectApplication(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Application not found');
    const app = await this.applications.findOneAndUpdate({ _id: id, storeId, status: 'pending' }, { $set: { status: 'rejected', decidedAt: new Date(), decisionNote: str(body?.note, 500) ?? null } }, { new: true }).lean();
    if (!app) throw new ConflictException('Application not found or already decided');
    await this.audit(storeId, actor, 'b2b_application_rejected', `Wholesale application from ${(app as any).email} rejected`, id, 'b2b_application');
    await this.notifyDecision(storeId, app, 'b2b_application_rejected');
    return { success: true };
  }

  /** Tells the applicant the decision (store-branded mail, seller can switch it off). Never fails the decision itself. */
  private async notifyDecision(storeId: string, app: any, event: 'b2b_application_approved' | 'b2b_application_rejected') {
    try {
      if (!this.notifications || !app?.email) return;
      const store: any = await this.db.repositories.storeModel.findById(storeId).select('name').lean();
      const user: any = await this.db.repositories.userModel.findById(app.userId).select('name').lean();
      const note = typeof app.decisionNote === 'string' && app.decisionNote.trim() ? app.decisionNote.trim() : '';
      await this.notifications.sendCustomerEmail({
        to: app.email, storeId, event,
        vars: { storeName: store?.name ?? '', customerName: user?.name ?? '', companyName: app.companyName ?? '', decisionNote: note ? `Note from the store: ${note}` : '' },
      });
    } catch { /* a mail problem must never undo the decision */ }
  }

  // ── catalogs ──────────────────────────────────────────────────────────────
  async listCatalogs(storeId: string) {
    const rows = await this.catalogs.find({ storeId, isDelete: false }).sort({ name: 1 }).lean();
    const counts = await this.items.aggregate([{ $match: { storeId } }, { $group: { _id: '$catalogId', n: { $sum: 1 } } }]);
    const byId = new Map(counts.map((c: any) => [c._id, c.n]));
    return rows.map((c: any) => ({ ...c, itemCount: byId.get(String(c._id)) ?? 0 }));
  }

  private catalogInput(body: any, partial = false) {
    const data: any = pick<B2BCatalog>(body, ['name', 'status', 'defaultAdjustmentPercent', 'includeAllProducts']);
    if (data.name !== undefined) { data.name = str(data.name, 120); if (!data.name) throw new BadRequestException('Catalog name is required'); }
    else if (!partial) throw new BadRequestException('Catalog name is required');
    if (data.status !== undefined && !['active', 'draft'].includes(data.status)) throw new BadRequestException('Unknown status');
    if (data.defaultAdjustmentPercent !== undefined) { const n = numOrNull(data.defaultAdjustmentPercent); if (n === undefined || (n !== null && (n < -100 || n > 1000))) throw new BadRequestException('Adjustment must be between -100 and 1000'); data.defaultAdjustmentPercent = n; }
    if (data.includeAllProducts !== undefined) data.includeAllProducts = data.includeAllProducts === true;
    return data;
  }

  /** How many live wholesale catalogs the store has — checked against the plan's `maxB2BCatalogs` before a new one is created. */
  countCatalogs(storeId: string): Promise<number> {
    return this.catalogs.countDocuments({ storeId, isDelete: false });
  }

  async createCatalog(storeId: string, actor: { id: string; role: string }, body: any) {
    const data = this.catalogInput(body);
    try {
      const c = await this.catalogs.create({ ...data, storeId });
      await this.audit(storeId, actor, 'b2b_catalog_created', `Catalog "${c.name}" created`, String(c._id), 'b2b_catalog');
      return c.toObject();
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('A catalog with this name already exists');
      throw e;
    }
  }

  async updateCatalog(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Catalog not found');
    const data = this.catalogInput(body, true);
    try {
      const c = await this.catalogs.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: data }, { new: true }).lean();
      if (!c) throw new NotFoundException('Catalog not found');
      await this.audit(storeId, actor, 'b2b_catalog_updated', `Catalog "${(c as any).name}" updated`, id, 'b2b_catalog');
      return c;
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('A catalog with this name already exists');
      throw e;
    }
  }

  async deleteCatalog(storeId: string, actor: { id: string; role: string }, id: string) {
    if (!isOid(id)) throw new NotFoundException('Catalog not found');
    const inUse = (await this.companies.exists({ storeId, catalogId: id, isDelete: false })) || (await this.locations.exists({ storeId, catalogId: id, isDelete: false }));
    if (inUse) throw new BadRequestException('This catalog is assigned to a company or location. Unassign it first.');
    const r = await this.catalogs.updateOne({ _id: id, storeId, isDelete: false }, { $set: { isDelete: true } });
    if (!r.matchedCount) throw new NotFoundException('Catalog not found');
    await this.items.deleteMany({ storeId, catalogId: id });
    await this.audit(storeId, actor, 'b2b_catalog_deleted', 'Catalog deleted', id, 'b2b_catalog');
    return { success: true };
  }

  async listCatalogItems(storeId: string, catalogId: string, q: { page?: any; limit?: any }) {
    if (!isOid(catalogId)) throw new NotFoundException('Catalog not found');
    const { page, limit, skip } = pageOf(q.page, q.limit, 200);
    const filter = { storeId, catalogId };
    const [rows, total] = await Promise.all([this.items.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), this.items.countDocuments(filter)]);
    return { items: rows, total, page, limit };
  }

  /** Upserts price/availability/quantity rules for variants of THIS store. Each row is validated; a bad row rejects the whole request. */
  async upsertCatalogItems(storeId: string, actor: { id: string; role: string }, catalogId: string, rows: any) {
    if (!isOid(catalogId) || !(await this.catalogs.exists({ _id: catalogId, storeId, isDelete: false }))) throw new NotFoundException('Catalog not found');
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) throw new BadRequestException('Send between 1 and 200 rows');
    const variantIds = rows.map((r: any) => String(r?.variantId ?? ''));
    if (variantIds.some((v) => !isOid(v))) throw new BadRequestException('Invalid variant id');
    const variants: any[] = await (this.db.repositories.productVariantModel as any).find({ _id: { $in: variantIds }, storeId, isDelete: false }).select('_id productId').lean();
    const owned = new Map(variants.map((v) => [String(v._id), String(v.productId)]));
    const ops: any[] = [];
    for (const r of rows) {
      const variantId = String(r.variantId);
      if (!owned.has(variantId)) throw new BadRequestException(`Variant ${variantId} is not in this store`);
      const d: any = pick<B2BCatalogItem>(r, ['available', 'fixedPrice', 'adjustmentPercent', 'minQty', 'maxQty', 'increment', 'priceBreaks']);
      for (const k of ['fixedPrice', 'adjustmentPercent', 'minQty', 'maxQty', 'increment']) if (d[k] !== undefined) { const n = numOrNull(d[k]); if (n === undefined) throw new BadRequestException(`${k} must be a number`); d[k] = n; }
      if (d.fixedPrice != null && d.fixedPrice < 0) throw new BadRequestException('Fixed price cannot be negative');
      if (d.adjustmentPercent != null && (d.adjustmentPercent < -100 || d.adjustmentPercent > 1000)) throw new BadRequestException('Adjustment must be between -100 and 1000');
      if (d.available !== undefined) d.available = d.available === true;
      if (d.priceBreaks !== undefined) {
        if (!Array.isArray(d.priceBreaks)) throw new BadRequestException('priceBreaks must be a list');
        d.priceBreaks = d.priceBreaks.map((b: any) => ({ minQty: b?.minQty, price: b?.price }));
        const e = validatePriceBreaks(d.priceBreaks);
        if (e) throw new BadRequestException(e);
      }
      const ruleErr = validateQuantityRuleDefinition({ minQty: d.minQty, maxQty: d.maxQty, increment: d.increment });
      if (ruleErr) throw new BadRequestException(ruleErr);
      ops.push({ updateOne: { filter: { storeId, catalogId, variantId }, update: { $set: { ...d, productId: owned.get(variantId) } }, upsert: true } });
    }
    await this.items.bulkWrite(ops);
    await this.audit(storeId, actor, 'b2b_catalog_items_saved', `${rows.length} catalog item(s) saved`, catalogId, 'b2b_catalog');
    return { saved: rows.length };
  }

  async removeCatalogItem(storeId: string, actor: { id: string; role: string }, catalogId: string, variantId: string) {
    if (!isOid(catalogId) || !isOid(variantId)) throw new NotFoundException('Item not found');
    await this.items.deleteOne({ storeId, catalogId, variantId });
    await this.audit(storeId, actor, 'b2b_catalog_item_removed', 'Catalog item removed', catalogId, 'b2b_catalog');
    return { success: true };
  }
}
