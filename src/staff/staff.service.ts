/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { STAFF_PERMISSIONS } from './schemas/staff-member.schema';

@Injectable()
export class StaffService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.repos.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /** Store-scoped staff login — a real email+password against `StaffMember`,
   *  never the seller's own `Seller` collection. Same JWT shape/signing
   *  mechanism as every other role, with `role:'staff'`, a required
   *  `storeId` claim, and `permissions` embedded directly (see
   *  JwtStrategy/PermissionsGuard). */
  async login(storeId: string, email: string, password: string) {
    const staff = await this.repos.staffMemberModel
      .findOne({ storeId, email: email.toLowerCase().trim(), isDelete: false })
      .select('+passwordHash');
    if (!staff) throw new UnauthorizedException('Invalid email or password');
    if (staff.status !== 'active') throw new UnauthorizedException('This staff account is inactive');

    const match = await bcrypt.compare(password, (staff as any).passwordHash);
    if (!match) throw new UnauthorizedException('Invalid email or password');

    const payload = {
      sub: staff._id,
      email: staff.email,
      role: 'staff',
      tokenVersion: staff.tokenVersion ?? 0,
      storeId,
      permissions: staff.permissions ?? [],
      sellerId: staff.sellerId,
    };
    const accessToken = this.jwtService.sign(payload);
    try {
      await this.redis.set(accessToken, staff._id.toString(), 24 * 60 * 60);
    } catch {
      // Redis unavailable — JwtAuthGuard already fails open on session-check
      // when disconnected, same as every other role's login.
    }

    return {
      success: true,
      data: {
        accessToken,
        staff: {
          id: staff._id, name: staff.name, email: staff.email,
          role: staff.role, permissions: staff.permissions, storeId,
        },
      },
    };
  }

  /** Creating a staff account is a seller/admin-only action, OR a staff
   *  member who already holds `staff.manage` — but a staff creator can
   *  never grant a permission they don't themselves hold (privilege-
   *  escalation guard). */
  async create(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, dto: CreateStaffDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);

    const requested = dto.permissions ?? [];
    if (actorRole === 'staff') {
      const disallowed = requested.filter((p) => !(actorPermissions ?? []).includes(p));
      if (disallowed.length > 0) {
        throw new ForbiddenException(`You can't grant permissions you don't have: ${disallowed.join(', ')}`);
      }
    }

    const existing = await this.repos.staffMemberModel.findOne({ storeId, email: dto.email.toLowerCase().trim() });
    if (existing) throw new BadRequestException('A staff member with this email already exists for this store');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const staff = await this.repos.staffMemberModel.create({
      storeId,
      sellerId: actorRole === 'seller' ? actorId : (await this.repos.storeModel.findById(storeId).select('sellerId').lean() as any)?.sellerId,
      name: dto.name,
      email: dto.email.toLowerCase().trim(),
      passwordHash,
      role: dto.role ?? 'staff',
      permissions: requested,
      locationId: dto.locationId ?? null,
      status: 'active',
    });

    this.activityLogService.log({
      storeId, category: 'settings', action: 'staff_member_added',
      description: `Staff member "${staff.name}" added (${(staff.permissions ?? []).length} permission(s))`,
      actorId, actorRole: actorRole as any,
      targetId: (staff as any)._id.toString(), targetType: 'staff_member',
    });

    const { passwordHash: _omit, ...safe } = staff.toObject();
    return { success: true, data: safe };
  }

  async list(actorId: string, actorRole: string, storeId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const staff = await this.repos.staffMemberModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    return { success: true, data: staff };
  }

  async update(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string, dto: UpdateStaffDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);

    if (actorRole === 'staff' && actorId === staffId) {
      throw new ForbiddenException("You can't edit your own role/permissions/status");
    }

    const staff = await this.repos.staffMemberModel.findOne({ _id: staffId, storeId, isDelete: false });
    if (!staff) throw new NotFoundException('Staff member not found');

    if (dto.permissions !== undefined && actorRole === 'staff') {
      const disallowed = dto.permissions.filter((p) => !(actorPermissions ?? []).includes(p));
      if (disallowed.length > 0) {
        throw new ForbiddenException(`You can't grant permissions you don't have: ${disallowed.join(', ')}`);
      }
    }

    let permissionsOrStatusChanged = false;
    if (dto.name !== undefined) staff.name = dto.name;
    if (dto.role !== undefined) { staff.role = dto.role as any; permissionsOrStatusChanged = true; }
    if (dto.permissions !== undefined) { staff.permissions = dto.permissions as any; permissionsOrStatusChanged = true; }
    if (dto.locationId !== undefined) staff.locationId = dto.locationId as any;
    if (dto.status !== undefined) { staff.status = dto.status; permissionsOrStatusChanged = true; }

    // A permission/role/status change invalidates any already-issued token
    // immediately — same tokenVersion-bump revocation JwtAuthGuard already
    // enforces for User/Seller/Admin.
    if (permissionsOrStatusChanged) staff.tokenVersion = (staff.tokenVersion ?? 0) + 1;

    await staff.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'staff_member_updated',
      description: `Staff member "${staff.name}" updated`,
      actorId, actorRole: actorRole as any,
      targetId: staffId, targetType: 'staff_member',
    });

    const { passwordHash: _omit, ...safe } = staff.toObject();
    return { success: true, data: safe };
  }

  async deactivate(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string) {
    return this.update(actorId, actorRole, actorPermissions, storeId, staffId, { status: 'inactive' } as any);
  }

  private assertCanManageStaff(actorRole: string, actorPermissions: string[] | null) {
    if (actorRole === 'seller' || actorRole === 'admin') return;
    if (actorRole === 'staff' && (actorPermissions ?? []).includes('staff.manage')) return;
    throw new ForbiddenException("You don't have permission to manage staff");
  }

  listPermissions() {
    return { success: true, data: STAFF_PERMISSIONS };
  }
}
