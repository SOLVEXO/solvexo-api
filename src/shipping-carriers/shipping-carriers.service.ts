import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ShippingCarrier, ShippingCarrierDocument } from './schemas/shipping-carrier.schema';
import { CreateShippingCarrierDto, UpdateShippingCarrierDto } from './dto/shipping-carrier.dto';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { DatabaseService } from '@/database/databaseservice';

@Injectable()
export class ShippingCarriersService {
  constructor(
    @InjectModel(ShippingCarrier.name) private readonly carrierModel: Model<ShippingCarrierDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  async list(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const carriers = await this.carrierModel.find({ storeId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: carriers };
  }

  async create(storeId: string, sellerId: string, dto: CreateShippingCarrierDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const carrier = await this.carrierModel.create({
      storeId,
      name: dto.name,
      trackingUrlTemplate: dto.trackingUrlTemplate ?? null,
    });
    return { success: true, message: 'Carrier added', data: carrier };
  }

  async update(storeId: string, sellerId: string, carrierId: string, dto: UpdateShippingCarrierDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const carrier = await this.carrierModel.findOneAndUpdate(
      { _id: carrierId, storeId },
      { $set: dto },
      { new: true },
    );
    if (!carrier) throw new NotFoundException('Carrier not found');
    return { success: true, message: 'Carrier updated', data: carrier };
  }

  async remove(storeId: string, sellerId: string, carrierId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const carrier = await this.carrierModel.findOneAndDelete({ _id: carrierId, storeId });
    if (!carrier) throw new NotFoundException('Carrier not found');
    return { success: true, message: 'Carrier removed' };
  }
}
