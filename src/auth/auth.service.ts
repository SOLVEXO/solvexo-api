import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto  } from './dto/social-login.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { OtpService } from 'src/otp/otp.service';
import { DatabaseService } from "src/database/databaseservice";
import { OAuth2Client } from 'google-auth-library';
import * as appleSignin from 'apple-signin-auth';
// import axios from 'axios';
import { stat } from 'fs';
import { RedisService } from '../redis/redis.service'
import { ActivityLogService } from 'src/activity-log/activity-log.service';

@Injectable()
export class AuthService {
   private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // 👈 Google Client
  constructor(

    private databaseService: DatabaseService,
      private readonly otpService: OtpService,
      private readonly redisService: RedisService,
      private readonly activityLogService: ActivityLogService,

    private readonly jwtService: JwtService
  ) {}

  /** Seller logins/edits are logged against their store's activity feed; users/admins have no store to attach to. */
  private async logSellerSecurityEvent(
    sellerId: string,
    category: 'security' | 'customers',
    action: string,
    description: string,
    ip?: string,
    userAgent?: string,
    isSecurityAlert = false,
  ) {
    try {
      const store = await this.databaseService.repositories.storeModel.findOne({ sellerId, isDelete: false });
      if (!store) return;
      await this.activityLogService.log({
        storeId: String(store._id),
        category,
        action,
        description,
        actorId: sellerId,
        actorRole: 'seller',
        ip,
        userAgent,
        isSecurityAlert,
      });
    } catch {
      // logging must never break auth
    }
  }


async signup(RegisterDto: RegisterDto) {
  try {
    const { name, email, password, phone , address, role, profileImage } = RegisterDto;

    let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } 
    
    else {
      throw new UnauthorizedException('Invalid user type');
    }
 
    


    const existingUser = await userModel.findOne({ email });
    if (existingUser) {
      throw new UnauthorizedException('User already exists');
    }

   
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); 

 
    const hashedPassword = await bcrypt.hash(password, 10);

    
    const user = new userModel({
      name,
      email,
      password: hashedPassword,
      phone,
      address,
      profileImage,
      role,
      otp,
      otpExpiresAt,
      isVerified: false,
    });

    await user.save();

    
    await this.otpService.sendOtp(email, otp);
    console.log(otp);

    return {
      message: 'OTP sent successfully',
       success: true,
      data: {
        userId: user._id,
        otp: user.otp, 
      },
    };
  } catch (error) {
    throw new UnauthorizedException(error.message || 'Signup failed');
  }
}


async login(loginDto: LoginDto, ip?: string, userAgent?: string) {
  try {
    const { email, password, role } = loginDto;

  let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    }

    else {
      throw new UnauthorizedException('Invalid user type');
    }




    const existingUser = await userModel.findOne({ email });
    if (!existingUser) {
      throw new UnauthorizedException('Invalid email or password');
    }


    const isPasswordMatch = await bcrypt.compare(password, existingUser.password);
    if (!isPasswordMatch) {
      if (role === 'seller') {
        this.logSellerSecurityEvent(existingUser._id.toString(), 'security', 'login_failed', `Failed login attempt from ${ip ?? 'unknown IP'}`, ip, userAgent, true);
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!existingUser.isVerified) {
  throw new UnauthorizedException('Account not verified. Please verify OTP first');
}

    if (role === 'seller') {
      this.logSellerSecurityEvent(existingUser._id.toString(), 'security', 'login_success', `Login from ${ip ?? 'unknown IP'}`, ip, userAgent, false);
    }

   
    const payload = {
      sub: existingUser._id,
      email: existingUser.email,
      role: existingUser.role,
    };

    const token = this.jwtService.sign(payload);




   await this.redisService.set(
  token,
  existingUser._id.toString(),
  24 * 60 * 60
);

        // ✅ Refresh Token (long expiry)
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
    });
    

return {
  message: 'Login successful',
  success: true, // ye add karna zaroori hai
  data: {
    user: {  // ⬅️ user object me rakhna
      id: existingUser._id,
      name: existingUser.name,
      email: existingUser.email,
      role: existingUser.role,
      image: existingUser.profileImage || null,
    },
    token: {  // ⬅️ token object me rakhna
      accessToken: token,
      refreshToken: refreshToken,
    },
  },
};

  } catch (error) {
    throw new UnauthorizedException(error.message || 'Login failed');
  }
}

/** Verifies the provider token server-side so a forged socialId/email pair can't be used to hijack an account. */
private async verifySocialToken(authProvider: string, socialId: string, token?: string) {
  if (!token) {
    throw new UnauthorizedException('Missing provider token for verification');
  }

  if (authProvider === 'google') {
    const ticket = await this.googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || payload.sub !== socialId) {
      throw new UnauthorizedException('Invalid Google token');
    }
  } else if (authProvider === 'facebook') {
    const resp = await fetch(
      `https://graph.facebook.com/me?fields=id&access_token=${encodeURIComponent(token)}`,
    );
    const data: any = await resp.json();
    if (!data?.id || data.id !== socialId) {
      throw new UnauthorizedException('Invalid Facebook token');
    }
  } else if (authProvider === 'apple') {
    const payload = await appleSignin.verifyIdToken(token, {
      audience: process.env.APPLE_CLIENT_ID,
    });
    if (!payload || payload.sub !== socialId) {
      throw new UnauthorizedException('Invalid Apple token');
    }
  } else {
    throw new UnauthorizedException('Unsupported auth provider');
  }
}

/** Social login always creates/looks up a buyer (role: 'user') account — sellers keep using email/password + onboarding. */
async socialLogin(dto: SocialLoginDto) {
  try {
    const { authProvider, socialId, userName, email, image, fcmToken, token } = dto;

    await this.verifySocialToken(authProvider, socialId, token);

    const userModel = this.databaseService.repositories.userModel;
    let user = await userModel.findOne({
      $or: [{ email }, { providerId: socialId, authProvider }],
    });

    if (!user) {
      user = new userModel({
        name: userName,
        email,
        role: 'user',
        isVerified: true,
        authProvider,
        providerId: socialId,
        profileImage: image || null,
        fcmToken: fcmToken || undefined,
      });
      await user.save();
    } else {
      let changed = false;
      if (!user.providerId) {
        user.providerId = socialId;
        changed = true;
      }
      if (!user.authProvider) {
        user.authProvider = authProvider;
        changed = true;
      }
      if (fcmToken && user.fcmToken !== fcmToken) {
        user.fcmToken = fcmToken;
        changed = true;
      }
      if (!user.isVerified) {
        user.isVerified = true;
        changed = true;
      }
      if (changed) await user.save();
    }

    const payload = { sub: user._id, email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload);
    await this.redisService.set(accessToken, user._id.toString(), 24 * 60 * 60);
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    return {
      message: 'Social login successful',
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          image: user.profileImage || null,
        },
        token: {
          accessToken,
          refreshToken,
        },
      },
    };
  } catch (error) {
    throw new UnauthorizedException(error.message || 'Social login failed');
  }
}

async resendOtp(email: string, role: string) {
  try {

    let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } 
    
    else {
      throw new UnauthorizedException('Invalid user type');
    }
   
    const user = await userModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

 
    if (user.isVerified) {
      throw new UnauthorizedException('User already verified');
    }

  
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = newOtp;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    
    await this.otpService.sendOtp(user.email, newOtp);

    return {
      message: 'New OTP sent successfully to your email',
      success: true,
      data: {
        userId: user._id,
        otp: user.otp,
      },
    };

  } catch (error) {
    throw new UnauthorizedException(error.message || 'Resend OTP failed');
  }
}

async verifyOtp(email: string, role: string, otp: string) {
  try {

   
      let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } 
    
    else {
      throw new UnauthorizedException('Invalid user type');
    }
   
    const user = await userModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

 
    if (user.isVerified) {
      throw new UnauthorizedException('User already verified');
    }


    if (user.otp !== otp) {
      throw new UnauthorizedException('Invalid OTP');
    }

  
    if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
      throw new UnauthorizedException('OTP has expired');
    }

    user.isVerified = true;
    user.otp = null as any;
    user.otpExpiresAt = null as any;
    await user.save();

   
    const payload = { sub: user._id, email: user.email,  role: user.role };
    const token = this.jwtService.sign(payload, { expiresIn: '1h' });

    
    await this.redisService.set(
      token,
      user._id.toString(),
      30 * 60
    );

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
    });

 return {
  message: 'OTP verified successfully',
  success: true,
  data: {
    user: {  // ✅ user object
      id: user._id,   // _id ko id me change karna better rahega Dart model ke liye
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
    },
    token: {  // ✅ token object
      accessToken: token,
      refreshToken: refreshToken,
    },
  },
};
  

  } catch (error) {
    throw new UnauthorizedException(error.message || 'OTP verification failed');
  }
}

async forgotPassword(email: string, role: string) {
  try {
    let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } 
    
    else {
      throw new UnauthorizedException('Invalid user type');
    }

    const user = await userModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('User not found with this email');
    }

 
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

   
    user.otp = otp;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();


    await this.otpService.sendOtp(user.email, otp);

   
    return {
      message: 'OTP sent successfully to your email for password reset',
      success: true,
      data: {
        userId: user._id,
        otp: user.otp,
      },
    };
  } catch (error) {
    throw new UnauthorizedException(error.message || 'Forgot password failed');
  }
}

async resetPassword(email: string, role: string, otp: string, newPassword: string) {
  try {
 let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } 
    
    else {
      throw new UnauthorizedException('Invalid user type');
    }


    const user = await userModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

 
    if (user.otp !== otp) {
      throw new UnauthorizedException('Invalid OTP');
    }


    const now = new Date();
    if (!user.otpExpiresAt || now > user.otpExpiresAt) {
      throw new UnauthorizedException('OTP has expired');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.password = hashedPassword;
    user.otp = null;
    user.otpExpiresAt = null;
    await user.save();

    return {
      message: 'Your password has been changed successfully',
      success: true,
    };
  } catch (error) {
    throw new UnauthorizedException(error.message || 'Password reset failed');
  }
}

async editProfile(userId: string, role: string, dto: UpdateProfileDto) {
  try {
    let userModel;

    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } else {
      throw new BadRequestException('Invalid role');
    }

    const user = await userModel.findByIdAndUpdate(
      userId,
      { $set: dto },
      { new: true, runValidators: true },
    ).select('-password -otp -otpExpiresAt');

    if (!user) {
      throw new BadRequestException('User not found');
    }

    return {
      message: 'Profile updated successfully',
      success: true,
      data: user,
    };
  } catch (error) {
    throw new BadRequestException(error.message || 'Failed to update profile');
  }
}

async getProfile(userId: string, role: string) {
  try {
    let userModel;

    // 1️⃣ Role ke base pe model select
    if (role === 'user') {
      userModel = this.databaseService.repositories.userModel;
    } else if (role === 'seller') {
      userModel = this.databaseService.repositories.sellerModel;
    } else if (role === 'admin') {
      userModel = this.databaseService.repositories.adminModel;
    } else {
      throw new UnauthorizedException('Invalid role');
    }

    // 2️⃣ User find karo
    const user = await userModel.findById(userId).select('-password -otp');

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // 3️⃣ Return data
    return {
      message: 'Profile fetched successfully',
      success: true,
      data: user,
    };

  } catch (error) {
    throw new UnauthorizedException(error.message || 'Failed to fetch profile');
  }
}

}