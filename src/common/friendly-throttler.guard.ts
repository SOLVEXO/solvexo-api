/* eslint-disable prettier/prettier */
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/**
 * Same global rate-limiting behavior as the stock `ThrottlerGuard` — this
 * only replaces the default "ThrottlerException: Too Many Requests" message
 * with one a seller/buyer actually understands, app-wide (every `@Throttle`d
 * route benefits, not just platform-plans' billing endpoints — a single
 * global override keeps the message consistent instead of each controller
 * hand-rolling its own copy of this same string).
 */
@Injectable()
export class FriendlyThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(_context: ExecutionContext, _throttlerLimitDetail: ThrottlerLimitDetail): Promise<void> {
    throw new ThrottlerException('Too many requests. Please wait a moment before trying again.');
  }
}
