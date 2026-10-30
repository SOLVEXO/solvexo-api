import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { storePublicUrl } from '../newsletter/marketing-email.util';
import type { CustomerEmailEvent } from '../notifications/customer-email-events';

/**
 * Customer emails of the digital module. Every send goes through the store's own notification
 * settings (per-store on/off switch, text, sender), is fire-and-forget and never throws into the
 * caller: a mail problem must not fail a purchase, a renewal run or a file upload.
 */
@Injectable()
export class DigitalMailerService {
  private readonly logger = new Logger(DigitalMailerService.name);

  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}

  private async resolve(storeId: string, customerId: string) {
    const { storeModel, userModel } = this.db.repositories as any;
    const [store, user] = await Promise.all([
      storeModel.findOne({ _id: storeId }).select('slug customDomain customDomainStatus name').lean(),
      userModel.findOne({ _id: customerId }).select('name email contactEmail isGuest').lean(),
    ]);
    const to = String(user?.contactEmail || user?.email || '');
    if (!store || !to.includes('@') || to.endsWith('.invalid')) return null; // guests with a synthetic login email have no real address
    return { to, name: user?.name ?? null, base: storePublicUrl(store) ?? '' };
  }

  private async send(event: CustomerEmailEvent, storeId: string, customerId: string, vars: Record<string, any>, path: string) {
    try {
      const r = await this.resolve(storeId, customerId);
      if (!r) return;
      const url = `${r.base}${path}`;
      await this.notifications.sendCustomerEmail({
        to: r.to, storeId, event,
        vars: { customerName: r.name, libraryUrl: url, membershipUrl: url, ...vars },
        cta: r.base ? { label: path === '/library' ? 'Open my library' : 'Manage membership', url } : null,
      });
    } catch (e: any) {
      this.logger.warn(`${event} email failed: ${e?.message}`);
    }
  }

  /** Guest recovery: the one-time link goes only to the address stored on the order's customer. */
  accessLink(storeId: string, customerId: string, token: string) {
    return this.send('digital_access_link', storeId, customerId, {}, `/library?recovery=${encodeURIComponent(token)}`);
  }

  purchaseDelivered(storeId: string, customerId: string, productName: string) {
    return this.send('digital_purchase_delivered', storeId, customerId, { productName }, '/library');
  }

  fileUpdated(storeId: string, customerId: string, v: { productName: string; fileName: string; version: string; changelog: string | null }) {
    return this.send('digital_file_updated', storeId, customerId, { productName: v.productName, fileName: v.fileName, versionLabel: v.version, changelog: v.changelog ? `What is new: ${v.changelog}` : '' }, '/library');
  }

  membership(event: Extract<CustomerEmailEvent, `membership_${string}`>, storeId: string, customerId: string, planName: string, renewalDate?: Date | null) {
    return this.send(event, storeId, customerId, { planName, renewalDate: renewalDate ? renewalDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '' }, '/memberships');
  }
}
