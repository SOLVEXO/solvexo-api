import * as crypto from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { EmailService } from '../otp/services/email.service';
import {
  newsletterUnsubscribeUrl,
  normalizeEmail,
  setMarketingConsent,
  setPendingConsent,
} from './newsletter-consent.util';
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import { NewsletterSource } from './schemas/newsletter-subscriber.schema';
import {
  escapeHtml,
  renderMarketingEmail,
  unsubscribeHeaders,
} from './marketing-email.util';
import { MarketingAutomationsService } from '../marketing-automations/marketing-automations.service';

const APP_NAME = process.env.APP_NAME || 'Solvexo';

/** Solvexo's own list — the audience is merchants, not shoppers. */
function platformWelcomeHtml(unsubscribeUrl: string): string {
  return renderMarketingEmail({
    senderName: APP_NAME,
    heading: "You're on the list!",
    bodyHtml: `<p style="margin:0">Thanks for subscribing to ${APP_NAME}. You'll get product updates, new features, selling tips and merchant-only offers to help your business grow.</p>`,
    reason: `You're receiving this because you subscribed to ${APP_NAME} updates. Didn't request this? Unsubscribe below.`,
    unsubscribeUrl,
  });
}

function unsubscribePageHtml(title: string, message: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #333; }
  .card { background: #fff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
}

export interface SubscribeOptions {
  storeId?: string | null;
  source?: NewsletterSource;
  userId?: string | null;
}

@Injectable()
export class NewsletterService implements OnModuleInit {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly emailService: EmailService,
    private readonly automations: MarketingAutomationsService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  onModuleInit() {
    // Not awaited — a slow migration must never hold up boot.
    void this.migrateLegacyData();
  }

  /**
   * One-time, idempotent upgrades for rows written before lists were
   * per-store:
   *  - the old `email_1` unique index would block the same email from
   *    subscribing to two stores, so it has to go (the schema now declares
   *    `{ storeId, email }` unique instead);
   *  - customers a seller had already marked `marketingOptIn` get a
   *    subscriber row, since campaigns now only send to subscriber rows.
   *    `$setOnInsert` only, so it never re-activates someone who
   *    unsubscribed.
   */
  private async migrateLegacyData() {
    const { newsletterSubscriberModel, storeCustomerMetaModel, userModel } =
      this.r;
    try {
      const indexes = await newsletterSubscriberModel.collection.indexes();
      if (indexes.some((i) => i.name === 'email_1')) {
        await newsletterSubscriberModel.collection.dropIndex('email_1');
        this.logger.log('Dropped legacy unique index newsletter email_1');
      }
    } catch (e: any) {
      // A missing collection (fresh DB) just means there's nothing to drop.
      if (e?.codeName !== 'NamespaceNotFound') {
        this.logger.warn(`Legacy index cleanup skipped: ${e?.message}`);
      }
    }

    try {
      const metas = await storeCustomerMetaModel
        .find({ marketingOptIn: true })
        .select('storeId userId')
        .lean();
      if (metas.length === 0) return;
      const users = await userModel
        .find({ _id: { $in: [...new Set(metas.map((m) => m.userId))] } })
        .select('email')
        .lean();
      const emailById = new Map(
        users.map((u: any) => [String(u._id), normalizeEmail(u.email)]),
      );

      const ops = metas
        .map((m) => ({ m, email: emailById.get(String(m.userId)) }))
        .filter((x) => !!x.email)
        .map(({ m, email }) => ({
          updateOne: {
            filter: { storeId: String(m.storeId), email },
            update: {
              $setOnInsert: {
                storeId: String(m.storeId),
                email,
                userId: String(m.userId),
                isActive: true,
                source: 'seller',
                consentAt: new Date(),
                unsubscribeToken: crypto.randomBytes(24).toString('hex'),
              },
            },
            upsert: true,
          },
        }));
      if (ops.length) {
        const res = await newsletterSubscriberModel.bulkWrite(ops as any, {
          ordered: false,
        });
        if (res.upsertedCount) {
          this.logger.log(
            `Backfilled ${res.upsertedCount} store subscriber(s) from customer opt-ins`,
          );
        }
      }
    } catch (e: any) {
      this.logger.warn(`Subscriber backfill skipped: ${e?.message}`);
    }
  }

  /** Keeps StoreCustomerMeta.marketingOptIn (what the seller's customer
   *  screens and GDPR export read) mirroring the subscriber row. Only
   *  updates meta rows that already exist — never invents a customer. */
  private async mirrorToCustomerMeta(
    storeId: string,
    email: string,
    subscribed: boolean,
    userId?: string | null,
  ) {
    const { userModel, storeCustomerMetaModel } = this.r;
    // User.email is stored lowercased, same as the subscriber row.
    const users = await userModel.find({ email }).select('_id').lean();
    const ids = new Set(users.map((u: any) => String(u._id)));
    if (userId) ids.add(String(userId));
    if (ids.size === 0) return;
    await storeCustomerMetaModel.updateMany(
      { storeId, userId: { $in: [...ids] } },
      { $set: { marketingOptIn: subscribed } },
    );
  }

  async subscribe(email: string, options: SubscribeOptions = {}) {
    const normalizedEmail = normalizeEmail(email);
    const storeId = options.storeId ? String(options.storeId) : null;

    let store: any = null;
    if (storeId) {
      store = await this.r.storeModel
        .findOne({ _id: storeId, isDelete: false })
        .select('name')
        .lean()
        .catch(() => null);
      if (!store) throw new BadRequestException('Store not found');
    }

    const source: NewsletterSource =
      options.source ?? (storeId ? 'store_footer' : 'platform_footer');

    // Double opt-in: record the request as pending and email a confirm link;
    // they only become a subscriber (and get the welcome) once they click it.
    if (storeId && (await this.automations.getSettings(storeId)).doubleOptIn) {
      const pending = await setPendingConsent(this.r.newsletterSubscriberModel, {
        storeId,
        email: normalizedEmail,
        source,
        userId: options.userId ?? null,
      });
      if (pending.alreadyActive) {
        return { success: true, message: "You're already subscribed — welcome aboard!" };
      }
      if (pending.confirmToken) {
        const confirmUrl = `${API_PUBLIC_ORIGIN}/api/newsletter/confirm/${pending.confirmToken}`;
        this.automations
          .sendConfirmation(storeId, normalizedEmail, confirmUrl)
          .catch((e) => this.logger.warn(`Confirmation email to ${normalizedEmail} failed: ${e?.message}`));
      }
      return {
        success: true,
        message: 'Almost done — check your inbox and confirm your subscription.',
        data: { pendingConfirmation: true },
      };
    }

    const result = await setMarketingConsent(this.r.newsletterSubscriberModel, {
      storeId,
      email: normalizedEmail,
      subscribed: true,
      source,
      userId: options.userId ?? null,
    });

    if (storeId) {
      await this.mirrorToCustomerMeta(
        storeId,
        normalizedEmail,
        true,
        options.userId,
      ).catch((e) =>
        this.logger.warn(`Customer opt-in mirror failed: ${e?.message}`),
      );
    }

    if (result.wasActive) {
      return {
        success: true,
        message: "You're already subscribed — welcome aboard!",
      };
    }

    // Checkout consent is a checkbox on the way to paying — a welcome email
    // on top of the order confirmation is noise (Shopify doesn't send one either).
    if (source !== 'checkout' && result.unsubscribeToken) {
      const token = result.unsubscribeToken;
      // A store's welcome is the seller's own (Marketing → Automations —
      // text, discount code, or switched off); Solvexo's is fixed.
      const send = storeId
        ? this.automations.sendWelcome(storeId, normalizedEmail, token)
        : this.emailService.sendMail(
            normalizedEmail,
            `Welcome to ${APP_NAME} updates`,
            platformWelcomeHtml(newsletterUnsubscribeUrl(token)),
            null,
            unsubscribeHeaders(newsletterUnsubscribeUrl(token)),
          );
      send.catch((e) =>
        this.logger.warn(
          `Welcome email to ${normalizedEmail} failed: ${e?.message}`,
        ),
      );
    }

    return { success: true, message: "You're subscribed — welcome aboard!" };
  }

  /** The link in a double opt-in confirmation email. */
  async confirmByToken(token: string): Promise<string> {
    const row = token
      ? await this.r.newsletterSubscriberModel.findOne({ confirmToken: token, pendingConfirmation: true }).lean()
      : null;
    if (!row) {
      return unsubscribePageHtml(APP_NAME, 'This confirmation link is invalid or was already used.');
    }
    const storeId = row.storeId ? String(row.storeId) : null;
    const result = await setMarketingConsent(this.r.newsletterSubscriberModel, {
      storeId,
      email: row.email,
      subscribed: true,
      source: row.source,
      userId: row.userId,
    });
    let listName = APP_NAME;
    if (storeId) {
      await this.mirrorToCustomerMeta(storeId, row.email, true, row.userId).catch(() => undefined);
      const store = await this.r.storeModel.findById(storeId).select('name').lean().catch(() => null);
      if (store?.name) listName = escapeHtml(store.name);
      if (result.unsubscribeToken && row.source !== 'checkout') {
        this.automations
          .sendWelcome(storeId, row.email, result.unsubscribeToken)
          .catch((e) => this.logger.warn(`Welcome email to ${row.email} failed: ${e?.message}`));
      }
    }
    return unsubscribePageHtml(listName, `You're subscribed! You'll now get news and offers from ${listName}.`);
  }

  /** Opt-in for a logged-in account, using the email on file. */
  async subscribeAccount(
    userId: string,
    storeId: string,
    source: NewsletterSource,
  ) {
    const user = await this.r.userModel
      .findById(userId)
      .select('email')
      .lean()
      .catch(() => null);
    if (!user?.email) throw new BadRequestException('Account email not found');
    return this.subscribe(user.email, { storeId, source, userId });
  }

  async unsubscribeByToken(token: string): Promise<string> {
    const subscriber = token
      ? await this.r.newsletterSubscriberModel.findOne({
          unsubscribeToken: token,
        })
      : null;

    if (!subscriber) {
      return unsubscribePageHtml(
        APP_NAME,
        'This unsubscribe link is invalid or has already been used.',
      );
    }

    let listName = APP_NAME;
    if (subscriber.storeId) {
      const store = await this.r.storeModel
        .findById(subscriber.storeId)
        .select('name')
        .lean()
        .catch(() => null);
      if (store?.name) listName = escapeHtml(store.name);
    }

    if (subscriber.isActive) {
      subscriber.isActive = false;
      subscriber.unsubscribedAt = new Date();
      await subscriber.save();
      if (subscriber.storeId) {
        await this.mirrorToCustomerMeta(
          subscriber.storeId,
          subscriber.email,
          false,
          subscriber.userId,
        ).catch((e) =>
          this.logger.warn(`Customer opt-out mirror failed: ${e?.message}`),
        );
      }
    }

    return unsubscribePageHtml(
      listName,
      `You've been unsubscribed and won't receive marketing emails from ${listName} anymore. Sorry to see you go!`,
    );
  }
}
