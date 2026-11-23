import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UploadModule } from '../upload/upload.module';
import { MerchantApiModule } from '../merchant-api/merchant-api.module';
import { NewsletterModule } from '../newsletter/newsletter.module';
import { FormUpload, FormUploadSchema } from './schemas/form-upload.schema';
import { StoreFormSettings, StoreFormSettingsSchema } from './schemas/store-form-settings.schema';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SavedFormsController } from './saved-forms.controller';
import { SavedFormsService } from './saved-forms.service';
import { SavedForm, SavedFormSchema } from './schemas/saved-form.schema';
import { FormStat, FormStatSchema } from './schemas/form-stat.schema';
import { StoreContactController, PublicStoreContactController } from './store-contact.controller';
import { StoreContactService } from './store-contact.service';
import { EmailService } from '../otp/services/email.service';

@Module({
  imports: [
    AuthModule, RedisModule, NotificationsModule, UploadModule, MerchantApiModule, NewsletterModule,
    MongooseModule.forFeature([{ name: FormStat.name, schema: FormStatSchema }, { name: SavedForm.name, schema: SavedFormSchema }, { name: FormUpload.name, schema: FormUploadSchema }, { name: StoreFormSettings.name, schema: StoreFormSettingsSchema }]),
  ],
  controllers: [SavedFormsController, StoreContactController, PublicStoreContactController],
  providers: [SavedFormsService, StoreContactService, EmailService],
  exports: [StoreContactService],
})
export class StoreContactModule {}
