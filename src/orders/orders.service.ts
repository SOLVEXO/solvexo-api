// import {
//   Injectable,
//   NotFoundException,
//   BadRequestException,
//   ForbiddenException,
// } from '@nestjs/common';
// import { DatabaseService } from 'src/database/databaseservice';

// @Injectable()
// export class OrdersService {
//   constructor(private readonly databaseService: DatabaseService) {}

//   async getMyOrders(userId: string) {
//     const orders = await this.databaseService.repositories.orderModel
//       .find({ userId, isDelete: false })
//       .sort({ createdAt: -1 });

//     return {
//       success: true,
//       count: orders.length,
//       data: orders,
//     };
//   }

//   async getOrderById(userId: string, orderId: string) {
//     if (!orderId) throw new BadRequestException('orderId is required');

//     const order = await this.databaseService.repositories.orderModel.findOne({
//       _id: orderId,
//       isDelete: false,
//     });

//     if (!order) throw new NotFoundException('Order not found');

//     if (order.userId !== userId) {
//       throw new ForbiddenException('You are not authorized to view this order');
//     }

//     return {
//       success: true,
//       data: order,
//     };
//   }

//   async cancelOrder(userId: string, orderId: string) {
//     if (!orderId) throw new BadRequestException('orderId is required');

//     const order = await this.databaseService.repositories.orderModel.findOne({
//       _id: orderId,
//       isDelete: false,
//     });

//     if (!order) throw new NotFoundException('Order not found');

//     if (order.userId !== userId) {
//       throw new ForbiddenException(
//         'You are not authorized to cancel this order',
//       );
//     }

//     if (!['pending', 'processing'].includes(order.orderStatus)) {
//       throw new BadRequestException(
//         `Order cannot be cancelled. Current status: ${order.orderStatus}`,
//       );
//     }

//     order.orderStatus = 'cancelled';
//     await order.save();

//     return {
//       success: true,
//       message: 'Order cancelled successfully',
//       data: order,
//     };
//   }
// }

import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';


@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
  ) {}

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
