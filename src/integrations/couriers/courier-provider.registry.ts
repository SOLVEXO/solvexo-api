/* eslint-disable prettier/prettier */
import { Inject, Injectable } from '@nestjs/common';
import { CourierKey, CourierProvider, isCourierKey } from './courier.types';

export const COURIER_PROVIDERS = Symbol('COURIER_PROVIDERS');

/**
 * Resolves a courier key to its adapter. Booking/order code depends only on this registry + the CourierProvider
 * interface (same idea as PaymentProviderRegistry) — adding a courier is one adapter class + one entry in
 * IntegrationsModule's COURIER_PROVIDERS factory, nothing else.
 */
@Injectable()
export class CourierProviderRegistry {
  private readonly providers = new Map<CourierKey, CourierProvider>();

  constructor(@Inject(COURIER_PROVIDERS) providers: CourierProvider[]) {
    for (const p of providers) this.providers.set(p.providerKey, p);
  }

  resolve(key: string): CourierProvider {
    const impl = isCourierKey(key) ? this.providers.get(key) : undefined;
    if (!impl) throw new Error(`No courier provider implementation registered for "${key}"`);
    return impl;
  }

  isSupported(key: string): boolean {
    return isCourierKey(key) && this.providers.has(key);
  }

  keys(): CourierKey[] {
    return [...this.providers.keys()];
  }
}
