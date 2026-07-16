import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from 'src/database/databaseservice';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  private get userModel() {
    return this.db.repositories.userModel;
  }

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId).select('-password -otp -otpExpiresAt');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    user.name = dto.name ?? user.name;
    user.phone = dto.phone ?? user.phone;
    user.profileImage = dto.profileImage ?? user.profileImage;
    user.address = dto.address ?? user.address;

    if (dto.email && dto.email !== user.email) {
      const emailExists = await this.userModel.findOne({ email: dto.email });
      if (emailExists) throw new BadRequestException('Email already in use');
      user.email = dto.email;
      user.isVerified = false;
    }

    await user.save();
    const updatedUser = await this.userModel
      .findById(userId)
      .select('-password -otp -otpExpiresAt');

    return {
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser,
    };
  }

  // Buyers and sellers are separate Mongoose collections (see
  // auth.service.ts's login/editProfile/etc.) — change-password must branch
  // on role the same way, or it 404s for every seller/admin caller.
  async changePassword(userId: string, role: string, dto: ChangePasswordDto) {
    const { currentPassword, newPassword } = dto;

    let model;
    if (role === 'user') {
      model = this.db.repositories.userModel;
    } else if (role === 'seller') {
      model = this.db.repositories.sellerModel;
    } else if (role === 'admin') {
      model = this.db.repositories.adminModel;
    } else {
      throw new UnauthorizedException('Invalid user type');
    }

    const user = await model.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (!user.password) {
      throw new BadRequestException('Cannot change password for social-login accounts');
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) throw new UnauthorizedException('Current password is incorrect');

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }

  async deleteAccount(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    user.isDelete = true;
    user.status = 'deleted';
    await user.save();

    return {
      success: true,
      message: 'Account deactivated successfully',
    };
  }
}
