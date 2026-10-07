/* eslint-disable prettier/prettier */
import { _resetGeocodingState, buildGeocodeQuery, geocodeAddress, isGeocodingEnabled, parseNominatimResponse } from './geocoding.util';

const addr = { addressLine1: '12 Main St', city: 'Lahore', zipCode: '54000', country: 'PK' };
const okFetch = (body: unknown, ok = true) => jest.fn(async () => ({ ok, json: async () => body }));
const noSleep = async () => undefined;

describe('geocoding util', () => {
  beforeEach(() => _resetGeocodingState());

  it('buildGeocodeQuery needs a country and a city/postcode', () => {
    expect(buildGeocodeQuery({ city: 'Lahore' })).toBeNull();
    expect(buildGeocodeQuery({ country: 'PK' })).toBeNull();
    const q = buildGeocodeQuery(addr)!;
    expect(q.countryCode).toBe('pk');
    expect(q.query).toBe('12 Main St, Lahore, 54000');
  });

  it('parseNominatimResponse reads lat/lon strings and rejects junk', () => {
    expect(parseNominatimResponse([{ lat: '31.5', lon: '74.3' }])).toEqual({ latitude: 31.5, longitude: 74.3 });
    expect(parseNominatimResponse([])).toBeNull();
    expect(parseNominatimResponse([{ lat: 'x', lon: '1' }])).toBeNull();
    expect(parseNominatimResponse([{ lat: '95', lon: '1' }])).toBeNull();
  });

  it('can be disabled without a key', () => {
    expect(isGeocodingEnabled({ GEOCODING_PROVIDER: 'none' } as any)).toBe(false);
    expect(isGeocodingEnabled({} as any)).toBe(true);
  });

  it('sends a User-Agent + countrycodes and caches the result', async () => {
    const fetchImpl = okFetch([{ lat: '31.5', lon: '74.3' }]);
    expect(await geocodeAddress(addr, { fetchImpl: fetchImpl as any, sleep: noSleep })).toEqual({ latitude: 31.5, longitude: 74.3 });
    expect(await geocodeAddress(addr, { fetchImpl: fetchImpl as any, sleep: noSleep })).toEqual({ latitude: 31.5, longitude: 74.3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toContain('countrycodes=pk');
    expect(init.headers['User-Agent']).toMatch(/Solvexo/);
  });

  it('negative results are cached; transient failures are not', async () => {
    const empty = okFetch([]);
    expect(await geocodeAddress(addr, { fetchImpl: empty as any, sleep: noSleep })).toBeNull();
    await geocodeAddress(addr, { fetchImpl: empty as any, sleep: noSleep });
    expect(empty).toHaveBeenCalledTimes(1);

    _resetGeocodingState();
    const failing = okFetch([], false);
    await geocodeAddress(addr, { fetchImpl: failing as any, sleep: noSleep });
    await geocodeAddress(addr, { fetchImpl: failing as any, sleep: noSleep });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('never throws and returns null when fetch rejects or the provider is disabled', async () => {
    const boom = jest.fn(async () => { throw new Error('network'); });
    expect(await geocodeAddress(addr, { fetchImpl: boom as any, sleep: noSleep })).toBeNull();
    expect(await geocodeAddress(addr, { env: { GEOCODING_PROVIDER: 'none' } as any })).toBeNull();
  });

  it('rate-limits: a second distinct lookup waits for the Nominatim gap', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = okFetch([{ lat: '1', lon: '2' }]);
    await geocodeAddress(addr, { fetchImpl: fetchImpl as any, sleep });
    await geocodeAddress({ ...addr, city: 'Karachi' }, { fetchImpl: fetchImpl as any, sleep });
    expect(sleep).toHaveBeenCalled();
    expect((sleep.mock.calls[0] as any)[0]).toBeGreaterThan(0);
  });
});
