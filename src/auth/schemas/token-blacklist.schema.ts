import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: false })
export class TokenBlacklist extends Document {
    @Prop({
        required: true,
        unique: true,
    })
    token: string;

    @Prop({
        required: true,
    })
    expiresAt: Date;
}

export const TokenBlacklistSchema =
    SchemaFactory.createForClass(TokenBlacklist);

// ⏱ TTL index (auto delete expired tokens)
TokenBlacklistSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
);
