import { Body, Controller, Post, Req, UseGuards, Get , Query} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('api/cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}


  @UseGuards(JwtAuthGuard)
  @Post('add-to-cart')
  async addToCart(@Req() req: any, @Body() dto: AddToCartDto) {
    const { userId } = req.user;

    return this.cartService.addToCart(userId, dto);
  }
    @UseGuards(JwtAuthGuard)
  @Get('get-cart')
  async getCart(@Req() req: any) {
    const { userId } = req.user;

    return this.cartService.getCart(userId);
  }

  @UseGuards(JwtAuthGuard)
@Post('update-cart-quantity')
async updateCartQuantity(@Req() req: any) {
  const { userId } = req.user;

  return this.cartService.updateCartQuantity(userId, req.body);
}

@UseGuards(JwtAuthGuard)
@Post('remove-cart-item')
async removeCartItem(@Req() req: any) {
  const { userId } = req.user;

  return this.cartService.removeCartItem(userId, req.body);
}

@UseGuards(JwtAuthGuard)
@Post('clear-cart')
async clearCart(@Req() req: any) {
  const { userId } = req.user;

  return this.cartService.clearCart(userId);
}





  @UseGuards(JwtAuthGuard)
@Post('add-to-wishlist')
async addToWishlist(@Req() req: any, @Body() body: any) {
  const { userId } = req.user;
  

  return this.cartService.addToWishlist(userId, body);
}

@UseGuards(JwtAuthGuard)
@Get('get-wishlist')
async getWishlist(@Req() req: any) {
  const { userId } = req.user;
  return this.cartService.getWishlist(userId);
}

@UseGuards(JwtAuthGuard)
@Get('get-wishlist-item')
async getWishlistItem(@Req() req: any, @Query() query: any) {
  const { userId } = req.user;
  return this.cartService.getWishlistItem(userId, query);
}

 
   @Post('remove-from-wishlist')
  async removeFromWishlist(@Body('wishlistId') wishlistId: string) {
    return await this.cartService.removeFromWishlist(wishlistId);
  }

  @UseGuards(JwtAuthGuard)
@Post('clear-wishlist')
async clearWishlist(@Req() req: any) {
  const { userId } = req.user;
  return this.cartService.clearWishlist(userId);
}

}



