/* eslint-disable prettier/prettier */
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Every pre-existing module in this codebase manually wraps its controller
 * return values in `{ success: true, data: ... }` (e.g. `finance.service.ts`,
 * `admin-finance.service.ts`) — the frontend's shared axios client/service
 * layer universally expects that envelope. The SEO module's services were
 * built to return plain typed values instead (cleaner separation, but not
 * what the frontend integration needs). Rather than touching 19 controller
 * files' ~74 individual method bodies, this interceptor applies the same
 * envelope at the HTTP boundary — applied per-controller (not globally) so
 * the 4 public delivery controllers (`SeoMetaController`,
 * `SeoRenderHtmlController`, `RobotsController`, `SitemapController`) keep
 * returning raw JSON/HTML/XML/text, which crawlers and the meta-delivery
 * consumers expect unwrapped.
 */
@Injectable()
export class SeoResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
