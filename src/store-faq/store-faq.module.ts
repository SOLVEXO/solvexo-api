import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoreFaqController } from './store-faq.controller';
import { PublicStoreFaqController } from './public-store-faq.controller';
import { StoreFaqService } from './store-faq.service';

@Module({
  imports: [AuthModule],
  controllers: [StoreFaqController, PublicStoreFaqController],
  providers: [StoreFaqService],
  exports: [StoreFaqService],
})
export class StoreFaqModule {}
