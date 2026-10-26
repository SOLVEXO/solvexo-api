import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreChatSettingsService } from './store-chat-settings.service';

// Public: the buyer chat page needs the store chat photo, name and line without any login.
@ApiTags('Store chat settings (public)')
@Controller('api/public/store-chat-settings')
export class PublicStoreChatSettingsController {
  constructor(private readonly service: StoreChatSettingsService) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.service.getPublic(storeId);
  }
}
