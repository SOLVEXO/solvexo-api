/* eslint-disable prettier/prettier */
import { PartialType } from '@nestjs/swagger';
import { CreateStoreBannerDto } from './create-store-banner.dto';

export class UpdateStoreBannerDto extends PartialType(CreateStoreBannerDto) {}
