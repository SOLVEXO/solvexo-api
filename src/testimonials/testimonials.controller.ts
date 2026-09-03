import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TestimonialsService } from './testimonials.service';
import { CreateTestimonialDto, UpdateTestimonialDto, SubmitTestimonialDto } from './dto/testimonial.dto';

@ApiTags('Testimonials')
@Controller('api/testimonials')
export class TestimonialsController {
  constructor(private readonly testimonialsService: TestimonialsService) {}

  // ── PUBLIC (No Auth) — homepage "Trusted by creators worldwide" section ──
  @Get()
  getActive(@Query('limit') limit?: string) {
    return this.testimonialsService.findAllActive(Math.min(12, parseInt(limit || '6', 10) || 6));
  }

  // ── SELLER (Auth Required) — self-submit a testimonial for review ───────
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @ApiBearerAuth()
  getMine(@Req() req: any) {
    return this.testimonialsService.getMySubmission(req.user.userId);
  }

  @Post('submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @ApiBearerAuth()
  submit(@Req() req: any, @Body() dto: SubmitTestimonialDto) {
    return this.testimonialsService.submitAsSeller(req.user.userId, dto);
  }

  // ── ADMIN (Auth Required) ────────────────────────────────────────────────
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  getAll() {
    return this.testimonialsService.findAll();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  create(@Body() dto: CreateTestimonialDto) {
    return this.testimonialsService.create(dto);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  update(@Param('id') id: string, @Body() dto: UpdateTestimonialDto) {
    return this.testimonialsService.update(id, dto);
  }

  @Put(':id/toggle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  toggle(@Param('id') id: string) {
    return this.testimonialsService.toggleActive(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  remove(@Param('id') id: string) {
    return this.testimonialsService.remove(id);
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  approve(@Param('id') id: string) {
    return this.testimonialsService.approve(id);
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  reject(@Param('id') id: string) {
    return this.testimonialsService.reject(id);
  }
}
