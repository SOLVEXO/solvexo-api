/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { DatabaseService } from '@/database/databaseservice';

/**
 * Wraps firebase-admin messaging for the device-token-registry push model
 * (see NotificationsService/DeviceToken schema). Initialized lazily from
 * FIREBASE_SERVICE_ACCOUNT (base64-encoded service account JSON) so pushing
 * degrades to a no-op — instead of crashing boot — when that env var isn't
 * configured yet (matches this repo's "never let notifications break the
 * flow that triggered them" convention).
 */
@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private messaging: admin.messaging.Messaging | null = null;

  constructor(private readonly databaseService: DatabaseService) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications are disabled');
      return;
    }
    try {
      const serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      this.messaging = admin.messaging();
    } catch (err) {
      this.logger.error(`Failed to initialize firebase-admin: ${err?.message}`);
    }
  }

  /** Pushes to every device registered for this user, pruning tokens FCM reports as dead. */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    if (!this.messaging) return;

    const tokens = await this.databaseService.repositories.deviceTokenModel
      .find({ userId })
      .lean();
    if (!tokens.length) return;

    const message: admin.messaging.MulticastMessage = {
      tokens: tokens.map((t) => t.fcmToken),
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    };

    try {
      const result = await this.messaging.sendEachForMulticast(message);
      const stale: string[] = [];
      result.responses.forEach((res, i) => {
        if (!res.success && res.error?.code === 'messaging/registration-token-not-registered') {
          stale.push(tokens[i].fcmToken);
        }
      });
      if (stale.length) {
        await this.databaseService.repositories.deviceTokenModel.deleteMany({
          fcmToken: { $in: stale },
        });
      }
    } catch (err) {
      this.logger.error(`Push send failed for user ${userId}: ${err?.message}`);
    }
  }
}
