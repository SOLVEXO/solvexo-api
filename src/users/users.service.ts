// import {
//     Injectable,
//     NotFoundException,
//     BadRequestException,
//     UnauthorizedException,
// } from '@nestjs/common';
// import { InjectModel } from '@nestjs/mongoose';
// import { Model } from 'mongoose';
// import { User, UserDocument } from './schemas/user.schema';
// import { UpdateProfileDto } from './dto/update-profile.dto';
// import { ChangePasswordDto } from './dto/change-password.dto';

// @Injectable()
// export class UsersService {
//     constructor(
//         @InjectModel(User.name)
//         private userModel: Model<UserDocument>,
//     ) { }

//     async getProfile(userId: string) {
//         const user = await this.userModel.findById(userId);

//         if (!user) {
//             throw new NotFoundException('User not found');
//         }

//         return user;
//     }

//     async updateProfile(userId: string, dto: UpdateProfileDto) {
//         const user = await this.userModel.findById(userId);

//         if (!user) {
//             throw new NotFoundException('User not found');
//         }

//         user.name = dto.name ?? user.name;
//         user.phone = dto.phone ?? user.phone;
//         user.profileImage = dto.profileImage ?? user.profileImage;
//         user.address = dto.address ?? user.address;

//         if (dto.email && dto.email !== user.email) {
//             const emailExists = await this.userModel.findOne({ email: dto.email });
//             if (emailExists) {
//                 throw new BadRequestException('Email already in use');
//             }
//             user.email = dto.email;
//             user.isEmailVerified = false;
//         }

//         const updatedUser = await user.save();

//         return {
//             success: true,
//             message: 'Profile updated successfully',
//             data: updatedUser,
//         };
//     }

//     async changePassword(userId: string, dto: ChangePasswordDto) {
//         const { currentPassword, newPassword } = dto;

//         if (!currentPassword || !newPassword) {
//             throw new BadRequestException(
//                 'Please provide current and new password',
//             );
//         }

//         if (newPassword.length < 6) {
//             throw new BadRequestException(
//                 'New password must be at least 6 characters',
//             );
//         }

//         const user = await this.userModel
//             .findById(userId)
//             .select('+password');

//         if (!user?.password) {
//             throw new BadRequestException(
//                 'Cannot change password for OAuth accounts',
//             );
//         }



//         user.password = newPassword;
//         await user.save();

//         return {
//             success: true,
//             message: 'Password changed successfully',
//         };
//     }

//     async deleteAccount(userId: string) {
//         const user = await this.userModel.findById(userId);

//         if (!user) {
//             throw new NotFoundException('User not found');
//         }

//         user.isActive = false;
//         await user.save();

//         return {
//             success: true,
//             message: 'Account deactivated successfully',
//         };
//     }
// }
