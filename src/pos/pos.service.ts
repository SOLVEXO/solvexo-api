/* eslint-disable prettier/prettier */
import {
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
import { Types } from 'mongoose';
import { searchStoreCustomers } from '@/common/store-customer-search.util';
import {
  allocateRefund, assertClientTotal, byTender, computeTotals, DiscountType, effectivePayments, exponentOf, fromMinor,
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

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
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
  private async verifyEmployeeToken(token: string | undefined, storeId: string, at?: Date): Promise<{ employeeId: string; role: string; jti?: string } | null> {
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
  private async requireManagerEmployee(token: string | undefined, storeId: string, actionLabel: string, at?: Date): Promise<{ employeeId: string; role: string }> {
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
        this.writeAuditLog({ storeId: dto.storeId, employeeId: String(employee._id), action: 'pin_locked', targetId: String(employee._id), targetType: 'employee' }).catch(() => {});
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

    this.writeAuditLog({ storeId: dto.storeId, employeeId: String(employee._id), action: 'pin_login', targetId: String(employee._id), targetType: 'employee' }).catch(() => {});

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
      this.writeAuditLog({ storeId, employeeId: actor.employeeId, action: 'pin_logout', targetId: actor.employeeId, targetType: 'employee' }).catch(() => {});
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

    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { registers: { name: body.name, defaultFloatCash: body.defaultFloatCash ?? 100, status: 'active', locationId: body.locationId ?? null } } },
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
        status: 'open',
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new BadRequestException('Register already has an open session');
      throw err;
    }

    this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: 'session_opened', targetId: String(session._id), targetType: 'session', metadata: { registerId: dto.registerId, openingCash: dto.openingCash } }).catch(() => {});

    return { success: true, message: 'Register session opened', data: session };
  }

  async closeSession(sellerId: string, dto: CloseSessionDto) {
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

    // status-guarded so two close requests (retry / two terminals) can't both close and double-audit
    const updated = await this.r.registerSessionModel.findOneAndUpdate(
      { _id: dto.sessionId, status: 'open' },
      { $set: { closingCash, expectedCash, cashDifference, closedAt: new Date(), status: 'closed' } },
      { new: true },
    );
    if (!updated) throw businessConflict('SESSION_ALREADY_CLOSED', 'This session was already closed');

    this.writeAuditLog({ storeId: (session as any).storeId, employeeId: (session as any).employeeId, action: 'session_closed', targetId: dto.sessionId, targetType: 'session', metadata: { closingCash, expectedCash, cashDifference } }).catch(() => {});

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
      for (const method of ['cash', 'card', 'other'] as const) {
        if (used.some((l) => l.method === method)) {
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
          refundsCount: refunded.length + sales.filter((r: any) => (r.refundedAmount || 0) > 0).length,
          refundsTotal,
          byPaymentMethod: byPayment,
          cashFlow: {
            openingCash: (session as any).openingCash,
            cashSales: (session as any).cashSales,
            cashIn,
            cashOut,
            expectedCash: (session as any).expectedCash,
            closingCash: (session as any).closingCash ?? null,
            cashDifference: (session as any).cashDifference,
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
    const adjustment = { type: dto.type, amount: roundMoney(dto.amount, adjExp), reason: dto.reason, employeeId: actor.employeeId, createdAt: new Date() };

    await this.r.registerSessionModel.findByIdAndUpdate(
      sessionId,
      { $push: { cashAdjustments: adjustment } },
    );

    this.writeAuditLog({ storeId: (session as any).storeId, employeeId: actor.employeeId, action: dto.type, targetId: sessionId, targetType: 'session', metadata: { amount: dto.amount, reason: dto.reason } }).catch(() => {});

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
    const discountReq = this.discountSpec(dto);
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
        lineTotal: 0, // set below from the server-computed, exponent-rounded line totals
      });
    }

    // The SERVER prices the sale: line totals, discount, tax and total are computed here in the store
    // currency's minor units; any client-sent `tax`/totals are ignored. A client total that disagrees
    // beyond one minor unit is rejected (TOTAL_MISMATCH) rather than charging a number nobody saw.
    // The tax rate comes from the settingsVersion the device priced with (when still within the offline window).
    const money = await this.moneyContext(dto.storeId, { version: dto.settingsVersion });
    const totals = computeTotals(saleItems, { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
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
    const settled = isHeld
      ? null
      : settlePayments(totals.minor.total, money.exp, { payments: dto.payments, paymentMethod: dto.paymentMethod, amountTendered: dto.amountTendered, reference: dto.paymentReference }, { allowShort: off.isOffline });
    if (settled && settled.shortBy > 0) flags.push({ type: 'payment_shortfall', detail: { shortBy: settled.shortBy, serverTotal: total } });

    // Take the stock first (all-or-nothing, floor-guarded). A completed sale only exists once its
    // stock has genuinely been taken; if recording the sale then fails, the stock is handed back.
    const sessionLocationId: string | null = (session as any).locationId ?? null;
    let reserved: Array<{ variantId: string; qty: number }> = [];
    const oversold: Array<{ variantId: string; sku?: string; requested: number; available: number }> = [];
    if (!isHeld) {
      try {
        reserved = await this.reserveStock(dto.items.map((i, idx) => ({ variantId: i.variantId, qty: i.qty, sku: saleItems[idx].sku })), sessionLocationId, { allowNegative: off.isOffline, oversold });
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
    let sale: any;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const saleNumber = await this.generateSaleNumber(dto.storeId);
        try {
          sale = await this.r.saleModel.create({
            saleNumber,
            storeId: dto.storeId,
            sessionId: dto.sessionId,
            registerId: dto.registerId,
            locationId: sessionLocationId,
            employeeId: dto.employeeId,
            items: saleItems,
            subtotal,
            discount,
            tax,
            total,
            currency: money.currency,
            currencyExponent: money.exp,
            discountType: discountReq.value > 0 ? discountReq.type : null,
            discountValue: discountReq.value > 0 ? discountReq.value : null,
            taxRate: money.taxRate,
            paymentMethod: settled ? settled.method : dto.paymentMethod,
            payments: settled ? settled.lines : [],
            changeGiven: settled ? settled.change : 0,
            paymentShortfall: settled ? settled.shortBy : 0,
            employeeName: (employee as any).name ?? null,
            settingsVersion: money.settingsVersion,
            approvedBy: approver?.employeeId ?? null,
            approvedAt: approver ? (off.isOffline ? off.at : new Date()) : null,
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
          });
          break;
        } catch (err: any) {
          if (err?.code === 11000 && err?.keyPattern?.saleNumber && attempt < 4) continue;
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

    this.writeAuditLog({
      storeId: dto.storeId,
      employeeId: dto.employeeId,
      action: isHeld ? 'sale_held' : 'sale_created',
      targetId: String(sale._id),
      targetType: 'sale',
      metadata: { total, discount, itemCount: dto.items.length, ...(off.isOffline ? { offline: true, clientCreatedAt: off.at, settingsVersion: money.settingsVersion, sessionClosed: (session as any).status === 'closed' } : {}) },
    }).catch(() => {});

    if (off.isOffline) {
      // Every flagged offline sale leaves a trail a manager can find: audit log (POS) + inventory activity (store).
      for (const f of sale.flags ?? []) {
        this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: f.type === 'oversold_on_sync' ? 'sale_oversold_offline' : `sale_flag_${f.type}`, targetId: String(sale._id), targetType: 'sale', metadata: f.detail }).catch(() => {});
      }
      if (approverGone) {
        this.writeAuditLog({ storeId: dto.storeId, employeeId: dto.employeeId, action: 'offline_approver_deactivated', targetId: String(sale._id), targetType: 'sale', metadata: { approvedBy: approver!.employeeId, clientCreatedAt: off.at } }).catch(() => {});
      }
      for (const o of oversold) {
        void this.activityLogService.log({
          storeId: dto.storeId, category: 'inventory', action: 'inventory_oversell',
          description: `Offline sale ${sale.saleNumber} sold ${o.requested} of "${o.sku ?? o.variantId}" but only ${o.available} were in stock — stock is now negative`,
          actorId: dto.employeeId, actorRole: 'pos_employee', targetId: o.variantId, targetType: 'variant', metadata: { saleId: String(sale._id), ...o },
        });
      }
    }

    return { success: true, message: isHeld ? 'Sale put on hold' : 'Sale completed', data: sale };
  }

  async completeSale(sellerId: string, saleId: string, dto: CompleteSaleDto, employeeToken: string | undefined) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be completed');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // Completion re-prices from the held lines with the CURRENT tax rate and the (possibly changed) discount.
    const discountReq = this.discountSpec(dto, sale);
    if (discountReq.value > 0) {
      await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'apply a discount');
    }

    // friendly pre-check against real availability (see ProductVariant.committedStock); the
    // authoritative, race-proof check is the atomic reserveStock below
    for (const item of (sale as any).items) {
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant no longer available: ${item.sku}`);
      const availableForPos = availableStock(variant as any);
      if (!variant.unlimitedStock && availableForPos < item.qty) {
        throw new BadRequestException(`Insufficient stock for "${item.sku}" — available: ${availableForPos}`);
      }
    }

    const money = await this.moneyContext(String((sale as any).storeId), { version: dto.settingsVersion });
    const totals = computeTotals((sale as any).items, { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    assertClientTotal(dto.clientTotal, totals);
    const settled = settlePayments(totals.minor.total, money.exp, { payments: dto.payments, paymentMethod: dto.paymentMethod, amountTendered: dto.amountTendered, reference: dto.paymentReference });
    const { discount, tax, total } = totals;
    const locationId: string | null = (sale as any).locationId ?? null;

    // Stock first, then claim the held sale with a status-guarded update: if two terminals (or a
    // retry) both get here, exactly one wins the `held → completed` transition; the loser gives
    // its stock back and is told the sale is already gone. No double decrement, no double count.
    const reserved = await this.reserveStock(
      (sale as any).items.map((i: any) => ({ variantId: String(i.variantId), qty: i.qty, sku: i.sku })),
      locationId,
    );

    const updated = await this.r.saleModel.findOneAndUpdate(
      { _id: saleId, status: 'held' },
      {
        $set: {
          status: 'completed',
          paymentMethod: settled.method,
          payments: settled.lines,
          changeGiven: settled.change,
          subtotal: totals.subtotal,
          discount,
          tax,
          total,
          currency: money.currency,
          currencyExponent: money.exp,
          discountType: discountReq.value > 0 ? discountReq.type : null,
          discountValue: discountReq.value > 0 ? discountReq.value : null,
          taxRate: money.taxRate,
          settingsVersion: money.settingsVersion,
          heldAt: null,
          notes: dto.notes ?? (sale as any).notes,
        },
      },
      { new: true },
    );
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

    this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: (sale as any).employeeId, action: 'sale_completed', targetId: saleId, targetType: 'sale', metadata: { total, discount } }).catch(() => {});

    return { success: true, message: 'Sale completed', data: updated };
  }

  async getHeldSales(sellerId: string, storeId: string, sessionId?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const filter: any = { storeId, status: 'held' };
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

  async getSales(sellerId: string, query: any) {
    if (!query.storeId) throw new BadRequestException('storeId is required');

    await this.verifyStoreOwnership(query.storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId: query.storeId };
    if (query.sessionId) filter.sessionId = query.sessionId;
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
    if (query.status) filter.status = query.status;
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

  async refundSale(sellerId: string, saleId: string, dto: RefundSaleDto | undefined, employeeToken: string | undefined) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status === 'voided') throw new BadRequestException('Sale is voided — cannot refund');
    if ((sale as any).status === 'refunded') throw new BadRequestException('Sale is already fully refunded');
    if ((sale as any).status === 'held') throw new BadRequestException('Cannot refund a held sale — discard it instead');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    const actor = await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'issue refunds');

    const isPartial = dto?.items && dto.items.length > 0;
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

    // Money for this refund and how it splits across the sale's tenders. See pos-money.util.ts#refundOrder for
    // the documented order (card/other first, cash last; cash change is not refundable).
    let refundAmount: number;
    let itemUpdates: Array<{ variantId: string; qtyToRestore: number; saleItemId: string }> = [];
    let newStatus: 'refunded' | 'partially_refunded' = 'refunded';

    if (!isPartial) {
      refundAmount = roundMoney((sale as any).total - alreadyRefunded, exp);
      (sale as any).items.forEach((item: any) => {
        const left = item.qty - (item.refundedQty || 0);
        if (left > 0) itemUpdates.push({ variantId: String(item.variantId), qtyToRestore: left, saleItemId: String(item._id) });
      });
    } else {
      const refundLines: Array<{ price: number; qty: number }> = [];
      for (const refundItem of dto!.items!) {
        const saleItem = (sale as any).items.find((i: any) => i._id.toString() === refundItem.saleItemId);
        if (!saleItem) throw new BadRequestException(`Sale item not found: ${refundItem.saleItemId}`);

        const available = saleItem.qty - (saleItem.refundedQty || 0);
        if (refundItem.qty > available) {
          throw new BadRequestException(`Cannot refund ${refundItem.qty} of "${saleItem.name}" — only ${available} unreturned`);
        }
        refundLines.push({ price: saleItem.price, qty: refundItem.qty });
        itemUpdates.push({ variantId: String(saleItem.variantId), qtyToRestore: refundItem.qty, saleItemId: refundItem.saleItemId });
      }
      const completesSale = (sale as any).items.every((item: any) => {
        const u = itemUpdates.find((x) => x.saleItemId === item._id.toString());
        return (item.refundedQty || 0) + (u?.qtyToRestore || 0) >= item.qty;
      });
      // pro-rated: each line's share of what the customer actually PAID (net of discount, incl. tax)
      refundAmount = partialRefundAmount(sale as any, refundLines, exp, completesSale);
      newStatus = completesSale ? 'refunded' : 'partially_refunded';
    }

    const tenders = allocateRefund(lines, alreadyRefunded, refundAmount, exp);
    const refundRecord = {
      amount: refundAmount, kind: isPartial ? 'partial' : 'full',
      tenders, items: itemUpdates.map((u) => ({ saleItemId: u.saleItemId, qty: u.qtyToRestore })),
      employeeId: actor.employeeId, currency, currencyExponent: exp, createdAt: new Date(),
    };

    const update: any = {
      $set: { status: newStatus, refundedAmount: roundMoney(alreadyRefunded + refundAmount, exp) },
      $push: { refunds: refundRecord },
    };
    let arrayFilters: any[] | undefined;
    if (isPartial) {
      const inc: Record<string, number> = {};
      arrayFilters = [];
      itemUpdates.forEach((u, idx) => {
        inc[`items.$[line${idx}].refundedQty`] = u.qtyToRestore;
        arrayFilters!.push({ [`line${idx}._id`]: new Types.ObjectId(u.saleItemId) });
      });
      update.$inc = inc;
    }
    const claimed = await this.r.saleModel.findOneAndUpdate(stateFilter, update, arrayFilters ? { arrayFilters } : undefined);
    if (!claimed) throw businessConflict('SALE_CHANGED_CONCURRENTLY', staleMessage);

    await this.restoreSoldStock(itemUpdates.map((u) => ({ variantId: u.variantId, qty: u.qtyToRestore })), locationId);

    // Session: the refund comes OUT of sales and out of the right tender — so a cash refund lowers the
    // cash the drawer should now hold (expected cash = opening + cashSales + cashIn − cashOut). The
    // transaction count drops only when the sale becomes fully refunded, and exactly once.
    const split = byTender(tenders);
    const sessionInc: any = {
      totalRefunds: refundAmount,
      totalSales: -refundAmount,
      ...this.tenderInc(split, -1),
    };
    if (newStatus === 'refunded') sessionInc.totalTransactions = -1;
    await this.r.registerSessionModel.findByIdAndUpdate((sale as any).sessionId, { $inc: sessionInc });

    await this.recordPosRefundInLedger(sale, refundAmount, newStatus === 'refunded' && !isPartial ? 'refund' : 'partial refund');
    this.writeAuditLog({
      storeId: (sale as any).storeId, employeeId: actor.employeeId,
      action: newStatus === 'refunded' && !isPartial ? 'sale_refunded_full' : (newStatus === 'refunded' ? 'sale_refunded_full' : 'sale_refunded_partial'),
      targetId: saleId, targetType: 'sale',
      metadata: { refundAmount, tenders, currency, items: dto?.items },
    }).catch(() => {});

    if (!isPartial) return { success: true, message: 'Sale fully refunded and stock restored', data: { refundedAmount: refundAmount, newStatus, tenders, currency, currencyExponent: exp } };
    return { success: true, message: `Partial refund of ${refundAmount.toFixed(exp)} processed`, data: { refundedAmount: refundAmount, newStatus, tenders, currency, currencyExponent: exp } };
  }

  async discardHeldSale(sellerId: string, saleId: string) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be discarded');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // status-guarded so a discard racing a completion can't delete a sale that just became real
    const deleted = await this.r.saleModel.findOneAndDelete({ _id: saleId, status: 'held' });
    if (!deleted) throw businessConflict('HELD_SALE_ALREADY_RESOLVED', 'This held sale was already completed or discarded');

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
      const variant: any = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false }).lean();
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);
      const product: any = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name').lean();
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);
      lines.push({ productId: item.productId, variantId: item.variantId, name: `${product.name}${formatOptionsSuffix(variant.options)}`, sku: variant.sku, price: variant.price, qty: item.qty });
    }
    const discountReq = this.discountSpec(dto);
    const money = await this.moneyContext(dto.storeId, { version: dto.settingsVersion });
    const totals = computeTotals(lines, { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    return {
      success: true,
      data: {
        lines: lines.map((l, i) => ({ ...l, lineTotal: totals.lineTotals[i] })),
        subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
        taxRate: money.taxRate, currency: money.currency, currencyExponent: money.exp,
        settingsVersion: money.settingsVersion,
        // the version asked for could not be honoured (unknown, or older than the offline window) → priced with current
        settingsVersionReplaced: !money.usedRequestedVersion,
      },
    };
  }

  // ── OFFLINE REVIEW / DISCARD ──────────────────────────────────────────────────

  /** Sales a manager should look at: oversold on sync, price changed while offline, payment shortfall. Newest first. */
  async getSalesNeedingReview(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const sales = await this.r.saleModel.find({ storeId, needsReview: true }).sort({ createdAt: -1 }).limit(200).lean();
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
    this.writeAuditLog({ storeId: sale.storeId, employeeId: actor.employeeId, action: 'sale_review_resolved', targetId: saleId, targetType: 'sale', metadata: { note: note.trim(), flags: sale.flags } }).catch(() => {});
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
        if (!productSales[item.productId]) productSales[item.productId] = { name: item.name, qty: 0, revenue: 0 };
        productSales[item.productId].qty += item.qty;
        productSales[item.productId].revenue = roundMoney(productSales[item.productId].revenue + item.lineTotal, exp);
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
        summary: flat,
        byPaymentMethod: byPayment,
        topProducts,
        hourlyBreakdown,
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
      for (const m of ['cash', 'card', 'other'] as const) {
        if (used.some((l) => l.method === m)) { byPayment[m].count++; byPayment[m].total = roundMoney(byPayment[m].total + nets[m], exp); }
      }
    }
    const refundedValue = sum(reversed.map((x) => (x.status === 'voided' ? x.total : (x.refundedAmount || x.total))));
    return {
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

  /** What discount the request asks for: the new type+value form, else the legacy flat `discount`, else (completing/editing a held sale) what's already on it. */
  private discountSpec(dto: { discount?: number; discountType?: DiscountType; discountValue?: number }, existing?: any): { type: DiscountType; value: number } {
    if (dto.discountType) return { type: dto.discountType, value: dto.discountValue ?? 0 };
    if (dto.discount !== undefined && dto.discount !== null) return { type: 'amount', value: dto.discount };
    if (existing?.discountType) return { type: existing.discountType, value: existing.discountValue ?? 0 };
    return { type: 'amount', value: existing?.discount ?? 0 };
  }

  /** `$inc` for the register session from a sale's tender nets (cash net of change; refunds already deducted). */
  private tenderInc(nets: Record<'cash' | 'card' | 'other', number>, sign: 1 | -1): Record<string, number> {
    const inc: Record<string, number> = {};
    if (nets.cash) inc.cashSales = sign * nets.cash;
    if (nets.card) inc.cardSales = sign * nets.card;
    if (nets.other) inc.otherSales = sign * nets.other;
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

  /** Counts a completed sale into its register session: total, one transaction, and each tender's NET amount (cash net of change). */
  private async _incrementSessionTotals(sessionId: string, sale: { total: number; payments?: any[]; paymentMethod?: string }, exp: number) {
    const nets = tenderNets({ ...sale, refundedAmount: 0, status: 'completed' }, exp);
    const inc: any = { totalSales: sale.total, totalTransactions: 1, ...this.tenderInc(nets, 1) };
    const updated: any = await this.r.registerSessionModel.findByIdAndUpdate(sessionId, { $inc: inc }, { new: true });

    // A sale synced into a session that has ALREADY been closed: its cash is real, so the session's stored close
    // figures must move with it — expected cash includes the sale, and the variance is re-derived from the count the
    // cashier entered at close (the drawer did hold that cash; the count simply pre-dated the sync).
    if (updated && updated.status === 'closed' && nets.cash) {
      const expectedCash = roundMoney((updated.expectedCash || 0) + nets.cash, exp);
      const $set: Record<string, any> = { expectedCash };
      if (updated.closingCash !== null && updated.closingCash !== undefined) $set.cashDifference = roundMoney(updated.closingCash - expectedCash, exp);
      await this.r.registerSessionModel.updateOne({ _id: sessionId }, { $set });
    }
  }

  private async writeAuditLog(data: {
    storeId: string;
    employeeId?: string | null;
    action: string;
    targetId?: string | null;
    targetType?: string | null;
    metadata?: object | null;
  }): Promise<void> {
    await this.r.posAuditLogModel.create({
      storeId: data.storeId,
      employeeId: data.employeeId ?? null,
      action: data.action,
      targetId: data.targetId ?? null,
      targetType: data.targetType ?? null,
      metadata: data.metadata ?? null,
    });
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
    if (dto.defaultFloatCash !== undefined) setFields['registers.$.defaultFloatCash'] = dto.defaultFloatCash;
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
    this.writeAuditLog({ storeId, employeeId: null, action: 'employee_updated', targetId: employeeId, targetType: 'employee', metadata: { fields: Object.keys(dto) } }).catch(() => {});

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

    this.writeAuditLog({ storeId, employeeId: null, action: 'employee_deactivated', targetId: employeeId, targetType: 'employee' }).catch(() => {});
    return { success: true, message: 'Employee deactivated' };
  }

  async resetPin(sellerId: string, storeId: string, employeeId: string, dto: ResetPinDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const hashedPin = await bcrypt.hash(dto.newPin, 10);
    await this.r.employeeModel.findByIdAndUpdate(employeeId, { pin: hashedPin, pinFailedAttempts: 0, pinLockedUntil: null });
    await this.revocations?.revokeEmployee(employeeId); // sessions opened with the OLD pin end now

    this.writeAuditLog({ storeId, employeeId: null, action: 'employee_pin_reset', targetId: employeeId, targetType: 'employee' }).catch(() => {});
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

    const updated = await this.r.registerSessionModel.findByIdAndUpdate(
      sessionId,
      {
        $set: {
          status: 'closed',
          closedAt: new Date(),
          expectedCash,
          closingCash: null,
          cashDifference: null,
          forceClosedBy: sellerId,
          forceCloseReason: dto.reason ?? 'Force closed by store owner',
          forceCloseAt: new Date(),
        },
      },
      { new: true },
    );

    this.writeAuditLog({ storeId: (session as any).storeId, employeeId: null, action: 'session_force_closed', targetId: sessionId, targetType: 'session', metadata: { reason: dto.reason } }).catch(() => {});
    return { success: true, message: 'Session force-closed', data: updated };
  }

  // ── PRODUCT BARCODE LOOKUP ────────────────────────────────────────────────

  async getProductByBarcode(sellerId: string, storeId: string, barcode: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const variant = await this.r.productVariantModel
      .findOne({ barcode, isDelete: false, status: 'active' })
      .lean();

    if (!variant) throw new NotFoundException(`No product found with barcode: ${barcode}`);

    const product = await this.r.productModel
      .findOne({ _id: (variant as any).productId, storeId, isDelete: false, status: 'active' })
      .select('_id name type gallery coverImages')
      .lean();

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

  async voidSale(sellerId: string, saleId: string, dto: { reason?: string }, employeeToken: string | undefined) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'completed') {
      throw new BadRequestException(`Cannot void a sale with status '${(sale as any).status}'`);
    }

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    const actor = await this.requireManagerEmployee(employeeToken, (sale as any).storeId, 'void sales');

    // Claim the void with a status-guarded update first; only the request that wins the
    // `completed → voided` transition restores stock and reverses the session totals.
    const claimed = await this.r.saleModel.findOneAndUpdate(
      { _id: saleId, status: 'completed' },
      { $set: { status: 'voided', voidedAt: new Date(), voidedBy: actor.employeeId } },
    );
    if (!claimed) throw businessConflict('SALE_CHANGED_CONCURRENTLY', 'This sale was already voided or refunded');

    await this.restoreSoldStock(
      (sale as any).items.map((item: any) => ({ variantId: String(item.variantId), qty: item.qty })),
      (sale as any).locationId ?? null,
    );

    // A void reverses the whole sale: total and per-tender nets (cash net of change) come out of the session.
    const { exp: voidExp } = await this.docMoney(sale);
    const voidNets = tenderNets({ ...(sale as any).toObject?.() ?? sale, refundedAmount: 0, status: 'completed' }, voidExp);
    await this.r.registerSessionModel.findByIdAndUpdate((sale as any).sessionId, {
      $inc: { totalSales: -(sale as any).total, totalTransactions: -1, ...this.tenderInc(voidNets, -1) },
    });

    await this.recordPosRefundInLedger(sale, (sale as any).total - ((sale as any).refundedAmount || 0), 'void');
    this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: actor.employeeId, action: 'sale_voided', targetId: saleId, targetType: 'sale', metadata: { reason: dto.reason } }).catch(() => {});
    return { success: true, message: 'Sale voided and stock restored' };
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
    const totals = computeTotals(saleItems, { exp: money.exp, discountType: discountReq.type, discountValue: discountReq.value, taxRate: money.taxRate });
    saleItems.forEach((it, i) => { it.lineTotal = totals.lineTotals[i]; });

    const updated = await this.r.saleModel.findByIdAndUpdate(
      saleId,
      {
        $set: {
          items: saleItems, subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
          currency: money.currency, currencyExponent: money.exp, taxRate: money.taxRate,
          discountType: discountReq.value > 0 ? discountReq.type : null, discountValue: discountReq.value > 0 ? discountReq.value : null,
        },
      },
      { new: true },
    );

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

    this.writeAuditLog({ storeId, employeeId: null, action: 'settings_updated', targetId: storeId, targetType: 'settings', metadata: { fields: Object.keys(dto), settingsVersion: settings?.settingsVersion } }).catch(() => {});

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
