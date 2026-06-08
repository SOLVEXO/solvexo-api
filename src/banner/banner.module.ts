import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { BannersController } from './banner.controller';
import { BannersService } from './banner.service';
import { Banner, BannerSchema } from './schemas/banner.schema';

@Module({
    imports: [
        ConfigModule,
        MongooseModule.forFeature([
            { name: Banner.name, schema: BannerSchema },
        ]),
    ],
    controllers: [BannersController],
    providers: [BannersService],
    exports: [BannersService],
})
export class BannersModule { }