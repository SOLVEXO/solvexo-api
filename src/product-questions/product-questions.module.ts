import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ProductQuestion, ProductQuestionSchema } from './product-question.schema';
import { ProductQuestionsController, PublicProductQuestionsController } from './product-questions.controller';
import { ProductQuestionsService } from './product-questions.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: ProductQuestion.name, schema: ProductQuestionSchema }])],
  controllers: [ProductQuestionsController, PublicProductQuestionsController],
  providers: [ProductQuestionsService],
})
export class ProductQuestionsModule {}
