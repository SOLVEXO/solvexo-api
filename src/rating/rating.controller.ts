import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Req,
    Query
} from '@nestjs/common';




import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; 
import { RatingService } from './rating.service';


@Controller('api/rating')
export class RatingController {
    constructor(private readonly RatingService: RatingService) { }

}