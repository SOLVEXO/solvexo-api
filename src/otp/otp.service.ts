import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(OtpService.name);

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  async sendOtp(toEmail: string, otp: string): Promise<void> {
    try {
      const mailOptions = {
        from: 'jamiraza359@gmail.com',  // 🟢 same Gmail as above
        to: toEmail,
        subject: 'Your OTP Code',
        text: `Your OTP code is: ${otp}`,
        html: `<p>Your OTP code is: <b>${otp}</b></p>`,
      };

      const result = await this.transporter.sendMail(mailOptions);


      this.logger.log(`OTP email sent to ${toEmail}: ${result.response}`);
    } catch (error) {

      this.logger.error(`Failed to send OTP to ${toEmail}`, error);
      throw new Error('Failed to send OTP email');
    }
  }
}