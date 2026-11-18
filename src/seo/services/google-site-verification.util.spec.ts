import { BadRequestException } from '@nestjs/common';
import { parseGoogleSiteVerification } from './google-site-verification.util';

const TOKEN = 'O-wDzSLQ0kLuYjtslj9-AEnlLC0TSIjEcp6ym_Dyvoo';

describe('parseGoogleSiteVerification', () => {
  it('takes the content value out of a pasted meta tag', () => {
    expect(parseGoogleSiteVerification(`<meta name="google-site-verification" content="${TOKEN}" />`)).toBe(TOKEN);
  });
  it('accepts the bare token', () => {
    expect(parseGoogleSiteVerification(`  ${TOKEN} `)).toBe(TOKEN);
  });
  it('treats blank as removal', () => {
    expect(parseGoogleSiteVerification('')).toBeNull();
    expect(parseGoogleSiteVerification('   ')).toBeNull();
    expect(parseGoogleSiteVerification(undefined)).toBeNull();
  });
  it('rejects anything that could carry markup', () => {
    expect(() => parseGoogleSiteVerification('"><script>alert(1)</script>')).toThrow(BadRequestException);
    expect(() => parseGoogleSiteVerification('<meta content="a b<c>">')).toThrow(BadRequestException);
    expect(() => parseGoogleSiteVerification('short')).toThrow(BadRequestException);
  });
});
