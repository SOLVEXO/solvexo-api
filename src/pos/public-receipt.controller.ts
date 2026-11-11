/* eslint-disable prettier/prettier */
import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { PosReceiptService, SYNCING_PAGE } from './pos-receipt.service';

const NOT_FOUND_PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Receipt not found</title><body style="font:16px -apple-system,Segoe UI,sans-serif;text-align:center;padding:64px 16px;color:#1b1d21"><h1 style="font-size:20px">This receipt is not available</h1><p style="color:#5b616b">The link is wrong or is no longer active.</p></body></html>';

/** PUBLIC (no auth, by design): trust is the unguessable token. Rendered by the API as plain HTML; no script, no third-party requests. */
@ApiExcludeController()
@Controller('r')
export class PublicReceiptController {
  constructor(private readonly receipts: PosReceiptService) {}

  // G4.9: the offline-buildable link (store public id + the sale's client key). Declared FIRST so `/r/s/…` never reaches `:token/credit-note/:number`.
  // Unknown / malformed / stale → the same 404 as every other link; a sale the till has not synced yet → the "syncing" page (no sale data).
  @Get('s/:store/:key')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  async byClientKey(@Param('store') store: string, @Param('key') key: string, @Res() res: Response) {
    const html = await this.receipts.renderByClientKey(store, key);
    if (html === 'syncing') return res.status(200).type('html').send(SYNCING_PAGE);
    res.status(html ? 200 : 404).type('html').send(html ?? NOT_FOUND_PAGE);
  }

  @Get(':token')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  async page(@Param('token') token: string, @Res() res: Response) {
    const html = await this.receipts.renderPublic(token);
    res.status(html ? 200 : 404).type('html').send(html ?? NOT_FOUND_PAGE); // one answer for unknown / revoked / malformed: nothing to probe
  }

  // G2.5: the tax invoice and credit notes behind the same unguessable link (same headers, same single 404)
  @Get(':token/invoice')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  async invoice(@Param('token') token: string, @Res() res: Response) {
    const html = await this.receipts.renderPublicInvoice(token);
    res.status(html ? 200 : 404).type('html').send(html ?? NOT_FOUND_PAGE);
  }

  @Get(':token/credit-note/:number')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  async creditNote(@Param('token') token: string, @Param('number') number: string, @Res() res: Response) {
    const html = await this.receipts.renderPublicCreditNote(token, number);
    res.status(html ? 200 : 404).type('html').send(html ?? NOT_FOUND_PAGE);
  }
}
