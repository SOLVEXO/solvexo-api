/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PosCapabilitiesController, POS_CAPABILITIES } from './pos-capabilities.controller';

/** G6.2 — the till's feature probe: one static, public, parameter-free route (it can never answer "resource not found"). */
describe('GET /api/pos/capabilities', () => {
  it('answers the contract, the release and every feature the till may gate on', () => {
    const r = new PosCapabilitiesController().capabilities();
    expect(r).toEqual({ success: true, data: POS_CAPABILITIES });
    expect(r.data.release).toBe(2);
    expect(r.data.features).toEqual(expect.arrayContaining(['productPage', 'receiptDelivery', 'connectors', 'receiptLogo', 'rolePresets', 'integrations', 'apiKeys', 'fiscalContract', 'fiscalIssues', 'connectorUi']));
    expect(new Set(r.data.features).size).toBe(r.data.features.length);
  });

  it('is exactly GET api/pos/capabilities with no path parameter and no guard (no auth state can change the answer)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PosCapabilitiesController)).toBe('api/pos/capabilities');
    const h = PosCapabilitiesController.prototype.capabilities;
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    expect([undefined, '/', ''].includes(Reflect.getMetadata(PATH_METADATA, h))).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, PosCapabilitiesController) ?? []).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, h) ?? []).toEqual([]);
  });
});
