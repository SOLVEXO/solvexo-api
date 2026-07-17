import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Req,
    Query,
    UseGuards,
} from '@nestjs/common';

import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateProductVariantDto} from './dto/productVariant.dto'
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';

@Controller('api/products')
export class productController {
    constructor(private readonly ProductsService: ProductsService) { }

   @UseGuards(JwtAuthGuard, RolesGuard)
 @Roles( 'seller', 'admin')
    @Post('add-product')
async addCategory( @Req() req: any , @Body() CreateProductDto : CreateProductDto ) {
   const { userId: sellerId, role } = req.user; 
    console.log(sellerId, role)
  return this.ProductsService.addProduct( sellerId, role, CreateProductDto);
}
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller', 'admin')
@Post('add-product-variant')
async addProductVariant(
  @Req() req: any,
  @Body() createProductVariantDto: CreateProductVariantDto
) {

  const { userId: sellerId, role } = req.user;

  return this.ProductsService.addProductVariant(
    sellerId,
    role,
    createProductVariantDto
  );

}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Post('create-product')
async createProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.createProduct(sellerId, body);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Post('create-variant')
async createVariant(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.createVariant(sellerId, body);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Post('update-product-and-variant')
async updateProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.updateProduct(sellerId, body, req.ip, req.headers['user-agent']);
}

@UseGuards(OptionalJwtAuthGuard, FeatureFlagGuard)
@RequireFeature('marketplace')
@Get('products-by-category')
async getProductsByCategoryId(
  @Req() req: any,
  @Query('id') id?: string,
  @Query('page') page: number = 1,
  @Query('limit') limit: number = 10
) {
  return this.ProductsService.getProductsByCategoryId(id, page, limit, req.user?.userId ?? null);
}

@UseGuards(OptionalJwtAuthGuard, FeatureFlagGuard)
@RequireFeature('marketplace')
@Get('getProductById/:id')
async getProductById(@Req() req: any, @Param('id') id: string) {
  return this.ProductsService.getProductById(id, req.user?.userId ?? null);
}

@Get('getVariantById/:variantId')
async getVariantById(@Param('variantId') variantId: string) {
  return this.ProductsService.getVariantById(variantId);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Post('add-physical-product')
async addPhysicalProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.addPhysicalProduct(sellerId, body);
}

@UseGuards(JwtAuthGuard, RolesGuard, FeatureFlagGuard)
@Roles('seller')
@RequireFeature('digitalUploads')
@Post('add-digital-product')
async addDigitalProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.addDigitalProduct(sellerId, body);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Get('get-my-product/:productId')
async getSellerProductById(@Req() req: any, @Param('productId') productId: string) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.getSellerProductById(sellerId, productId);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Get('store-products/:storeId')
async getStoreProducts(
  @Req() req: any,
  @Param('storeId') storeId: string,
  @Query() query: any,
) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.getStoreProducts(sellerId, storeId, query);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Post('edit-product')
async editProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.editProduct(sellerId, body);
}

}

