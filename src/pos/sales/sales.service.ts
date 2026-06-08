/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class SalesService {
  constructor(private readonly databaseService: DatabaseService) {}

  async recordSale(body: any) {
    const { sessionId, items, paymentMethod, customerId, customerName } = body;

    if (!sessionId) throw new BadRequestException('sessionId is required');
    if (!items || !Array.isArray(items) || items.length === 0)
      throw new BadRequestException('items are required');

    const session = await this.databaseService.repositories.registerSessionModel.findOne({
      _id: sessionId,
      status: 'open',
    });

    if (!session) throw new NotFoundException('Open session not found');

    const saleItems: any[] = [];
    let subtotal = 0;

    for (const item of items) {
      const { productId, variantId, qty } = item;

      if (!productId || !variantId || !qty)
        throw new BadRequestException('Each item must have productId, variantId and qty');

      const variant = await this.databaseService.repositories.productVariantModel.findOne({
        _id: variantId,
        productId,
        isDelete: false,
      });

      if (!variant) throw new NotFoundException(`Variant not found: ${variantId}`);

      const product = await this.databaseService.repositories.productModel
        .findOne({ _id: productId, isDelete: false })
        .lean();

      if (!product) throw new NotFoundException(`Product not found: ${productId}`);

      if (product.productType === 'physical' && variant.stock < qty) {
        throw new BadRequestException(`Insufficient stock for: ${product.name}`);
      }

      const lineTotal = variant.price * qty;
      subtotal += lineTotal;

      saleItems.push({
        productId,
        variantId,
        name: product.name,
        sku: variant.sku,
        price: variant.price,
        qty,
        lineTotal,
      });
    }

    const sale = await this.databaseService.repositories.saleModel.create({
      storeId: session.storeId,
      sessionId,
      registerId: session.registerId,
      employeeId: session.employeeId,
      items: saleItems,
      subtotal,
      total: subtotal,
      paymentMethod: paymentMethod ?? 'cash',
      customerId: customerId ?? null,
      customerName: customerName ?? 'Walk-in',
    });

    // Stock update — physical only
    for (const item of items) {
      const product = await this.databaseService.repositories.productModel
        .findOne({ _id: item.productId, isDelete: false })
        .lean();

      if (product?.productType === 'physical') {
        await this.databaseService.repositories.productVariantModel.findByIdAndUpdate(
          item.variantId,
          { $inc: { stock: -item.qty } },
        );
      }
    }

    // Session totals update
    const sessionInc: any = {
      totalSales: subtotal,
      totalTransactions: 1,
    };

    if (!paymentMethod || paymentMethod === 'cash') {
      sessionInc.cashSales = subtotal;
    } else {
      sessionInc.cardSales = subtotal;
    }

    await this.databaseService.repositories.registerSessionModel.findByIdAndUpdate(
      sessionId,
      { $inc: sessionInc },
    );

    return {
      success: true,
      message: 'Sale recorded successfully',
      data: sale,
    };
  }
}
