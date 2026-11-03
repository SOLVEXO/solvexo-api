import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isDevMailSinkEnabled, isDevThrottleDisabled, writeDevMail } from './dev-mail-sink.util';

describe('dev mail sink / dev throttle switch', () => {
  it('is off by default', () => {
    expect(isDevMailSinkEnabled({} as any)).toBe(false);
    expect(isDevThrottleDisabled({} as any)).toBe(false);
  });
  it('is on only for DEV_* = "true" outside production', () => {
    expect(isDevMailSinkEnabled({ DEV_OTP_LOG: 'true' } as any)).toBe(true);
    expect(isDevMailSinkEnabled({ DEV_OTP_LOG: '1' } as any)).toBe(false);
    expect(isDevThrottleDisabled({ NODE_ENV: 'development', DEV_DISABLE_THROTTLE: 'true' } as any)).toBe(true);
  });
  it('is IMPOSSIBLE in production, whatever the flags say', () => {
    expect(isDevMailSinkEnabled({ NODE_ENV: 'production', DEV_OTP_LOG: 'true' } as any)).toBe(false);
    expect(isDevThrottleDisabled({ NODE_ENV: 'production', DEV_DISABLE_THROTTLE: 'true' } as any)).toBe(false);
  });
  it('writes a JSON line with the 6-digit code', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-')), 'mail.log');
    writeDevMail({ to: 'a@b.com', subject: 'Your OTP Code', text: 'Your OTP code is: 123456' }, { DEV_MAIL_LOG_FILE: file } as any);
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(line).toMatchObject({ to: 'a@b.com', otp: '123456' });
  });
});
