import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PlatformSeoService } from '../services/platform-seo-settings.service';

// Bare path (no `api/` prefix), same convention as `health`/`address` — this
// must be served at the literal root `/robots.txt` crawlers expect, and is
// hit by every crawling bot on the platform, so it's exempt from the global
// per-IP throttle (a legitimate high-frequency, non-abusive caller).
@Controller()
export class RobotsController {
  constructor(private readonly platformSeoService: PlatformSeoService) {}

  @SkipThrottle()
  @Get('robots.txt')
  async getRobotsTxt(@Res() res: Response) {
    const body = await this.platformSeoService.getResolvedRobotsTxt();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(body);
  }
}
