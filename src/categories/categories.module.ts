import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { AuthModule } from 'src/auth/auth.module';  
import { RedisModule } from 'src/redis/redis.module';  




@Module({
 
   imports: [AuthModule, RedisModule], 
  controllers: [ CategoriesController],
  providers: [CategoriesService], 
  exports: [CategoriesService], 

})

export class categoryModule {}