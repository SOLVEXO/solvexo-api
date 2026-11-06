/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { MessagingConsentService } from '../messaging-channels/messaging-consent.service';
import { SmsGatewayService } from '../messaging-channels/sms-gateway.service';
import { contactKey } from '../messaging-channels/messaging-rules.util';
import { KhataAccount, KhataAccountDocument } from './khata.schema';
import { round2 } from './khata-rules.util';

const DAY = 86_400_000;
/** One reminder per customer account per this many hours. */
export const REMINDER_GAP_HOURS = 24;

/** Pure: the text of a balance reminder. The opt-out line is added by the SMS gateway. */
export function reminderText(storeName: string, amount: number, currency: string): string {
  return `${storeName}: your balance due is ${currency} ${round2(amount).toLocaleString('en-US')}. Please pay at your earliest convenience. Thank you.`.slice(0, 300);
}

/**
 * Payment reminder for a khata customer over SMS (P4 channel). Only to a customer who OPTED IN to SMS from this store, only while the
 * platform messaging switch and the store's own SMS gateway are on, at most one per day per customer. WhatsApp needs an approved
 * template and is not used here.
 */
@Injectable()
export class KhataRemindersService {
  constructor(
    @InjectModel(KhataAccount.name) private readonly accounts: Model<KhataAccountDocument>,
    private readonly consent: MessagingConsentService,
    private readonly sms: SmsGatewayService,
    private readonly db: DatabaseService,
  ) {}

  async remind(storeId: string, accountId: string) {
    if (process.env.MESSAGING_CAMPAIGNS_ENABLED !== 'true') throw new ForbiddenException('Messaging is not available yet');
    const acc: any = await this.accounts.findOne({ _id: accountId, storeId, archived: false }).lean();
    if (!acc) throw new NotFoundException('Account not found');
    if (!(acc.balance > 0)) throw new BadRequestException('This customer owes nothing');
    const key = contactKey(acc.phone);
    if (!key) throw new BadRequestException('Add a valid phone number for this customer first');
    const status = (await this.consent.statusFor(storeId, 'sms', [key])).get(key);
    if (status !== 'opted_in') throw new BadRequestException('This customer has not agreed to receive SMS from your store, so no reminder was sent');
    if (!(await this.sms.activeConfig(storeId))) throw new BadRequestException('Your SMS provider is not switched on');
    const since = new Date(Date.now() - REMINDER_GAP_HOURS * 3_600_000);
    const claimed = await this.accounts.findOneAndUpdate({ _id: accountId, storeId, $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: since } }] }, { $set: { lastReminderAt: new Date() } }, { new: false }).lean();
    if (!claimed) throw new ConflictException('A reminder was already sent in the last 24 hours');
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name').lean();
    const r = await this.sms.sendMarketing(storeId, acc.phone, reminderText(store?.name ?? 'Your store', acc.balance, acc.currency));
    if (!r.success) {
      await this.accounts.updateOne({ _id: accountId, lastReminderAt: { $ne: null } }, { $set: { lastReminderAt: claimed.lastReminderAt ?? null } });
      throw new BadRequestException(`The SMS was not sent: ${r.error ?? 'provider error'}`);
    }
    return { sent: true, to: `…${String(acc.phone).slice(-4)}` };
  }
}
