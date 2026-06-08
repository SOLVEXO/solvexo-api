import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto  } from './dto/social-login.dto';
import { LoginDto } from './dto/login.dto';
import { OtpService } from 'src/otp/otp.service';
import { DatabaseService } from "src/database/databaseservice";
import { OAuth2Client } from 'google-auth-library';
// import axios from 'axios';
import { stat } from 'fs';
import { RedisService } from '../redis/redis.service'

@Injectable()
export class AuthService {
   private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // 👈 Google Client
  constructor(
   
    private databaseService: DatabaseService,
      private readonly otpService: OtpService, 
      private readonly redisService: RedisService,

    private readonly jwtService: JwtService
  ) {}


async signup(RegisterDto: RegisterDto) {
  try {
    const { name, email, password, phone , address, role } = RegisterDto;

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


async login(loginDto: LoginDto) {
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
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!existingUser.isVerified) {
  throw new UnauthorizedException('Account not verified. Please verify OTP first');
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