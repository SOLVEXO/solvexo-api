import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
  Get,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartQuantityDto } from './dto/update-cart-quantity.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { DatabaseService } from '../database/databaseservice';
import { markStorefrontSession, readAnalyticsSessionId } from '../common/storefront-session.util';

@Controller('api/cart')
export class CartController {
  constructor(
    private readonly cartService: CartService,
    private readonly databaseService: DatabaseService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('add-to-cart')
  async addToCart(@Req() req: any, @Body() dto: AddToCartDto) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, dto.storeId);

    const result = await this.cartService.addToCart(userId, storeId, dto);
    // Online-store funnel: this visit added to cart (only after the real cart write succeeded).
    void markStorefrontSession(this.databaseService.repositories.storefrontSessionModel, storeId, readAnalyticsSessionId(req.body), { addedToCart: true, userId });
    return result;
  }
  @UseGuards(JwtAuthGuard)
  @Get('get-cart')
  async getCart(@Req() req: any, @Query('storeId') queryStoreId: string) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, queryStoreId);

    return this.cartService.getCart(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('update-cart-quantity')
  async updateCartQuantity(@Req() req: any, @Body() dto: UpdateCartQuantityDto) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, dto.storeId);

    return this.cartService.updateCartQuantity(userId, storeId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('remove-cart-item')
  async removeCartItem(@Req() req: any) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, req.body.storeId);

    return this.cartService.removeCartItem(userId, storeId, req.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('clear-cart')
  async clearCart(@Req() req: any, @Body('storeId') bodyStoreId: string) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, bodyStoreId);

    return this.cartService.clearCart(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('add-to-wishlist')
  async addToWishlist(@Req() req: any, @Body() body: any) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, body.storeId);

    return this.cartService.addToWishlist(userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-wishlist')
  async getWishlist(@Req() req: any, @Query('storeId') queryStoreId: string) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, queryStoreId);
    return this.cartService.getWishlist(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-wishlist-item')
  async getWishlistItem(@Req() req: any, @Query() query: any) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, query.storeId);
    return this.cartService.getWishlistItem(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard)
  @Post('remove-from-wishlist')
  async removeFromWishlist(
    @Req() req: any,
    @Body('wishlistId') wishlistId: string,
    @Body('storeId') bodyStoreId: string,
  ) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, bodyStoreId);
    return await this.cartService.removeFromWishlist(userId, storeId, wishlistId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('clear-wishlist')
  async clearWishlist(@Req() req: any, @Body('storeId') bodyStoreId: string) {
    const { userId, storeId: userStoreId } = req.user;
    const storeId = resolveBuyerStoreScope(userStoreId, bodyStoreId);
    return this.cartService.clearWishlist(userId, storeId);
  }
}
