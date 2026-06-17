

import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';


@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
  ) {}

  async getSellerOrders(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { orderModel, storeModel, userModel } = this.databaseService.repositories;

    // store ownership check
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    // base filter — is store ke orders
    const matchFilter: any = {
      'sellerOrders.storeId': storeId,
      isDelete: false,
    };

    if (query.type && query.type !== 'all') {
      matchFilter['sellerOrders.fulfillmentType'] = query.type;
    }
    if (query.status && query.status !== 'all') {
      matchFilter['sellerOrders.status'] = query.status;
    }
    if (query.time && query.time !== 'all') {
      const now = new Date();
      if (query.time === 'today') {
        matchFilter.createdAt = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
      } else if (query.time === 'week') {
        const week = new Date(); week.setDate(week.getDate() - 7);
        matchFilter.createdAt = { $gte: week };
      } else if (query.time === 'month') {
        const month = new Date(); month.setMonth(month.getMonth() - 1);
        matchFilter.createdAt = { $gte: month };
      }
    }

    const totalOrders = await orderModel.countDocuments(matchFilter);
    const totalPages = Math.ceil(totalOrders / limit);

    const orders = await orderModel
      .find(matchFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // stats — all orders for this store (no pagination)
    const allOrders = await orderModel.find({ 'sellerOrders.storeId': storeId, isDelete: false }).lean();

    let totalRevenue = 0;
    let pendingCount = 0;

    for (const order of allOrders) {
      const so = (order.sellerOrders as any[]).find((s: any) => s.storeId === storeId);
      if (!so) continue;
      if (['completed', 'delivered'].includes(so.status)) {
        totalRevenue += so.subtotal || 0;
      }
      if (['pending', 'processing'].includes(so.status)) {
        pendingCount++;
      }
    }

    const avgOrder = allOrders.length > 0 ? totalRevenue / allOrders.length : 0;

    // order rows format
    const rows = await Promise.all(
      orders.map(async (order: any) => {
        const so = order.sellerOrders.find((s: any) => s.storeId === storeId);
        if (!so) return null;

        const user = await userModel.findOne({ _id: order.userId }).select('name email').lean();
        const firstItem = so.items?.[0];

        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: (user as any)?.email || '',
          },
          product: firstItem?.name || '',
          type: so.fulfillmentType,
          date: order.createdAt,
          amount: so.subtotal,
          status: so.status,
          isPaid: order.isPaid,
          paymentType: order.paymentType,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          totalOrders,
          revenue: totalRevenue,
          pending: pendingCount,
          avgOrder: parseFloat(avgOrder.toFixed(2)),
        },
        pagination: {
          page,
          limit,
          totalPages,
          totalOrders,
        },
        orders: rows.filter(Boolean),
      },
    };
  }

  async getDownloadUrls(userId: string, orderId: string, productId: string) {
    if (!orderId) throw new BadRequestException('orderId is required');
    if (!productId) throw new BadRequestException('productId is required');

    const { orderModel, productModel } = this.databaseService.repositories;

    // 1. order fetch + ownership
    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');

    // 2. payment check
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');

    // 3. product is in this order
    let targetItem: any = null;
    let sellerOrderIndex = -1;
    let itemIndex = -1;

    for (let si = 0; si < order.sellerOrders.length; si++) {
      const so = order.sellerOrders[si];
      for (let ii = 0; ii < so.items.length; ii++) {
        if (so.items[ii].productId === productId) {
          targetItem = so.items[ii];
          sellerOrderIndex = si;
          itemIndex = ii;
          break;
        }
      }
    }

    if (!targetItem) throw new BadRequestException('Product not found in this order');
    if (targetItem.type !== 'digital') throw new BadRequestException('This is not a digital product');

    // 4. product fetch
    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.digital?.files?.length) throw new BadRequestException('No digital files found for this product');

    // 5. link expiry check
    if (product.digital.linkExpiryDays) {
      const paidAt = order.paidAt;
      if (paidAt) {
        const expiryDate = new Date(paidAt);
        expiryDate.setDate(expiryDate.getDate() + product.digital.linkExpiryDays);
        if (new Date() > expiryDate) {
          throw new BadRequestException(`Download link expired on ${expiryDate.toDateString()}`);
        }
      }
    }

    // 6. download limit check
    const downloadLimit = product.digital.downloadLimit;
    if (downloadLimit !== 'unlimited') {
      const limitNum = parseInt(downloadLimit);
      if (targetItem.downloadCount >= limitNum) {
        throw new BadRequestException(`Download limit reached (${limitNum}/${limitNum})`);
      }
    }

    // 7. downloadCount++ (atomic) + first download pe order complete
    const updatePath = `sellerOrders.${sellerOrderIndex}.items.${itemIndex}.downloadCount`;
    const isFirstDownload = targetItem.downloadCount === 0;
    await orderModel.findByIdAndUpdate(orderId, {
      $inc: { [updatePath]: 1 },
      ...(isFirstDownload && { orderStatus: 'completed' }),
    });

    // 8. generate URLs for all files
    const files = product.digital.files;
    const isPdfStamping = product.digital.pdfStampingEnabled;

    const result = await Promise.all(
      files.map(async (file: any, index: number) => {
        const isPdf = file.mimeType === 'application/pdf';

        if (isPdf && isPdfStamping) {
          // stamping wala → alag endpoint se stream hoga
          return {
            index,
            fileName: file.name,
            mimeType: file.mimeType,
            size: file.size,
            type: 'stamped',
            streamUrl: `/api/orders/stream-pdf?orderId=${orderId}&productId=${productId}&fileIndex=${index}`,
          };
        }

        // normal signed URL
        const resourceType = file.mimeType?.startsWith('video/') ? 'video' : file.mimeType?.startsWith('image/') ? 'image' : 'raw';
        const signedUrl = this.uploadService.generateSignedUrl(file.url, resourceType, 3600);

        return {
          index,
          fileName: file.name,
          mimeType: file.mimeType,
          size: file.size,
          type: 'signed_url',
          url: signedUrl,
          expiresIn: '1 hour',
        };
      }),
    );

    const remaining = product.digital.downloadLimit === 'unlimited'
      ? 'unlimited'
      : `${parseInt(product.digital.downloadLimit) - (targetItem.downloadCount + 1)} remaining`;

    return {
      success: true,
      message: 'Download links generated',
      data: {
        files: result,
        downloadCount: targetItem.downloadCount + 1,
        downloadLimit: product.digital.downloadLimit,
        remaining,
      },
    };
  }

  async updateSellerOrderStatus(sellerId: string, body: any) {
    const { orderId, storeId, status, tracking } = body;

    if (!orderId) throw new BadRequestException('orderId is required');
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!status) throw new BadRequestException('status is required');

    const validStatuses = ['processing', 'shipped', 'delivered', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(`Invalid status. Allowed: ${validStatuses.join(', ')}`);
    }

    const { orderModel, storeModel } = this.databaseService.repositories;

    // store ownership check
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrderIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (sellerOrderIndex === -1) throw new ForbiddenException('Unauthorized');

    if (status === 'shipped' && !tracking) {
      throw new BadRequestException('tracking info required when status is shipped');
    }

    const updateData: any = {};

    // sellerOrder status
    updateData[`sellerOrders.${sellerOrderIndex}.status`] = status;

    // saare items same status
    const soItems = order.sellerOrders[sellerOrderIndex].items;
    soItems.forEach((_: any, itemIndex: number) => {
      updateData[`sellerOrders.${sellerOrderIndex}.items.${itemIndex}.status`] = status;
    });

    // status-specific fields
    if (status === 'shipped') {
      updateData[`sellerOrders.${sellerOrderIndex}.shippedAt`] = new Date();
      updateData[`sellerOrders.${sellerOrderIndex}.tracking`] = tracking;
    }
    if (status === 'delivered') {
      updateData[`sellerOrders.${sellerOrderIndex}.deliveredAt`] = new Date();
    }

    // overall orderStatus derive
    const allStatuses = order.sellerOrders.map((so: any, idx: number) =>
      idx === sellerOrderIndex ? status : so.status,
    );

    if (allStatuses.every((s: string) => s === 'completed')) {
      updateData.orderStatus = 'completed';
    } else if (allStatuses.some((s: string) => ['shipped', 'delivered'].includes(s))) {
      updateData.orderStatus = 'partially_shipped';
    } else if (allStatuses.every((s: string) => s === 'processing')) {
      updateData.orderStatus = 'processing';
    }

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    return { success: true, message: `Order status updated to ${status}` };
  }

  async markPaid(orderId: string) {
    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.isPaid) throw new BadRequestException('Order is already paid');

    await orderModel.findByIdAndUpdate(orderId, {
      isPaid: true,
      paymentStatus: 'paid',
      paidAt: new Date(),
      orderStatus: 'completed',
    });

    return { success: true, message: 'Order marked as paid' };
  }

  async streamStampedPdf(userId: string, orderId: string, productId: string, fileIndex: number) {
    const { orderModel, productModel, userModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid');

    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product?.digital?.files?.length) throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found');

    const user = await userModel.findOne({ _id: userId }).select('email').lean();
    const userEmail = (user as any)?.email || userId;

    const stampedBuffer = await this.uploadService.stampPdf(file.url, userEmail, order.orderNumber);

    return {
      buffer: stampedBuffer,
      fileName: file.name,
      mimeType: 'application/pdf',
    };
  }
}
