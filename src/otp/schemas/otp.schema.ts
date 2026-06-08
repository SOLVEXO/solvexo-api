import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OtpDocument = HydratedDocument<Otp> & {
    isExpired(): boolean;
    canBeUsed(): boolean;
};
@Schema({ timestamps: true })
export class Otp {
    _id: string;

    @Prop({ required: true, lowercase: true, trim: true })
    email: string;

    @Prop({ required: true })
    otp: string;

    @Prop({
        required: true,
        enum: ['email_verification', 'password_reset', 'login', 'phone_verification'],
        default: 'email_verification'
    })
    type: string;

    @Prop({ required: true })
    expiresAt: Date;

    @Prop({ default: false })
    isUsed: boolean;

    @Prop()
    usedAt?: Date;

    @Prop({ default: 0 })
    attempts: number;

    @Prop({ default: 3 })
    maxAttempts: number;

    @Prop()
    ipAddress?: string;

    @Prop()
    userAgent?: string;

    createdAt?: Date;
    updatedAt?: Date;
}

export const OtpSchema = SchemaFactory.createForClass(Otp);

// Indexes
OtpSchema.index({ email: 1, type: 1 });
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Auto-delete expired OTPs
OtpSchema.index({ createdAt: 1 });

// Method to check if OTP is expired
OtpSchema.methods.isExpired = function () {
    return new Date() > this.expiresAt;
};

// Method to check if OTP can be used
OtpSchema.methods.canBeUsed = function () {
    return !this.isUsed && !this.isExpired() && this.attempts < this.maxAttempts;
};

// Remove __v from JSON
OtpSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.__v;
    delete obj.otp; // Don't expose OTP in API responses
    return obj;
};