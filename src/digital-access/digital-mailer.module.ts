import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { DigitalMailerService } from './digital-mailer.service';

@Module({ imports: [NotificationsModule], providers: [DigitalMailerService], exports: [DigitalMailerService] })
export class DigitalMailerModule {}
