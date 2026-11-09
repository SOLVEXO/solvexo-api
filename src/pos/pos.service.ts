/* eslint-disable prettier/prettier */
import {
  forwardRef,
  Inject,
  Injectable,
  Optional,
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { availableStock, AVAILABLE_STOCK_EXPR } from '@/common/stock-availability.util';
import { drainLocationStock, restoreLocationStock } from '@/common/location-stock.util';
import { ClientSession, Types } from 'mongoose';
import { Long } from 'mongodb';
import { checkMinorPairs, isoExponent, MinorMismatch } from '@/common/money-minor.util';
import { PosMinorMetrics } from './pos-minor-metrics';
import { normalizeReason } from './pos-reasons';
import { searchStoreCustomers } from '@/common/store-customer-search.util';
import { PaymentsCoreService } from '@/payments-core/payments-core.service';
import {
  allocateRefund, assertClientTotal, byTender, computeTotals, digitalRefundPlan, DiscountType, effectivePayments, exponentOf, fromMinor, isDigitalTender,
  moneyError, partialRefundAmount, roundMoney, settlePayments, tenderNets, toMinor, Totals,
} from './pos-money.util';
import { CLOCK_SKEW_MS, offlineWindowMs, parseOffline } from './pos-offline.util';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { DatabaseService } from '@/database/databaseservice';
import { formatOptionsSuffix } from '@/products/variant-options.util';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { OpenSessionDto } from './dto/open-session.dto';
import { CloseSessionDto } from './dto/close-session.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { CashAdjustmentDto } from './dto/cash-adjustment.dto';
import { RefundSaleDto } from './dto/refund-sale.dto';
import { ForceCloseSessionDto } from './dto/force-close-session.dto';

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set — refusing to sign POS employee tokens with a default secret');
  }
  return secret;
}
import { UpdateRegisterDto } from './dto/update-register.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { UpdateSaleItemsDto } from './dto/update-sale-items.dto';
import { UpdatePosSettingsDto } from './dto/update-pos-settings.dto';
import { QuoteSaleDto } from './dto/quote-sale.dto';
import { CREDIT_NOTE_PREFIX, INVOICE_PREFIX, daysBetween, formatDocNumber, lineBreakdown, returnApprovalReasons, returnLineAmounts } from './pos-documents.util';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { FinanceService } from '@/finance/finance.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { assertWithinPosPlanLimit } from '../pos-plans/pos-plan-limits.util';
import { PosTokenRevocationService } from './pos-token-revocation.service';
import { currentDeviceScope } from './pos-device-scope';
import { randomUUID } from 'crypto';

/** 409 for a *business* conflict — final, never to be retried by a client. (The idempotency
 *  "same key still running" 409 is a different, retryable code: IDEMPOTENCY_IN_PROGRESS.) */
function businessConflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, code, message });
}

/** Consecutive wrong PINs before an employee is locked out of PIN login, and for how long. */
const POS_PIN_MAX_ATTEMPTS = 5;
const POS_PIN_LOCK_MS = 15 * 60 * 1000;

@Injectable()
export class PosService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
    private readonly financeService: FinanceService,
    // optional so unit tests that build the service by hand keep working (no revocation list → nothing revoked)
    @Optional() private readonly revocations?: PosTokenRevocationService,
    // G2.3: digital (Raast QR) payments. Optional for the same reason; a sale with a QR line is refused when it is absent.
    @Optional() @Inject(forwardRef(() => PaymentsCoreService)) private readonly payments?: PaymentsCoreService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /**
   * In-person sales settle at the counter (cash / the seller's own card terminal) — the platform never holds that money, so
   * they are recorded in the finance ledger as directly-settled sales ('pos' = manual rail: no fee, no balance credit).
   * That puts POS revenue, refunds and tax in the seller's Finance page and tax reports. Never fails the sale.
   */
  private async recordPosSaleInLedger(sale: any): Promise<void> {
    try {
      const store: any = await this.r.storeModel.findById(sale.storeId).select('sellerId baseCurrency').lean();
      if (!store || !(Number(sale.total) > 0)) return;
      await this.financeService.recordSale(
        String(sale.storeId), String(store.sellerId), String(sale._id), Number(sale.total),
        `POS sale #${sale.saleNumber ?? sale._id}`, 0, null,
        String(store.baseCurrency || 'USD').toUpperCase(), 'pos', false, Number(sale.tax) || 0, true,
      );
    } catch (e: any) {
      console.error('Finance recordSale failed (POS sale):', e?.message);
    }
  }

  private async recordPosRefundInLedger(sale: any, amount: number, reason: string): Promise<void> {
    try {
      if (!(amount > 0)) return;
      const store: any = await this.r.storeModel.findById(sale.storeId).select('sellerId baseCurrency').lean();
      if (!store) return;
      await this.financeService.recordRefund(
        String(sale.storeId), String(store.sellerId), String(sale._id), amount, undefined, 'seller',
        { description: `POS ${reason} — Sale #${sale.saleNumber ?? sale._id}`, targetType: 'sale', currency: String(store.baseCurrency || 'USD').toUpperCase() },
      );
    } catch (e: any) {
      console.error('Finance recordRefund failed (POS):', e?.message);
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  async verifyStoreOwnership(storeId: string, sellerId: string) {
    // A POS device is bound to ONE store: whatever route/id it came in through, any other store is off limits.
    const scope = currentDeviceScope();
    if (scope && String(storeId) !== scope.storeId) {
      throw new ForbiddenException({ statusCode: 403, code: 'POS_DEVICE_WRONG_STORE', message: 'This device is registered to a different store' });
    }
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async assertLocationBelongsToStore(storeId: string, locationId: string | null | undefined) {
    if (!locationId) return;
    const location = await this.r.storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false });
    if (!location) throw new BadRequestException('Location not found in this store');
  }

  // Verifies the signed employee JWT minted by pinLogin (see that method) —
  // NOT the client-supplied `actingEmployeeId` string the refund/void checks
  // used to trust (spoofable: any seller-JWT holder can list every
  // employee's _id/role via GET /pos/employees/:storeId and just pass one
  // through). This is the actual employee currently PIN-logged-in on the
  // device, proven by a signature only the server could have issued.
  async verifyEmployeeToken(token: string | undefined, storeId: string, at?: Date): Promise<{ employeeId: string; role: string; jti?: string } | null> {
    if (!token) return null;
    try {
      // For an offline sale replayed later, the token may have expired since — what matters is that it was a valid,
      // signed PIN session AT THE TIME of the sale (iat ≤ sale time ≤ exp), not at sync time.
      const payload = jwt.verify(token, requireJwtSecret(), at ? { ignoreExpiration: true } : undefined) as any;
      if (at) {
        const t = at.getTime();
        if (!(payload?.iat * 1000 <= t + 5 * 60 * 1000) || !(t <= payload?.exp * 1000 + 5 * 60 * 1000)) return null;
      }
      if (payload?.type !== 'pos_employee' || payload?.storeId !== storeId) return null;
      // Server-side revocation (pin-logout / deactivation / PIN reset / lockout). For an offline replay it only counts if
      // it had already happened when the sale was made — see PosTokenRevocationService.
      if (this.revocations && (await this.revocations.isRevoked(payload, at))) return null;
      return { employeeId: payload.employeeId, role: payload.role, jti: payload.jti };
    } catch {
      return null;
    }
  }

  // Throws if there's no valid, verified, manager-role employee token — used
  // by every privileged action (refund, void, cash in/out, discounts).
  // Mandatory, unlike the old actingEmployeeId check it replaces: there is
  // no "skip the check if the field is omitted" path anymore.
  async requireManagerEmployee(token: string | undefined, storeId: string, actionLabel: string, at?: Date): Promise<{ employeeId: string; role: string }> {
    const actor = await this.verifyEmployeeToken(token, storeId, at);
    if (!actor) throw new ForbiddenException(`A valid employee PIN session is required to ${actionLabel}`);
    if (actor.role !== 'manager') throw new ForbiddenException(`Only managers can ${actionLabel}`);
    return actor;
  }

  // Atomic per-store counter — countDocuments() would race under concurrent
  // checkouts (two terminals could read the same count and mint the same
  // saleNumber); $inc via findOneAndUpdate is race-free.
  private async generateSaleNumber(storeId: string): Promise<string> {
    const settings = await this.r.posSettingsModel.findOneAndUpdate(
      { storeId },
      { $inc: { saleCounter: 1 } },
      { new: true, upsert: true },
    );
    return `POS-${String(settings.saleCounter).padStart(5, '0')}`;
  }

  // ── EMPLOYEE MANAGEMENT ───────────────────────────────────────────────────

  async addEmployee(sellerId: string, dto: CreateEmployeeDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);

    const existing = await this.r.employeeModel.findOne({
      storeId: dto.storeId,
      email: dto.email,
      isDelete: false,
    });
    if (existing) throw new BadRequestException('Employee with this email already exists in this store');

    // No plan staff-seat check here on purpose: POS employees (PIN-only, no
    // dashboard access) don't count toward the plan's staff-account limit —
    // Shopify's own rule for POS-only staff. (The plan's location limit is
    // still enforced where locations are created — StoreLocationService.)
    await this.assertLocationBelongsToStore(dto.storeId, dto.locationId);
    await assertWithinPosPlanLimit(this.r, dto.storeId, 'employees', await this.r.employeeModel.countDocuments({ storeId: dto.storeId, isDelete: false }));

    const hashedPin = await bcrypt.hash(dto.pin, 10);

    const employee = await this.r.employeeModel.create({
      storeId: dto.storeId,
      sellerId,
      name: dto.name,
      email: dto.email,
      pin: hashedPin,
      role: dto.role ?? 'cashier',
      shiftIds: dto.shiftIds ?? [],
      locationId: dto.locationId ?? null,
    });

    const { pin: _, ...safe } = (employee as any).toObject();

    this.activityLogService.log({
      storeId: dto.storeId,
      category: 'settings',
      action: 'team_member_added',
      description: `${dto.name} — ${dto.role ?? 'cashier'} role`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(employee._id),
      targetType: 'employee',
      ip,
      userAgent,
    });

    return { success: true, message: 'Employee added successfully', data: safe };
  }

  async getEmployees(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const employees = await this.r.employeeModel
      .find({ storeId, isDelete: false })
      .select('-pin')
      .lean();

    return { success: true, count: employees.length, data: employees };
  }

  async updateEmployee(sellerId: string, employeeId: string, dto: UpdateEmployeeDto) {
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, sellerId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');
    if (dto.locationId !== undefined) await this.assertLocationBelongsToStore(employee.storeId, dto.locationId);

    const updateData: any = { ...dto };
    if (dto.pin) {
      updateData.pin = await bcrypt.hash(dto.pin, 10);
      updateData.pinFailedAttempts = 0;
      updateData.pinLockedUntil = null;
    }

    const updated = await this.r.employeeModel
      .findByIdAndUpdate(employeeId, { $set: updateData }, { new: true })
      .select('-pin');
    if (dto.pin || (dto as any).status === 'inactive') await this.revocations?.revokeEmployee(employeeId);

    return { success: true, message: 'Employee updated successfully', data: updated };
  }

  async removeEmployee(sellerId: string, employeeId: string) {
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, sellerId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const activeSession = await this.r.registerSessionModel.findOne({ employeeId, status: 'open' });
    if (activeSession) throw new BadRequestException('Employee has an open session — close it first');

    await this.r.employeeModel.findByIdAndUpdate(employeeId, { isDelete: true, status: 'inactive' });
    await this.revocations?.revokeEmployee(employeeId);
    return { success: true, message: 'Employee removed successfully' };
  }

  // ── PIN LOGIN ─────────────────────────────────────────────────────────────

  async pinLogin(
    dto: PinLoginDto,
    caller: { userId: string; role: string; storeId?: string | null; sellerId?: string | null; deviceId?: string | null },
  ) {
    // The terminal's own session (seller or staff) must belong to the store
    // whose employee PIN it is trying — otherwise any token could brute-force
    // another store's 4-digit PINs.
    if (caller.role === 'staff') {
      if (!caller.storeId || caller.storeId !== dto.storeId) throw new ForbiddenException('Store not found or unauthorized');
    } else if (caller.role === 'seller') {
      await this.verifyStoreOwnership(dto.storeId, caller.userId);
    } else {
      throw new ForbiddenException('Store not found or unauthorized');
    }

    // Per-DEVICE guess limiter (owner/staff sessions are keyed by account): the per-employee lockout below stops one
    // account being ground down, this stops a terminal cycling through every employee and PIN.
    const rlKey = `${caller.deviceId ? `dev:${caller.deviceId}` : `acct:${caller.userId}`}:${dto.storeId}`;
    const retryAfter = (await this.revocations?.pinRetryAfter(rlKey)) ?? 0;
    if (retryAfter > 0) {
      throw new HttpException({ statusCode: 429, code: 'POS_PIN_RATE_LIMITED', message: 'Too many wrong PIN attempts on this device. Try again later.', retryAfterSeconds: retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const employee = await this.r.employeeModel
      .findOne({ storeId: dto.storeId, email: dto.email, isDelete: false })
      .select('+pin +pinFailedAttempts +pinLockedUntil');

    if (!employee) { await this.revocations?.notePinFailure(rlKey); throw new BadRequestException('Invalid credentials'); }
    if (employee.status === 'inactive') throw new BadRequestException('Employee account is inactive');

    const lockedUntil: Date | null = (employee as any).pinLockedUntil ?? null;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
      throw new BadRequestException(`Too many failed PIN attempts. Try again in ${minutes} minute(s), or ask the store owner to reset the PIN.`);
    }

    const isPinValid = await bcrypt.compare(dto.pin, employee.pin);
    if (!isPinValid) {
      await this.revocations?.notePinFailure(rlKey);
      // Atomic so parallel guesses can't slip past the counter.
      const after: any = await this.r.employeeModel
        .findOneAndUpdate({ _id: employee._id }, { $inc: { pinFailedAttempts: 1 } }, { new: true })
        .select('+pinFailedAttempts')
        .lean();
      if ((after?.pinFailedAttempts ?? 0) >= POS_PIN_MAX_ATTEMPTS) {
        await this.r.employeeModel.updateOne(
          { _id: employee._id },
          { $set: { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + POS_PIN_LOCK_MS) } },
        );
        // A locked-out employee must not be able to keep working on a session opened before the lock.
        await this.revocations?.revokeEmployee(String(employee._id));
        await this.writeAuditLog({ storeId: dto.storeId, employeeId: String(employee._id), action: 'pin_locked', targetId: String(employee._id), targetType: 'employee' });
      }
      throw new BadRequestException('Invalid credentials');
    }

    if (((employee as any).pinFailedAttempts ?? 0) > 0 || lockedUntil) {
      await this.r.employeeModel.updateOne({ _id: employee._id }, { $set: { pinFailedAttempts: 0, pinLockedUntil: null } });
    }

    const activeSession = await this.r.registerSessionModel
      .findOne({ storeId: dto.storeId, employeeId: String(employee._id), status: 'open' })
      .lean();

    const { pin: _, ...safe } = (employee as any).toObject();

    const employeeToken = jwt.sign(
      {
        employeeId: String(employee._id),
        storeId: dto.storeId,
        sellerId: String((employee as any).sellerId),
        role: employee.role,
        type: 'pos_employee',
        iatMs: Date.now(), // millisecond issue time: lets a revocation made in the same second still tell old tokens from new
      },
      requireJwtSecret(),
      { expiresIn: '12h', jwtid: randomUUID() },
    );
    await this.revocations?.clearPinFailures(rlKey);

    await this.writeAuditLog({ storeId: dto.storeId, employeeId: String(employee._id), action: 'pin_login', targetId: String(employee._id), targetType: 'employee' });

    return {
      success: true,
      message: 'PIN login successful',
      data: { employee: safe, activeSession: activeSession ?? null, employeeToken },
    };
  }

  // Best-effort — logs the event, doesn't hard-fail on a missing/expired
  // token (the client is ending the session either way). Real token
  // revocation (a blocklist) would be needed to actually invalidate the JWT
  // early; not built here — the 12h expiry is the bound until then.
  async pinLogout(sellerId: string, storeId: string, employeeToken: string | undefined) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const actor = await this.verifyEmployeeToken(employeeToken, storeId);
    if (actor) {
      await this.revocations?.revokeToken(actor.jti); // the 12h token stops working server-side, not just on this device
      await this.writeAuditLog({ storeId, employeeId: actor.employeeId, action: 'pin_logout', targetId: actor.employeeId, targetType: 'employee' });
    }
    return { success: true, message: 'Logged out' };
  }

  // ── REGISTER & SHIFT MANAGEMENT ───────────────────────────────────────────

  async addRegister(sellerId: string, storeId: string, body: { name: string; defaultFloatCash?: number; locationId?: string }) {
    if (!body.name) throw new BadRequestException('Register name is required');
    await this.verifyStoreOwnership(storeId, sellerId);
    await this.assertLocationBelongsToStore(storeId, body.locationId);
    const store: any = await this.r.storeModel.findById(storeId).select('registers').lean();
    await assertWithinPosPlanLimit(this.r, storeId, 'registers', (store?.registers ?? []).filter((x: any) => x.status !== 'inactive').length);

    const regExp = isoExponent(store?.baseCurrency ?? (await this.r.storeModel.findById(storeId).select('baseCurrency').lean() as any)?.baseCurrency);
    const floatCash = body.defaultFloatCash ?? 100;
    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { registers: { name: body.name, defaultFloatCash: floatCash, defaultFloatCashMinor: toMinor(floatCash, regExp), status: 'active', locationId: body.locationId ?? null } } },
      { new: true },
    );

    return { success: true, message: 'Register added', data: updated?.registers };
  }

  async removeRegister(sellerId: string, storeId: string, registerId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const openSession = await this.r.registerSessionModel.findOne({ registerId, status: 'open' });
    if (openSession) throw new BadRequestException('Register has an open session — close it first');

    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $pull: { registers: { _id: registerId } } },
      { new: true },
    );

    return { success: true, message: 'Register removed', data: updated?.registers };
  }

  async addShift(sellerId: string, storeId: string, body: { name: string; startTime: string; endTime: string; daysOfWeek?: number[] }) {
    if (!body.name || !body.startTime || !body.endTime) {
      throw new BadRequestException('name, startTime and endTime are required');
    }
    await this.verifyStoreOwnership(storeId, sellerId);

    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { shifts: { name: body.name, startTime: body.startTime, endTime: body.endTime, daysOfWeek: body.daysOfWeek ?? [1, 2, 3, 4, 5], status: 'active' } } },
      { new: true },
    );

    return { success: true, message: 'Shift added', data: updated?.shifts };
  }

  // Deletion is handled by deleteShift() below.

  // ── PRODUCT SEARCH / BROWSE FOR POS ──────────────────────────────────────

  async searchProducts(sellerId: string, storeId: string, q: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    if (!q || q.trim().length < 1) throw new BadRequestException('Search query is required');

    const products = await this.r.productModel
      .find({
        storeId,
        sellerId,
        isDelete: false,
        status: 'active',
        $or: [
          { name: { $regex: q, $options: 'i' } },
        ],
      })
      .select('_id name type gallery coverImages')
      .limit(20)
      .lean();

    const productIds = products.map((p: any) => p._id.toString());

    // also search by SKU across variants
    const variantsBySkuRaw = await this.r.productVariantModel
      .find({
        storeId: undefined,  // variants don't store storeId, filter by productId
        isDelete: false,
        status: 'active',
        productId: { $in: productIds },
        sku: { $regex: q, $options: 'i' },
      })
      .lean();

    const allVariants = await this.r.productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false, status: 'active' })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    // include products that matched by SKU even if name didn't match
    const skuMatchedProductIds = new Set(variantsBySkuRaw.map((v: any) => v.productId));
    const extraProducts = skuMatchedProductIds.size > 0
      ? await this.r.productModel
          .find({ _id: { $in: [...skuMatchedProductIds] }, isDelete: false, status: 'active' })
          .select('_id name type gallery coverImages')
          .lean()
      : [];

    const allProducts = [
      ...products,
      ...extraProducts.filter((ep: any) => !productIds.includes(ep._id.toString())),
    ];

    const result = allProducts.map((p: any) => ({
      productId: p._id,
      name: p.name,
      type: p.type,
      image: p.gallery?.[0] ?? p.coverImages?.[0] ?? null,
      variants: (variantMap[p._id.toString()] || []).map((v: any) => ({
        variantId: v._id,
        sku: v.sku,
        barcode: v.barcode ?? null, // lets the till find a scanned item in its own catalogue (no round trip)
        hsCode: v.hsCode ?? null,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        stock: v.stock,
        unlimitedStock: v.unlimitedStock === true,
        options: v.options,
        isDefault: v.isDefault,
        images: v.images,
      })),
    }));

    return { success: true, count: result.length, data: result };
  }

  async getPosProducts(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 30;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, sellerId, isDelete: false, status: 'active', type: 'physical' };
    if (query.categoryId) filter.categoryId = query.categoryId;

    const total = await this.r.productModel.countDocuments(filter);
    const products = await this.r.productModel
      .find(filter)
      .select('_id name type gallery coverImages categoryId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await this.r.productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false, status: 'active' })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const result = products.map((p: any) => ({
      productId: p._id,
      name: p.name,
      type: p.type,
      image: p.gallery?.[0] ?? p.coverImages?.[0] ?? null,
      categoryId: p.categoryId,
      variants: (variantMap[p._id.toString()] || []).map((v: any) => ({
        variantId: v._id,
        sku: v.sku,
        barcode: v.barcode ?? null, // lets the till find a scanned item in its own catalogue (no round trip)
        hsCode: v.hsCode ?? null,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        stock: v.stock,
        unlimitedStock: v.unlimitedStock === true,
        options: v.options,
        isDefault: v.isDefault,
        images: v.images,
      })),
    }));

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        products: result,
      },
    };
  }

  // ── REGISTER SESSIONS ─────────────────────────────────────────────────────

  async openSession(sellerId: string, dto: OpenSessionDto) {
    const store = await this.verifyStoreOwnership(dto.storeId, sellerId);

    const register = store.registers.find((r: any) => r._id.toString() === dto.registerId);
    if (!register) throw new BadRequestException('Register not found in this store');

    const employee = await this.r.employeeModel.findOne({ _id: dto.employeeId, storeId: dto.storeId, isDelete: false });
    if (!employee) throw new BadRequestException('Employee not found in this store');

    const existingOpen = await this.r.registerSessionModel.findOne({ registerId: dto.registerId, status: 'open' });
    if (existingOpen) {
      const holdingEmployee = await this.r.employeeModel.findById((existingOpen as any).employeeId).select('name').lean();
      const holder = holdingEmployee ? (holdingEmployee as any).name : 'another employee';
      throw new BadRequestException(`Register already has an open session (held by ${holder})`);
    }

    // The check above gives a friendly message; the unique partial index on (registerId, status:'open')
    // is what actually guarantees one open session per register when two terminals open at once.
    const sessionMoney = await this.moneyContext(dto.storeId);
    let session: any;
    try {
      session = await this.r.registerSessionModel.create({
        storeId: dto.storeId,
        registerId: dto.registerId,
        currency: sessionMoney.currency,
        currencyExponent: sessionMoney.exp,
        locationId: (register as any).locationId ?? null,
        employeeId: dto.employeeId,
        shiftId: dto.shiftId ?? null,
        openedAt: new Date(),
        openingCash: roundMoney(dto.openingCash, sessionMoney.exp),
        openingCashMinor: toMinor(dto.openingCash, sessionMoney.exp),
        // counters start at 0 in both forms
        cashSalesMinor: 0, cardSalesMinor: 0, otherSalesMinor: 0, digitalSalesMinor: 0, totalSalesMinor: 0, totalRefundsMinor: 0,
        status: 'open',
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new BadRequestException('Register already has an open session');
      throw err;
    }

    await this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: 'session_opened', targetId: String(session._id), targetType: 'session', metadata: { registerId: dto.registerId, openingCash: dto.openingCash } });

    return { success: true, message: 'Register session opened', data: session };
  }

  async closeSession(sellerId: string, dto: CloseSessionDto, employeeToken?: string) {
    const session = await this.r.registerSessionModel.findOne({ _id: dto.sessionId, status: 'open' });
    if (!session) throw new NotFoundException('Open session not found');

    await this.verifyStoreOwnership((session as any).storeId, sellerId);

    // factor in cash adjustments
    const adjustments = (session as any).cashAdjustments || [];
    const cashIn = adjustments.filter((a: any) => a.type === 'cash_in').reduce((s: number, a: any) => s + a.amount, 0);
    const cashOut = adjustments.filter((a: any) => a.type === 'cash_out').reduce((s: number, a: any) => s + a.amount, 0);

    const { exp: closeExp } = await this.docMoney(session);
    const expectedCash = roundMoney(session.openingCash + session.cashSales + cashIn - cashOut, closeExp);
    const closingCash = roundMoney(dto.closingCash, closeExp);
    const cashDifference = roundMoney(closingCash - expectedCash, closeExp);
    const expectedCashMinor = toMinor(expectedCash, closeExp);
    const closingCashMinor = toMinor(closingCash, closeExp);

    // Card reconciliation (D2): card payments are only RECORDED by the cashier, so at close the cashier enters the card total
    // printed on the terminal's settlement slip. Server compares it with the card total the till recorded (net of refunds).
    // No slip total (old app build / skipped) → closes exactly as before, marked "not reconciled". A DIFFERENCE needs a manager
    // PIN session and is audit-logged; nothing is closed without it.
    const expectedCard = roundMoney((session as any).cardSales || 0, closeExp);
    const expectedCardMinor = toMinor(expectedCard, closeExp);
    let cardRecon: any = { status: 'not_reconciled', slipTotal: null, expectedCard, expectedCardMinor, variance: null, approvedBy: null, approvedAt: null };
    let varianceApprover: { employeeId: string; role: string } | null = null;
    if (dto.cardTotalFromSlip !== undefined && dto.cardTotalFromSlip !== null) {
      const slipTotal = roundMoney(dto.cardTotalFromSlip, closeExp);
      const variance = roundMoney(slipTotal - expectedCard, closeExp);
      if (variance === 0) {
        cardRecon = { status: 'matched', slipTotal, expectedCard, slipTotalMinor: toMinor(slipTotal, closeExp), expectedCardMinor, variance: 0, varianceMinor: 0, approvedBy: null, approvedAt: null };
      } else {
        varianceApprover = await this.verifyEmployeeToken(employeeToken, (session as any).storeId);
        if (!varianceApprover || varianceApprover.role !== 'manager') {
          throw new ForbiddenException({
            statusCode: 403, code: 'CARD_VARIANCE_APPROVAL_REQUIRED',
            message: 'The card total on the slip differs from the card total recorded at the till — a manager must approve closing the shift with this difference',
            slipTotal, expectedCard, variance,
          });
        }
        cardRecon = { status: 'variance_approved', slipTotal, expectedCard, slipTotalMinor: toMinor(slipTotal, closeExp), expectedCardMinor, variance, varianceMinor: toMinor(slipTotal, closeExp) - expectedCardMinor, approvedBy: varianceApprover.employeeId, approvedAt: new Date() };
      }
    }

    // status-guarded so two close requests (retry / two terminals) can't both close and double-audit; the close, the card
    // reconciliation and its audit events commit together
    const sessCtx = { sessionId: dto.sessionId, registerId: (session as any).registerId ?? null, shiftId: (session as any).shiftId ?? null };
    const updated = await this.atomic(async (tx) => {
      const u = await this.r.registerSessionModel.findOneAndUpdate(
        { _id: dto.sessionId, status: 'open' },
        { $set: { closingCash, closingCashMinor, expectedCash, expectedCashMinor, cashDifference, cashDifferenceMinor: closingCashMinor - expectedCashMinor, closedAt: new Date(), status: 'closed', cardReconciliation: cardRecon } },
        { new: true, ...(tx ? { session: tx } : {}) },
      );
      if (!u) return null;
      await this.writeAuditLog({ storeId: (session as any).storeId, employeeId: (session as any).employeeId, action: 'session_closed', targetId: dto.sessionId, targetType: 'session', ...sessCtx, metadata: { closingCash, expectedCash, cashDifference, cardReconciliation: { status: cardRecon.status, slipTotal: cardRecon.slipTotal, expectedCard: cardRecon.expectedCard, variance: cardRecon.variance } } }, tx);
      if (varianceApprover) {
        await this.writeAuditLog({ storeId: (session as any).storeId, employeeId: varianceApprover.employeeId, action: 'card_variance_approved', targetId: dto.sessionId, targetType: 'session', ...sessCtx, metadata: { slipTotal: cardRecon.slipTotal, expectedCard: cardRecon.expectedCard, variance: cardRecon.variance, cashierId: (session as any).employeeId } }, tx);
      }
      return u;
    });
    if (!updated) throw businessConflict('SESSION_ALREADY_CLOSED', 'This session was already closed');
    await this.checkMinor('session', updated, closeExp);

    return { success: true, message: 'Register session closed', data: updated };
  }

  async getActiveSession(sellerId: string, storeId: string, registerId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!registerId) throw new BadRequestException('registerId is required');
    await this.verifyStoreOwnership(storeId, sellerId);

    const session = await this.r.registerSessionModel
      .findOne({ storeId, registerId, status: 'open' })
      .lean();

    return { success: true, data: session ?? null };
  }

  async getSessionHistory(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.registerId) filter.registerId = query.registerId;
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) { const t = new Date(query.to); t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
    }

    const total = await this.r.registerSessionModel.countDocuments(filter);
    const sessions = await this.r.registerSessionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        sessions,
      },
    };
  }

  async getSessionReport(sellerId: string, sessionId: string) {
    const session = await this.r.registerSessionModel.findById(sessionId).lean();
    if (!session) throw new NotFoundException('Session not found');

    await this.verifyStoreOwnership((session as any).storeId, sellerId);
    const { currency, exp } = await this.docMoney(session);

    // Partially refunded sales are still sales (and their tender nets already have the refund taken out).
    const sales = await this.r.saleModel.find({ sessionId, status: { $in: ['completed', 'partially_refunded'] } }).lean();
    const refunded = await this.r.saleModel.find({ sessionId, status: 'refunded' }).lean();
    const held = await this.r.saleModel.countDocuments({ sessionId, status: 'held' });

    const byPayment: Record<string, { count: number; total: number }> = {
      cash: { count: 0, total: 0 },
      card: { count: 0, total: 0 },
      other: { count: 0, total: 0 },
    };
    let splitSales = 0;
    for (const sale of sales) {
      const nets = tenderNets(sale as any, exp);
      const used = effectivePayments(sale as any);
      if (new Set(used.map((l) => l.method)).size > 1) splitSales++;
      for (const method of ['cash', 'card', 'other', 'raast_qr'] as const) {
        if (used.some((l) => l.method === method)) {
          byPayment[method] ??= { count: 0, total: 0 }; // raast_qr appears only for stores that sell with it
          byPayment[method].count++;
          byPayment[method].total = roundMoney(byPayment[method].total + nets[method], exp);
        }
      }
    }

    const adjustments = (session as any).cashAdjustments || [];
    const cashIn = adjustments.filter((a: any) => a.type === 'cash_in').reduce((s: number, a: any) => s + a.amount, 0);
    const cashOut = adjustments.filter((a: any) => a.type === 'cash_out').reduce((s: number, a: any) => s + a.amount, 0);
    const refundsTotal = roundMoney(refunded.reduce((s: number, r: any) => s + r.total, 0) + sales.reduce((s: number, r: any) => s + (r.refundedAmount || 0), 0), exp);

    return {
      success: true,
      data: {
        session,
        currency,
        currencyExponent: exp,
        summary: {
          totalSales: (session as any).totalSales,
          totalTransactions: (session as any).totalTransactions,
          completedSales: sales.length,
          heldSales: held,
          splitSales,
          customItems: this.customItemsSummary(sales, exp),
          refundsCount: refunded.length + sales.filter((r: any) => (r.refundedAmount || 0) > 0).length,
          refundsTotal,
          // G1b minor twins (from the shift's own integer counters when present, else derived from the decimals)
          totalSalesMinor: (session as any).totalSalesMinor ?? toMinor((session as any).totalSales || 0, exp),
          refundsTotalMinor: toMinor(refundsTotal, exp),
          byPaymentMethod: Object.fromEntries(Object.entries(byPayment).map(([k, v]) => [k, { ...v, totalMinor: toMinor(v.total, exp) }])), // G1b minor twin per tender
          cashFlow: {
            openingCash: (session as any).openingCash,
            cashSales: (session as any).cashSales,
            cashIn,
            cashOut,
            expectedCash: (session as any).expectedCash,
            closingCash: (session as any).closingCash ?? null,
            cashDifference: (session as any).cashDifference,
            openingCashMinor: (session as any).openingCashMinor ?? toMinor((session as any).openingCash || 0, exp),
            cashSalesMinor: (session as any).cashSalesMinor ?? toMinor((session as any).cashSales || 0, exp),
            cashInMinor: toMinor(cashIn, exp),
            cashOutMinor: toMinor(cashOut, exp),
            expectedCashMinor: (session as any).expectedCashMinor ?? toMinor((session as any).expectedCash || 0, exp),
            closingCashMinor: (session as any).closingCash === null || (session as any).closingCash === undefined ? null : ((session as any).closingCashMinor ?? toMinor((session as any).closingCash, exp)),
            cashDifferenceMinor: (session as any).cashDifferenceMinor ?? toMinor((session as any).cashDifference || 0, exp),
          },
        },
      },
    };
  }

  // ── CASH DRAWER ADJUSTMENT ────────────────────────────────────────────────

  async cashInOut(sellerId: string, sessionId: string, dto: CashAdjustmentDto, employeeToken: string | undefined) {
    const session = await this.r.registerSessionModel.findOne({ _id: sessionId, status: 'open' });
    if (!session) throw new NotFoundException('Open session not found');

    await this.verifyStoreOwnership((session as any).storeId, sellerId);

    const actor = await this.requireManagerEmployee(employeeToken, (session as any).storeId, 'record cash movements');

    const { exp: adjExp } = await this.docMoney(session);
    const adjustment = { type: dto.type, amount: roundMoney(dto.amount, adjExp), amountMinor: toMinor(dto.amount, adjExp), reason: dto.reason, employeeId: actor.employeeId, createdAt: new Date() };

    await this.atomic(async (tx) => {
      await this.r.registerSessionModel.findByIdAndUpdate(sessionId, { $push: { cashAdjustments: adjustment } }, tx ? { session: tx } : undefined);
      await this.writeAuditLog({ storeId: (session as any).storeId, employeeId: actor.employeeId, action: dto.type, targetId: sessionId, targetType: 'session', sessionId, registerId: (session as any).registerId ?? null, shiftId: (session as any).shiftId ?? null, metadata: { amount: dto.amount, reason: dto.reason } }, tx);
    });

    return {
      success: true,
      message: `Cash ${dto.type === 'cash_in' ? 'added to' : 'removed from'} drawer`,
      data: adjustment,
    };
  }

  // ── SALES ─────────────────────────────────────────────────────────────────

  /** Was `charged` a genuine price of the variant while an offline sale made at `at` was being rung up? */
  private async isGenuineOfflinePrice(variantId: string, current: number, charged: number, at: Date): Promise<boolean> {
    const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    if (same(current, charged)) return true;
    const model = (this.r as any).variantPriceHistoryModel;
    if (!model) return false;
    // A previous price was still in force at/after the sale time iff it was superseded no earlier than then.
    const rows: any[] = await model.find({ variantId, supersededAt: { $gte: new Date(at.getTime() - CLOCK_SKEW_MS) } }).select('price').lean();
    return rows.some((r) => same(Number(r.price), charged));
  }

  async createSale(sellerId: string, dto: CreateSaleDto, employeeToken: string | undefined) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);

    if (dto.idempotencyKey) {
      const existing = await this.r.saleModel.findOne({ idempotencyKey: dto.idempotencyKey, storeId: dto.storeId }).lean();
      if (existing) return { success: true, message: 'Duplicate request — returning existing sale', data: existing };
    }

    // Offline replay? Validates the device timestamp (not future, not older than the offline window).
    const off = parseOffline(dto);

    // Online: the session must be open. Offline: the sale belongs to the session that was open WHEN it was made —
    // even if that session has been closed since (checked below against its open period).
    const session = await this.r.registerSessionModel.findOne(off.isOffline ? { _id: dto.sessionId } : { _id: dto.sessionId, status: 'open' });
    if (!session) throw new BadRequestException(off.isOffline ? 'Session not found' : 'No open session found');
    // The session must belong to the store this request is entitled/authorised for — otherwise a
    // seller could sell into one store's register while the entitlement check passed for another.
    if (String((session as any).storeId) !== String(dto.storeId)) throw new BadRequestException('Session does not belong to this store');
    if (off.isOffline) {
      const opened = new Date((session as any).openedAt).getTime();
      const closed = (session as any).closedAt ? new Date((session as any).closedAt).getTime() : Infinity;
      const t = off.at.getTime();
      if (t < opened - CLOCK_SKEW_MS || t > closed + CLOCK_SKEW_MS) {
        throw moneyError('OFFLINE_SALE_OUTSIDE_SESSION', "This sale's time is outside the session it was rung up in — a manager must resolve it", {
          clientCreatedAt: off.at.toISOString(), sessionOpenedAt: (session as any).openedAt, sessionClosedAt: (session as any).closedAt ?? null,
        });
      }
    }

    const employee = await this.r.employeeModel.findOne({ _id: dto.employeeId, storeId: dto.storeId, isDelete: false });
    if (!employee) throw new BadRequestException('Employee not found');

    // A discount requires a verified manager — the mobile UI already keeps
    // cashiers from entering one; this is the server-side backstop for
    // direct API calls. See requireManagerEmployee's doc comment.
    let discountReq = this.discountSpec(dto);
    if (dto.couponCode && discountReq.value > 0) throw moneyError('COUPON_WITH_DISCOUNT', 'A coupon and a manual discount cannot be combined on one sale');
    let approver: { employeeId: string; role: string } | null = null;
    if (discountReq.value > 0) {
      approver = await this.requireManagerEmployee(employeeToken, dto.storeId, 'apply a discount', off.isOffline ? off.at : undefined);
    }
    // Offline: the approval was judged at the sale's time. If that manager has since been deactivated/removed the
    // sale still stands (money is already collected) — but it is logged so the owner can see who approved it.
    let approverGone = false;
    if (approver && off.isOffline) {
      const a: any = await this.r.employeeModel.findOne({ _id: approver.employeeId, storeId: dto.storeId }).select('status isDelete').lean();
      approverGone = !a || a.isDelete === true || a.status === 'inactive';
    }

    // resolve items — fetch variant snapshots + check stock
    const saleItems: any[] = [];
    const isHeld = dto.status === 'held';

    for (const item of dto.items) {
      if (item.isCustom) { saleItems.push(this.customLine(item, await this.defaultTaxCategory(dto.storeId))); continue; }
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);

      // Checked against `stock - committedStock` (real availability), not
      // raw `stock` — some of it may already be reserved by a paid-but-
      // unshipped online order (see ProductVariant.committedStock).
      const availableForPos = availableStock(variant as any);
      if (!isHeld && !off.isOffline && !variant.unlimitedStock && availableForPos < item.qty) {
        throw new BadRequestException(`Insufficient stock for "${variant.sku}" — available: ${availableForPos}`);
      }

      const product = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name gallery coverImages');
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);

      // Offline replay: the till collected `unitPrice`. Record THAT (money in the drawer must equal the sale) and judge it:
      // genuine = the variant's current price, or one it had since the sale was made (variant price history).
      let charged = variant.price;
      let listPrice: number | null = null;
      let priceVerified = true;
      if (off.isOffline && item.unitPrice !== undefined && item.unitPrice !== null) {
        charged = item.unitPrice;
        listPrice = variant.price;
        priceVerified = await this.isGenuineOfflinePrice(item.variantId, variant.price, item.unitPrice, off.at);
      }

      saleItems.push({
        productId: item.productId,
        variantId: item.variantId,
        name: `${product.name}${formatOptionsSuffix(variant.options)}`,
        sku: variant.sku,
        image: (product as any).gallery?.[0] ?? (product as any).coverImages?.[0] ?? null,
        price: charged,
        listPrice,
        priceVerified,
        qty: item.qty,
        hsCode: (variant as any).hsCode ?? null, // G2.5: PCT/HS code snapshot at sale time
        // G3.1 (D5): the cost at the moment of sale — the minor twin when the variant has one, else its decimal converted below (once the currency exponent is known)
        unitCostMinor: (variant as any).costPriceMinor ?? null,
        _costDecimal: (variant as any).costPrice ?? null,
        lineTotal: 0, // set below from the server-computed, exponent-rounded line totals
      });
    }

    // The SERVER prices the sale: line totals, discount, tax and total are computed here in the store
    // currency's minor units; any client-sent `tax`/totals are ignored. A client total that disagrees
    // beyond one minor unit is rejected (TOTAL_MISMATCH) rather than charging a number nobody saw.
    // The tax rate comes from the settingsVersion the device priced with (when still within the offline window).
    const money = await this.moneyContext(dto.storeId, { version: dto.settingsVersion });
    for (const it of saleItems as any[]) {
      if (it.unitCostMinor == null && it._costDecimal != null) it.unitCostMinor = toMinor(Number(it._costDecimal), money.exp);
      delete it._costDecimal;
    }
    // custom items: manager approval above the store's limit (judged as of the sale's time for an offline replay)
    const customApproval = await this.approveCustomItems(dto.storeId, saleItems, money.exp, employeeToken, off.isOffline ? off.at : undefined);
    // coupon: validated here against THIS sale's subtotal; its usage is counted inside the sale transaction
    let couponUsed: any = null;
    if (dto.couponCode && !isHeld) {
      if (off.isOffline) throw moneyError('COUPON_ONLINE_ONLY', 'A coupon needs a live check and cannot be used on an offline sale');
      const pre = computeTotals(this.taxLines(saleItems), { exp: money.exp, taxRate: money.taxRate });
      const r = await this.resolveCoupon(dto.storeId, dto.couponCode, pre.minor.subtotal, money);
      discountReq = { type: r.type, value: r.value };
      couponUsed = r.coupon;
    }
    // a held sale keeps the CODE only (no discount, no usage count); it is validated again when the sale is resumed / completed
    const heldCouponCode = dto.couponCode && isHeld ? String(dto.couponCode).trim().toUpperCase().slice(0, 40) : null;
    const totals = computeTotals(this.taxLines(saleItems), { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    const clientMismatches = this.reconcileClientMoney(dto, money.exp, totals.minor.total); // G1b: recorded, NEVER a rejection (see recordClientMismatches)
    const flags: Array<{ type: string; detail: Record<string, any> }> = [];
    const unverified = saleItems.filter((it) => it.priceVerified === false);
    if (unverified.length) {
      flags.push({ type: 'unverified_price', detail: { lines: unverified.map((it) => ({ variantId: it.variantId, sku: it.sku, charged: it.price, listPrice: it.listPrice })) } });
    }
    if (off.isOffline) {
      // Money has ALREADY changed hands on the device, so a synced offline sale is never rejected over its total.
      // If a catalog PRICE changed while the device was offline the server total differs from what was charged:
      // record it at the server's price and flag the difference for a manager (see paymentShortfall).
      if (dto.clientTotal !== undefined && Math.abs(toMinor(dto.clientTotal, totals.exp) - totals.minor.total) > 1 && !saleItems.some((it) => it.listPrice !== null)) {
        flags.push({ type: 'price_changed_while_offline', detail: { deviceTotal: dto.clientTotal, serverTotal: totals.total } });
      }
    } else {
      assertClientTotal(dto.clientTotal, totals);
    }
    saleItems.forEach((it, i) => { it.lineTotal = totals.lineTotals[i]; });
    const { subtotal, discount, tax, total } = totals;

    // Tender lines — validated against the server's total (a held sale has none yet; it is paid when completed).
    if (!isHeld && !(dto.payments?.length) && isDigitalTender(String(dto.paymentMethod))) throw moneyError('QR_REQUIRES_PAYMENT_LINES', 'A Raast QR sale must send its payment as a payment line carrying the confirmed payment (payments[].intentId)');
    if (isHeld && (dto.payments ?? []).some((p) => isDigitalTender(p.method))) throw moneyError('DIGITAL_PAYMENT_ON_HELD_SALE', 'A held sale has no payments yet; pay it when it is completed');
    let settled = isHeld
      ? null
      : settlePayments(totals.minor.total, money.exp, { payments: dto.payments, paymentMethod: dto.paymentMethod, amountTendered: dto.amountTendered, reference: dto.paymentReference }, { allowShort: off.isOffline });
    // G2.3: every digital (QR) line must point at a CONFIRMED, unused payment of this shift for exactly its amount — before stock is touched
    let digital: Array<{ intentId: string; providerRef: string }> = [];
    if (settled) {
      const v = await this.verifyDigitalLines(dto.storeId, dto.sessionId, settled.lines, money, off.isOffline);
      settled = { ...settled, lines: v.lines };
      digital = v.digital;
    }
    if (settled && settled.shortBy > 0) flags.push({ type: 'payment_shortfall', detail: { shortBy: settled.shortBy, serverTotal: total } });

    // Take the stock first (all-or-nothing, floor-guarded). A completed sale only exists once its
    // stock has genuinely been taken; if recording the sale then fails, the stock is handed back.
    const sessionLocationId: string | null = (session as any).locationId ?? null;
    let reserved: Array<{ variantId: string; qty: number }> = [];
    const oversold: Array<{ variantId: string; sku?: string; requested: number; available: number }> = [];
    if (!isHeld) {
      try {
        reserved = await this.reserveStock(dto.items.map((i, idx) => ({ variantId: i.variantId, qty: i.qty, sku: saleItems[idx].sku })).filter((x) => !!x.variantId), sessionLocationId, { allowNegative: off.isOffline, oversold });
      } catch (err) {
        // A concurrent duplicate of THIS checkout may have just taken the last units and written the sale;
        // that is the same sale, not a shortage — hand back the winner instead of "insufficient stock".
        if (dto.idempotencyKey) {
          const winner = await this.r.saleModel.findOne({ idempotencyKey: dto.idempotencyKey, storeId: dto.storeId }).lean();
          if (winner) return { success: true, message: 'Duplicate request — returning existing sale', data: winner };
        }
        throw err;
      }
    }

    // saleNumber is only unique per-store, and two terminals in the same store
    // can check out at nearly the same instant — retry with a fresh number on
    // a rare duplicate-key collision instead of failing the sale outright.
    // idempotencyKey is a *unique* sparse index (sales.schema.ts) — a
    // concurrent retry of the same logical checkout that loses the race
    // hits that instead of creating a second sale; re-fetch and return the
    // winner (after giving back the stock this loser took).
    // The provisional number the offline till printed (offline replays only): kept as a lookup reference, unique per store. If another sale of
    // this store already holds it (a different device with the same short id), the sale is still recorded — money has changed hands — without it,
    // flagged for a manager.
    let provisional: string | null = null;
    if (off.isOffline && dto.provisionalNumber && !isHeld) {
      const wanted = String(dto.provisionalNumber).trim().toUpperCase();
      if (await this.r.saleModel.exists({ storeId: dto.storeId, provisionalNumber: wanted })) flags.push({ type: 'provisional_number_clash', detail: { number: wanted } });
      else provisional = wanted;
    }
    let sale: any;
    try {
      await this.ensureSettings(dto.storeId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const saleNumber = await this.generateSaleNumber(dto.storeId);
        try {
          sale = await this.atomic(async (tx) => {
          // G2.5: a COMPLETED sale gets its tax-invoice number inside this transaction (a held sale gets one when it is completed)
          const invoice = isHeld ? null : await this.issueInvoice(dto.storeId, off.isOffline ? off.at : new Date(), provisional, tx);
          const [created] = await this.r.saleModel.create([{
            saleNumber,
            ...(invoice ? { invoice } : {}),
            ...(provisional ? { provisionalNumber: provisional } : {}),
            ...(heldCouponCode ? { heldCouponCode } : {}),
            storeId: dto.storeId,
            sessionId: dto.sessionId,
            registerId: dto.registerId,
            locationId: sessionLocationId,
            employeeId: dto.employeeId,
            items: this.itemsMinor(saleItems, totals, money.exp),
            subtotal,
            discount,
            tax,
            total,
            ...this.saleMoneyMinor(totals, discountReq, money.exp, settled ? { change: settled.change, shortBy: settled.shortBy } : null),
            currency: money.currency,
            currencyExponent: money.exp,
            discountType: discountReq.value > 0 ? discountReq.type : null,
            discountValue: discountReq.value > 0 ? discountReq.value : null,
            taxRate: money.taxRate,
            paymentMethod: settled ? settled.method : dto.paymentMethod,
            payments: settled ? this.paymentLinesMinor(settled.lines, money.exp) : [],
            changeGiven: settled ? settled.change : 0,
            paymentShortfall: settled ? settled.shortBy : 0,
            ...(couponUsed ? { couponCode: couponUsed.code, couponId: String(couponUsed._id), couponDiscountMinor: totals.minor.discount } : {}),
            employeeName: (employee as any).name ?? null,
            settingsVersion: money.settingsVersion,
            approvedBy: approver?.employeeId ?? null,
            approvedAt: approver ? (off.isOffline ? off.at : new Date()) : null,
            shiftId: (session as any).shiftId ?? null,
            deviceId: this.callerDeviceId(),
            receivedAt: new Date(),
            ...(off.isOffline ? { isOffline: true, clientCreatedAt: off.at, createdAt: off.at } : {}),
            flags: [...flags, ...oversold.map((o) => ({ type: 'oversold_on_sync', detail: o }))],
            needsReview: flags.length > 0 || oversold.length > 0,
            customerId: dto.customerId ?? null,
            customerName: dto.customerName ?? 'Walk-in',
            notes: dto.notes ?? null,
            heldAt: isHeld ? new Date() : null,
            status: isHeld ? 'held' : 'completed',
            // Omit entirely (not `null`) when absent — a `sparse` index only
            // excludes documents where the field doesn't exist at all, not
            // ones where it's explicitly set to `null`.
            ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {}),
          }], tx ? { session: tx } : undefined);

          const auditCtx = { sessionId: dto.sessionId, registerId: dto.registerId, shiftId: (session as any).shiftId ?? null };
          if (!isHeld) {
            await this.recordMovements(tx, { type: 'sale', refType: 'sale', refId: String((created as any)._id), storeId: dto.storeId, locationId: sessionLocationId, ctx: { employeeId: dto.employeeId, registerId: dto.registerId, sessionId: dto.sessionId },
              lines: ((created as any).items as any[]).map((it: any, idx: number) => ({ lineKey: String(idx), variantId: it.variantId, productId: it.productId, name: it.name, sku: it.sku, qty: it.qty, unitCostMinor: it.unitCostMinor ?? null, isCustom: !!it.isCustom })) });
            await this.recordPayments(created, settled!.lines, { ...auditCtx, employeeId: dto.employeeId }, tx);
            await this.consumeDigital(dto.storeId, digital, created, tx); // one sale per payment: the unique `consumed` event commits with the sale or not at all
            if (couponUsed) await this.consumeCoupon(String(couponUsed._id), tx); // race-safe usage count, in the same transaction
          }
          await this.writeAuditLog({
            storeId: dto.storeId,
            employeeId: dto.employeeId,
            action: isHeld ? 'sale_held' : 'sale_created',
            targetId: String(created._id),
            targetType: 'sale',
            ...auditCtx,
            metadata: { total, discount, itemCount: dto.items.length, ...(couponUsed ? { couponCode: couponUsed.code, couponDiscountMinor: totals.minor.discount } : {}), ...(customApproval.count ? { customItems: customApproval.count, customItemsTotalMinor: customApproval.totalMinor, customItemsApprovedBy: customApproval.approver } : {}), ...(off.isOffline ? { offline: true, clientCreatedAt: off.at, settingsVersion: money.settingsVersion, sessionClosed: (session as any).status === 'closed' } : {}) },
          }, tx);
          for (const ci of (created as any).items.filter((x: any) => x.isCustom)) {
            await this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: 'custom_item_sold', targetId: String(created._id), targetType: 'sale', ...auditCtx, metadata: { name: ci.name, qty: ci.qty, priceMinor: toMinor(ci.price, money.exp), taxCategory: ci.taxCategory, approvedBy: ci.customApprovedBy ?? null, saleNumber: (created as any).saleNumber } }, tx);
          }
          if (off.isOffline) {
            // Every flagged offline sale leaves a trail a manager can find: audit log (POS) + inventory activity (store).
            for (const f of (created as any).flags ?? []) {
              await this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: f.type === 'oversold_on_sync' ? 'sale_oversold_offline' : `sale_flag_${f.type}`, targetId: String(created._id), targetType: 'sale', ...auditCtx, metadata: f.detail }, tx);
            }
            if (approverGone) {
              await this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: 'offline_approver_deactivated', targetId: String(created._id), targetType: 'sale', ...auditCtx, metadata: { approvedBy: approver!.employeeId, clientCreatedAt: off.at } }, tx);
            }
          }
          return created;
          });
          break;
        } catch (err: any) {
          if (err?.code === 11000 && err?.keyPattern?.saleNumber && attempt < 4) continue;
          if (err?.code === 11000 && err?.keyPattern?.provisionalNumber && provisional && attempt < 4) { flags.push({ type: 'provisional_number_clash', detail: { number: provisional } }); provisional = null; continue; }
          throw err;
        }
      }
    } catch (err: any) {
      await this.releaseStock(reserved, sessionLocationId);
      if (err?.code === 11000 && err?.keyPattern?.idempotencyKey && dto.idempotencyKey) {
        const existing = await this.r.saleModel.findOne({ idempotencyKey: dto.idempotencyKey, storeId: dto.storeId }).lean();
        if (existing) return { success: true, message: 'Duplicate request — returning existing sale', data: existing };
      }
      throw err;
    }

    if (!isHeld) {
      try {
        await this._incrementSessionTotals(dto.sessionId, { total, payments: settled!.lines, paymentMethod: settled!.method }, money.exp);
      } catch (e: any) {
        // The sale and its stock movement are committed; only the drawer counters missed this sale.
        // eslint-disable-next-line no-console
        console.error(`[createSale] session totals update failed for sale ${sale?._id} (session ${dto.sessionId}) — reconcile manually:`, e?.message);
      }
      await this.recordPosSaleInLedger(sale);
    }

    if (off.isOffline) {
      for (const o of oversold) {
        void this.activityLogService.log({
          storeId: dto.storeId, category: 'inventory', action: 'inventory_oversell',
          description: `Offline sale ${sale.saleNumber} sold ${o.requested} of "${o.sku ?? o.variantId}" but only ${o.available} were in stock — stock is now negative`,
          actorId: dto.employeeId, actorRole: 'pos_employee', targetId: o.variantId, targetType: 'variant', metadata: { saleId: String(sale._id), ...o },
        });
      }
    }

    await this.recordClientMismatches(sale, clientMismatches, money.exp);
    await this.checkMinor('sale', sale, money.exp);
    return { success: true, message: isHeld ? 'Sale put on hold' : 'Sale completed', data: sale };
  }

  async completeSale(sellerId: string, saleId: string, dto: CompleteSaleDto, employeeToken: string | undefined) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be completed');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // Completion re-prices from the held lines with the CURRENT tax rate and the (possibly changed) discount.
    let discountReq = this.discountSpec(dto, sale);
    if (discountReq.value > 0) {
      await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'apply a discount');
    }

    // friendly pre-check against real availability (see ProductVariant.committedStock); the
    // authoritative, race-proof check is the atomic reserveStock below
    for (const item of (sale as any).items) {
      if (item.isCustom) continue; // a custom item has no stock
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant no longer available: ${item.sku}`);
      const availableForPos = availableStock(variant as any);
      if (!variant.unlimitedStock && availableForPos < item.qty) {
        throw new BadRequestException(`Insufficient stock for "${item.sku}" — available: ${availableForPos}`);
      }
    }

    const money = await this.moneyContext(String((sale as any).storeId), { version: dto.settingsVersion });
    // G2.4: a coupon is applied now (checked live against THIS cart), whatever code the held sale remembered
    let couponUsed: any = null;
    if (dto.couponCode) {
      if (discountReq.value > 0) throw moneyError('COUPON_WITH_DISCOUNT', 'A coupon and a manual discount cannot be combined on one sale');
      const pre = computeTotals(this.taxLines((sale as any).items), { exp: money.exp, taxRate: money.taxRate });
      const rc = await this.resolveCoupon(String((sale as any).storeId), dto.couponCode, pre.minor.subtotal, money);
      discountReq = { type: rc.type, value: rc.value };
      couponUsed = rc.coupon;
    }
    const totals = computeTotals(this.taxLines((sale as any).items), { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    const clientMismatches = this.reconcileClientMoney(dto, money.exp, totals.minor.total);
    assertClientTotal(dto.clientTotal, totals);
    if (!(dto.payments?.length) && isDigitalTender(String(dto.paymentMethod))) throw moneyError('QR_REQUIRES_PAYMENT_LINES', 'A Raast QR sale must send its payment as a payment line carrying the confirmed payment (payments[].intentId)');
    let settled = settlePayments(totals.minor.total, money.exp, { payments: dto.payments, paymentMethod: dto.paymentMethod, amountTendered: dto.amountTendered, reference: dto.paymentReference });
    const verifiedDigital = await this.verifyDigitalLines(String((sale as any).storeId), String((sale as any).sessionId), settled.lines, money, false);
    settled = { ...settled, lines: verifiedDigital.lines };
    const digital = verifiedDigital.digital;
    const { discount, tax, total } = totals;
    const locationId: string | null = (sale as any).locationId ?? null;

    // Stock first, then claim the held sale with a status-guarded update: if two terminals (or a
    // retry) both get here, exactly one wins the `held → completed` transition; the loser gives
    // its stock back and is told the sale is already gone. No double decrement, no double count.
    const reserved = await this.reserveStock(
      (sale as any).items.filter((i: any) => !i.isCustom).map((i: any) => ({ variantId: String(i.variantId), qty: i.qty, sku: i.sku })),
      locationId,
    );

    const completeCtx = { sessionId: String((sale as any).sessionId), registerId: (sale as any).registerId ?? null, shiftId: ((await this.r.registerSessionModel.findById((sale as any).sessionId)) as any)?.shiftId ?? null };
    let updated: any;
    try {
    await this.ensureSettings(String((sale as any).storeId));
    updated = await this.atomic(async (tx) => {
      const invoice = await this.issueInvoice(String((sale as any).storeId), new Date(), null, tx);
      const bdItems = this.itemsMinor((sale as any).items.map((i: any) => ({ price: i.price, taxCategory: i.taxCategory })), totals, money.exp);
      const itemSet: Record<string, any> = {};
      bdItems.forEach((b: any, i: number) => { itemSet[`items.${i}.lineTotalMinor`] = b.lineTotalMinor; itemSet[`items.${i}.discountShareMinor`] = b.discountShareMinor; itemSet[`items.${i}.netMinor`] = b.netMinor; itemSet[`items.${i}.taxMinor`] = b.taxMinor; });
      const claimed = await this.r.saleModel.findOneAndUpdate(
      { _id: saleId, status: 'held', deletedAt: null, 'invoice.number': null },
      {
        $set: {
          ...itemSet,
          invoice,
          ...(couponUsed ? { couponCode: couponUsed.code, couponId: String(couponUsed._id), couponDiscountMinor: totals.minor.discount } : {}),
          heldCouponCode: null,
          status: 'completed',
          paymentMethod: settled.method,
          payments: this.paymentLinesMinor(settled.lines, money.exp),
          changeGiven: settled.change,
          subtotal: totals.subtotal,
          discount,
          tax,
          total,
          ...this.saleMoneyMinor(totals, discountReq, money.exp, { change: settled.change, shortBy: 0 }),
          currency: money.currency,
          currencyExponent: money.exp,
          discountType: discountReq.value > 0 ? discountReq.type : null,
          discountValue: discountReq.value > 0 ? discountReq.value : null,
          taxRate: money.taxRate,
          settingsVersion: money.settingsVersion,
          heldAt: null,
          notes: dto.notes ?? (sale as any).notes,
          shiftId: completeCtx.shiftId,
          deviceId: this.callerDeviceId(),
        },
      },
      { new: true, ...(tx ? { session: tx } : {}) },
    );
      if (!claimed) return null;
      await this.recordPayments(claimed, settled.lines, { ...completeCtx, employeeId: (sale as any).employeeId }, tx);
      await this.consumeDigital(String((sale as any).storeId), digital, claimed, tx);
      if (couponUsed) await this.consumeCoupon(String(couponUsed._id), tx); // race-safe usage count, in the same transaction
      await this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: (sale as any).employeeId, action: 'sale_completed', targetId: saleId, targetType: 'sale', ...completeCtx, metadata: { total, discount, fromHeld: true } }, tx);
      return claimed;
    });
    } catch (e) {
      await this.releaseStock(reserved, locationId); // the stock taken above goes back if the sale (or its digital payment) could not be committed
      throw e;
    }
    if (!updated) {
      await this.releaseStock(reserved, locationId);
      throw businessConflict('HELD_SALE_ALREADY_RESOLVED', 'This held sale was already completed or discarded');
    }

    try {
      await this._incrementSessionTotals((sale as any).sessionId, { total, payments: settled.lines, paymentMethod: settled.method }, money.exp);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[completeSale] session totals update failed for sale ${saleId} — reconcile manually:`, e?.message);
    }
    await this.recordPosSaleInLedger(updated);
    await this.recordClientMismatches(updated, clientMismatches, money.exp);
    await this.checkMinor('sale', updated, money.exp);

    return { success: true, message: 'Sale completed', data: updated };
  }

  async getHeldSales(sellerId: string, storeId: string, sessionId?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const filter: any = { storeId, status: 'held', deletedAt: null };
    if (sessionId) filter.sessionId = sessionId;

    const sales = await this.r.saleModel.find(filter).sort({ heldAt: -1 }).lean();

    return { success: true, count: sales.length, data: sales };
  }

  async getSaleById(sellerId: string, saleId: string) {
    const sale = await this.r.saleModel.findById(saleId).lean();
    if (!sale) throw new NotFoundException('Sale not found');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // sales from before 5B carry no currency snapshot — always hand the app one
    const m = await this.docMoney(sale);
    return { success: true, data: { ...(sale as any), currency: m.currency, currencyExponent: m.exp } };
  }

  /**
   * Finds sales by what a CUSTOMER or a receipt shows: the offline `OFF-…` number printed on the first receipt, the tax invoice number, the sale
   * (receipt) number, or a credit note number — exact match, upper-cased; a bare number (`123`) is also tried as `INV-000123` / `POS-00123`.
   * (A return at another till starts here.)
   */
  private async salesMatchingReference(storeId: string, raw: string): Promise<string[]> {
    const ref = String(raw ?? '').trim().toUpperCase();
    if (ref.length > 40 || !/^[A-Z0-9-]+$/.test(ref) || (ref.length < 2 && !/^\d$/.test(ref))) return [];
    const candidates = [ref];
    if (/^\d{1,6}$/.test(ref)) candidates.push(`INV-${ref.padStart(6, '0')}`, `POS-${ref.padStart(5, '0')}`);
    const or: any[] = [{ provisionalNumber: { $in: candidates } }, { 'invoice.number': { $in: candidates } }, { saleNumber: { $in: candidates } }];
    const ids = new Set<string>((await this.r.saleModel.find({ storeId, deletedAt: null, $or: or }).select('_id').limit(10).lean()).map((s: any) => String(s._id)));
    if (/^CN-\d+$/.test(ref)) {
      const cn: any = await this.r.posCreditNoteModel.findOne({ storeId, number: ref }).select('saleId').lean();
      if (cn?.saleId) ids.add(String(cn.saleId));
    }
    return [...ids];
  }

  async lookupSales(sellerId: string, storeId: string, ref: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const ids = await this.salesMatchingReference(storeId, ref);
    const found = ids.length ? await this.r.saleModel.find({ _id: { $in: ids } }).sort({ createdAt: -1 }).limit(5).lean() : [];
    const m = await this.moneyContext(storeId);
    return { success: true, data: found.map((x: any) => ({ ...x, currency: x.currency ?? m.currency, currencyExponent: x.currencyExponent ?? m.exp })) };
  }

  async getSales(sellerId: string, query: any) {
    if (!query.storeId) throw new BadRequestException('storeId is required');

    await this.verifyStoreOwnership(query.storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId: query.storeId, deletedAt: null };
    if (query.sessionId) filter.sessionId = query.sessionId;
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
    if (query.status) filter.status = query.status;
    if (query.search) {
      const ids = await this.salesMatchingReference(query.storeId, String(query.search));
      filter._id = { $in: ids };
    }
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) { const t = new Date(query.to); t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
    }

    const total = await this.r.saleModel.countDocuments(filter);
    const found = await this.r.saleModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
    const m = await this.moneyContext(query.storeId);
    const sales = found.map((x: any) => ({ ...x, currency: x.currency ?? m.currency, currencyExponent: x.currencyExponent ?? m.exp }));

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        currency: m.currency,
        currencyExponent: m.exp,
        sales,
      },
    };
  }

  async refundSale(sellerId: string, saleId: string, dto: RefundSaleDto | undefined, employeeToken: string | undefined, idempotencyKey?: string) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');

    // A retry of a refund that already went through (same Idempotency-Key) returns THAT refund — never a second one.
    // Checked first (before the "already refunded" status guards below) and only after the caller proves they may see it.
    if (idempotencyKey) {
      const prior: any = await this.r.posRefundModel.findOne({ saleId, idempotencyKey }).lean();
      if (prior) {
        await this.verifyStoreOwnership((sale as any).storeId, sellerId);
        await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'issue refunds');
        return {
          success: true, message: 'Refund already processed — returning the original result',
          data: { refundedAmount: prior.amount, newStatus: (sale as any).status, tenders: prior.tenders, currency: prior.currency, currencyExponent: prior.currencyExponent, refundId: String(prior._id), reference: prior.reference, replayed: true },
        };
      }
    }
    if ((sale as any).status === 'voided') throw new BadRequestException('Sale is voided — cannot refund');
    if ((sale as any).status === 'refunded') throw new BadRequestException('Sale is already fully refunded');
    if ((sale as any).status === 'held') throw new BadRequestException('Cannot refund a held sale — discard it instead');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // WHO is returning is decided below, once the amount is known (a cashier may return within the store's limits; anything else needs a manager)
    const who = await this.verifyEmployeeToken(employeeToken, (sale as any).storeId);
    if (!who) throw new ForbiddenException('A valid employee PIN session is required to issue refunds');

    const isPartial = !!(dto?.items && dto.items.length > 0);
    const locationId: string | null = (sale as any).locationId ?? null;
    const { currency, exp } = await this.docMoney(sale);
    const lines = effectivePayments(sale as any);
    const alreadyRefunded = (sale as any).refundedAmount || 0;

    // Optimistic-concurrency claim: the sale document is updated only if it is still exactly in
    // the state we just read (same status + same cumulative refundedAmount). Two concurrent
    // refunds (double-tap, two terminals, a retry) therefore cannot both succeed — the loser gets
    // a 409 — and stock is restored only by the request that won the claim.
    const stateFilter = { _id: saleId, status: (sale as any).status, refundedAmount: alreadyRefunded };
    const staleMessage = 'This sale was changed by another refund or terminal — reload it and check before refunding again';

    // G2.5: every line is credited with ITS OWN part of what the customer paid (net of its share of the discount, plus its tax),
    // by cumulative proration — see pos-documents.util.ts. The credits of all returns of a line add up to exactly what the line cost.
    const saleItems: any[] = (sale as any).items;
    const bd = this.saleBreakdown(sale as any, exp);
    const wanted: Array<{ idx: number; qty: number; restock: boolean; restockReason: string | null }> = [];
    if (!isPartial) {
      saleItems.forEach((item: any, idx: number) => {
        const left = item.qty - (item.refundedQty || 0);
        if (left > 0) wanted.push({ idx, qty: left, restock: !item.isCustom, restockReason: null });
      });
    } else {
      const seen = new Set<string>();
      for (const refundItem of dto!.items!) {
        if (seen.has(refundItem.saleItemId)) throw new BadRequestException(`Sale item listed twice: ${refundItem.saleItemId}`);
        seen.add(refundItem.saleItemId);
        const idx = saleItems.findIndex((i: any) => i._id.toString() === refundItem.saleItemId);
        if (idx < 0) throw new BadRequestException(`Sale item not found: ${refundItem.saleItemId}`);
        const saleItem = saleItems[idx];
        const available = saleItem.qty - (saleItem.refundedQty || 0);
        if (refundItem.qty > available) {
          throw new BadRequestException(`Cannot refund ${refundItem.qty} of "${saleItem.name}" — only ${available} unreturned`);
        }
        const restock = saleItem.isCustom ? false : refundItem.restock !== false;
        const restockReason = (refundItem.restockReason ?? '').trim() || null;
        if (!restock && !saleItem.isCustom && !restockReason) throw moneyError('RESTOCK_REASON_REQUIRED', `Say why "${saleItem.name}" is not going back on the shelf`);
        wanted.push({ idx, qty: refundItem.qty, restock, restockReason: restock ? null : restockReason });
      }
    }
    const credit = wanted.map((w) => ({ ...w, a: returnLineAmounts(bd[w.idx], saleItems[w.idx].qty, saleItems[w.idx].refundedQty || 0, w.qty) }));
    let creditMinor = credit.reduce((sum, c) => sum + c.a.totalMinor, 0);
    const itemUpdates: Array<{ variantId: string; qtyToRestore: number; saleItemId: string; restock: boolean }> = wanted.map((w) => ({
      variantId: saleItems[w.idx].variantId ? String(saleItems[w.idx].variantId) : '', qtyToRestore: w.qty, saleItemId: String(saleItems[w.idx]._id), restock: w.restock,
    }));
    const completesSale = saleItems.every((item: any, idx: number) => (item.refundedQty || 0) + (wanted.find((w) => w.idx === idx)?.qty || 0) >= item.qty);
    const newStatus: 'refunded' | 'partially_refunded' = completesSale ? 'refunded' : 'partially_refunded';

    // The amount. A sale issued under G2.5 (it has an invoice) is fully on the new proration. An older sale had its earlier
    // refunds priced the old way, so its amount keeps the old rule (the last refund returns the exact remainder) and the credit note's
    // lines are nudged by the rounding difference so the note always equals what was paid out.
    let refundAmount: number;
    if ((sale as any).invoice) {
      refundAmount = fromMinor(creditMinor, exp);
    } else if (!isPartial) {
      refundAmount = roundMoney((sale as any).total - alreadyRefunded, exp);
    } else {
      refundAmount = partialRefundAmount(sale as any, wanted.map((w) => ({ price: saleItems[w.idx].price, qty: w.qty })), exp, completesSale);
    }
    if (credit.length && toMinor(refundAmount, exp) !== creditMinor) {
      const delta = toMinor(refundAmount, exp) - creditMinor;
      const last = credit[credit.length - 1].a;
      last.netMinor += delta; last.totalMinor += delta;
      creditMinor += delta;
    }

    // Who may do it: a manager always; a cashier only when the store allows it and the return is within every limit.
    const settingsDoc: any = await this.r.posSettingsModel.findOne({ storeId: (sale as any).storeId }).select('cashierReturnsEnabled returnApprovalAboveMinor returnApprovalAfterDays').lean();
    const needs = returnApprovalReasons({
      amountMinor: toMinor(refundAmount, exp), aboveMinor: settingsDoc?.returnApprovalAboveMinor ?? null,
      daysSinceSale: daysBetween(new Date((sale as any).createdAt ?? Date.now()), new Date()), afterDays: settingsDoc?.returnApprovalAfterDays ?? null,
      receiptPresented: dto?.receiptPresented !== false, cashierReturnsEnabled: settingsDoc?.cashierReturnsEnabled === true,
    });
    const isManager = who.role === 'manager';
    if (!isManager && needs.length) {
      throw new ForbiddenException({ statusCode: 403, code: 'RETURN_NEEDS_MANAGER', reasons: needs, message: needs.includes('store_requires_manager') ? 'Only managers can issue refunds' : 'A manager must approve this return' });
    }
    const actor = { employeeId: who.employeeId, role: who.role };
    const approvedBy = isManager && needs.length ? who.employeeId : null;

    const tenders = allocateRefund(lines, alreadyRefunded, refundAmount, exp);
    const reason = normalizeReason('refund', dto?.reasonCode, dto?.reason);
    const refundId = new Types.ObjectId();
    const refundSeq = ((sale as any).refunds ?? []).length;
    await this.ensureSettings(String((sale as any).storeId));
    const refundRecord = {
      refundId: String(refundId),
      amount: refundAmount, amountMinor: toMinor(refundAmount, exp), kind: isPartial ? 'partial' : 'full',
      tenders: this.tendersMinor(tenders, exp), items: itemUpdates.map((u) => ({ saleItemId: u.saleItemId, qty: u.qtyToRestore })),
      employeeId: actor.employeeId, currency, currencyExponent: exp, createdAt: new Date(),
    };

    const update: any = {
      $set: { status: newStatus, refundedAmount: roundMoney(alreadyRefunded + refundAmount, exp), refundedAmountMinor: toMinor(alreadyRefunded, exp) + toMinor(refundAmount, exp) },
      $push: { refunds: refundRecord },
    };
    // every line's returned quantity is counted — for a full refund too (the units still on the sale), so refundedQty is always the truth
    let arrayFilters: any[] | undefined;
    if (itemUpdates.length) {
      const inc: Record<string, number> = {};
      arrayFilters = [];
      itemUpdates.forEach((u, idx) => {
        inc[`items.$[line${idx}].refundedQty`] = u.qtyToRestore;
        arrayFilters!.push({ [`line${idx}._id`]: new Types.ObjectId(u.saleItemId) });
      });
      update.$inc = inc;
    }
    // The refund happens at the till the customer is standing at — its register's CURRENT shift — which can be another register (or shift)
    // than the sale's own (a return with a receipt printed offline, or at a second till). `registerId` in the request names that till.
    const returnRegisterId: string | null = dto?.registerId ?? (sale as any).registerId ?? null;
    const nowSession: any = returnRegisterId
      ? await this.r.registerSessionModel.findOne({ registerId: returnRegisterId, storeId: (sale as any).storeId, status: 'open' })
      : null;
    // a cash refund comes out of a drawer: it needs an open shift on the register that pays it
    if (returnRegisterId && tenders.some((t: any) => t.method === 'cash' && t.amount > 0) && !nowSession) {
      throw businessConflict('OPEN_SHIFT_REQUIRED', 'Open a shift on this register before paying a cash refund');
    }
    // G3.0: the refund belongs to the shift whose drawer / terminal paid it. Only when the returning register has NO open shift (card / other
    // tenders only — cash was refused above) does it fall back to the sale's own shift, and only if that one is still open; a CLOSED shift is never touched.
    const refundShift = await this.refundShiftFor(sale, nowSession);
    const refundCtx = { sessionId: refundShift ? String(refundShift._id) : null, registerId: returnRegisterId, shiftId: refundShift?.shiftId ?? null };
    const refundAuditAction = newStatus === 'refunded' ? 'sale_refunded_full' : 'sale_refunded_partial';
    let createdCreditNote: any = null;
    const claimed = await this.atomic(async (tx) => {
      // The sale claim, the refund record and the audit event commit together or not at all.
      const c = await this.r.saleModel.findOneAndUpdate(stateFilter, update, { new: true, ...(arrayFilters ? { arrayFilters } : {}), ...(tx ? { session: tx } : {}) });
      if (!c) return null;
      await this.r.posRefundModel.create([{
        _id: refundId, saleId, saleNumber: (sale as any).saleNumber ?? null, seq: refundSeq, reference: `${(sale as any).saleNumber ?? saleId}-R${refundSeq + 1}`,
        kind: isPartial ? 'partial' : 'full', amount: refundAmount, amountMinor: toMinor(refundAmount, exp), currency, currencyExponent: exp, tenders: this.tendersMinor(tenders, exp),
        items: refundRecord.items, reason: reason.note, reasonCode: reason.code,
        status: tenders.every((t: any) => t.method === 'cash') ? 'confirmed' : 'recorded_unverified', confirmationSource: null,
        storeId: (sale as any).storeId, ...refundCtx, deviceId: this.callerDeviceId(), employeeId: actor.employeeId,
        saleSessionId: (sale as any).sessionId ?? null, saleEmployeeId: (sale as any).employeeId ?? null,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }], tx ? { session: tx } : undefined);
      const creditNote = await this.createCreditNote(tx, {
        sale: sale as any, kind: 'return', scope: completesSale ? 'full' : 'partial', refundId: String(refundId), reason, exp, currency,
        lines: credit.map((c2) => ({ idx: c2.idx, qty: c2.qty, a: c2.a, restock: c2.restock, restockReason: c2.restockReason })),
        tenders: this.tendersMinor(tenders, exp), actorId: actor.employeeId, approvedBy, approvalReasons: needs, ctx: refundCtx,
      });
      createdCreditNote = creditNote;
      // G3.1: the units that really went back on the shelf are a stock movement, at the cost the sale snapshotted
      await this.recordMovements(tx, { type: 'return', refType: 'refund', refId: String(refundId), storeId: String((sale as any).storeId), locationId, ctx: { employeeId: actor.employeeId, registerId: returnRegisterId, sessionId: refundShift ? String(refundShift._id) : null },
        lines: itemUpdates.filter((u) => !!u.variantId && u.restock).map((u) => { const it = saleItems.find((x: any) => String(x._id) === u.saleItemId); return { lineKey: u.saleItemId, variantId: u.variantId, productId: it?.productId, name: it?.name, sku: it?.sku, qty: u.qtyToRestore, unitCostMinor: it?.unitCostMinor ?? null, isCustom: false }; }) });
      await this.writeAuditLog({
        storeId: (sale as any).storeId, employeeId: actor.employeeId, action: refundAuditAction, targetId: saleId, targetType: 'sale', ...refundCtx,
        metadata: { refundAmount, tenders, currency, items: dto?.items, refundId: String(refundId), reference: `${(sale as any).saleNumber ?? saleId}-R${refundSeq + 1}`, reason: reason.note, reasonCode: reason.code, creditNote: creditNote.number, approvedBy, approvalReasons: needs },
      }, tx);
      return c;
    });
    if (!claimed) throw businessConflict('SALE_CHANGED_CONCURRENTLY', staleMessage);

    await this.restoreSoldStock(itemUpdates.filter((u) => !!u.variantId && u.restock).map((u) => ({ variantId: u.variantId, qty: u.qtyToRestore })), locationId);

    // Session: the refund comes OUT of sales and out of the right tender — so a cash refund lowers the
    // cash the drawer should now hold (expected cash = opening + cashSales + cashIn − cashOut). The
    // transaction count drops only when the sale becomes fully refunded, and exactly once.
    // G3.0: the counters (refunds, net sales, the paying tender → expected cash / expected card) move on the REFUNDING shift. When that is another
    // shift than the sale's own, the sale's shift is left exactly as it closed or stands (and the transaction count stays where the sale was made).
    const split = byTender(tenders);
    const sessionInc: any = {
      totalRefunds: refundAmount,
      totalSales: -refundAmount,
      ...this.tenderInc(split, -1),
    };
    const sameShift = !!refundShift && String(refundShift._id) === String((sale as any).sessionId);
    if (newStatus === 'refunded' && sameShift) sessionInc.totalTransactions = -1;
    const refundedSession = refundShift ? await this.incSessionCounters(String(refundShift._id), sessionInc, exp) : null;
    await this.checkMinor('sale', claimed, exp);
    if (refundedSession) await this.checkMinor('session', refundedSession, exp);

    await this.recordPosRefundInLedger(sale, refundAmount, newStatus === 'refunded' && !isPartial ? 'refund' : 'partial refund');

    // G2.3: the Raast part of the refund goes back through the provider, as provider-refund EVENTS (never a typed-in record). The sale-side
    // refund above is already committed; if a provider call fails the payment shows up under "Needs attention → refund failed" for a manager.
    const digitalPlan = this.payments ? digitalRefundPlan(lines as any, alreadyRefunded, refundAmount, exp) : [];
    const digitalRefunds = digitalPlan.length ? await this.payments!.refundForSale(String((sale as any).storeId), digitalPlan, { employeeId: actor.employeeId, refundId: String(refundId), reason: dto?.reason?.trim() ?? '' }) : undefined;

    if (!isPartial) return { success: true, message: 'Sale fully refunded and stock restored', data: { ...(digitalRefunds ? { digitalRefunds } : {}), refundedAmount: refundAmount, newStatus, tenders, currency, currencyExponent: exp, refundId: String(refundId), reference: `${(sale as any).saleNumber ?? saleId}-R${refundSeq + 1}`, creditNote: createdCreditNote ? { id: String(createdCreditNote._id), number: createdCreditNote.number, totalMinor: createdCreditNote.totalMinor } : null } };
    return { success: true, message: `Partial refund of ${refundAmount.toFixed(exp)} processed`, data: { ...(digitalRefunds ? { digitalRefunds } : {}), refundedAmount: refundAmount, newStatus, tenders, currency, currencyExponent: exp, refundId: String(refundId), reference: `${(sale as any).saleNumber ?? saleId}-R${refundSeq + 1}`, creditNote: createdCreditNote ? { id: String(createdCreditNote._id), number: createdCreditNote.number, totalMinor: createdCreditNote.totalMinor } : null } };
  }

  /**
   * Soft delete (G1a): the held sale is kept, marked `discarded` with who / when / why, and an audit event is written in the
   * same transaction. It disappears from every list (deletedAt is set) but is never physically deleted. `reason` is what the
   * cashier typed; old app builds send none → "not provided". Idempotent: discarding an already-discarded sale succeeds.
   */
  async discardHeldSale(sellerId: string, saleId: string, opts: { reason?: string; reasonCode?: string; employeeToken?: string } = {}) {
    const sale: any = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    await this.verifyStoreOwnership(sale.storeId, sellerId);

    if (sale.status === 'discarded') return { success: true, message: 'Held sale already discarded', data: { saleId, alreadyDiscarded: true } };
    if (sale.status !== 'held') throw new BadRequestException('Only held sales can be discarded');

    const rsn = normalizeReason('discard', opts.reasonCode, opts.reason);
    const reason = rsn.note || (rsn.code !== 'not_provided' ? rsn.code.replace(/_/g, ' ') : 'not provided');
    const actor = await this.verifyEmployeeToken(opts.employeeToken, sale.storeId); // optional: who at the till pressed it
    const deletedBy = actor?.employeeId ?? sellerId;

    // status-guarded so a discard racing a completion can't discard a sale that just became real
    const discarded = await this.atomic(async (tx) => {
      const d = await this.r.saleModel.findOneAndUpdate(
        { _id: saleId, status: 'held', deletedAt: null },
        { $set: { status: 'discarded', deletedAt: new Date(), deletedBy, deleteReason: reason, deleteReasonCode: rsn.code, heldAt: null } },
        { new: true, ...(tx ? { session: tx } : {}) },
      );
      if (!d) return null;
      await this.writeAuditLog({
        storeId: sale.storeId, employeeId: actor?.employeeId ?? sale.employeeId ?? null, action: 'held_sale_discarded', targetId: saleId, targetType: 'sale',
        sessionId: sale.sessionId ?? null, registerId: sale.registerId ?? null, shiftId: sale.shiftId ?? null,
        metadata: { reason, reasonCode: rsn.code, saleNumber: sale.saleNumber, total: sale.total, itemCount: (sale.items ?? []).length, deletedBy, byOwnerSession: !actor },
      }, tx);
      return d;
    });
    if (!discarded) {
      const now: any = await this.r.saleModel.findById(saleId);
      if (now?.status === 'discarded') return { success: true, message: 'Held sale already discarded', data: { saleId, alreadyDiscarded: true } };
      throw businessConflict('HELD_SALE_ALREADY_RESOLVED', 'This held sale was already completed or discarded');
    }
    return { success: true, message: 'Held sale discarded' };
  }

  // ── QUOTE (price a cart, no side effects) ─────────────────────────────────────

  /**
   * What the server WOULD charge for a cart — lines, discount, tax, total, currency, exponent and the settingsVersion
   * used. Nothing is created and no stock is touched. The app calls it before Charge (when online), shows the
   * server's total and sends that same total + settingsVersion with the sale, so a stale tax rate or price on the
   * device is corrected BEFORE the customer is charged rather than rejected after.
   */
  async quoteSale(sellerId: string, dto: QuoteSaleDto) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);
    if (!dto.items?.length) throw new BadRequestException('Add at least one item to price');

    const lines: any[] = [];
    for (const item of dto.items) {
      if (item.isCustom) { lines.push(this.customLine(item, await this.defaultTaxCategory(dto.storeId))); continue; }
      const variant: any = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false }).lean();
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);
      const product: any = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name').lean();
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);
      lines.push({ productId: item.productId, variantId: item.variantId, name: `${product.name}${formatOptionsSuffix(variant.options)}`, sku: variant.sku, price: variant.price, qty: item.qty });
    }
    let discountReq = this.discountSpec(dto);
    const money = await this.moneyContext(dto.storeId, { version: dto.settingsVersion });
    let couponInfo: any = null;
    if (dto.couponCode) {
      if (discountReq.value > 0) throw moneyError('COUPON_WITH_DISCOUNT', 'A coupon and a manual discount cannot be combined on one sale');
      const pre = computeTotals(this.taxLines(lines), { exp: money.exp, taxRate: money.taxRate });
      const r = await this.resolveCoupon(dto.storeId, dto.couponCode, pre.minor.subtotal, money);
      discountReq = { type: r.type, value: r.value };
      couponInfo = { code: r.coupon.code, discountType: r.coupon.discountType, discountValue: r.coupon.discountValue };
    }
    const totals = computeTotals(this.taxLines(lines), { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    return {
      success: true,
      data: {
        lines: lines.map((l, i) => ({ ...l, lineTotal: totals.lineTotals[i], lineTotalMinor: totals.lineTotalsMinor[i] })),
        subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
        // G1b: the same figures in integer minor units (what the maths was done in)
        subtotalMinor: totals.minor.subtotal, discountMinor: totals.minor.discount, taxMinor: totals.minor.tax, totalMinor: totals.minor.total,
        taxRate: money.taxRate, currency: money.currency, currencyExponent: money.exp,
        settingsVersion: money.settingsVersion,
        // the version asked for could not be honoured (unknown, or older than the offline window) → priced with current
        settingsVersionReplaced: !money.usedRequestedVersion,
        // G2.4: the coupon that was applied (code + how it discounts) — null when none
        coupon: couponInfo,
      },
    };
  }

  // ── OFFLINE REVIEW / DISCARD ──────────────────────────────────────────────────

  /** Sales a manager should look at: oversold on sync, price changed while offline, payment shortfall. Newest first. */
  async getSalesNeedingReview(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const sales = await this.r.saleModel.find({ storeId, needsReview: true, deletedAt: null }).sort({ createdAt: -1 }).limit(200).lean();
    return { success: true, count: sales.length, data: sales };
  }

  /** A manager acknowledges a flagged sale (note required). Atomic — a second resolve gets a business 409. */
  async resolveSaleReview(sellerId: string, saleId: string, note: string, employeeToken: string | undefined) {
    const sale: any = await this.r.saleModel.findById(saleId).lean();
    if (!sale) throw new NotFoundException('Sale not found');
    await this.verifyStoreOwnership(sale.storeId, sellerId);
    const actor = await this.requireManagerEmployee(employeeToken, sale.storeId, 'resolve a flagged sale');
    if (!note || note.trim().length < 3) throw moneyError('REASON_REQUIRED', 'A short note explaining the resolution is required');
    const done = await this.r.saleModel.findOneAndUpdate(
      { _id: saleId, needsReview: true },
      { $set: { needsReview: false, reviewedBy: actor.employeeId, reviewedAt: new Date(), reviewNote: note.trim() } },
      { new: true },
    );
    if (!done) throw businessConflict('SALE_ALREADY_REVIEWED', 'This sale was already resolved');
    await this.writeAuditLog({ storeId: sale.storeId, employeeId: actor.employeeId, action: 'sale_review_resolved', targetId: saleId, targetType: 'sale', metadata: { note: note.trim(), flags: sale.flags } });
    return { success: true, message: 'Sale marked as reviewed', data: done };
  }

  /**
   * A manager gives up on a queued offline sale that can never sync (too old, outside its session, …). The sale itself
   * never reached the server, so this writes the audit trail ("sale X for 42.00 made at T was discarded by M because …")
   * — keyed by the sale's idempotency key so a retried discard is a no-op. Reason required; manager token required.
   */
  async recordOfflineDiscard(
    sellerId: string,
    dto: { storeId: string; idempotencyKey: string; reason: string; summary?: Record<string, any> },
    employeeToken: string | undefined,
  ) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);
    const actor = await this.requireManagerEmployee(employeeToken, dto.storeId, 'discard an unsynced sale');
    if (!dto.reason || dto.reason.trim().length < 3) throw moneyError('REASON_REQUIRED', 'A reason is required to discard an unsynced sale');
    if (!dto.idempotencyKey) throw moneyError('INVALID_KEY', 'idempotencyKey is required');

    const sold = await this.r.saleModel.findOne({ idempotencyKey: dto.idempotencyKey, storeId: dto.storeId }).select('_id saleNumber').lean();
    if (sold) throw businessConflict('SALE_ALREADY_SYNCED', 'This sale already reached the server — it cannot be discarded');

    const already = await this.r.posAuditLogModel.findOne({ storeId: dto.storeId, action: 'offline_sale_discarded', targetId: dto.idempotencyKey }).lean();
    if (!already) {
      await this.writeAuditLog({
        storeId: dto.storeId, employeeId: actor.employeeId, action: 'offline_sale_discarded', targetId: dto.idempotencyKey, targetType: 'offline_sale',
        metadata: { reason: dto.reason.trim(), summary: dto.summary ?? null },
      });
    }
    return { success: true, message: 'Discard recorded', data: { idempotencyKey: dto.idempotencyKey, alreadyRecorded: !!already } };
  }

  // ── CUSTOMER SEARCH (store-scoped) ────────────────────────────────────────

  /**
   * Finds customers to attach to a sale — limited to people who already relate to THIS store (see
   * `common/store-customer-search.util.ts`). The same rule now scopes the draft-orders search.
   */
  async searchStoreCustomers(sellerId: string, storeId: string, q: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    if ((q ?? '').trim().length < 2) return { success: true, data: [] };
    return { success: true, data: await searchStoreCustomers(this.r as any, storeId, q) };
  }

  // ── DAILY REPORT ──────────────────────────────────────────────────────────

  async getDailyReport(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { currency, exp } = await this.moneyContext(storeId);

    const date = query.date ? new Date(query.date) : new Date();
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const scope: any = { storeId, createdAt: { $gte: startOfDay, $lte: endOfDay } };
    if (query.registerId) scope.registerId = query.registerId;
    if (query.locationId) scope.locationId = query.locationId;

    // completed AND partially-refunded sales are sales; fully refunded / voided ones are "reversed"
    const sales = await this.r.saleModel.find({ ...scope, status: { $in: ['completed', 'partially_refunded'] } }).lean();
    const reversed = await this.r.saleModel.find({ ...scope, status: { $in: ['refunded', 'voided'] } }).lean();
    const summary = this.summarizeSales(sales, reversed, exp);

    const hourlyMap: Record<number, number> = {};
    const productSales: Record<string, { name: string; qty: number; revenue: number }> = {};
    for (const sale of sales) {
      const hour = new Date((sale as any).createdAt).getHours();
      hourlyMap[hour] = roundMoney((hourlyMap[hour] || 0) + (sale as any).total, exp);
      for (const item of (sale as any).items) {
        // custom items (no product) are grouped under one row, "Custom item"
        const key = item.isCustom ? 'custom' : item.productId;
        if (!productSales[key]) productSales[key] = { name: item.isCustom ? 'Custom item' : item.name, qty: 0, revenue: 0 };
        productSales[key].qty += item.qty;
        productSales[key].revenue = roundMoney(productSales[key].revenue + item.lineTotal, exp);
      }
    }

    const topProducts = Object.entries(productSales)
      .map(([productId, data]) => ({ productId, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const hourlyBreakdown = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      total: hourlyMap[h] || 0,
    }));

    const { byPayment, ...flat } = summary;
    return {
      success: true,
      data: {
        date: date.toISOString().split('T')[0],
        currency,
        currencyExponent: exp,
        customItems: this.customItemsSummary(sales, exp),
        summary: flat,
        byPaymentMethod: byPayment,
        topProducts,
        hourlyBreakdown,
      },
    };
  }

  // ── G2.6 HOME DASHBOARD ────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The Home "business pulse". ROLE-BASED: a cashier sees ONLY their own open shift; a manager / the owner see the whole store for today.
   * The sales figures come from the SAME `summarizeSales` the daily report uses over the SAME window, so they match that report to the
   * minor unit (tested). Reads use the (storeId, createdAt) / (sessionId) indexes and a projection (no images / notes / flags).
   */
  async getDashboard(sellerId: string, storeId: string, employeeToken: string | undefined) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const who = await this.verifyEmployeeToken(employeeToken, storeId);
    const role: 'cashier' | 'manager' | 'owner' = who?.role === 'cashier' ? 'cashier' : who?.role === 'manager' ? 'manager' : 'owner';
    const { currency, exp } = await this.moneyContext(storeId);
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);

    let scope: any = { storeId, createdAt: { $gte: start, $lte: end } };
    let shifts: any[];
    if (role === 'cashier') {
      shifts = await this.r.registerSessionModel.find({ storeId, employeeId: who!.employeeId, status: 'open' }).sort({ openedAt: -1 }).limit(1).lean();
      scope = { storeId, sessionId: shifts.length ? String(shifts[0]._id) : '__no_open_shift__' };
    } else {
      shifts = await this.r.registerSessionModel.find({ storeId, status: 'open' }).sort({ openedAt: -1 }).limit(20).lean();
    }

    const proj = '-items.image -notes -flags -idempotencyKey -receipt';
    const [sales, reversed]: any[][] = await Promise.all([
      this.r.saleModel.find({ ...scope, status: { $in: ['completed', 'partially_refunded'] } }).select(proj).lean(),
      this.r.saleModel.find({ ...scope, status: { $in: ['refunded', 'voided'] } }).select(proj).lean(),
    ]);
    const summary = this.summarizeSales(sales, reversed, exp);
    const productSales: Record<string, { name: string; qty: number; revenue: number }> = {};
    for (const sale of sales) {
      for (const item of sale.items ?? []) {
        const key = item.isCustom ? 'custom' : item.productId;
        if (!productSales[key]) productSales[key] = { name: item.isCustom ? 'Custom item' : item.name, qty: 0, revenue: 0 };
        productSales[key].qty += item.qty;
        productSales[key].revenue = roundMoney(productSales[key].revenue + item.lineTotal, exp);
      }
    }
    const topProducts = Object.entries(productSales).map(([productId, d]) => ({ productId, ...d })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const names = new Map<string, string>();
    const empIds = [...new Set(shifts.map((s2) => String(s2.employeeId)))];
    if (empIds.length) for (const e of await this.r.employeeModel.find({ _id: { $in: empIds } }).select('name').lean()) names.set(String((e as any)._id), (e as any).name);

    const { byPayment, ...flat } = summary as any;
    const manager = role !== 'cashier';
    const [needsReview, digital] = manager
      ? await Promise.all([
          this.r.saleModel.countDocuments({ storeId, needsReview: true, deletedAt: null }),
          this.payments ? this.payments.listAttention(storeId).then((x: any) => (x?.items ?? []).length).catch(() => 0) : Promise.resolve(0),
        ])
      : [0, 0];
    return {
      success: true,
      data: {
        role, scope: role === 'cashier' ? 'shift' : 'store', date: start.toISOString().split('T')[0], currency, currencyExponent: exp,
        summary: flat, byPaymentMethod: byPayment, topProducts, customItems: this.customItemsSummary(sales, exp),
        shifts: shifts.map((s2) => ({ sessionId: String(s2._id), registerId: s2.registerId ?? null, employeeId: String(s2.employeeId), employeeName: names.get(String(s2.employeeId)) ?? null, openedAt: s2.openedAt, openingCash: s2.openingCash ?? 0, totalSales: s2.totalSales ?? 0, totalTransactions: s2.totalTransactions ?? 0 })),
        needsAttention: manager ? { salesNeedingReview: needsReview, digitalPayments: digital, total: needsReview + digital } : null,
      },
    };
  }

  // ── REPORT SUMMARY (shared by the daily and range reports) ─────────────────────

  /**
   * `sales` = completed + partially-refunded sales in the window; `reversed` = fully refunded or voided
   * sales in the same window. Everything is rounded to the currency exponent, tender figures are NET of
   * refunds (a cash partial refund lowers cash), and refunds count partial refunds too.
   */
  private summarizeSales(sales: any[], reversed: any[], exp: number) {
    const sum = (xs: number[]) => roundMoney(xs.reduce((a, b) => a + b, 0), exp);
    const totalRevenue = sum(sales.map((x) => x.total));
    const totalDiscount = sum(sales.map((x) => x.discount));
    const totalTax = sum(sales.map((x) => x.tax));
    const partialRefunds = sum(sales.map((x) => x.refundedAmount || 0));
    const byPayment: Record<string, { count: number; total: number }> = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 }, other: { count: 0, total: 0 } };
    for (const sale of sales) {
      const nets = tenderNets(sale, exp);
      const used = effectivePayments(sale);
      for (const m of ['cash', 'card', 'other', 'raast_qr'] as const) {
        if (used.some((l) => l.method === m)) { byPayment[m] ??= { count: 0, total: 0 }; byPayment[m].count++; byPayment[m].total = roundMoney(byPayment[m].total + nets[m], exp); }
      }
    }
    const refundedValue = sum(reversed.map((x) => (x.status === 'voided' ? x.total : (x.refundedAmount || x.total))));
    const out = {
      totalTransactions: sales.length,
      totalRevenue,
      totalDiscount,
      totalTax,
      // revenue the shop keeps: gross sales minus what was handed back on partially refunded sales
      netRevenue: roundMoney(totalRevenue - partialRefunds, exp),
      avgTransactionValue: sales.length > 0 ? roundMoney(totalRevenue / sales.length, exp) : 0,
      refundsCount: reversed.length + sales.filter((x) => (x.refundedAmount || 0) > 0).length,
      refundsTotal: roundMoney(refundedValue + partialRefunds, exp),
      byPayment,
    };
    return this.withSummaryMinor(out, exp);
  }

  /** G1b: minor twins of a report summary (derived from the same rounded decimals, so they agree by construction). */
  private withSummaryMinor(s: any, exp: number): any {
    const m = (v: number) => toMinor(v, exp);
    const byPayment: Record<string, any> = {};
    for (const [k, v] of Object.entries(s.byPayment ?? {}) as Array<[string, any]>) byPayment[k] = { ...v, totalMinor: m(v.total) };
    return {
      ...s, byPayment,
      totalRevenueMinor: m(s.totalRevenue), totalDiscountMinor: m(s.totalDiscount), totalTaxMinor: m(s.totalTax), netRevenueMinor: m(s.netRevenue),
      avgTransactionValueMinor: m(s.avgTransactionValue), refundsTotalMinor: m(s.refundsTotal),
    };
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  // ── MONEY HELPERS (Phase 5B) ──────────────────────────────────────────────────

  /**
   * The store's selling currency, minor-unit exponent and POS tax rate — everything money maths needs — plus the
   * `settingsVersion` they belong to.
   *
   * Pass `version` (what the device priced with) and the server prices with THAT version when it still exists and
   * was superseded no more than the offline window ago; otherwise (unknown version, or too old) it silently uses
   * the current settings. That is what keeps TOTAL_MISMATCH meaning "tampering or a client bug": a tax-rate change
   * made while a device was offline or mid-checkout no longer makes an honest sale disagree with the server.
   */
  private async moneyContext(storeId: string, opts: { version?: number | null } = {}): Promise<{ currency: string; exp: number; taxRate: number; settingsVersion: number; usedRequestedVersion: boolean }> {
    const [store, settings]: any[] = await Promise.all([
      this.r.storeModel.findById(storeId).select('baseCurrency').lean(),
      this.r.posSettingsModel.findOne({ storeId }).select('taxRate settingsVersion createdAt').lean(),
    ]);
    const currency = String(store?.baseCurrency || 'USD').toUpperCase();
    const current = { currency, exp: exponentOf(currency), taxRate: Number(settings?.taxRate) || 0, settingsVersion: Number(settings?.settingsVersion) || 1 };

    const wanted = opts.version ?? null;
    if (wanted && wanted !== current.settingsVersion) {
      const row: any = await this.r.posSettingsVersionModel.findOne({ storeId, version: wanted }).lean();
      const stillUsable = row && (!row.supersededAt || new Date(row.supersededAt).getTime() >= Date.now() - offlineWindowMs());
      if (stillUsable) {
        return { currency: row.currency, exp: row.currencyExponent, taxRate: Number(row.taxRate) || 0, settingsVersion: row.version, usedRequestedVersion: true };
      }
    }
    return { ...current, usedRequestedVersion: !wanted || wanted === current.settingsVersion };
  }

  /** Makes sure the CURRENT settings version has a history row (stores created before versioning have none). */
  private async ensureVersionRow(storeId: string): Promise<void> {
    const [store, settings]: any[] = await Promise.all([
      this.r.storeModel.findById(storeId).select('baseCurrency').lean(),
      this.r.posSettingsModel.findOne({ storeId }).lean(),
    ]);
    if (!settings) return;
    const currency = String(store?.baseCurrency || 'USD').toUpperCase();
    try {
      await this.r.posSettingsVersionModel.updateOne(
        { storeId, version: settings.settingsVersion || 1 },
        { $setOnInsert: { storeId, version: settings.settingsVersion || 1, taxRate: Number(settings.taxRate) || 0, currency, currencyExponent: exponentOf(currency), effectiveFrom: settings.createdAt ?? new Date(), supersededAt: null } },
        { upsert: true },
      );
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // a concurrent request created it — fine
    }
  }

  /** currency/exponent of an existing sale or session; documents from before 5B carry neither, so fall back to the store's. */
  private async docMoney(doc: any): Promise<{ currency: string; exp: number }> {
    if (doc?.currency && doc?.currencyExponent !== null && doc?.currencyExponent !== undefined) {
      return { currency: doc.currency, exp: doc.currencyExponent };
    }
    const ctx = await this.moneyContext(String(doc.storeId));
    return { currency: ctx.currency, exp: ctx.exp };
  }

  // ── G2.4: custom items and coupons ────────────────────────────────────────────────────────────────────

  async storeIdOfSale(saleId: string): Promise<string> {
    const s: any = await this.r.saleModel.findById(saleId).select('storeId').lean();
    if (!s) throw new NotFoundException('Sale not found');
    return String(s.storeId);
  }

  /** A custom item as a sale line: no product, no variant, never stocked. The price is whatever the till says (a manager approves it above the store's limit). */
  /** G2.6: the store's default tax category for a custom item that does not say (owner-set in the store tax profile). */
  private async defaultTaxCategory(storeId: string): Promise<string> {
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('defaultTaxCategory').lean();
    return s?.defaultTaxCategory === 'exempt' ? 'exempt' : 'standard';
  }

  private customLine(item: any, defaultTaxCategory: string = 'standard'): any {
    const price = Number(item.unitPrice);
    if (!(price > 0) || !Number.isFinite(price)) throw moneyError('CUSTOM_ITEM_PRICE_REQUIRED', 'A custom item needs a price above zero');
    const name = String(item.customName ?? '').trim();
    if (!name) throw moneyError('CUSTOM_ITEM_NAME_REQUIRED', 'A custom item needs a name');
    return {
      productId: null, variantId: null, name: name.slice(0, 120), sku: 'CUSTOM', image: null, price, listPrice: null, priceVerified: true,
      qty: item.qty, lineTotal: 0, refundedQty: 0, isCustom: true, taxCategory: item.taxCategory === 'exempt' ? 'exempt' : item.taxCategory === 'standard' ? 'standard' : (defaultTaxCategory === 'exempt' ? 'exempt' : 'standard'),
      customApprovedBy: null, note: item.customNote ? String(item.customNote).slice(0, 200) : null,
    };
  }

  /** "Custom item" in reports: how many were sold and for how much. */
  private customItemsSummary(sales: any[], exp: number): { count: number; total: number; totalMinor: number } {
    let count = 0; let totalMinor = 0;
    for (const sale of sales) for (const it of sale.items ?? []) if (it.isCustom) { count += it.qty; totalMinor += it.lineTotalMinor ?? toMinor(it.lineTotal, exp); }
    return { count, total: fromMinor(totalMinor, exp), totalMinor };
  }

  /** Lines for computeTotals: an exempt custom item carries no tax. */
  private taxLines(items: any[]): Array<{ price: number; qty: number; taxable: boolean }> {
    return items.map((i) => ({ price: i.price, qty: i.qty, taxable: i.taxCategory !== 'exempt' }));
  }

  /**
   * A custom item (no catalog product) needs a manager unless its line total is within the store's `customItemApprovalAboveMinor`
   * (null = every custom item needs one). The manager's PIN session is verified server-side (for an offline replay: as of the sale's time).
   * Stamps `customApprovedBy` on the lines and returns the approver (audited by the caller).
   */
  private async approveCustomItems(storeId: string, items: any[], exp: number, employeeToken: string | undefined, at?: Date): Promise<{ approver: string | null; count: number; totalMinor: number }> {
    const custom = items.filter((i) => i.isCustom);
    if (!custom.length) return { approver: null, count: 0, totalMinor: 0 };
    const settings: any = await this.r.posSettingsModel.findOne({ storeId }).select('customItemApprovalAboveMinor').lean();
    const limit: number | null = settings?.customItemApprovalAboveMinor ?? null;
    const totalMinor = custom.reduce((s2, i) => s2 + toMinor(i.price * i.qty, exp), 0);
    const needsManager = limit === null || custom.some((i) => toMinor(i.price * i.qty, exp) > limit);
    let approver: string | null = null;
    if (needsManager) {
      const m = await this.verifyEmployeeToken(employeeToken, storeId, at);
      if (!m || m.role !== 'manager') throw new ForbiddenException({ statusCode: 403, code: 'CUSTOM_ITEM_NEEDS_MANAGER', message: 'A manager must approve this custom item', limitMinor: limit });
      approver = m.employeeId;
    }
    custom.forEach((i) => { i.customApprovedBy = approver; });
    return { approver, count: custom.length, totalMinor };
  }

  /**
   * POS coupon check (reuses the storefront's `Coupon` model; only a `posEnabled` seller coupon of THIS store counts). Rules: active, not
   * deleted, started, not expired, usage limit not reached, minimum spend met, same currency for fixed-amount / minimum-spend coupons.
   * Returns the discount in the form `computeTotals` takes. Usage is NOT counted here — see `consumeCoupon` (inside the sale transaction).
   */
  private async resolveCoupon(storeId: string, rawCode: string, subtotalMinor: number, money: { currency: string; exp: number }, now = new Date()) {
    const code = String(rawCode ?? '').trim().toUpperCase();
    if (!code) throw moneyError('COUPON_INVALID', 'Enter a coupon code');
    const c: any = await this.r.couponModel.findOne({ code, scope: 'seller', storeId, isDelete: { $ne: true } }).lean();
    if (!c || c.isActive === false || c.posEnabled !== true) throw moneyError('COUPON_INVALID', 'This coupon code is not valid at the till');
    if (c.startsAt && new Date(c.startsAt) > now) throw moneyError('COUPON_NOT_STARTED', 'This coupon is not active yet', { startsAt: c.startsAt });
    if (c.expiresAt && new Date(c.expiresAt) < now) throw moneyError('COUPON_EXPIRED', 'This coupon has expired');
    if (c.usageLimit != null && (c.usageCount ?? 0) >= c.usageLimit) throw moneyError('COUPON_LIMIT_REACHED', 'This coupon has been used the maximum number of times');
    const cur = String(c.currency ?? money.currency).toUpperCase();
    if ((c.discountType === 'fixed' || c.minOrderAmount != null) && cur !== String(money.currency).toUpperCase()) throw moneyError('COUPON_CURRENCY_MISMATCH', 'This coupon is in a different currency than this store');
    if (c.minOrderAmount != null && subtotalMinor < toMinor(c.minOrderAmount, money.exp)) throw moneyError('COUPON_MIN_SPEND', 'The sale is below this coupon\'s minimum spend', { minSpend: c.minOrderAmount });
    if (c.discountType === 'percentage') return { coupon: c, type: 'percent' as DiscountType, value: Number(c.discountValue) };
    const off = Math.min(toMinor(c.discountValue, money.exp), subtotalMinor); // a fixed coupon larger than the sale takes the whole subtotal, never more
    return { coupon: c, type: 'amount' as DiscountType, value: fromMinor(off, money.exp) };
  }

  /** Counts one use of the coupon, race-safe, inside the sale's transaction: the update only matches while the limit has room. */
  private async consumeCoupon(couponId: string, tx?: ClientSession): Promise<void> {
    const r: any = await this.r.couponModel.updateOne(
      { _id: couponId, $or: [{ usageLimit: null }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }] },
      { $inc: { usageCount: 1 } }, tx ? { session: tx } : undefined,
    );
    if ((r?.modifiedCount ?? r?.nModified ?? 0) === 0) throw moneyError('COUPON_LIMIT_REACHED', 'This coupon has just been used the maximum number of times');
  }

  /** What discount the request asks for: the new type+value form, else the legacy flat `discount`, else (completing/editing a held sale) what's already on it. */
  private discountSpec(dto: { discount?: number; discountType?: DiscountType; discountValue?: number }, existing?: any): { type: DiscountType; value: number } {
    if (dto.discountType) return { type: dto.discountType, value: dto.discountValue ?? 0 };
    if (dto.discount !== undefined && dto.discount !== null) return { type: 'amount', value: dto.discount };
    if (existing?.discountType) return { type: existing.discountType, value: existing.discountValue ?? 0 };
    return { type: 'amount', value: existing?.discount ?? 0 };
  }

  /** `$inc` for the register session from a sale's tender nets (cash net of change; refunds already deducted). */
  private tenderInc(nets: Record<'cash' | 'card' | 'other' | 'raast_qr', number>, sign: 1 | -1): Record<string, number> {
    const inc: Record<string, number> = {};
    if (nets.cash) inc.cashSales = sign * nets.cash;
    if (nets.card) inc.cardSales = sign * nets.card;
    if (nets.other) inc.otherSales = sign * nets.other;
    if (nets.raast_qr) inc.digitalSales = sign * nets.raast_qr;
    return inc;
  }

  // ── ATOMIC STOCK HELPERS ──────────────────────────────────────────────────
  // Stock is reserved BEFORE the sale document is written and handed back if the sale can't be
  // recorded, so a sale never exists without its stock having been taken, and a lost race
  // rejects the sale instead of silently overselling. (No Mongo transaction: nothing else in
  // this codebase's sale paths uses one, and the per-variant `$gte`-guarded `$inc` is atomic.)

  /** Takes `qty` of each stock-tracked line, all-or-nothing. Unlimited-stock variants are skipped. */
  private async reserveStock(
    items: Array<{ variantId: string; qty: number; sku?: string }>,
    locationId: string | null,
    opts: { allowNegative?: boolean; oversold?: Array<{ variantId: string; sku?: string; requested: number; available: number }> } = {},
  ): Promise<Array<{ variantId: string; qty: number }>> {
    const taken: Array<{ variantId: string; qty: number }> = [];
    for (const item of items) {
      const result = await this.r.productVariantModel.updateOne(
        {
          _id: item.variantId,
          unlimitedStock: { $ne: true },
          $expr: { $gte: [AVAILABLE_STOCK_EXPR, item.qty] },
        },
        { $inc: { stock: -item.qty } },
      );
      if (result.modifiedCount > 0) {
        taken.push({ variantId: String(item.variantId), qty: item.qty });
        await drainLocationStock(this.r, String(item.variantId), item.qty, { preferLocationId: locationId });
        continue;
      }
      // Matched nothing: either an unlimited-stock variant (fine — nothing to take) or the floor
      // guard lost a race / stock is short (reject and give back what this call already took).
      const trackedVariant: any = await this.r.productVariantModel.findOne({ _id: item.variantId, unlimitedStock: { $ne: true } }).lean();
      if (trackedVariant && opts.allowNegative) {
        // OFFLINE-SYNC RULE: the goods already left the shop, so the sale is recorded and stock is allowed to go
        // negative — the shortfall is reported (opts.oversold → audit log, inventory activity, needs-review flag).
        // Online sales never take this branch: they keep the strict no-negative rule.
        opts.oversold?.push({ variantId: String(item.variantId), sku: item.sku, requested: item.qty, available: Math.max(0, availableStock(trackedVariant)) });
        await this.r.productVariantModel.updateOne({ _id: item.variantId }, { $inc: { stock: -item.qty } });
        taken.push({ variantId: String(item.variantId), qty: item.qty });
        await drainLocationStock(this.r, String(item.variantId), item.qty, { preferLocationId: locationId });
        continue;
      }
      if (trackedVariant) {
        await this.releaseStock(taken, locationId);
        throw new BadRequestException(`Insufficient stock for "${item.sku ?? item.variantId}"`);
      }
    }
    return taken;
  }

  /** Puts back stock previously taken by reserveStock (compensation path). */
  private async releaseStock(taken: Array<{ variantId: string; qty: number }>, locationId: string | null): Promise<void> {
    for (const t of taken) {
      try {
        await this.r.productVariantModel.updateOne({ _id: t.variantId }, { $inc: { stock: t.qty } });
        await restoreLocationStock(this.r, t.variantId, t.qty, { preferLocationId: locationId });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error(`[pos] stock release failed for variant ${t.variantId} (qty ${t.qty}) — manual stock correction needed:`, e?.message);
      }
    }
  }

  /**
   * Returns stock for a refund/void. Variants flagged `unlimitedStock` are skipped — they never
   * had stock taken on sale, so adding units back would inflate a number that means nothing.
   */
  private async restoreSoldStock(items: Array<{ variantId: string; qty: number }>, locationId: string | null): Promise<void> {
    if (!items.length) return;
    const unlimited = new Set(
      (await this.r.productVariantModel
        .find({ _id: { $in: items.map((i) => i.variantId) }, unlimitedStock: true })
        .select('_id')
        .lean()).map((v: any) => String(v._id)),
    );
    for (const item of items) {
      if (!(item.qty > 0) || unlimited.has(String(item.variantId))) continue;
      await this.r.productVariantModel.findByIdAndUpdate(item.variantId, { $inc: { stock: item.qty } });
      await restoreLocationStock(this.r, String(item.variantId), item.qty, { preferLocationId: locationId });
    }
  }

  /**
   * G3.0: the shift a refund / void is booked on — the one whose drawer (or terminal) physically paid it. [returning] is the open shift of the
   * register the customer is standing at (null when that register has none). Fallback for tenders that need no drawer: the sale's own shift, but
   * ONLY while it is still open — a closed shift is never changed after the fact. Null = no shift (the refund row still carries every id).
   */
  private async refundShiftFor(sale: any, returning: any | null): Promise<any | null> {
    if (returning) return returning;
    if (!sale?.sessionId) return null;
    return this.r.registerSessionModel.findOne({ _id: sale.sessionId, status: 'open' });
  }

  /**
   * G3.1: the stock-ledger rows of a sale / return / void, INSIDE the caller's transaction (so they exist exactly when the document does). Custom items and unlimited-stock
   * variants never moved stock and write nothing. Idempotent per (type, document, line). A deployment without the ledger model (older unit-test doubles) writes nothing.
   */
  private async recordMovements(tx: ClientSession | undefined, a: {
    type: 'sale' | 'return' | 'void'; refType: string; refId: string; storeId: string; locationId: string | null;
    ctx: { employeeId?: string | null; registerId?: string | null; sessionId?: string | null };
    lines: Array<{ lineKey: string; variantId?: string | null; productId?: string | null; name?: string | null; sku?: string | null; qty: number; unitCostMinor: number | null; isCustom: boolean }>;
  }): Promise<void> {
    const model = this.r.stockMovementModel;
    if (!model) return;
    const lines = a.lines.filter((l) => !l.isCustom && l.variantId && l.qty > 0);
    if (!lines.length) return;
    const unlimited = new Set((await this.r.productVariantModel.find({ _id: { $in: lines.map((l) => String(l.variantId)) }, unlimitedStock: true }).select('_id').lean()).map((v: any) => String(v._id)));
    const sign = a.type === 'sale' ? -1 : 1;
    const docs = lines.filter((l) => !unlimited.has(String(l.variantId))).map((l) => ({
      storeId: a.storeId, variantId: String(l.variantId), productId: l.productId ?? null, sku: l.sku ?? null, productName: l.name ?? null, locationId: a.locationId,
      type: a.type, qtyDelta: sign * l.qty, unitCostMinor: l.unitCostMinor, refType: a.refType, refId: a.refId,
      employeeId: a.ctx.employeeId ?? null, registerId: a.ctx.registerId ?? null, sessionId: a.ctx.sessionId ?? null, deviceId: this.callerDeviceId(),
      dedupeKey: `${a.type}:${a.refId}:${l.lineKey}`,
    }));
    if (docs.length) await model.insertMany(docs, { ...(tx ? { session: tx } : {}), ordered: true });
  }

  /** Counts a completed sale into its register session: total, one transaction, and each tender's NET amount (cash net of change). */
  private async _incrementSessionTotals(sessionId: string, sale: { total: number; payments?: any[]; paymentMethod?: string }, exp: number) {
    const nets = tenderNets({ ...sale, refundedAmount: 0, status: 'completed' }, exp);
    const inc: any = { totalSales: sale.total, totalTransactions: 1, ...this.tenderInc(nets, 1) };
    const updated: any = await this.incSessionCounters(sessionId, inc, exp);

    // A sale synced into a session that has ALREADY been closed: its cash is real, so the session's stored close
    // figures must move with it — expected cash includes the sale, and the variance is re-derived from the count the
    // cashier entered at close (the drawer did hold that cash; the count simply pre-dated the sync).
    if (updated && updated.status === 'closed' && nets.cash) {
      const expectedCash = roundMoney((updated.expectedCash || 0) + nets.cash, exp);
      const $set: Record<string, any> = { expectedCash, expectedCashMinor: toMinor(expectedCash, exp) };
      if (updated.closingCash !== null && updated.closingCash !== undefined) {
        $set.cashDifference = roundMoney(updated.closingCash - expectedCash, exp);
        $set.cashDifferenceMinor = toMinor(updated.closingCash, exp) - toMinor(expectedCash, exp);
      }
      await this.r.registerSessionModel.updateOne({ _id: sessionId }, { $set });
    }
    await this.checkMinor('session', updated, exp);
  }

  /**
   * Durable audit write. ALWAYS awaited (never fire-and-forget); inside a business transaction it takes the transaction's
   * session, so the audit event commits or rolls back TOGETHER with the sale / refund / void / close it describes.
   * `deviceId` defaults to the authenticated POS device of this request (never from the request body).
   */
  private async writeAuditLog(data: {
    storeId: string;
    employeeId?: string | null;
    action: string;
    targetId?: string | null;
    targetType?: string | null;
    metadata?: object | null;
    sessionId?: string | null;
    registerId?: string | null;
    shiftId?: string | null;
    deviceId?: string | null;
  }, tx?: ClientSession): Promise<void> {
    await this.r.posAuditLogModel.create(
      [{
        storeId: data.storeId,
        employeeId: data.employeeId ?? null,
        action: data.action,
        targetId: data.targetId ?? null,
        targetType: data.targetType ?? null,
        metadata: data.metadata ?? null,
        sessionId: data.sessionId ?? null,
        registerId: data.registerId ?? null,
        shiftId: data.shiftId ?? null,
        deviceId: data.deviceId ?? currentDeviceScope()?.deviceId ?? null,
      }],
      tx ? { session: tx } : undefined,
    );
  }

  private txUnsupported = false;

  /**
   * Runs `fn` inside a MongoDB transaction when the deployment supports one (Atlas, any replica set — every environment this
   * API is deployed to; the dev stack is a replica set too). On a standalone mongod (some unit/integration harnesses) it runs
   * `fn` without a transaction: writes are still awaited, just not atomic. `fn` may be retried by the driver on a transient
   * transaction error, so it must only do database work through `tx`.
   */
  private async atomic<T>(fn: (tx?: ClientSession) => Promise<T>): Promise<T> {
    const conn: any = (this.r as any).saleModel?.db;
    if (!conn || typeof conn.transaction !== 'function' || this.txUnsupported) return fn(undefined);
    try {
      return await conn.transaction((session: ClientSession) => fn(session));
    } catch (e: any) {
      if (e?.code === 20 && /replica set|Transaction numbers/i.test(String(e?.message))) {
        this.txUnsupported = true;
        // eslint-disable-next-line no-console
        console.warn('[PosService] this MongoDB does not support transactions — POS audit/payment records are awaited but not atomic with the sale');
        return fn(undefined);
      }
      throw e;
    }
  }

  /** The device (from the authenticated token), never from the request body. */
  private callerDeviceId(): string | null {
    return currentDeviceScope()?.deviceId ?? null;
  }

  // ── G1b: integer minor-unit twins (dual-write) ──────────────────────────────────────────────────────────────────
  // Every money figure is stored twice: the decimal (what old builds and every report read today) and a `...Minor` integer.
  // Both come from the SAME calculation — computeTotals already works in minor units and derives the decimals with fromMinor — so
  // they cannot disagree; the checker (checkMinor) proves it after every write. Reads still use the decimals until step f.

  /** Items with their minor twins. `lineTotalMinor` is the engine's own `toMinor(price × qty)`; `priceMinor × qty` may differ only for a sub-minor price. */
  /**
   * Per-line gross / discount / net / tax of a sale, aligned with `sale.items`. Uses what was stored at sale time (G2.5) and, for an
   * older sale, derives the same split from the sale's own figures (deterministic, so the same answer every time).
   */
  private saleBreakdown(sale: any, exp: number) {
    const items: any[] = sale.items ?? [];
    const stored = items.length > 0 && items.every((i) => i.netMinor !== undefined && i.netMinor !== null && i.taxMinor !== undefined && i.taxMinor !== null);
    if (stored) {
      return items.map((i) => {
        const gross = Number(i.lineTotalMinor ?? toMinor(i.lineTotal ?? Number(i.price) * Number(i.qty), exp));
        const disc = Number(i.discountShareMinor ?? gross - Number(i.netMinor));
        return { grossMinor: gross, discountMinor: disc, netMinor: Number(i.netMinor), taxMinor: Number(i.taxMinor), totalMinor: Number(i.netMinor) + Number(i.taxMinor) };
      });
    }
    return lineBreakdown(
      items.map((i) => ({ grossMinor: Number(i.lineTotalMinor ?? toMinor(i.lineTotal ?? Number(i.price) * Number(i.qty), exp)), taxable: i.taxCategory !== 'exempt' })),
      Number(sale.discountMinor ?? toMinor(sale.discount ?? 0, exp)), Number(sale.taxMinor ?? toMinor(sale.tax ?? 0, exp)),
    );
  }

  /** Writes the CREDIT NOTE of a return / void inside the caller's transaction (own gap-free number, linked to the invoice and lines). */
  private async createCreditNote(tx: ClientSession | undefined, a: {
    sale: any; kind: 'return' | 'void'; scope: 'partial' | 'full'; refundId: string | null; reason: { note: string | null; code: string | null }; exp: number; currency: string;
    lines: Array<{ idx: number; qty: number; a: { grossMinor: number; discountMinor: number; netMinor: number; taxMinor: number; totalMinor: number }; restock: boolean; restockReason: string | null }>;
    tenders: Array<{ method: string; amountMinor?: number; amount?: number }>; actorId: string; approvedBy: string | null; approvalReasons: string[];
    ctx: { sessionId: string | null; registerId: string | null; shiftId?: string | null };
  }) {
    const n = await this.nextDocNumber(String(a.sale.storeId), 'creditNote', tx);
    const lines = a.lines.map((l) => {
      const it = a.sale.items[l.idx];
      return {
        saleItemId: String(it._id), productId: it.productId ?? null, variantId: it.variantId ?? null, name: it.name, sku: it.sku, hsCode: it.hsCode ?? null,
        taxCategory: it.taxCategory ?? 'standard', qty: l.qty, unitPriceMinor: Number(it.priceMinor ?? toMinor(it.price, a.exp)),
        grossMinor: l.a.grossMinor, discountMinor: l.a.discountMinor, netMinor: l.a.netMinor, taxMinor: l.a.taxMinor, totalMinor: l.a.totalMinor,
        restock: l.restock, restockReason: l.restockReason,
      };
    });
    const sum = (k: 'grossMinor' | 'discountMinor' | 'netMinor' | 'taxMinor' | 'totalMinor') => lines.reduce((s2, l) => s2 + l[k], 0);
    const [doc] = await this.r.posCreditNoteModel.create([{
      storeId: a.sale.storeId, number: n.number, seq: n.seq, saleId: String(a.sale._id), saleNumber: a.sale.saleNumber ?? null,
      invoiceNumber: a.sale.invoice?.number ?? null, invoiceIssuedAt: a.sale.invoice?.issuedAt ?? null,
      kind: a.kind, scope: a.scope, refundId: a.refundId, reasonCode: a.reason.code, reason: a.reason.note,
      lines, grossMinor: sum('grossMinor'), discountMinor: sum('discountMinor'), netMinor: sum('netMinor'), taxMinor: sum('taxMinor'), totalMinor: sum('totalMinor'),
      currency: a.currency, currencyExponent: a.exp,
      tenders: a.tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor ?? toMinor(t.amount ?? 0, a.exp) })),
      seller: a.sale.invoice?.seller ?? (await this.sellerSnapshot(String(a.sale.storeId), tx)), customerName: a.sale.customerName ?? null,
      employeeId: a.actorId, approvedBy: a.approvedBy, approvalReasons: a.approvalReasons,
      // the REFUNDING till / shift (whose drawer paid) …
      registerId: a.ctx.registerId ?? null, sessionId: a.ctx.sessionId ?? null,
      // … and the ORIGINAL sale's till / shift — both are kept (G3.0)
      saleRegisterId: a.sale.registerId ?? null, saleSessionId: a.sale.sessionId ?? null,
    }], tx ? { session: tx } : undefined);
    return doc as any;
  }

  private itemsMinor(items: any[], totals: { lineTotalsMinor: number[]; minor?: { discount: number; tax: number } }, exp: number): any[] {
    // G2.5: every line carries its own share of the discount and tax (Σ lines = the sale), so a return can reverse exactly its part
    const bd = totals.minor ? lineBreakdown(items.map((it, i) => ({ grossMinor: totals.lineTotalsMinor[i], taxable: it.taxCategory !== 'exempt' })), totals.minor.discount, totals.minor.tax) : null;
    return items.map((it, i) => ({
      ...it,
      priceMinor: toMinor(it.price, exp),
      ...(it.listPrice !== null && it.listPrice !== undefined ? { listPriceMinor: toMinor(it.listPrice, exp) } : {}),
      lineTotalMinor: totals.lineTotalsMinor[i],
      ...(bd ? { discountShareMinor: bd[i].discountMinor, netMinor: bd[i].netMinor, taxMinor: bd[i].taxMinor } : {}),
    }));
  }

  // ── G2.5: tax invoice numbers + seller snapshot ─────────────────────────────────────────────────────────────────
  /** Makes sure the store's settings document exists BEFORE a transaction opens (a first-ever upsert inside two concurrent transactions would collide). */
  private async ensureSettings(storeId: string): Promise<void> {
    await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true });
  }

  /**
   * The next number of a per-store document sequence. Called INSIDE the transaction that creates the document: if that transaction aborts
   * the increment aborts with it, so the sequence has no holes; two tills contend on the same counter document and one retries.
   */
  private async nextDocNumber(storeId: string, kind: 'invoice' | 'creditNote', tx?: ClientSession): Promise<{ seq: number; number: string }> {
    const field = kind === 'invoice' ? 'invoiceCounter' : 'creditNoteCounter';
    const s: any = await this.r.posSettingsModel.findOneAndUpdate({ storeId }, { $inc: { [field]: 1 } }, { new: true, upsert: true, ...(tx ? { session: tx } : {}) });
    const seq = Number(s[field]);
    return { seq, number: formatDocNumber(kind === 'invoice' ? INVOICE_PREFIX : CREDIT_NOTE_PREFIX, seq) };
  }

  /** The seller as registered (store tax profile), snapshotted onto every invoice and credit note. */
  private async sellerSnapshot(storeId: string, tx?: ClientSession) {
    const s: any = await this.r.posSettingsModel.findOne({ storeId }, null, tx ? { session: tx } : undefined).select('taxNtn taxStrn taxLegalName taxRegisteredAddress businessName businessAddress').lean();
    return { legalName: s?.taxLegalName ?? s?.businessName ?? null, address: s?.taxRegisteredAddress ?? s?.businessAddress ?? null, ntn: s?.taxNtn ?? null, strn: s?.taxStrn ?? null };
  }

  private async issueInvoice(storeId: string, issuedAt: Date, offlineRef: string | null | undefined, tx?: ClientSession) {
    const n = await this.nextDocNumber(storeId, 'invoice', tx);
    return { number: n.number, seq: n.seq, issuedAt, offlineRef: offlineRef ?? null, seller: await this.sellerSnapshot(storeId, tx), fiscal: { status: 'not_enabled', externalInvoiceNumber: null, qrPayload: null, attempts: 0, lastError: null } };
  }

  /** Sale-level minor figures. `discountValueMinor` exists only for an AMOUNT discount (a percentage is not money). */
  private saleMoneyMinor(totals: { minor: { subtotal: number; discount: number; tax: number; total: number } }, discount: { type: string; value: number }, exp: number, settled?: { change: number; shortBy: number } | null): Record<string, number> {
    return {
      subtotalMinor: totals.minor.subtotal,
      discountMinor: totals.minor.discount,
      taxMinor: totals.minor.tax,
      totalMinor: totals.minor.total,
      refundedAmountMinor: 0, // a sale starts un-refunded (the decimal's schema default is 0); the refund path moves both
      ...(discount.value > 0 && discount.type === 'amount' ? { discountValueMinor: toMinor(discount.value, exp) } : {}),
      ...(settled !== undefined ? { changeGivenMinor: settled ? toMinor(settled.change, exp) : 0, paymentShortfallMinor: settled ? toMinor(settled.shortBy, exp) : 0 } : {}),
    };
  }

  private paymentLinesMinor(lines: Array<{ method: string; amount: number; tendered?: number; reference?: string | null }>, exp: number): any[] {
    return lines.map((l) => ({ ...l, amountMinor: toMinor(l.amount, exp), ...(l.tendered !== undefined && l.tendered !== null ? { tenderedMinor: toMinor(l.tendered, exp) } : {}) }));
  }

  private tendersMinor(tenders: Array<{ method: string; amount: number }>, exp: number): any[] {
    return tenders.map((t) => ({ ...t, amountMinor: toMinor(t.amount, exp) }));
  }

  /**
   * Adds deltas to a shift's running counters: the decimal AND its integer twin, in ONE atomic update. An update pipeline, so a
   * shift that was already OPEN when G1b was deployed (counters have no minor yet) starts its minor counter from the existing
   * decimal in the same update — never from 0. `inc` holds decimal deltas keyed by counter name (`totalTransactions` is a plain count).
   */
  private async incSessionCounters(sessionId: string, inc: Record<string, number>, exp: number, tx?: ClientSession): Promise<any> {
    const f = 10 ** exp;
    const set: Record<string, any> = {};
    for (const [k, d] of Object.entries(inc)) {
      set[k] = { $add: [{ $ifNull: ['$' + k, 0] }, d] };
      if (k === 'totalTransactions') continue;
      const fromMajor = { $toLong: { $round: [{ $multiply: [{ $ifNull: ['$' + k, 0] }, f] }, 0] } };
      set[k + 'Minor'] = { $add: [{ $ifNull: ['$' + k + 'Minor', fromMajor] }, Long.fromNumber(toMinor(d, exp))] };
    }
    return this.r.registerSessionModel.findByIdAndUpdate(sessionId, [{ $set: set }] as any, { new: true, updatePipeline: true, ...(tx ? { session: tx } : {}) } as any);
  }

  /**
   * G1b: the server RECOMPUTES every amount from its own data; a client's decimal and its optional integer twin are only a
   * cross-check — and a disagreement NEVER rejects the sale (an offline sale whose cash was already taken must always sync, and a
   * client rounding bug must never stop checkout at the counter). Returns what disagreed, with the client's and the server's values;
   * the caller stores the sale as the server computed it and calls `recordClientMismatches` once it is saved.
   * `serverTotalMinor` is the server's own total, shown next to the client's `clientTotalMinor` / `clientTotal`.
   */
  private reconcileClientMoney(dto: any, exp: number, serverTotalMinor: number): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    const pair = (major: any, minor: any, field: string, serverMinor: number | null) => {
      if (minor === undefined || minor === null) return;
      if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
        out.push({ field, clientDecimal: major ?? null, clientMinor: String(minor), serverMinor, reason: 'minor_not_a_safe_integer' });
        return;
      }
      if (major === undefined || major === null) return;
      if (toMinor(major, exp) !== minor) out.push({ field, clientDecimal: major, clientMinor: minor, serverMinor: serverMinor ?? toMinor(major, exp), reason: 'decimal_and_minor_disagree' });
    };
    pair(dto.clientTotal, dto.clientTotalMinor, 'clientTotal', serverTotalMinor);
    pair(dto.amountTendered, dto.amountTenderedMinor, 'amountTendered', null);
    if ((dto.discountType ?? 'amount') === 'amount') pair(dto.discountValue, dto.discountValueMinor, 'discountValue', null);
    (dto.payments ?? []).forEach((p: any, i: number) => pair(p.amount, p.amountMinor, `payments[${i}].amount`, null));
    (dto.items ?? []).forEach((it: any, i: number) => pair(it.unitPrice, it.unitPriceMinor, `items[${i}].unitPrice`, null));
    return out;
  }

  /** After the sale is saved: log + `money_minor_mismatch` audit event (source: client) + metric. NEVER throws and never changes the sale. */
  private async recordClientMismatches(sale: any, mismatches: Array<Record<string, any>>, exp: number): Promise<void> {
    if (!mismatches.length) return;
    try {
      PosMinorMetrics.recordClient(mismatches.length);
      // eslint-disable-next-line no-console
      console.warn(`[pos-minor-mismatch] client payload for sale ${String(sale?._id)} disagreed with itself: ${JSON.stringify(mismatches.slice(0, 5))}`);
      await this.writeAuditLog({
        storeId: String(sale?.storeId ?? ''), employeeId: sale?.employeeId ?? null, action: 'money_minor_mismatch', targetId: sale?._id ? String(sale._id) : null, targetType: 'sale',
        sessionId: sale?.sessionId ?? null, registerId: sale?.registerId ?? null, shiftId: sale?.shiftId ?? null,
        metadata: { source: 'client', exponent: exp, offline: !!sale?.isOffline, serverTotalMinor: sale?.totalMinor != null ? (typeof sale.totalMinor.toNumber === 'function' ? sale.totalMinor.toNumber() : sale.totalMinor) : null, count: mismatches.length, mismatches: mismatches.slice(0, 10) },
      });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[pos-minor-mismatch] could not record a client mismatch (ignored):', e?.message);
    }
  }

  /** Consistency checker (G1b b): `minor == toMinor(major)` for every pair of a just-written document. NEVER throws and never delays/fails the sale. */
  private async checkMinor(kind: keyof typeof PosService.MINOR_PAIRS, doc: any, exp: number): Promise<MinorMismatch[]> {
    try {
      if (!doc) return [];
      const plain = typeof doc.toObject === 'function' ? doc.toObject({ getters: true, virtuals: false }) : doc;
      const mismatches = checkMinorPairs(plain, PosService.MINOR_PAIRS[kind], exp);
      PosMinorMetrics.record(kind, mismatches.length);
      if (mismatches.length === 0) return [];
      // eslint-disable-next-line no-console
      console.error(`[pos-minor-mismatch] ${kind} ${String(plain._id)}: ${JSON.stringify(mismatches.slice(0, 5))}`);
      try {
        await this.writeAuditLog({
          storeId: String(plain.storeId ?? ''), employeeId: null, action: 'money_minor_mismatch', targetId: plain._id ? String(plain._id) : null, targetType: kind,
          sessionId: plain.sessionId ?? (kind === 'session' ? String(plain._id) : null), registerId: plain.registerId ?? null, shiftId: plain.shiftId ?? null,
          metadata: { exponent: exp, count: mismatches.length, mismatches: mismatches.slice(0, 10) },
        });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[pos-minor-mismatch] audit write failed:', e?.message);
      }
      return mismatches;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[pos-minor-check] checker failed (ignored):', e?.message);
      return [];
    }
  }

  static readonly MINOR_PAIRS = {
    sale: [
      ['subtotal', 'subtotalMinor'], ['discount', 'discountMinor'], ['tax', 'taxMinor'], ['total', 'totalMinor'],
      ['changeGiven', 'changeGivenMinor'], ['paymentShortfall', 'paymentShortfallMinor'], ['refundedAmount', 'refundedAmountMinor'],
      ['items[].price', 'items[].priceMinor'], ['items[].listPrice', 'items[].listPriceMinor'], ['items[].lineTotal', 'items[].lineTotalMinor'],
      ['payments[].amount', 'payments[].amountMinor'], ['payments[].tendered', 'payments[].tenderedMinor'],
      ['refunds[].amount', 'refunds[].amountMinor'],
    ],
    session: [
      ['openingCash', 'openingCashMinor'], ['closingCash', 'closingCashMinor'], ['expectedCash', 'expectedCashMinor'], ['cashDifference', 'cashDifferenceMinor'],
      ['cashSales', 'cashSalesMinor'], ['cardSales', 'cardSalesMinor'], ['otherSales', 'otherSalesMinor'], ['digitalSales', 'digitalSalesMinor'], ['totalSales', 'totalSalesMinor'], ['totalRefunds', 'totalRefundsMinor'],
      ['cashAdjustments[].amount', 'cashAdjustments[].amountMinor'],
      ['cardReconciliation.slipTotal', 'cardReconciliation.slipTotalMinor'], ['cardReconciliation.expectedCard', 'cardReconciliation.expectedCardMinor'], ['cardReconciliation.variance', 'cardReconciliation.varianceMinor'],
    ],
    payment: [['amount', 'amountMinor'], ['tendered', 'tenderedMinor']],
    refund: [['amount', 'amountMinor'], ['tenders[].amount', 'tenders[].amountMinor']],
  } as unknown as Record<'sale' | 'session' | 'payment' | 'refund', Array<[string, string]>>;

  /** card / other are only RECORDED by the cashier today (no terminal integration); cash the cashier physically took is confirmed. */
  private paymentStatus(tender: string): 'confirmed' | 'recorded_unverified' {
    return tender === 'cash' || isDigitalTender(tender) ? 'confirmed' : 'recorded_unverified'; // a digital payment is only ever attached once CONFIRMED
  }

  /**
   * G2.3 — Raast QR lines. A QR line is accepted only when it points at a payment the provider has CONFIRMED (and nothing else):
   * confirmed, unused, unrefunded, in this store and shift, in the sale's currency and for exactly the line's amount. Never offline
   * (a digital payment is proven by the server, not by the till). Checked BEFORE stock is touched; the payment is then marked used
   * inside the sale's transaction (`consumeDigital`). Returns the lines with the provider reference filled in.
   */
  private async verifyDigitalLines<L extends { method: string; amount: number; reference?: string | null; intentId?: string | null }>(
    storeId: string, sessionId: string, lines: L[], money: { currency: string; exp: number }, isOffline: boolean,
  ): Promise<{ lines: L[]; digital: Array<{ intentId: string; providerRef: string }> }> {
    const digital: Array<{ intentId: string; providerRef: string }> = [];
    const hasDigital = lines.some((l) => isDigitalTender(l.method));
    if (!hasDigital) return { lines, digital };
    if (isOffline) throw moneyError('DIGITAL_PAYMENT_ONLINE_ONLY', 'A Raast QR payment cannot be part of an offline sale: it needs the network');
    if (!this.payments) throw new HttpException({ statusCode: 503, code: 'DIGITAL_PAYMENTS_UNAVAILABLE', message: 'Digital payments are not available' }, 503);
    const seen = new Set<string>();
    const out: L[] = [];
    for (const l of lines) {
      if (!isDigitalTender(l.method)) { out.push(l); continue; }
      if (!l.intentId) throw moneyError('PAYMENT_INTENT_REQUIRED', 'A Raast QR line must carry the confirmed payment it settles (intentId)');
      if (seen.has(String(l.intentId))) throw moneyError('PAYMENT_USED_TWICE', 'The same payment cannot settle two lines of one sale');
      seen.add(String(l.intentId));
      const v = await this.payments.verifyForSale(storeId, String(l.intentId), { sessionId, amountMinor: toMinor(l.amount, money.exp), currency: money.currency });
      digital.push({ intentId: v.intentId, providerRef: v.providerRef });
      out.push({ ...l, reference: v.providerRef });
    }
    return { lines: out, digital };
  }

  /** Marks the confirmed payments as belonging to this sale — inside the sale's transaction (one sale per payment, race-safe). */
  private async consumeDigital(storeId: string, digital: Array<{ intentId: string }>, sale: any, tx?: ClientSession): Promise<void> {
    for (const d of digital) await this.payments!.consumeInTx(storeId, d.intentId, { id: String(sale._id), number: sale.saleNumber ?? null }, tx);
  }

  /** One immutable PosPayment per tender line. (saleId, lineNo) and (store, idempotencyKey, lineNo) are unique → a retry cannot add a second row. */
  private async recordPayments(
    sale: any,
    lines: Array<{ method: string; amount: number; tendered?: number | null; reference?: string | null; intentId?: string | null }>,
    ctx: { sessionId: string | null; registerId: string | null; shiftId: string | null; employeeId: string | null },
    tx?: ClientSession,
  ): Promise<void> {
    if (!lines.length) return;
    const deviceId = this.callerDeviceId();
    await this.r.posPaymentModel.insertMany(
      lines.map((l, i) => ({
        saleId: String(sale._id), saleNumber: sale.saleNumber ?? null, lineNo: i,
        tender: l.method, amount: l.amount, tendered: l.tendered ?? null,
        amountMinor: toMinor(l.amount, sale.currencyExponent ?? 2), ...(l.tendered !== undefined && l.tendered !== null ? { tenderedMinor: toMinor(l.tendered, sale.currencyExponent ?? 2) } : {}),
        currency: sale.currency ?? null, currencyExponent: sale.currencyExponent ?? null,
        reference: l.reference ?? null, status: this.paymentStatus(l.method), confirmationSource: isDigitalTender(l.method) ? 'raast' : null, confirmedAt: isDigitalTender(l.method) ? new Date() : null,
        paymentIntentId: isDigitalTender(l.method) ? (l.intentId ?? null) : null,
        storeId: sale.storeId, registerId: ctx.registerId, sessionId: ctx.sessionId, shiftId: ctx.shiftId, deviceId, employeeId: ctx.employeeId,
        ...(sale.idempotencyKey ? { idempotencyKey: sale.idempotencyKey } : {}),
      })),
      tx ? { session: tx, ordered: true } : { ordered: true },
    );
  }

  // ── REGISTER CRUD EXTENSIONS ──────────────────────────────────────────────

  async listRegisters(sellerId: string, storeId: string) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    return { success: true, count: store.registers.length, data: store.registers };
  }

  async getRegisterById(sellerId: string, storeId: string, registerId: string) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const register = store.registers.find((r: any) => r._id.toString() === registerId);
    if (!register) throw new NotFoundException('Register not found');
    return { success: true, data: register };
  }

  async updateRegister(sellerId: string, storeId: string, registerId: string, dto: UpdateRegisterDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const store = await this.r.storeModel.findOne({ _id: storeId, 'registers._id': registerId });
    if (!store) throw new NotFoundException('Register not found');
    if (dto.locationId !== undefined) await this.assertLocationBelongsToStore(storeId, dto.locationId);

    const setFields: any = {};
    if (dto.name !== undefined) setFields['registers.$.name'] = dto.name;
    if (dto.defaultFloatCash !== undefined) {
      setFields['registers.$.defaultFloatCash'] = dto.defaultFloatCash;
      setFields['registers.$.defaultFloatCashMinor'] = toMinor(dto.defaultFloatCash, isoExponent((store as any).baseCurrency));
    }
    if (dto.status !== undefined) setFields['registers.$.status'] = dto.status;
    if (dto.locationId !== undefined) setFields['registers.$.locationId'] = dto.locationId;

    const updated = await this.r.storeModel.findOneAndUpdate(
      { _id: storeId, 'registers._id': registerId },
      { $set: setFields },
      { new: true },
    );

    const register = updated?.registers.find((r: any) => r._id.toString() === registerId);
    return { success: true, message: 'Register updated', data: register };
  }

  // ── SHIFT CRUD EXTENSIONS ─────────────────────────────────────────────────

  async listShifts(sellerId: string, storeId: string) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    return { success: true, count: store.shifts.length, data: store.shifts };
  }

  async getShiftById(sellerId: string, storeId: string, shiftId: string) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const shift = store.shifts.find((s: any) => s._id.toString() === shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    return { success: true, data: shift };
  }

  async updateShift(sellerId: string, storeId: string, shiftId: string, dto: UpdateShiftDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const store = await this.r.storeModel.findOne({ _id: storeId, 'shifts._id': shiftId });
    if (!store) throw new NotFoundException('Shift not found');

    const setFields: any = {};
    if (dto.name !== undefined) setFields['shifts.$.name'] = dto.name;
    if (dto.startTime !== undefined) setFields['shifts.$.startTime'] = dto.startTime;
    if (dto.endTime !== undefined) setFields['shifts.$.endTime'] = dto.endTime;
    if (dto.daysOfWeek !== undefined) setFields['shifts.$.daysOfWeek'] = dto.daysOfWeek;
    if (dto.status !== undefined) setFields['shifts.$.status'] = dto.status;

    const updated = await this.r.storeModel.findOneAndUpdate(
      { _id: storeId, 'shifts._id': shiftId },
      { $set: setFields },
      { new: true },
    );

    const shift = updated?.shifts.find((s: any) => s._id.toString() === shiftId);
    return { success: true, message: 'Shift updated', data: shift };
  }

  async deleteShift(sellerId: string, storeId: string, shiftId: string, force = false) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const assignedCount = await this.r.employeeModel.countDocuments({ storeId, shiftIds: shiftId, isDelete: false });
    if (assignedCount > 0 && !force) {
      throw new BadRequestException(
        `${assignedCount} employee(s) are assigned to this shift. Use force=true to remove anyway.`,
      );
    }

    if (assignedCount > 0 && force) {
      await this.r.employeeModel.updateMany(
        { storeId, shiftIds: shiftId },
        { $pull: { shiftIds: shiftId } },
      );
    }

    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $pull: { shifts: { _id: shiftId } } },
      { new: true },
    );

    return { success: true, message: 'Shift removed', data: updated?.shifts };
  }

  // ── EMPLOYEE EXTENSIONS ───────────────────────────────────────────────────

  async getEmployeeById(sellerId: string, storeId: string, employeeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel
      .findOne({ _id: employeeId, storeId, isDelete: false })
      .select('-pin')
      .lean();
    if (!employee) throw new NotFoundException('Employee not found');
    return { success: true, data: employee };
  }

  async updateEmployeeV2(sellerId: string, storeId: string, employeeId: string, dto: UpdateEmployeeDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');
    if (dto.locationId !== undefined) await this.assertLocationBelongsToStore(storeId, dto.locationId);

    const updateData: any = { ...dto };
    if (dto.pin) {
      updateData.pin = await bcrypt.hash(dto.pin, 10);
      updateData.pinFailedAttempts = 0;
      updateData.pinLockedUntil = null;
    }

    const updated = await this.r.employeeModel
      .findByIdAndUpdate(employeeId, { $set: updateData }, { new: true })
      .select('-pin');

    if (dto.pin || (dto as any).status === 'inactive') await this.revocations?.revokeEmployee(employeeId);
    await this.writeAuditLog({ storeId, employeeId: null, action: 'employee_updated', targetId: employeeId, targetType: 'employee', metadata: { fields: Object.keys(dto) } });

    return { success: true, message: 'Employee updated', data: updated };
  }

  async removeEmployeeV2(sellerId: string, storeId: string, employeeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const activeSession = await this.r.registerSessionModel.findOne({ employeeId, status: 'open' });
    if (activeSession) throw new BadRequestException('Employee has an open session — close it first');

    await this.r.employeeModel.findByIdAndUpdate(employeeId, { isDelete: true, status: 'inactive' });
    await this.revocations?.revokeEmployee(employeeId);

    await this.writeAuditLog({ storeId, employeeId: null, action: 'employee_deactivated', targetId: employeeId, targetType: 'employee' });
    return { success: true, message: 'Employee deactivated' };
  }

  async resetPin(sellerId: string, storeId: string, employeeId: string, dto: ResetPinDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const hashedPin = await bcrypt.hash(dto.newPin, 10);
    await this.r.employeeModel.findByIdAndUpdate(employeeId, { pin: hashedPin, pinFailedAttempts: 0, pinLockedUntil: null });
    await this.revocations?.revokeEmployee(employeeId); // sessions opened with the OLD pin end now

    await this.writeAuditLog({ storeId, employeeId: null, action: 'employee_pin_reset', targetId: employeeId, targetType: 'employee' });
    return { success: true, message: 'PIN reset successfully' };
  }

  // ── SESSION EXTENSIONS ────────────────────────────────────────────────────

  async forceCloseSession(sellerId: string, sessionId: string, dto: ForceCloseSessionDto) {
    const session = await this.r.registerSessionModel.findOne({ _id: sessionId, status: 'open' });
    if (!session) throw new NotFoundException('Open session not found');

    await this.verifyStoreOwnership((session as any).storeId, sellerId);

    const adjustments = (session as any).cashAdjustments || [];
    const cashIn = adjustments.filter((a: any) => a.type === 'cash_in').reduce((s: number, a: any) => s + a.amount, 0);
    const cashOut = adjustments.filter((a: any) => a.type === 'cash_out').reduce((s: number, a: any) => s + a.amount, 0);
    const { exp: forceExp } = await this.docMoney(session);
    const expectedCash = roundMoney(session.openingCash + session.cashSales + cashIn - cashOut, forceExp);

    // status-guarded like closeSession: a force close racing the cashier's own close must not overwrite the counted cash
    const updated = await this.r.registerSessionModel.findOneAndUpdate(
      { _id: sessionId, status: 'open' },
      {
        $set: {
          status: 'closed',
          closedAt: new Date(),
          expectedCash,
          expectedCashMinor: toMinor(expectedCash, forceExp),
          closingCash: null,
          cashDifference: null,
          forceClosedBy: sellerId,
          forceCloseReason: dto.reason ?? 'Force closed by store owner',
          forceCloseAt: new Date(),
        },
      },
      { new: true },
    );
    if (!updated) throw businessConflict('SESSION_ALREADY_CLOSED', 'This session was already closed');

    await this.writeAuditLog({ storeId: (session as any).storeId, employeeId: null, action: 'session_force_closed', targetId: sessionId, targetType: 'session', metadata: { reason: dto.reason } });
    return { success: true, message: 'Session force-closed', data: updated };
  }

  // ── PRODUCT BARCODE LOOKUP ────────────────────────────────────────────────

  async getProductByBarcode(sellerId: string, storeId: string, barcode: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    // G2.6: a barcode is unique per STORE, not globally — several stores may use the same code, so pick the match that belongs to THIS store
    const candidates: any[] = await this.r.productVariantModel.find({ barcode, isDelete: false, status: 'active' }).limit(50).lean();
    if (!candidates.length) throw new NotFoundException(`No product found with barcode: ${barcode}`);
    let variant: any = null; let product: any = null;
    for (const c of candidates) {
      if (c.storeId && String(c.storeId) !== storeId) continue;
      const p = await this.r.productModel.findOne({ _id: c.productId, storeId, isDelete: false, status: 'active' }).select('_id name type gallery coverImages').lean();
      if (p) { variant = c; product = p; break; }
    }
    if (!product) throw new NotFoundException('Product not found in this store');

    return {
      success: true,
      data: {
        productId: (product as any)._id,
        name: (product as any).name,
        type: (product as any).type,
        image: (product as any).gallery?.[0] ?? (product as any).coverImages?.[0] ?? null,
        variant: {
          variantId: (variant as any)._id,
          sku: (variant as any).sku,
          barcode: (variant as any).barcode,
          price: (variant as any).price,
          compareAtPrice: (variant as any).compareAtPrice,
          stock: (variant as any).stock,
          unlimitedStock: (variant as any).unlimitedStock === true,
          options: (variant as any).options,
          isDefault: (variant as any).isDefault,
        },
      },
    };
  }

  // ── SALES EXTENSIONS ──────────────────────────────────────────────────────

  async voidSale(sellerId: string, saleId: string, dto: { reason?: string; reasonCode?: string; registerId?: string }, employeeToken: string | undefined) {
    const voidReason = normalizeReason('void', dto?.reasonCode, dto?.reason);
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'completed') {
      throw new BadRequestException(`Cannot void a sale with status '${(sale as any).status}'`);
    }

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    const actor = await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'void sales');

    // Claim the void with a status-guarded update first; only the request that wins the
    // `completed → voided` transition restores stock and reverses the session totals.
    await this.ensureSettings(String((sale as any).storeId));
    const { exp: cnExp, currency: cnCurrency } = await this.docMoney(sale);
    // G3.0: a void pays the customer back at the till the manager is standing at — same shift rule as a refund
    const voidRegisterId: string | null = dto?.registerId ?? (sale as any).registerId ?? null;
    const voidNow: any = voidRegisterId ? await this.r.registerSessionModel.findOne({ registerId: voidRegisterId, storeId: (sale as any).storeId, status: 'open' }) : null;
    const voidCash = effectivePayments(sale as any).some((l: any) => l.method === 'cash' && l.amount > 0);
    if (voidRegisterId && dto?.registerId && voidCash && !voidNow) throw businessConflict('OPEN_SHIFT_REQUIRED', 'Open a shift on this register before paying a cash refund');
    const voidShift = await this.refundShiftFor(sale, voidNow);
    const voidCtx = { sessionId: voidShift ? String(voidShift._id) : null, registerId: voidRegisterId, shiftId: voidShift?.shiftId ?? null };
    let voidCreditNote: any = null;
    const claimed = await this.atomic(async (tx) => {
      const c = await this.r.saleModel.findOneAndUpdate(
        { _id: saleId, status: 'completed' },
        { $set: { status: 'voided', voidedAt: new Date(), voidedBy: actor.employeeId, voidReason: voidReason.note, voidReasonCode: voidReason.code } },
        tx ? { session: tx } : undefined,
      );
      if (!c) return null;
      // G2.5: a void is a full return — it produces a credit note too (every line, restocked)
      const bdv = this.saleBreakdown(sale as any, cnExp);
      voidCreditNote = await this.createCreditNote(tx, {
        sale: sale as any, kind: 'void', scope: 'full', refundId: null, reason: voidReason, exp: cnExp, currency: cnCurrency,
        lines: (sale as any).items.map((it: any, idx: number) => ({ idx, qty: it.qty, a: returnLineAmounts(bdv[idx], it.qty, 0, it.qty), restock: !it.isCustom, restockReason: null })),
        tenders: effectivePayments(sale as any).map((l: any) => ({ method: l.method, amountMinor: toMinor(l.amount, cnExp) })), actorId: actor.employeeId, approvedBy: actor.employeeId, approvalReasons: [],
        ctx: voidCtx,
      });
      await this.recordMovements(tx, { type: 'void', refType: 'void', refId: saleId, storeId: String((sale as any).storeId), locationId: (sale as any).locationId ?? null, ctx: { employeeId: actor.employeeId, registerId: voidRegisterId, sessionId: voidShift ? String(voidShift._id) : null },
        lines: ((sale as any).items as any[]).map((it: any, idx: number) => ({ lineKey: String(idx), variantId: it.variantId, productId: it.productId, name: it.name, sku: it.sku, qty: it.qty - 0, unitCostMinor: it.unitCostMinor ?? null, isCustom: !!it.isCustom })) });
      await this.writeAuditLog({
        storeId: (sale as any).storeId, employeeId: actor.employeeId, action: 'sale_voided', targetId: saleId, targetType: 'sale',
        ...voidCtx, metadata: { reason: voidReason.note, reasonCode: voidReason.code, saleSessionId: (sale as any).sessionId ?? null, saleRegisterId: (sale as any).registerId ?? null },
      }, tx);
      return c;
    });
    if (!claimed) throw businessConflict('SALE_CHANGED_CONCURRENTLY', 'This sale was already voided or refunded');

    await this.restoreSoldStock(
      (sale as any).items.filter((item: any) => !item.isCustom).map((item: any) => ({ variantId: String(item.variantId), qty: item.qty })),
      (sale as any).locationId ?? null,
    );

    // A void reverses the whole sale: total and per-tender nets (cash net of change) come out of the session.
    const { exp: voidExp } = await this.docMoney(sale);
    const voidNets = tenderNets({ ...(sale as any).toObject?.() ?? sale, refundedAmount: 0, status: 'completed' }, voidExp);
    // On the shift that paid it. Same shift as the sale: exactly as before. Another shift: it books a refund there and the sale's own shift is untouched.
    const voidSame = !!voidShift && String(voidShift._id) === String((sale as any).sessionId);
    const voidInc: any = voidSame
      ? { totalSales: -(sale as any).total, totalTransactions: -1, ...this.tenderInc(voidNets, -1) }
      : { totalRefunds: (sale as any).total, totalSales: -(sale as any).total, ...this.tenderInc(voidNets, -1) };
    const voidedSession = voidShift ? await this.incSessionCounters(String(voidShift._id), voidInc, voidExp) : null;
    if (voidedSession) await this.checkMinor('session', voidedSession, voidExp);

    await this.recordPosRefundInLedger(sale, (sale as any).total - ((sale as any).refundedAmount || 0), 'void');

    // G2.3: voiding a sale that was paid by Raast QR sends that money back through the provider
    const voidPlan = this.payments ? digitalRefundPlan(effectivePayments(sale as any) as any, 0, (sale as any).total, voidExp) : [];
    const digitalRefunds = voidPlan.length ? await this.payments!.refundForSale(String((sale as any).storeId), voidPlan, { employeeId: actor.employeeId, refundId: `void-${saleId}`, reason: dto.reason?.trim() ?? 'void' }) : undefined;
    return { success: true, message: 'Sale voided and stock restored', data: { ...(digitalRefunds ? { digitalRefunds } : {}), creditNote: voidCreditNote ? { id: String(voidCreditNote._id), number: voidCreditNote.number, totalMinor: voidCreditNote.totalMinor } : null } };
  }

  async editHeldSaleItems(sellerId: string, saleId: string, dto: UpdateSaleItemsDto, employeeToken: string | undefined) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be edited');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    const discountReq = this.discountSpec(dto, sale);
    if (discountReq.value > 0) {
      await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'apply a discount');
    }

    const saleItems: any[] = [];

    for (const item of dto.items) {
      if (item.isCustom) { saleItems.push(this.customLine(item, await this.defaultTaxCategory(String((sale as any).storeId)))); continue; }
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);

      const product = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name gallery coverImages');
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);

      saleItems.push({
        productId: item.productId,
        variantId: item.variantId,
        name: `${(product as any).name}${formatOptionsSuffix((variant as any).options)}`,
        sku: variant.sku,
        image: (product as any).gallery?.[0] ?? (product as any).coverImages?.[0] ?? null,
        price: variant.price,
        qty: item.qty,
        lineTotal: 0,
        refundedQty: 0,
      });
    }

    const money = await this.moneyContext(String((sale as any).storeId));
    await this.approveCustomItems(String((sale as any).storeId), saleItems, money.exp, employeeToken);
    const totals = computeTotals(this.taxLines(saleItems), { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    saleItems.forEach((it, i) => { it.lineTotal = totals.lineTotals[i]; });

    const updated = await this.r.saleModel.findByIdAndUpdate(
      saleId,
      {
        $set: {
          items: this.itemsMinor(saleItems, totals, money.exp), subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
          ...this.saleMoneyMinor(totals, discountReq, money.exp),
          currency: money.currency, currencyExponent: money.exp, taxRate: money.taxRate,
          discountType: discountReq.value > 0 ? discountReq.type : null, discountValue: discountReq.value > 0 ? discountReq.value : null,
        },
      },
      { new: true },
    );

    await this.checkMinor('sale', updated, money.exp);
    return { success: true, message: 'Held sale items updated', data: updated };
  }

  // ── REPORTS EXTENSIONS ────────────────────────────────────────────────────

  async getDateRangeReport(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { currency, exp } = await this.moneyContext(storeId);

    if (!query.from || !query.to) throw new BadRequestException('from and to date are required');

    const from = new Date(query.from);
    const to = new Date(query.to);
    to.setHours(23, 59, 59, 999);

    const scope: any = { storeId, createdAt: { $gte: from, $lte: to }, ...(query.locationId ? { locationId: query.locationId } : {}) };
    const sales = await this.r.saleModel.find({ ...scope, status: { $in: ['completed', 'partially_refunded'] } }).lean();
    const reversed = await this.r.saleModel.find({ ...scope, status: { $in: ['refunded', 'voided'] } }).lean();
    const summary = this.summarizeSales(sales, reversed, exp);

    const dailyMap: Record<string, number> = {};
    const productSales: Record<string, { name: string; qty: number; revenue: number }> = {};
    for (const sale of sales) {
      const day = new Date((sale as any).createdAt).toISOString().split('T')[0];
      dailyMap[day] = roundMoney((dailyMap[day] || 0) + (sale as any).total, exp);
      for (const item of (sale as any).items) {
        if (!productSales[item.productId]) productSales[item.productId] = { name: item.name, qty: 0, revenue: 0 };
        productSales[item.productId].qty += item.qty;
        productSales[item.productId].revenue = roundMoney(productSales[item.productId].revenue + item.lineTotal, exp);
      }
    }

    const topProducts = Object.entries(productSales)
      .map(([productId, d]) => ({ productId, ...d }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const { byPayment, ...flat } = summary;
    return {
      success: true,
      data: {
        from: query.from,
        to: query.to,
        currency,
        currencyExponent: exp,
        summary: flat,
        byPaymentMethod: byPayment,
        topProducts,
        dailyBreakdown: Object.entries(dailyMap).map(([date, total]) => ({ date, total })).sort((a, b) => a.date.localeCompare(b.date)),
      },
    };
  }

  async getRegisterReport(sellerId: string, registerId: string, query: any) {
    const store = await this.r.storeModel.findOne({ sellerId, isDelete: false, 'registers._id': registerId });
    if (!store) throw new NotFoundException('Register not found or unauthorized');

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? (() => { const d = new Date(query.to); d.setHours(23, 59, 59, 999); return d; })() : null;

    const sessionFilter: any = { registerId };
    if (from || to) { sessionFilter.createdAt = {}; if (from) sessionFilter.createdAt.$gte = from; if (to) sessionFilter.createdAt.$lte = to; }

    const sessions = await this.r.registerSessionModel.find(sessionFilter).lean();
    const sessionIds = sessions.map((s: any) => s._id.toString());

    const salesFilter: any = { registerId, status: { $in: ['completed', 'partially_refunded'] } };
    if (from || to) { salesFilter.createdAt = {}; if (from) salesFilter.createdAt.$gte = from; if (to) salesFilter.createdAt.$lte = to; }

    const sales = await this.r.saleModel.find(salesFilter).lean();

    const regExp = exponentOf((store as any).baseCurrency);
    const totalRevenue = roundMoney(sales.reduce((s: number, sale: any) => s + sale.total, 0), regExp);
    const register = store.registers.find((r: any) => r._id.toString() === registerId);

    return {
      success: true,
      data: {
        register,
        period: { from: query.from ?? null, to: query.to ?? null },
        summary: {
          totalSessions: sessions.length,
          totalTransactions: sales.length,
          totalRevenue,
          avgPerSession: sessions.length > 0 ? roundMoney(totalRevenue / sessions.length, regExp) : 0,
        },
        sessions: sessions.map((s: any) => ({
          sessionId: s._id,
          employeeId: s.employeeId,
          openedAt: s.openedAt,
          closedAt: s.closedAt,
          totalSales: s.totalSales,
          totalTransactions: s.totalTransactions,
          status: s.status,
        })),
      },
    };
  }

  async getEmployeeReport(sellerId: string, employeeId: string, query: any) {
    if (!query.storeId) throw new BadRequestException('storeId is required');
    await this.verifyStoreOwnership(query.storeId, sellerId);

    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId: query.storeId, isDelete: false }).select('-pin').lean();
    if (!employee) throw new NotFoundException('Employee not found');

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? (() => { const d = new Date(query.to); d.setHours(23, 59, 59, 999); return d; })() : null;

    const filter: any = { employeeId, storeId: query.storeId, status: { $in: ['completed', 'partially_refunded'] } };
    if (from || to) { filter.createdAt = {}; if (from) filter.createdAt.$gte = from; if (to) filter.createdAt.$lte = to; }

    const sales = await this.r.saleModel.find(filter).lean();
    const empMoney = await this.moneyContext(query.storeId);
    const totalRevenue = roundMoney(sales.reduce((s: number, sale: any) => s + sale.total, 0), empMoney.exp);

    const sessionFilter: any = { employeeId, storeId: query.storeId };
    if (from || to) { sessionFilter.createdAt = {}; if (from) sessionFilter.createdAt.$gte = from; if (to) sessionFilter.createdAt.$lte = to; }
    const sessions = await this.r.registerSessionModel.find(sessionFilter).lean();

    return {
      success: true,
      data: {
        employee,
        period: { from: query.from ?? null, to: query.to ?? null },
        summary: {
          totalTransactions: sales.length,
          totalRevenue,
          avgTransactionValue: sales.length > 0 ? roundMoney(totalRevenue / sales.length, empMoney.exp) : 0,
          totalSessions: sessions.length,
        },
        recentSales: sales.slice(0, 20).map((s: any) => ({ saleId: s._id, saleNumber: s.saleNumber, total: s.total, paymentMethod: s.paymentMethod, createdAt: s.createdAt })),
      },
    };
  }

  async exportDailyReportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { currency, exp } = await this.moneyContext(storeId);

    const date = query.date ? new Date(query.date) : new Date();
    const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);

    const sales = await this.r.saleModel.find({
      storeId,
      status: { $in: ['completed', 'partially_refunded', 'refunded', 'voided'] },
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    // amounts are written with exactly the currency's decimals (JPY 0, USD 2, KWD 3), never a fixed 2
    const money = (n: number) => Number(n || 0).toFixed(exp);
    const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Sale Number', 'Date', 'Employee', 'Status', 'Payment', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'Refunded', 'Change Given', 'Customer'].join(',')];

    for (const sale of sales) {
      const used = effectivePayments(sale as any);
      const payment = used.map((l) => `${l.method} ${money(l.amount)}`).join(' + ');
      rows.push([
        csvCell((sale as any).saleNumber),
        new Date((sale as any).createdAt).toISOString(),
        csvCell((sale as any).employeeName ?? (sale as any).employeeId),
        (sale as any).status,
        csvCell(payment),
        (sale as any).currency ?? currency,
        money((sale as any).subtotal),
        money((sale as any).discount),
        money((sale as any).tax),
        money((sale as any).total),
        money((sale as any).refundedAmount || 0),
        money((sale as any).changeGiven || 0),
        csvCell((sale as any).customerName || ''),
      ].join(','));
    }

    return rows.join('\n');
  }

  // ── POS SETTINGS ──────────────────────────────────────────────────────────

  async getPosSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    let settings: any = await this.r.posSettingsModel.findOne({ storeId }).lean();
    if (!settings) {
      settings = (await this.r.posSettingsModel.create({ storeId })).toObject();
    }

    // The authoritative selling currency comes from the store, not from the free-text `currencySymbol`.
    await this.ensureVersionRow(storeId);
    const { currency, exp } = await this.moneyContext(storeId);
    return { success: true, data: { ...settings, autoLockMinutes: settings.autoLockMinutes ?? 5, settingsVersion: settings.settingsVersion || 1, currency, currencyExponent: exp } };
  }

  async updatePosSettings(sellerId: string, storeId: string, dto: UpdatePosSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const existing: any = await this.r.posSettingsModel.findOne({ storeId }).lean();
    const taxChanged = dto.taxRate !== undefined && existing && Number(existing.taxRate) !== Number(dto.taxRate);

    let settings: any;
    if (taxChanged) {
      // A change to how sales are priced bumps settingsVersion and keeps the old values, so devices that priced a
      // sale (possibly offline) with the previous version can still be honoured. Optimistic on the version so two
      // concurrent edits can't both claim the same number.
      await this.ensureVersionRow(storeId);
      const curVersion = existing.settingsVersion ?? 1;
      settings = await this.r.posSettingsModel.findOneAndUpdate(
        { storeId, settingsVersion: existing.settingsVersion === undefined ? { $exists: false } : existing.settingsVersion },
        { $set: { ...dto, settingsVersion: curVersion + 1 } },
        { new: true },
      );
      if (!settings) throw businessConflict('SETTINGS_CHANGED_CONCURRENTLY', 'The POS settings were changed by someone else — reload and try again');
      const ctx = await this.moneyContext(storeId);
      const now = new Date();
      await this.r.posSettingsVersionModel.updateOne({ storeId, version: curVersion }, { $set: { supersededAt: now } });
      await this.r.posSettingsVersionModel.updateOne(
        { storeId, version: settings.settingsVersion },
        { $setOnInsert: { storeId, version: settings.settingsVersion, taxRate: Number(settings.taxRate) || 0, currency: ctx.currency, currencyExponent: ctx.exp, effectiveFrom: now, supersededAt: null } },
        { upsert: true },
      );
    } else {
      settings = await this.r.posSettingsModel.findOneAndUpdate({ storeId }, { $set: dto }, { new: true, upsert: true });
    }

    await this.writeAuditLog({ storeId, employeeId: null, action: 'settings_updated', targetId: storeId, targetType: 'settings', metadata: { fields: Object.keys(dto), settingsVersion: settings?.settingsVersion } });

    return { success: true, message: 'POS settings updated', data: settings };
  }

  // ── AUDIT LOGS ────────────────────────────────────────────────────────────

  async getAuditLogs(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.action) filter.action = query.action;
    if (query.targetType) filter.targetType = query.targetType;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) { const t = new Date(query.to); t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
    }

    const total = await this.r.posAuditLogModel.countDocuments(filter);
    const logs = await this.r.posAuditLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs,
      },
    };
  }
}
