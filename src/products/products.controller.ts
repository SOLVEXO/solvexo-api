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
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; 
import { CreateProductVariantDto} from './dto/productVariant.dto'

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
  return this.ProductsService.updateProduct(sellerId, body);
}

@Get('products-by-category')
async getProductsByCategoryId(
  @Query('id') id?: string,
  @Query('page') page: number = 1,
  @Query('limit') limit: number = 10
) {
  return this.ProductsService.getProductsByCategoryId(id, page, limit);
}

@Get('getProductById/:id')
async getProductById(@Param('id') id: string) {
  return this.ProductsService.getProductById(id);
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

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
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
@Post('edit-product')
async editProduct(@Req() req: any, @Body() body: any) {
  const { userId: sellerId } = req.user;
  return this.ProductsService.editProduct(sellerId, body);
}

}

