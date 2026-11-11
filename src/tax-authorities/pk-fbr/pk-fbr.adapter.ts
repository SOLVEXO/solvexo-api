/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import type { AuthorityCall, AuthorityMode, TaxAuthorityAdapter } from '../../tax-core/tax-authority.adapter';
import { FbrDiClient } from '../../fbr-di/fbr-di.client';
import { isValidFbrInvoiceNumber, qrText } from '../../fbr-di/fbr-di.util';

/**
 * Pakistan, FBR digital invoicing (PRAL API v1.12). A thin adapter over the existing client: the client keeps the hard production
 * lock as its last line of defence, so this adapter cannot file in production either.
 */
@Injectable()
export class PkFbrAdapter implements TaxAuthorityAdapter {
  readonly key = 'PK_FBR';
  constructor(private readonly client: Pick<FbrDiClient, 'post' | 'validate'>) {}

  post(input: any, mode: AuthorityMode, token: string): Promise<AuthorityCall> { return this.client.post(input, mode, token); }
  validate(input: any, mode: AuthorityMode, token: string): Promise<AuthorityCall> { return this.client.validate(input, mode, token); }
  qrFor(invoiceNumber: string): string { return qrText(invoiceNumber); }
  isValidInvoiceNumber(invoiceNumber: string): boolean { return isValidFbrInvoiceNumber(invoiceNumber); }
}
