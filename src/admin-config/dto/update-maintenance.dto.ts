import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateMaintenanceDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  maintenanceMode: boolean;
}
