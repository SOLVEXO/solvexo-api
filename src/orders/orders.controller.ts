import { Controller, Get, Put, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OrdersService } from './orders.service';

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('myOrders')
  async getMyOrders(@Req() req: any) {
    const { userId } = req.user;
    return this.ordersService.getMyOrders(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get(':orderId')
  async getOrderById(@Req() req: any, @Param('orderId') orderId: string) {
    const { userId } = req.user;
    return this.ordersService.getOrderById(userId, orderId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Put('cancel/:orderId')
  async cancelOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const { userId } = req.user;
    return this.ordersService.cancelOrder(userId, orderId);
  }
}
