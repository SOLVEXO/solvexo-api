/* eslint-disable prettier/prettier */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { Observable } from 'rxjs';

/**
 * The store a POS device token is bound to, for the duration of one request. PosAuthGuard records the device on
 * `req.user.posDevice`; PosDeviceScopeInterceptor runs the handler inside this context; PosService's ownership check reads
 * it — so EVERY service path that resolves a store (including ones that only get a saleId or sessionId and look the
 * store up) refuses a device acting outside its own store, without threading the device through every method signature.
 * Owner/staff sessions never set it (no restriction).
 */
const als = new AsyncLocalStorage<{ storeId: string; deviceId: string }>();

export const runInDeviceScope = <T>(scope: { storeId: string; deviceId: string }, fn: () => T): T => als.run(scope, fn);
export const currentDeviceScope = () => als.getStore();

@Injectable()
export class PosDeviceScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const device = context.switchToHttp().getRequest()?.user?.posDevice;
    if (!device) return next.handle();
    return new Observable((subscriber) => runInDeviceScope({ storeId: device.storeId, deviceId: device.deviceId }, () => next.handle().subscribe(subscriber)));
  }
}
