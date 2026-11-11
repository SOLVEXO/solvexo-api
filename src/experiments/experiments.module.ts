import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { Experiment, ExperimentSchema } from './experiment.schema';
import { ExperimentsController, PublicExperimentsController } from './experiments.controller';
import { ExperimentsService } from './experiments.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: Experiment.name, schema: ExperimentSchema }])],
  controllers: [ExperimentsController, PublicExperimentsController],
  providers: [ExperimentsService],
  exports: [ExperimentsService],
})
export class ExperimentsModule {}
