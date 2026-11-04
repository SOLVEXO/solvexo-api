import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { repairMojibakeDeep } from './repair-mojibake.util';

/** Fixes garbled (UTF-8 read as Latin-1) text in incoming JSON bodies before any handler can save it. */
@Injectable()
export class RepairMojibakeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      if (req?.body && typeof req.body === 'object') repairMojibakeDeep(req.body);
    }
    return next.handle();
  }
}
