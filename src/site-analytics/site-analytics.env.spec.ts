/* eslint-disable prettier/prettier */
import { parseServiceAccount, readGaEnv } from './site-analytics.env';

const KEY = { type: 'service_account', project_id: 'solvexo', client_email: 'ga@solvexo.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n' };

describe('Google Analytics settings from the environment', () => {
  it('reads the measurement id, property id and service account under common names', () => {
    const env = readGaEnv({ GOOGLE_ANALYTICS_ID: 'g-ab12cd34ef', GA_PROPERTY_ID: 'properties/412345678', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) });
    expect(env.measurementId).toEqual({ value: 'G-AB12CD34EF', variable: 'GOOGLE_ANALYTICS_ID' });
    expect(env.propertyId).toEqual({ value: 'properties/412345678', variable: 'GA_PROPERTY_ID' });
    expect(env.serviceAccount?.key.client_email).toBe('ga@solvexo.iam.gserviceaccount.com');
    expect(env.serviceAccount?.key.private_key).toBe('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n');
    expect(env.problems).toEqual([]);
  });

  it('accepts a base64 or quoted key and a key file path', () => {
    expect((parseServiceAccount(Buffer.from(JSON.stringify(KEY)).toString('base64')) as any).client_email).toBe(KEY.client_email);
    expect((parseServiceAccount(`'${JSON.stringify(KEY)}'`) as any).client_email).toBe(KEY.client_email);
    const env = readGaEnv({ GOOGLE_APPLICATION_CREDENTIALS: '/etc/solvexo/ga.json' }, () => JSON.stringify(KEY));
    expect(env.serviceAccount?.variable).toBe('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('explains values it cannot use, and fixes a measurement id and property id swapped between variables', () => {
    const bad = readGaEnv({ GA_MEASUREMENT_ID: 'UA-1234-1', GA4_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user"}' });
    expect(bad.measurementId).toBeNull();
    expect(bad.serviceAccount).toBeNull();
    expect(bad.problems).toEqual(['GA_MEASUREMENT_ID should look like G-XXXXXXXXXX', 'GA4_SERVICE_ACCOUNT_JSON is a "authorized_user" key, not a service account key']);
    const swapped = readGaEnv({ GA_MEASUREMENT_ID: '412345678', GA4_PROPERTY_ID: 'G-AB12CD34EF' });
    expect(swapped.measurementId?.value).toBe('G-AB12CD34EF');
    expect(swapped.propertyId?.value).toBe('properties/412345678');
    expect(readGaEnv({ GA4_SERVICE_ACCOUNT_JSON: '{not json' }).problems[0]).toContain('is not valid JSON');
  });
});
