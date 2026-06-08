/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class RegisterSessionService {
  constructor(private readonly databaseService: DatabaseService) {}

  async openSession(body: any) {
    const { storeId, registerId, employeeId, shiftId, openingCash } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!registerId) throw new BadRequestException('registerId is required');
    if (!employeeId) throw new BadRequestException('employeeId is required');

    const store = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, isDelete: false })
      .lean();

    if (!store) throw new NotFoundException('Store not found');

    const registerExists = (store.registers as any[]).some(
      (r: any) => r._id.toString() === registerId,
    );

    if (!registerExists) throw new BadRequestException('Register not found in store');

    const alreadyOpen = await this.databaseService.repositories.registerSessionModel.findOne({
      registerId,
      status: 'open',
    });

    if (alreadyOpen) throw new ConflictException('This register already has an open session');

    const session = await this.databaseService.repositories.registerSessionModel.create({
      storeId,
      registerId,
      employeeId,
      shiftId: shiftId ?? null,
      openedAt: new Date(),
      openingCash: openingCash ?? 0,
    });

    return {
      success: true,
      message: 'Register session opened',
      data: session,
    };
  }

  async closeSession(body: any) {
    const { sessionId, closingCash } = body;

    if (!sessionId) throw new BadRequestException('sessionId is required');
    if (closingCash === undefined || closingCash === null)
      throw new BadRequestException('closingCash is required');

    const session = await this.databaseService.repositories.registerSessionModel.findOne({
      _id: sessionId,
      status: 'open',
    });

    if (!session) throw new NotFoundException('Open session not found');

    const expectedCash = session.openingCash + session.cashSales;
    const cashDifference = closingCash - expectedCash;

    session.closingCash = closingCash;
    session.expectedCash = expectedCash;
    session.cashDifference = cashDifference;
    session.closedAt = new Date();
    session.status = 'closed';

    await session.save();

    return {
      success: true,
      message: 'Register session closed',
      data: session,
    };
  }
}
