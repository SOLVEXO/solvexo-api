/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { DatabaseService } from 'src/database/databaseservice';
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

@Injectable()
export class PosService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get r() {
    return this.databaseService.repositories;
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async generateSaleNumber(storeId: string): Promise<string> {
    const count = await this.r.saleModel.countDocuments({ storeId });
    return `POS-${String(count + 1).padStart(5, '0')}`;
  }

  // ── EMPLOYEE MANAGEMENT ───────────────────────────────────────────────────

  async addEmployee(sellerId: string, dto: CreateEmployeeDto) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);

    const existing = await this.r.employeeModel.findOne({
      storeId: dto.storeId,
      email: dto.email,
      isDelete: false,
    });
    if (existing) throw new BadRequestException('Employee with this email already exists in this store');

    const hashedPin = await bcrypt.hash(dto.pin, 10);

    const employee = await this.r.employeeModel.create({
      storeId: dto.storeId,
      sellerId,
      name: dto.name,
      email: dto.email,
      pin: hashedPin,
      role: dto.role ?? 'cashier',
      shiftIds: dto.shiftIds ?? [],
    });

    const { pin: _, ...safe } = (employee as any).toObject();
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

    const updateData: any = { ...dto };
    if (dto.pin) updateData.pin = await bcrypt.hash(dto.pin, 10);

    const updated = await this.r.employeeModel
      .findByIdAndUpdate(employeeId, { $set: updateData }, { new: true })
      .select('-pin');

    return { success: true, message: 'Employee updated successfully', data: updated };
  }

  async removeEmployee(sellerId: string, employeeId: string) {
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, sellerId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const activeSession = await this.r.registerSessionModel.findOne({ employeeId, status: 'open' });
    if (activeSession) throw new BadRequestException('Employee has an open session — close it first');

    await this.r.employeeModel.findByIdAndUpdate(employeeId, { isDelete: true, status: 'inactive' });
    return { success: true, message: 'Employee removed successfully' };
  }

  // ── PIN LOGIN ─────────────────────────────────────────────────────────────

  async pinLogin(dto: PinLoginDto) {
    const employee = await this.r.employeeModel
      .findOne({ storeId: dto.storeId, email: dto.email, isDelete: false })
      .select('+pin');

    if (!employee) throw new BadRequestException('Invalid credentials');
    if (employee.status === 'inactive') throw new BadRequestException('Employee account is inactive');

    const isPinValid = await bcrypt.compare(dto.pin, employee.pin);
    if (!isPinValid) throw new BadRequestException('Invalid credentials');

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
      },
      requireJwtSecret(),
      { expiresIn: '12h' },
    );

    return {
      success: true,
      message: 'PIN login successful',
      data: { employee: safe, activeSession: activeSession ?? null, employeeToken },
    };
  }

  // ── REGISTER & SHIFT MANAGEMENT ───────────────────────────────────────────

  async addRegister(sellerId: string, storeId: string, body: { name: string; defaultFloatCash?: number }) {
    if (!body.name) throw new BadRequestException('Register name is required');
    await this.verifyStoreOwnership(storeId, sellerId);

    const updated = await this.r.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { registers: { name: body.name, defaultFloatCash: body.defaultFloatCash ?? 100, status: 'active' } } },
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
        size: v.size,
        color: v.color,
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
        size: v.size,
        color: v.color,
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

    const session = await this.r.registerSessionModel.create({
      storeId: dto.storeId,
      registerId: dto.registerId,
      employeeId: dto.employeeId,
      shiftId: dto.shiftId ?? null,
      openedAt: new Date(),
      openingCash: dto.openingCash,
      status: 'open',
    });

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

    const expectedCash = session.openingCash + session.cashSales + cashIn - cashOut;
    const cashDifference = dto.closingCash - expectedCash;

    const updated = await this.r.registerSessionModel.findByIdAndUpdate(
      dto.sessionId,
      { $set: { closingCash: dto.closingCash, expectedCash, cashDifference, closedAt: new Date(), status: 'closed' } },
      { new: true },
    );

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

    const sales = await this.r.saleModel.find({ sessionId, status: 'completed' }).lean();
    const refunds = await this.r.saleModel.find({ sessionId, status: 'refunded' }).lean();
    const held = await this.r.saleModel.countDocuments({ sessionId, status: 'held' });

    const byPayment: Record<string, { count: number; total: number }> = {
      cash: { count: 0, total: 0 },
      card: { count: 0, total: 0 },
      other: { count: 0, total: 0 },
    };
    for (const sale of sales) {
      const pm = (sale as any).paymentMethod;
      byPayment[pm].count++;
      byPayment[pm].total += (sale as any).total;
    }

    const adjustments = (session as any).cashAdjustments || [];
    const cashIn = adjustments.filter((a: any) => a.type === 'cash_in').reduce((s: number, a: any) => s + a.amount, 0);
    const cashOut = adjustments.filter((a: any) => a.type === 'cash_out').reduce((s: number, a: any) => s + a.amount, 0);

    return {
      success: true,
      data: {
        session,
        summary: {
          totalSales: (session as any).totalSales,
          totalTransactions: (session as any).totalTransactions,
          completedSales: sales.length,
          heldSales: held,
          refundsCount: refunds.length,
          refundsTotal: refunds.reduce((s: number, r: any) => s + r.total, 0),
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

  async cashInOut(sellerId: string, sessionId: string, dto: CashAdjustmentDto) {
    const session = await this.r.registerSessionModel.findOne({ _id: sessionId, status: 'open' });
    if (!session) throw new NotFoundException('Open session not found');

    await this.verifyStoreOwnership((session as any).storeId, sellerId);

    const adjustment = { type: dto.type, amount: dto.amount, reason: dto.reason, employeeId: dto.employeeId, createdAt: new Date() };

    await this.r.registerSessionModel.findByIdAndUpdate(
      sessionId,
      { $push: { cashAdjustments: adjustment } },
    );

    return {
      success: true,
      message: `Cash ${dto.type === 'cash_in' ? 'added to' : 'removed from'} drawer`,
      data: adjustment,
    };
  }

  // ── SALES ─────────────────────────────────────────────────────────────────

  async createSale(sellerId: string, dto: CreateSaleDto) {
    await this.verifyStoreOwnership(dto.storeId, sellerId);

    if (dto.idempotencyKey) {
      const existing = await this.r.saleModel.findOne({ idempotencyKey: dto.idempotencyKey, storeId: dto.storeId }).lean();
      if (existing) return { success: true, message: 'Duplicate request — returning existing sale', data: existing };
    }

    const session = await this.r.registerSessionModel.findOne({ _id: dto.sessionId, status: 'open' });
    if (!session) throw new BadRequestException('No open session found');

    const employee = await this.r.employeeModel.findOne({ _id: dto.employeeId, storeId: dto.storeId, isDelete: false });
    if (!employee) throw new BadRequestException('Employee not found');

    // resolve items — fetch variant snapshots + check stock
    const saleItems: any[] = [];
    let subtotal = 0;
    const isHeld = dto.status === 'held';

    for (const item of dto.items) {
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);

      if (!isHeld && variant.stock < item.qty) {
        throw new BadRequestException(`Insufficient stock for "${variant.sku}" — available: ${variant.stock}`);
      }

      const product = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name gallery coverImages');
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);

      const lineTotal = variant.price * item.qty;
      subtotal += lineTotal;

      saleItems.push({
        productId: item.productId,
        variantId: item.variantId,
        name: `${product.name}${variant.size ? ` (${variant.size})` : ''}${variant.color ? ` - ${variant.color}` : ''}`,
        sku: variant.sku,
        image: (product as any).gallery?.[0] ?? (product as any).coverImages?.[0] ?? null,
        price: variant.price,
        qty: item.qty,
        lineTotal,
      });
    }

    const discount = dto.discount ?? 0;
    let tax = dto.tax ?? null;
    if (tax === null) {
      const settings = await this.r.posSettingsModel.findOne({ storeId: dto.storeId }).lean();
      tax = settings ? parseFloat(((settings as any).taxRate * subtotal).toFixed(2)) : 0;
    }
    const total = subtotal - discount + tax;
    const saleNumber = await this.generateSaleNumber(dto.storeId);

    const sale = await this.r.saleModel.create({
      saleNumber,
      storeId: dto.storeId,
      sessionId: dto.sessionId,
      registerId: dto.registerId,
      employeeId: dto.employeeId,
      items: saleItems,
      subtotal,
      discount,
      tax,
      total,
      paymentMethod: dto.paymentMethod,
      customerId: dto.customerId ?? null,
      customerName: dto.customerName ?? 'Walk-in',
      notes: dto.notes ?? null,
      heldAt: isHeld ? new Date() : null,
      status: isHeld ? 'held' : 'completed',
      idempotencyKey: dto.idempotencyKey ?? null,
    });

    if (!isHeld) {
      // decrement stock and update session totals only when completing
      for (const item of dto.items) {
        await this.r.productVariantModel.findByIdAndUpdate(item.variantId, { $inc: { stock: -item.qty } });
      }
      await this._incrementSessionTotals(dto.sessionId, total, dto.paymentMethod);
    }

    return { success: true, message: isHeld ? 'Sale put on hold' : 'Sale completed', data: sale };
  }

  async completeSale(sellerId: string, saleId: string, dto: CompleteSaleDto) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be completed');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    // re-check stock before completing
    for (const item of (sale as any).items) {
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant no longer available: ${item.sku}`);
      if (variant.stock < item.qty) {
        throw new BadRequestException(`Insufficient stock for "${item.sku}" — available: ${variant.stock}`);
      }
    }

    const discount = dto.discount ?? (sale as any).discount;
    const tax = dto.tax ?? (sale as any).tax;
    const total = (sale as any).subtotal - discount + tax;

    const updated = await this.r.saleModel.findByIdAndUpdate(
      saleId,
      {
        $set: {
          status: 'completed',
          paymentMethod: dto.paymentMethod,
          discount,
          tax,
          total,
          heldAt: null,
          notes: dto.notes ?? (sale as any).notes,
        },
      },
      { new: true },
    );

    // now decrement stock and update session
    for (const item of (sale as any).items) {
      await this.r.productVariantModel.findByIdAndUpdate(item.variantId, { $inc: { stock: -item.qty } });
    }
    await this._incrementSessionTotals((sale as any).sessionId, total, dto.paymentMethod);

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

    return { success: true, data: sale };
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
    const sales = await this.r.saleModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        sales,
      },
    };
  }

  async refundSale(sellerId: string, saleId: string, dto?: RefundSaleDto) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status === 'voided') throw new BadRequestException('Sale is voided — cannot refund');
    if ((sale as any).status === 'refunded') throw new BadRequestException('Sale is already fully refunded');
    if ((sale as any).status === 'held') throw new BadRequestException('Cannot refund a held sale — discard it instead');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    if (dto?.actingEmployeeId) {
      const actor = await this.r.employeeModel.findOne({ _id: dto.actingEmployeeId, storeId: (sale as any).storeId, isDelete: false });
      if (actor && actor.role !== 'manager') throw new ForbiddenException('Only managers can issue refunds');
    }

    const isPartial = dto?.items && dto.items.length > 0;

    if (!isPartial) {
      // full refund — existing behavior
      for (const item of (sale as any).items) {
        const unrefunded = item.qty - (item.refundedQty || 0);
        if (unrefunded > 0) {
          await this.r.productVariantModel.findByIdAndUpdate(item.variantId, { $inc: { stock: unrefunded } });
        }
      }
      const refundAmount = (sale as any).total - ((sale as any).refundedAmount || 0);
      await this.r.saleModel.findByIdAndUpdate(saleId, { status: 'refunded', refundedAmount: (sale as any).total });

      const sessionUpdate: any = { $inc: { totalRefunds: refundAmount, totalTransactions: -1 } };
      const pm = (sale as any).paymentMethod;
      if (pm === 'cash') sessionUpdate.$inc.cashSales = -refundAmount;
      else if (pm === 'card') sessionUpdate.$inc.cardSales = -refundAmount;
      else sessionUpdate.$inc.otherSales = -refundAmount;
      sessionUpdate.$inc.totalSales = -refundAmount;
      await this.r.registerSessionModel.findByIdAndUpdate((sale as any).sessionId, sessionUpdate);

      this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: dto?.actingEmployeeId ?? null, action: 'sale_refunded_full', targetId: saleId, targetType: 'sale' }).catch(() => {});
      return { success: true, message: 'Sale fully refunded and stock restored' };
    }

    // partial refund
    let partialTotal = 0;
    const itemUpdates: Array<{ variantId: string; qtyToRestore: number; saleItemId: string }> = [];

    for (const refundItem of dto!.items!) {
      const saleItem = (sale as any).items.find((i: any) => i._id.toString() === refundItem.saleItemId);
      if (!saleItem) throw new BadRequestException(`Sale item not found: ${refundItem.saleItemId}`);

      const available = saleItem.qty - (saleItem.refundedQty || 0);
      if (refundItem.qty > available) {
        throw new BadRequestException(`Cannot refund ${refundItem.qty} of "${saleItem.name}" — only ${available} unreturned`);
      }

      const lineRefund = parseFloat((refundItem.qty * saleItem.price).toFixed(2));
      partialTotal += lineRefund;
      itemUpdates.push({ variantId: saleItem.variantId, qtyToRestore: refundItem.qty, saleItemId: refundItem.saleItemId });
    }

    // apply stock restores
    for (const u of itemUpdates) {
      await this.r.productVariantModel.findByIdAndUpdate(u.variantId, { $inc: { stock: u.qtyToRestore } });
      await this.r.saleModel.updateOne(
        { _id: saleId, 'items._id': u.saleItemId },
        { $inc: { 'items.$.refundedQty': u.qtyToRestore } },
      );
    }

    const newRefundedAmount = ((sale as any).refundedAmount || 0) + partialTotal;
    const allItemsFullyRefunded = (sale as any).items.every((item: any) => {
      const updated = itemUpdates.find((u) => u.saleItemId === item._id.toString());
      const finalRefundedQty = (item.refundedQty || 0) + (updated?.qtyToRestore || 0);
      return finalRefundedQty >= item.qty;
    });

    const newStatus = allItemsFullyRefunded ? 'refunded' : 'partially_refunded';
    await this.r.saleModel.findByIdAndUpdate(saleId, { status: newStatus, refundedAmount: newRefundedAmount });

    const sessionUpdate: any = { $inc: { totalRefunds: partialTotal } };
    await this.r.registerSessionModel.findByIdAndUpdate((sale as any).sessionId, sessionUpdate);

    this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: dto?.actingEmployeeId ?? null, action: 'sale_refunded_partial', targetId: saleId, targetType: 'sale', metadata: { partialTotal, items: dto!.items } }).catch(() => {});
    return { success: true, message: `Partial refund of ${partialTotal.toFixed(2)} processed`, data: { refundedAmount: partialTotal, newStatus } };
  }

  async discardHeldSale(sellerId: string, saleId: string) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be discarded');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    await this.r.saleModel.findByIdAndDelete(saleId);

    return { success: true, message: 'Held sale discarded' };
  }

  // ── DAILY REPORT ──────────────────────────────────────────────────────────

  async getDailyReport(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const date = query.date ? new Date(query.date) : new Date();
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const filter: any = {
      storeId,
      status: 'completed',
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    };
    if (query.registerId) filter.registerId = query.registerId;

    const sales = await this.r.saleModel.find(filter).lean();

    let totalRevenue = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    const byPayment: Record<string, { count: number; total: number }> = {
      cash: { count: 0, total: 0 },
      card: { count: 0, total: 0 },
      other: { count: 0, total: 0 },
    };
    const hourlyMap: Record<number, number> = {};
    const productSales: Record<string, { name: string; qty: number; revenue: number }> = {};

    for (const sale of sales) {
      totalRevenue += (sale as any).total;
      totalDiscount += (sale as any).discount;
      totalTax += (sale as any).tax;

      const pm = (sale as any).paymentMethod;
      byPayment[pm].count++;
      byPayment[pm].total += (sale as any).total;

      const hour = new Date((sale as any).createdAt).getHours();
      hourlyMap[hour] = (hourlyMap[hour] || 0) + (sale as any).total;

      for (const item of (sale as any).items) {
        if (!productSales[item.productId]) {
          productSales[item.productId] = { name: item.name, qty: 0, revenue: 0 };
        }
        productSales[item.productId].qty += item.qty;
        productSales[item.productId].revenue += item.lineTotal;
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

    const refunds = await this.r.saleModel.find({
      storeId, status: 'refunded',
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    return {
      success: true,
      data: {
        date: date.toISOString().split('T')[0],
        summary: {
          totalTransactions: sales.length,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalDiscount: parseFloat(totalDiscount.toFixed(2)),
          totalTax: parseFloat(totalTax.toFixed(2)),
          netRevenue: parseFloat((totalRevenue - totalDiscount).toFixed(2)),
          avgTransactionValue: sales.length > 0 ? parseFloat((totalRevenue / sales.length).toFixed(2)) : 0,
          refundsCount: refunds.length,
          refundsTotal: parseFloat(refunds.reduce((s: number, r: any) => s + r.total, 0).toFixed(2)),
        },
        byPaymentMethod: byPayment,
        topProducts,
        hourlyBreakdown,
      },
    };
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  private async _incrementSessionTotals(sessionId: string, total: number, paymentMethod: string) {
    const inc: any = { totalSales: total, totalTransactions: 1 };
    if (paymentMethod === 'cash') inc.cashSales = total;
    else if (paymentMethod === 'card') inc.cardSales = total;
    else inc.otherSales = total;

    await this.r.registerSessionModel.findByIdAndUpdate(sessionId, { $inc: inc });
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

    const setFields: any = {};
    if (dto.name !== undefined) setFields['registers.$.name'] = dto.name;
    if (dto.defaultFloatCash !== undefined) setFields['registers.$.defaultFloatCash'] = dto.defaultFloatCash;
    if (dto.status !== undefined) setFields['registers.$.status'] = dto.status;

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

    const updateData: any = { ...dto };
    if (dto.pin) updateData.pin = await bcrypt.hash(dto.pin, 10);

    const updated = await this.r.employeeModel
      .findByIdAndUpdate(employeeId, { $set: updateData }, { new: true })
      .select('-pin');

    return { success: true, message: 'Employee updated', data: updated };
  }

  async removeEmployeeV2(sellerId: string, storeId: string, employeeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const activeSession = await this.r.registerSessionModel.findOne({ employeeId, status: 'open' });
    if (activeSession) throw new BadRequestException('Employee has an open session — close it first');

    await this.r.employeeModel.findByIdAndUpdate(employeeId, { isDelete: true, status: 'inactive' });

    this.writeAuditLog({ storeId, employeeId: null, action: 'employee_deactivated', targetId: employeeId, targetType: 'employee' }).catch(() => {});
    return { success: true, message: 'Employee deactivated' };
  }

  async resetPin(sellerId: string, storeId: string, employeeId: string, dto: ResetPinDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const employee = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: false });
    if (!employee) throw new NotFoundException('Employee not found');

    const hashedPin = await bcrypt.hash(dto.newPin, 10);
    await this.r.employeeModel.findByIdAndUpdate(employeeId, { pin: hashedPin });

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
    const expectedCash = session.openingCash + session.cashSales + cashIn - cashOut;

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
          size: (variant as any).size,
          color: (variant as any).color,
          isDefault: (variant as any).isDefault,
        },
      },
    };
  }

  // ── SALES EXTENSIONS ──────────────────────────────────────────────────────

  async voidSale(sellerId: string, saleId: string, dto: { reason?: string; actingEmployeeId?: string }) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'completed') {
      throw new BadRequestException(`Cannot void a sale with status '${(sale as any).status}'`);
    }

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    if (dto.actingEmployeeId) {
      const actor = await this.r.employeeModel.findOne({ _id: dto.actingEmployeeId, storeId: (sale as any).storeId, isDelete: false });
      if (actor && actor.role !== 'manager') throw new ForbiddenException('Only managers can void sales');
    }

    for (const item of (sale as any).items) {
      await this.r.productVariantModel.findByIdAndUpdate(item.variantId, { $inc: { stock: item.qty } });
    }

    await this.r.saleModel.findByIdAndUpdate(saleId, {
      status: 'voided',
      voidedAt: new Date(),
      voidedBy: dto.actingEmployeeId ?? sellerId,
    });

    const sessionUpdate: any = { $inc: { totalSales: -(sale as any).total, totalTransactions: -1 } };
    const pm = (sale as any).paymentMethod;
    if (pm === 'cash') sessionUpdate.$inc.cashSales = -(sale as any).total;
    else if (pm === 'card') sessionUpdate.$inc.cardSales = -(sale as any).total;
    else sessionUpdate.$inc.otherSales = -(sale as any).total;
    await this.r.registerSessionModel.findByIdAndUpdate((sale as any).sessionId, sessionUpdate);

    this.writeAuditLog({ storeId: (sale as any).storeId, employeeId: dto.actingEmployeeId ?? null, action: 'sale_voided', targetId: saleId, targetType: 'sale', metadata: { reason: dto.reason } }).catch(() => {});
    return { success: true, message: 'Sale voided and stock restored' };
  }

  async editHeldSaleItems(sellerId: string, saleId: string, dto: UpdateSaleItemsDto) {
    const sale = await this.r.saleModel.findById(saleId);
    if (!sale) throw new NotFoundException('Sale not found');
    if ((sale as any).status !== 'held') throw new BadRequestException('Only held sales can be edited');

    await this.verifyStoreOwnership((sale as any).storeId, sellerId);

    const saleItems: any[] = [];
    let subtotal = 0;

    for (const item of dto.items) {
      const variant = await this.r.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false });
      if (!variant) throw new BadRequestException(`Variant not found: ${item.variantId}`);

      const product = await this.r.productModel.findOne({ _id: item.productId, isDelete: false }).select('name gallery coverImages');
      if (!product) throw new BadRequestException(`Product not found: ${item.productId}`);

      const lineTotal = variant.price * item.qty;
      subtotal += lineTotal;

      saleItems.push({
        productId: item.productId,
        variantId: item.variantId,
        name: `${(product as any).name}${variant.size ? ` (${variant.size})` : ''}${variant.color ? ` - ${variant.color}` : ''}`,
        sku: variant.sku,
        image: (product as any).gallery?.[0] ?? (product as any).coverImages?.[0] ?? null,
        price: variant.price,
        qty: item.qty,
        lineTotal,
        refundedQty: 0,
      });
    }

    const discount = dto.discount ?? (sale as any).discount;
    const tax = dto.tax ?? (sale as any).tax;
    const total = subtotal - discount + tax;

    const updated = await this.r.saleModel.findByIdAndUpdate(
      saleId,
      { $set: { items: saleItems, subtotal, discount, tax, total } },
      { new: true },
    );

    return { success: true, message: 'Held sale items updated', data: updated };
  }

  // ── REPORTS EXTENSIONS ────────────────────────────────────────────────────

  async getDateRangeReport(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    if (!query.from || !query.to) throw new BadRequestException('from and to date are required');

    const from = new Date(query.from);
    const to = new Date(query.to);
    to.setHours(23, 59, 59, 999);

    const statusFilter = ['completed', 'partially_refunded'];
    const sales = await this.r.saleModel.find({
      storeId,
      status: { $in: statusFilter },
      createdAt: { $gte: from, $lte: to },
    }).lean();

    const refunds = await this.r.saleModel.find({
      storeId,
      status: { $in: ['refunded', 'voided'] },
      createdAt: { $gte: from, $lte: to },
    }).lean();

    let totalRevenue = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    const byPayment: Record<string, { count: number; total: number }> = {
      cash: { count: 0, total: 0 },
      card: { count: 0, total: 0 },
      other: { count: 0, total: 0 },
    };
    const dailyMap: Record<string, number> = {};
    const productSales: Record<string, { name: string; qty: number; revenue: number }> = {};

    for (const sale of sales) {
      totalRevenue += (sale as any).total;
      totalDiscount += (sale as any).discount;
      totalTax += (sale as any).tax;
      const pm = (sale as any).paymentMethod;
      byPayment[pm].count++;
      byPayment[pm].total += (sale as any).total;

      const day = new Date((sale as any).createdAt).toISOString().split('T')[0];
      dailyMap[day] = (dailyMap[day] || 0) + (sale as any).total;

      for (const item of (sale as any).items) {
        if (!productSales[item.productId]) productSales[item.productId] = { name: item.name, qty: 0, revenue: 0 };
        productSales[item.productId].qty += item.qty;
        productSales[item.productId].revenue += item.lineTotal;
      }
    }

    const topProducts = Object.entries(productSales)
      .map(([productId, d]) => ({ productId, ...d }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    return {
      success: true,
      data: {
        from: query.from,
        to: query.to,
        summary: {
          totalTransactions: sales.length,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalDiscount: parseFloat(totalDiscount.toFixed(2)),
          totalTax: parseFloat(totalTax.toFixed(2)),
          netRevenue: parseFloat((totalRevenue - totalDiscount).toFixed(2)),
          avgTransactionValue: sales.length > 0 ? parseFloat((totalRevenue / sales.length).toFixed(2)) : 0,
          refundsCount: refunds.length,
          refundsTotal: parseFloat(refunds.reduce((s: number, r: any) => s + r.total, 0).toFixed(2)),
        },
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

    const totalRevenue = sales.reduce((s: number, sale: any) => s + sale.total, 0);
    const register = store.registers.find((r: any) => r._id.toString() === registerId);

    return {
      success: true,
      data: {
        register,
        period: { from: query.from ?? null, to: query.to ?? null },
        summary: {
          totalSessions: sessions.length,
          totalTransactions: sales.length,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          avgPerSession: sessions.length > 0 ? parseFloat((totalRevenue / sessions.length).toFixed(2)) : 0,
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
    const totalRevenue = sales.reduce((s: number, sale: any) => s + sale.total, 0);

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
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          avgTransactionValue: sales.length > 0 ? parseFloat((totalRevenue / sales.length).toFixed(2)) : 0,
          totalSessions: sessions.length,
        },
        recentSales: sales.slice(0, 20).map((s: any) => ({ saleId: s._id, saleNumber: s.saleNumber, total: s.total, paymentMethod: s.paymentMethod, createdAt: s.createdAt })),
      },
    };
  }

  async exportDailyReportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(storeId, sellerId);

    const date = query.date ? new Date(query.date) : new Date();
    const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);

    const sales = await this.r.saleModel.find({
      storeId,
      status: { $in: ['completed', 'partially_refunded', 'refunded', 'voided'] },
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    const rows = [['Sale Number', 'Date', 'Employee', 'Status', 'Payment', 'Subtotal', 'Discount', 'Tax', 'Total', 'Customer'].join(',')];

    for (const sale of sales) {
      rows.push([
        (sale as any).saleNumber,
        new Date((sale as any).createdAt).toISOString(),
        (sale as any).employeeId,
        (sale as any).status,
        (sale as any).paymentMethod,
        (sale as any).subtotal,
        (sale as any).discount,
        (sale as any).tax,
        (sale as any).total,
        ((sale as any).customerName || '').replace(/,/g, ' '),
      ].join(','));
    }

    return rows.join('\n');
  }

  // ── POS SETTINGS ──────────────────────────────────────────────────────────

  async getPosSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    let settings = await this.r.posSettingsModel.findOne({ storeId }).lean();
    if (!settings) {
      settings = await this.r.posSettingsModel.create({ storeId });
    }

    return { success: true, data: settings };
  }

  async updatePosSettings(sellerId: string, storeId: string, dto: UpdatePosSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const settings = await this.r.posSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: dto },
      { new: true, upsert: true },
    );

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
