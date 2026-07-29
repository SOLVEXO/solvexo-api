/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Buyers (User) and Sellers live in two separate collections — merged here via
// $unionWith so the admin table can page/sort/search across both as one list,
// same way the rest of the app keeps them as distinct schemas everywhere else.
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'customers',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async getStats() {
    const [totalBuyers, activeSellerAccounts, suspendedUsers, suspendedSellers] = await Promise.all([
      this.r.userModel.countDocuments({ isDelete: false }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'active' }),
      this.r.userModel.countDocuments({ isDelete: false, status: 'suspended' }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'suspended' }),
    ]);

    return {
      success: true,
      data: {
        totalBuyers,
        activeSellerAccounts,
        suspended: suspendedUsers + suspendedSellers,
      },
    };
  }

  private buildMatch(query: AdminUsersQueryDto) {
    const match: Record<string, unknown> = { isDelete: false };
    if (query.status) match.status = query.status;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      match.$or = [{ name: rx }, { email: rx }];
    }
    return match;
  }

  async list(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const buyerMatch = this.buildMatch(query);
    const sellerMatch = this.buildMatch(query);

    let rows: any[];
    let total: number;

    if (query.role === 'buyer') {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.userModel.countDocuments(buyerMatch),
      ]);
    } else if (query.role === 'seller') {
      [rows, total] = await Promise.all([
        this.r.sellerModel.aggregate([
          { $match: sellerMatch },
          { $addFields: { roleLabel: 'seller' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.sellerModel.countDocuments(sellerMatch),
      ]);
    } else {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $unionWith: { coll: 'sellers', pipeline: [{ $match: sellerMatch }, { $addFields: { roleLabel: 'seller' } }] } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        Promise.all([this.r.userModel.countDocuments(buyerMatch), this.r.sellerModel.countDocuments(sellerMatch)]).then(
          ([a, b]) => a + b,
        ),
      ]);
    }

    const sellerRows = rows.filter((row) => row.roleLabel === 'seller');
    const storeIds = sellerRows.map((row) => row.storeId).filter(Boolean);
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }, { plan: 1 });
    const planByStoreId = new Map(stores.map((s) => [String(s._id), s.plan]));

    const items = rows.map((row) => ({
      id: row._id,
      name: row.name,
      email: row.email,
      role: row.roleLabel,
      plan: row.roleLabel === 'seller' ? planByStoreId.get(row.storeId) ?? 'starter' : 'free',
      status: row.status,
      createdAt: row.createdAt,
    }));

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(role: 'buyer' | 'seller', id: string) {
    // dynamic model selection: userModel/sellerModel differ in document type,
    // so the union call is widened to `any` here rather than fighting Mongoose's
    // overload resolution for two structurally different models.
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    const doc = await model.findOne({ _id: id, isDelete: false });
    if (!doc) throw new NotFoundException(`${role} not found`);
    return doc;
  }

  async getById(role: 'buyer' | 'seller', id: string) {
    const doc = await this.findOrThrow(role, id);
    return { success: true, data: doc };
  }

  private async setStatus(role: 'buyer' | 'seller', id: string, status: string, meta: AuditMeta, action: string) {
    const doc = await this.findOrThrow(role, id);
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    await model.findByIdAndUpdate(id, { $set: { status } });
    this.log(action, `${role} "${doc.name ?? doc.email}" set to ${status}`, meta, id);
    return { success: true, message: `${role === 'buyer' ? 'Buyer' : 'Seller'} set to ${status}` };
  }

  async suspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    return this.setStatus(role, id, 'suspended', meta, `${role}_suspended`);
  }

  async unsuspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    return this.setStatus(role, id, 'active', meta, `${role}_unsuspended`);
  }
}
