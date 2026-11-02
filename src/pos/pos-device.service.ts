/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { DatabaseService } from '@/database/databaseservice';

export const POS_DEVICE_TOKEN_TYPE = 'pos_device';
const DEVICE_TOKEN_TTL = '365d';
const MAX_ACTIVE_DEVICES_PER_STORE = 50;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

export interface VerifiedDevice { deviceId: string; storeId: string; sellerId: string; registerId: string }

@Injectable()
export class PosDeviceService {
  constructor(private readonly databaseService: DatabaseService) {}
  private get r() { return this.databaseService.repositories; }

  /** Owner (seller JWT) registers THIS terminal for one store + register and receives its long-lived token. */
  async register(sellerId: string, dto: { storeId: string; registerId: string; name: string; platform?: string }, ip?: string) {
    const store: any = await this.r.storeModel.findOne({ _id: dto.storeId, sellerId, isDelete: false }).lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    if (!(store.registers ?? []).some((rg: any) => String(rg._id) === String(dto.registerId) && rg.status !== 'inactive')) {
      throw new BadRequestException('Register not found in this store');
    }
    const active = await this.r.posDeviceModel.countDocuments({ storeId: dto.storeId, status: 'active' });
    if (active >= MAX_ACTIVE_DEVICES_PER_STORE) throw new BadRequestException('Too many active devices for this store — revoke one first');
    const device: any = await this.r.posDeviceModel.create({
      storeId: dto.storeId, sellerId, registerId: dto.registerId, name: dto.name.trim(), platform: dto.platform ?? null, lastSeenAt: new Date(), lastIp: ip ?? null,
    });
    const deviceToken = jwt.sign(
      { type: POS_DEVICE_TOKEN_TYPE, deviceId: String(device._id), storeId: dto.storeId, registerId: dto.registerId, sellerId },
      secret(), { expiresIn: DEVICE_TOKEN_TTL, jwtid: String(device._id) },
    );
    return { success: true, message: 'Device registered', data: { deviceId: String(device._id), deviceToken, storeId: dto.storeId, registerId: dto.registerId, name: device.name } };
  }

  async list(sellerId: string, storeId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const devices = await this.r.posDeviceModel.find({ storeId }).sort({ status: 1, lastSeenAt: -1 }).lean();
    return { success: true, data: devices };
  }

  /** Immediate: the very next request from the device is refused. Already-queued offline sales stay on the device. */
  async revoke(sellerId: string, storeId: string, deviceId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const device: any = await this.r.posDeviceModel.findOneAndUpdate(
      { _id: deviceId, storeId },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: sellerId } },
      { new: true },
    ).lean();
    if (!device) throw new NotFoundException('Device not found');
    await this.r.posAuditLogModel.create({ storeId, employeeId: sellerId, action: 'device_revoked', targetId: deviceId, targetType: 'device', metadata: { name: device.name } }).catch(() => {});
    return { success: true, message: 'Device revoked', data: device };
  }

  /** The device retiring itself (full sign-out / reset): its own token stops working. */
  async signOutSelf(deviceId: string, storeId: string) {
    await this.r.posDeviceModel.updateOne({ _id: deviceId, storeId }, { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: 'device' } });
    await this.r.posAuditLogModel.create({ storeId, employeeId: null, action: 'device_signed_out', targetId: deviceId, targetType: 'device' }).catch(() => {});
    return { success: true, message: 'Device signed out' };
  }

  /** Verifies the signature, the type, and — the part that makes revocation instant — that the device row is still active. */
  async verifyToken(token: string, ip?: string): Promise<VerifiedDevice> {
    let payload: any;
    try {
      payload = jwt.verify(token, secret());
    } catch {
      throw new UnauthorizedException({ statusCode: 401, code: 'POS_DEVICE_INVALID', message: 'Device token is invalid or expired — set this device up again' });
    }
    if (payload?.type !== POS_DEVICE_TOKEN_TYPE) throw new UnauthorizedException({ statusCode: 401, code: 'POS_DEVICE_INVALID', message: 'Not a device token' });
    const device: any = await this.r.posDeviceModel.findById(payload.deviceId).select('status storeId sellerId registerId lastSeenAt').lean();
    if (!device || device.status !== 'active') {
      throw new UnauthorizedException({ statusCode: 401, code: 'POS_DEVICE_REVOKED', message: 'This device was removed by the store owner — set it up again to continue' });
    }
    // Scope comes from the DB row, not the token, so it can never drift from what the owner registered.
    if (!device.lastSeenAt || Date.now() - new Date(device.lastSeenAt).getTime() > 5 * 60_000) {
      this.r.posDeviceModel.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date(), lastIp: ip ?? null } }).catch(() => {});
    }
    return { deviceId: String(device._id), storeId: String(device.storeId), sellerId: String(device.sellerId), registerId: String(device.registerId) };
  }
}
