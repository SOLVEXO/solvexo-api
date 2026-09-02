/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { EmailService } from '../otp/services/email.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateStoreAppRequestDto } from './dto/create-store-app-request.dto';
import { UpdatePlatformStatusDto } from './dto/update-platform-status.dto';
import { StoreAppPlatformStatus } from './schemas/store-app-request.schema';

const ICON_MAX_BYTES = 1 * 1024 * 1024;
const ICON_REQUIRED_SIZE = 512;
const FEATURE_GRAPHIC_MAX_BYTES = 15 * 1024 * 1024;
const FEATURE_GRAPHIC_REQUIRED_WIDTH = 1024;
const FEATURE_GRAPHIC_REQUIRED_HEIGHT = 500;

@Injectable()
export class StoreAppRequestsService {
  private readonly logger = new Logger(StoreAppRequestsService.name);
  private readonly stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    else this.logger.warn('STRIPE_SECRET_KEY not set — store app platform payments are disabled.');
  }

  private get model() {
    return this.databaseService.repositories.storeAppRequestModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }
  private get adminModel() {
    return this.databaseService.repositories.adminModel;
  }

  /** Per-platform build fee — configurable via env (STORE_APP_PLATFORM_FEE_USD),
   *  with a sensible placeholder fallback. Unrelated to Solvexo POS, which is
   *  a Google Play paid listing and has no fee/Stripe flow on our side at all
   *  (see StoreService.getPosAppInfo). */
  private platformFeeUSD(): number {
    const raw = this.configService.get<string>('STORE_APP_PLATFORM_FEE_USD');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 9.99;
  }

  // ── Seller ──────────────────────────────────────────────────────────────

  /** Creates the app's profile/listing shell (name, descriptions, optional
   *  icon/feature graphic) — free to submit. Android and iOS aren't chosen
   *  here: each is requested (and paid for) separately afterward via
   *  createPlatformPaymentIntent/confirmPlatformPayment, so a seller can buy
   *  just Android now and iOS later without resubmitting anything. */
  async create(
    sellerId: string,
    storeId: string,
    dto: CreateStoreAppRequestDto,
    iconFile?: Express.Multer.File,
    featureGraphicFile?: Express.Multer.File,
  ) {
    const store = await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);

    // One app shell per store, ever — a seller doesn't re-submit the app
    // profile just to buy another platform; they use the existing shell's
    // per-platform pay buttons instead.
    const existing = await this.model.exists({ storeId });
    if (existing) {
      throw new BadRequestException('An app request already exists for this store — use it to request a platform.');
    }

    // Icon/feature graphic are both optional — a seller can submit the
    // request without them and add them later; only spec-check + upload
    // whichever one was actually provided.
    if (iconFile) this.assertIconSpec(iconFile);
    if (featureGraphicFile) this.assertFeatureGraphicSpec(featureGraphicFile);

    const [icon, featureGraphic] = await Promise.all([
      iconFile ? this.uploadService.uploadFile(iconFile, { folder: 'uploads/store-app-icons' }) : Promise.resolve(null),
      featureGraphicFile ? this.uploadService.uploadFile(featureGraphicFile, { folder: 'uploads/store-app-feature-graphics' }) : Promise.resolve(null),
    ]);

    if (icon) this.assertUploadedDimensions(icon, ICON_REQUIRED_SIZE, ICON_REQUIRED_SIZE, 'App icon');
    if (featureGraphic) this.assertUploadedDimensions(featureGraphic, FEATURE_GRAPHIC_REQUIRED_WIDTH, FEATURE_GRAPHIC_REQUIRED_HEIGHT, 'Feature graphic');

    const request = await this.model.create({
      storeId,
      sellerId,
      appName: dto.appName,
      shortDescription: dto.shortDescription,
      fullDescription: dto.fullDescription,
      iconUrl: icon?.url ?? null,
      iconPublicId: icon?.publicId ?? '',
      featureGraphicUrl: featureGraphic?.url ?? null,
      featureGraphicPublicId: featureGraphic?.publicId ?? '',
      // Both platforms start unrequested/unpaid — chosen individually later.
    });

    this.notifyAdmins(store.name, request._id.toString(), dto.appName).catch(() => {});

    return { success: true, message: 'App request submitted — request a platform to start a build', data: request };
  }

  async getForStore(sellerId: string, storeId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const requests = await this.model.find({ storeId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: requests };
  }

  /**
   * Starts a Stripe PaymentIntent for one platform's build fee. The platform
   * only actually becomes `requested` once confirmPlatformPayment verifies
   * the charge succeeded. Also allows re-paying a platform that was
   * previously rejected, so a seller isn't stuck after admin feedback.
   */
  async createPlatformPaymentIntent(sellerId: string, storeId: string, platform: 'android' | 'ios') {
    if (platform !== 'android' && platform !== 'ios') {
      throw new BadRequestException('Platform must be "android" or "ios"');
    }
    if (!this.stripe) throw new BadRequestException('Online payments are not configured yet.');
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);

    const request = await this.model.findOne({ storeId }).sort({ createdAt: -1 });
    if (!request) {
      throw new BadRequestException('Submit your app details first before requesting a platform.');
    }
    const state = request[platform];
    if (state.requested && state.status !== 'rejected') {
      throw new BadRequestException(`${platform === 'android' ? 'Android' : 'iOS'} has already been requested for this app.`);
    }

    const priceUSD = this.platformFeeUSD();
    const amountCents = Math.round(priceUSD * 100);
    const idempotencyKey = `store_app_platform_${request._id.toString()}_${platform}_${amountCents}`;

    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        metadata: { storeId, sellerId, requestId: request._id.toString(), platform, purpose: 'store_app_platform' },
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      { idempotencyKey },
    );

    state.paymentStatus = 'pending';
    state.stripePaymentIntentId = paymentIntent.id;
    await request.save();

    return { success: true, data: { clientSecret: paymentIntent.client_secret, amount: priceUSD } };
  }

  /** Called right after Stripe Elements confirms the card payment
   *  client-side — verifies the PaymentIntent's real status directly with
   *  Stripe before flipping that platform's `requested`/`status`, same
   *  client-confirm convention used elsewhere (e.g. PromotionsService). */
  async confirmPlatformPayment(sellerId: string, storeId: string, platform: 'android' | 'ios') {
    if (platform !== 'android' && platform !== 'ios') {
      throw new BadRequestException('Platform must be "android" or "ios"');
    }
    if (!this.stripe) throw new BadRequestException('Online payments are not configured yet.');
    const store = await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);

    const request = await this.model.findOne({ storeId }).sort({ createdAt: -1 });
    if (!request) throw new NotFoundException('Request not found');
    const state = request[platform];

    if (state.requested && state.status !== 'rejected') {
      return { success: true, message: 'Already confirmed', data: request };
    }
    if (!state.stripePaymentIntentId) {
      throw new BadRequestException('No payment has been started for this platform yet');
    }

    const paymentIntent = await this.stripe.paymentIntents.retrieve(state.stripePaymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException(`Payment has not completed yet (status: ${paymentIntent.status}).`);
    }

    state.requested = true;
    state.status = 'pending';
    state.paymentStatus = 'paid';
    state.storeUrl = null;
    state.rejectionReason = null;
    state.publishedAt = null;
    // Fresh timeline for this request cycle — a platform re-requested after
    // a rejection starts a brand-new history, not a continuation of the old
    // (rejected) one.
    state.statusHistory = [{ status: 'pending', changedAt: new Date() }] as any;
    await request.save();

    this.notifyAdminsPlatformAdded(store.name, request._id.toString(), request.appName, platform).catch(() => {});

    return { success: true, message: `${platform === 'android' ? 'Android' : 'iOS'} requested`, data: request };
  }

  // ── Admin ───────────────────────────────────────────────────────────────

  async adminList(query: { status?: StoreAppPlatformStatus; platform?: 'android' | 'ios' }) {
    const filter: Record<string, unknown> = {};
    if (query.status && query.platform) {
      filter[`${query.platform}.status`] = query.status;
    } else if (query.status) {
      filter.$or = [{ 'android.status': query.status }, { 'ios.status': query.status }];
    }

    const requests = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    // Every request already carries storeId — this join is what actually
    // surfaces "which store sent this" as a real name in the admin list,
    // not just a bare id.
    const storeIds = [...new Set(requests.map((r: any) => r.storeId))];
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug sellerId').lean();
    const storeMap = new Map(stores.map((s: any) => [String(s._id), s]));

    return {
      success: true,
      data: requests.map((r: any) => ({
        ...r,
        storeName: storeMap.get(r.storeId)?.name ?? null,
        storeSlug: storeMap.get(r.storeId)?.slug ?? null,
      })),
    };
  }

  async adminGetOne(id: string) {
    const request = await this.model.findById(id).lean();
    if (!request) throw new NotFoundException('Request not found');
    const store = await this.storeModel.findById((request as any).storeId).select('name slug sellerId').lean();
    return { success: true, data: { ...request, storeName: store?.name ?? null, storeSlug: store?.slug ?? null } };
  }

  async updatePlatformStatus(adminId: string, id: string, dto: UpdatePlatformStatusDto) {
    const request = await this.model.findById(id);
    if (!request) throw new NotFoundException('Request not found');

    const state = request[dto.platform];
    if (!state.requested) {
      throw new BadRequestException(`${dto.platform === 'android' ? 'Android' : 'iOS'} was not requested on this request`);
    }
    if (dto.status === 'published' && !dto.storeUrl) {
      throw new BadRequestException('storeUrl is required when marking a platform published');
    }

    state.status = dto.status;
    state.statusHistory = [...(state.statusHistory ?? []), { status: dto.status, changedAt: new Date() }] as any;
    if (dto.status === 'published') {
      state.storeUrl = dto.storeUrl!;
      state.publishedAt = new Date();
      state.rejectionReason = null;
    } else if (dto.status === 'rejected') {
      state.rejectionReason = dto.rejectionReason ?? null;
    }

    if (dto.adminNotes !== undefined) request.adminNotes = dto.adminNotes;
    request.reviewedBy = adminId;
    await request.save();

    const store = await this.storeModel.findById(request.storeId).select('name').lean();
    const platformLabel = dto.platform === 'android' ? 'Android' : 'iOS';

    if (dto.status === 'published') {
      this.notificationsService.notify({
        recipientId: request.sellerId, recipientRole: 'seller',
        type: NOTIFICATION_TYPES.STORE_APP_PUBLISHED,
        title: `Your ${platformLabel} app is live!`,
        body: `${request.appName} is now published on the ${dto.platform === 'android' ? 'Play Store' : 'App Store'}${(store as any)?.name ? ` for ${(store as any).name}` : ''}.`,
        data: { storeAppRequestId: id, platform: dto.platform, storeUrl: dto.storeUrl },
      }).catch(() => {});
    } else if (dto.status === 'rejected') {
      this.notificationsService.notify({
        recipientId: request.sellerId, recipientRole: 'seller',
        type: NOTIFICATION_TYPES.STORE_APP_REJECTED,
        title: `${platformLabel} app request needs changes`,
        body: dto.rejectionReason || `Your ${platformLabel} app request couldn't be approved as submitted.`,
        data: { storeAppRequestId: id, platform: dto.platform },
      }).catch(() => {});
    } else {
      this.notificationsService.notify({
        recipientId: request.sellerId, recipientRole: 'seller',
        type: NOTIFICATION_TYPES.STORE_APP_PLATFORM_UPDATED,
        title: `${platformLabel} app update`,
        body: `Your ${platformLabel} app request for ${request.appName} is now "${dto.status.replace(/_/g, ' ')}".`,
        data: { storeAppRequestId: id, platform: dto.platform, status: dto.status },
      }).catch(() => {});
    }

    return { success: true, message: 'Platform status updated', data: request };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private assertIconSpec(file: Express.Multer.File) {
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
      throw new BadRequestException('App icon must be a PNG or JPEG');
    }
    if (file.size > ICON_MAX_BYTES) {
      throw new BadRequestException('App icon must be 1MB or smaller');
    }
  }

  private assertFeatureGraphicSpec(file: Express.Multer.File) {
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
      throw new BadRequestException('Feature graphic must be a PNG or JPEG');
    }
    if (file.size > FEATURE_GRAPHIC_MAX_BYTES) {
      throw new BadRequestException('Feature graphic must be 15MB or smaller');
    }
  }

  // Cloudinary reports the actual decoded pixel dimensions on its upload
  // response — checked here (post-upload) rather than pre-upload, since
  // that's the one place we get real dimensions without adding a separate
  // image-parsing dependency just for this.
  private assertUploadedDimensions(
    uploaded: { width?: number; height?: number; publicId: string },
    requiredWidth: number,
    requiredHeight: number,
    label: string,
  ) {
    if (uploaded.width !== requiredWidth || uploaded.height !== requiredHeight) {
      this.uploadService.deleteFile(uploaded.publicId, 'image').catch(() => {});
      throw new BadRequestException(
        `${label} must be exactly ${requiredWidth}×${requiredHeight}px (got ${uploaded.width ?? '?'}×${uploaded.height ?? '?'})`,
      );
    }
  }

  private async notifyAdmins(storeName: string, requestId: string, appName: string) {
    const admins = await this.adminModel.find({}).select('email').lean();
    const subject = `New store app profile submitted — ${storeName}`;
    const html = `<p><strong>${storeName}</strong> submitted a white-label app profile (no platform paid/requested yet).</p><p>App name: ${appName}</p><p>Request ID: ${requestId}</p>`;
    await Promise.allSettled((admins as any[]).map((a) => this.emailService.sendMail(a.email, subject, html)));
  }

  private async notifyAdminsPlatformAdded(storeName: string, requestId: string, appName: string, platform: 'android' | 'ios') {
    const platformLabel = platform === 'android' ? 'Android' : 'iOS';
    const admins = await this.adminModel.find({}).select('email').lean();
    const subject = `Store app platform paid — ${storeName} requested ${platformLabel}`;
    const html = `<p><strong>${storeName}</strong> paid for and requested <strong>${platformLabel}</strong>.</p><p>App name: ${appName}</p><p>Request ID: ${requestId}</p>`;
    await Promise.allSettled((admins as any[]).map((a) => this.emailService.sendMail(a.email, subject, html)));
  }
}
