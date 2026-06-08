/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import * as bcrypt from 'bcrypt';

@Injectable()
export class EmployeeService {
  constructor(private readonly databaseService: DatabaseService) {}

  async addRegister(sellerId: string, body: any) {
    const { storeId, name, defaultFloatCash } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!name) throw new BadRequestException('name is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { registers: { name, defaultFloatCash: defaultFloatCash ?? 100 } } },
      { new: true },
    );

    return {
      success: true,
      message: 'Register added successfully',
      data: updated?.registers,
    };
  }

  async addShift(sellerId: string, body: any) {
    const { storeId, name, startTime, endTime, daysOfWeek } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!name) throw new BadRequestException('name is required');
    if (!startTime) throw new BadRequestException('startTime is required');
    if (!endTime) throw new BadRequestException('endTime is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      storeId,
      { $push: { shifts: { name, startTime, endTime, daysOfWeek: daysOfWeek ?? [1, 2, 3, 4, 5] } } },
      { new: true },
    );

    return {
      success: true,
      message: 'Shift added successfully',
      data: updated?.shifts,
    };
  }

  async addEmployee(sellerId: string, body: any) {
    const { storeId, name, email, pin, role, shiftIds } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!name) throw new BadRequestException('name is required');
    if (!email) throw new BadRequestException('email is required');
    if (!pin) throw new BadRequestException('pin is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    const existing = await this.databaseService.repositories.employeeModel.findOne({
      storeId,
      email,
      isDelete: false,
    });

    if (existing) throw new ConflictException('Employee with this email already exists');

    const hashedPin = await bcrypt.hash(pin, 10);

    const employee = await this.databaseService.repositories.employeeModel.create({
      storeId,
      sellerId,
      name,
      email,
      pin: hashedPin,
      role: role ?? 'cashier',
      shiftIds: shiftIds ?? [],
    });

    const empObj: any = employee.toObject();
    delete empObj.pin;

    return {
      success: true,
      message: 'Employee added successfully',
      data: empObj,
    };
  }

  async posLogin(body: any) {
    const { storeId, pin } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!pin) throw new BadRequestException('pin is required');

    const store = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, isDelete: false, status: 'active' })
      .lean();

    if (!store) throw new NotFoundException('Store not found');

    const employees = await this.databaseService.repositories.employeeModel
      .find({ storeId, status: 'active', isDelete: false })
      .select('+pin')
      .lean();

    let matchedEmployee: any = null;

    for (const emp of employees) {
      const isMatch = await bcrypt.compare(pin, emp.pin);
      if (isMatch) {
        matchedEmployee = emp;
        break;
      }
    }

    if (!matchedEmployee) throw new UnauthorizedException('Invalid PIN');

    if (matchedEmployee.shiftIds?.length > 0) {
      const now = new Date();
      const currentDay = now.getDay();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      const activeShift = (store.shifts as any[]).find(
        (s: any) =>
          matchedEmployee.shiftIds.includes(s._id.toString()) &&
          s.daysOfWeek.includes(currentDay) &&
          s.startTime <= currentTime &&
          currentTime <= s.endTime &&
          s.status === 'active',
      );

      if (!activeShift) throw new ForbiddenException('Your shift is not active right now');
    }

    const { pin: _pin, ...employeeData } = matchedEmployee;

    return {
      success: true,
      message: 'Login successful',
      data: {
        employee: employeeData,
        storeName: (store as any).name,
      },
    };
  }
}
