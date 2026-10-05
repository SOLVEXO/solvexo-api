/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Shopify-style GUEST CHECKOUT. A visitor can shop and check out without creating an account (store setting
 * "Customer accounts: Optional", the default — "Required" turns guests off).
 *
 * How it works here (buyer data is keyed by a per-store `User` row, so a guest is simply a real but password-less
 * `User` with `isGuest: true`): the guest gets a normal session token (flagged `guest`) and then uses the exact same cart /
 * checkout / payment / order endpoints as a signed-in buyer — no parallel guest code path to keep in sync. Each guest
 * SESSION is its own row with a synthetic, un-guessable login email (so the `{storeId,email}` unique index never collides
 * and nobody can sign in as a guest); the buyer's real email is `contactEmail`, entered at checkout and used for
 * confirmation emails. A guest never sees another session's orders. When the same person later signs in / registers
 * (email verified), their guest orders are moved onto their account (`mergeGuestOrders`), exactly like Shopify attaches
 * guest orders to a customer account created with the same email.
 */
@Injectable()
export class GuestSessionService {
  private readonly logger = new Logger(GuestSessionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
  ) {}

  private get r() { return this.db.repositories; }

  async createSession(storeId: string) {
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('status customerAccounts').lean();
    if (!store || store.status === 'suspended' || store.status === 'rejected') throw new NotFoundException('Store not found');
    if (store.customerAccounts === 'required') {
      throw new ForbiddenException('This store requires an account to check out. Please sign in or create an account.');
    }

    const hashed = await bcrypt.hash(randomBytes(32).toString('hex'), 10); // nobody can ever log in as a guest
    const user: any = await this.r.userModel.create({
      name: 'Guest',
      email: `guest-${randomUUID()}@guest.invalid`,
      password: hashed,
      role: 'user',
      storeId,
      isVerified: true,
      isGuest: true,
      status: 'active',
    });

    const payload = { sub: user._id, email: user.email, role: 'user', tokenVersion: 0, storeId, guest: true };
    const accessToken = this.jwtService.sign(payload);
    await this.redis.set(accessToken, user._id.toString(), 24 * 60 * 60);
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    return {
      success: true,
      message: 'Guest session started',
      data: {
        user: { id: user._id, name: user.name, email: null, role: 'user', isGuest: true, image: null },
        token: { accessToken, refreshToken },
      },
    };
  }

  /** The email (and optionally name) a guest checks out with. Only ever valid for a guest session. */
  async setContact(userId: string, body: { email: string; name?: string }) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email) || email.length > 254) throw new BadRequestException('Enter a valid email address');
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const res: any = await this.r.userModel.updateOne(
      { _id: userId, isGuest: true },
      { $set: { contactEmail: email, ...(name ? { name } : {}) } },
    );
    if ((res.matchedCount ?? res.n ?? 0) === 0) throw new ForbiddenException('Only a guest checkout session can set a contact email');
    return { success: true, message: 'Contact saved', data: { email } };
  }

  /** Moves guest orders placed with this (now verified) email onto the real account. Best-effort, idempotent. */
  async mergeGuestOrders(storeId: string | null | undefined, email: string | null | undefined, userId: string): Promise<number> {
    if (!storeId || !email) return 0;
    const guests: any[] = await this.r.userModel
      .find({ storeId, isGuest: true, contactEmail: email.trim().toLowerCase() })
      .select('_id').lean();
    if (guests.length === 0) return 0;
    const guestIds = guests.map((g) => String(g._id));
    const res: any = await this.r.orderModel.updateMany({ userId: { $in: guestIds } }, { $set: { userId, customerId: userId } });
    // other guest sessions' orders that were counted under one of these guests now belong to the account's customer
    await this.r.orderModel.updateMany({ customerId: { $in: guestIds }, userId: { $ne: userId } }, { $set: { customerId: userId } });
    return res.modifiedCount ?? 0;
  }

  /** After a successful buyer login / OTP verification / social login. Never fails the auth response. */
  async mergeFromAuthResult(result: any, storeId: string | null | undefined): Promise<void> {
    try {
      const u = result?.data?.user;
      if (!u?.id || u.role !== 'user') return;
      await this.mergeGuestOrders(storeId, u.email, String(u.id));
    } catch (err: any) {
      this.logger.warn(`Guest order merge failed: ${err?.message}`);
    }
  }

  /** Daily housekeeping: guest sessions that never placed an order are worthless after a while. */
  async deleteStaleGuests(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const stale: any[] = await this.r.userModel
      .find({ isGuest: true, createdAt: { $lt: cutoff } })
      .select('_id').limit(2000).lean();
    if (stale.length === 0) return 0;
    const ids = stale.map((g) => String(g._id));
    const withOrders: any[] = await this.r.orderModel.distinct('userId', { userId: { $in: ids } });
    const keep = new Set(withOrders.map(String));
    const del = ids.filter((id) => !keep.has(id));
    if (del.length === 0) return 0;
    await this.r.cartModel.deleteMany({ userId: { $in: del } });
    const res: any = await this.r.userModel.deleteMany({ _id: { $in: del }, isGuest: true });
    return res.deletedCount ?? del.length;
  }
}
