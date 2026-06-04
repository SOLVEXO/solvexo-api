import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class OrdersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getMyOrders(userId: string) {
    const orders = await this.databaseService.repositories.orderModel
      .find({ userId, isDelete: false })
      .sort({ createdAt: -1 });

    return {
      success: true,
      count: orders.length,
      data: orders,
    };
  }

  async getOrderById(userId: string, orderId: string) {
    if (!orderId) throw new BadRequestException('orderId is required');

    const order = await this.databaseService.repositories.orderModel.findOne({
      _id: orderId,
      isDelete: false,
    });

    if (!order) throw new NotFoundException('Order not found');

    if (order.userId !== userId) {
      throw new ForbiddenException('You are not authorized to view this order');
    }

    return {
      success: true,
      data: order,
    };
  }

  async cancelOrder(userId: string, orderId: string) {
    if (!orderId) throw new BadRequestException('orderId is required');

    const order = await this.databaseService.repositories.orderModel.findOne({
      _id: orderId,
      isDelete: false,
    });

    if (!order) throw new NotFoundException('Order not found');

    if (order.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to cancel this order',
      );
    }

    if (!['pending', 'processing'].includes(order.orderStatus)) {
      throw new BadRequestException(
        `Order cannot be cancelled. Current status: ${order.orderStatus}`,
      );
    }

    order.orderStatus = 'cancelled';
    await order.save();

    return {
      success: true,
      message: 'Order cancelled successfully',
      data: order,
    };
  }
}
