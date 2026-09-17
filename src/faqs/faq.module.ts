import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Faq, FaqSchema } from './schemas/faq.schema';
import { FaqService } from './faq.service';
import { FaqController } from './faq.controller';
import { RedisModule } from '@/redis/redis.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Faq.name, schema: FaqSchema }]),
    RedisModule,
  ],
  controllers: [FaqController],
  providers: [FaqService],
  exports: [FaqService], // ✅ Export for use in other modules if needed
})
export class FaqModule {}
