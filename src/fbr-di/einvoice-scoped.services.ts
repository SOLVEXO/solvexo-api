/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { FbrDiService, ResolveInput } from './fbr-di.service';

type ListQuery = { status?: string; page?: number; limit?: number };
type Actor = { id: string; role: 'admin' | 'seller' };

/**
 * Solvexo's OWN invoices (plan fees, add-ons, fee bills, ...). Reads and writes only `platform_einvoice_records`; it has no way to
 * name a store's record, so a seller's invoice cannot be listed, retried or resolved through it.
 */
@Injectable()
export class PlatformEinvoiceService {
  constructor(private readonly core: FbrDiService) {}
  list(q: ListQuery) { return this.core.list({ issuer: 'platform', ...q }); }
  retry(id: string) { return this.core.retry(id, { issuer: 'platform' }); }
  resolve(id: string, input: ResolveInput, actor: Actor) { return this.core.resolve(id, { issuer: 'platform' }, input, actor); }
}

/** A store's own sales invoices. Reads and writes only `store_einvoice_records`, and only for the store it is called with. */
@Injectable()
export class StoreEinvoiceService {
  constructor(private readonly core: FbrDiService) {}
  list(storeId: string, q: ListQuery) { return this.core.list({ issuer: 'store', storeId, ...q }); }
  retry(storeId: string, id: string) { return this.core.retry(id, { issuer: 'store', storeId }); }
  resolve(storeId: string, id: string, input: ResolveInput, actor: Actor) { return this.core.resolve(id, { issuer: 'store', storeId }, input, actor); }
}
