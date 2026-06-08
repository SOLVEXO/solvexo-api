import { ApiProperty } from '@nestjs/swagger';

export class ValidationErrorDto {
    @ApiProperty()
    productId: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    error: string;

    @ApiProperty({ required: false })
    warning?: boolean;
}

export class ValidateCartResponseDto {
    @ApiProperty()
    success: boolean;

    @ApiProperty()
    isValid: boolean;

    @ApiProperty({ type: [ValidationErrorDto], required: false })
    errors?: ValidationErrorDto[];

    @ApiProperty()
    data: any;
}
