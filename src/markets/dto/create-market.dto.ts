import { IsString, IsArray, IsEnum, IsOptional, IsBoolean, IsNumber, Min, Max } from 'class-validator';

export class CreateMarketDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  countries: string[];

  @IsString()
  currency: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  languages?: string[];

  @IsEnum(['primary', 'subdomain', 'subfolder'])
  @IsOptional()
  domainType?: 'primary' | 'subdomain' | 'subfolder';

  @IsString()
  @IsOptional()
  domain?: string;

  @IsString()
  @IsOptional()
  subfolder?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @IsOptional()
  pricingRule?: {
    type?: 'auto' | 'manual' | 'percentage' | 'fixed';
    percentageAdjustment?: number;
    useRounding?: boolean;
    roundingRule?: '0.95' | '0.99' | '1.00' | 'nearest';
    conversionFee?: number;
  };

  @IsOptional()
  shippingSettings?: {
    currencyMode?: 'store' | 'local';
  };
}
