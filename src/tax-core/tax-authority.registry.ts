/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import type { TaxAuthorityAdapter } from './tax-authority.adapter';

/** Adapters by authority key. Adding a country = write an adapter and register it here; the engine does not change. */
@Injectable()
export class TaxAuthorityRegistry {
  private readonly adapters = new Map<string, TaxAuthorityAdapter>();

  register(adapter: TaxAuthorityAdapter): this {
    if (this.adapters.has(adapter.key)) throw new Error(`A tax authority adapter for ${adapter.key} is already registered`);
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  get(key: string): TaxAuthorityAdapter | null { return this.adapters.get(key) ?? null; }
  require(key: string): TaxAuthorityAdapter {
    const a = this.get(key);
    if (!a) throw new Error(`No tax authority adapter is registered for ${key}`);
    return a;
  }
  keys(): string[] { return [...this.adapters.keys()]; }
}
