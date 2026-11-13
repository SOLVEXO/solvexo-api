import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { devUploadStubActive, UploadService } from './upload.service';

/**
 * G5.8: the dev upload stub (DEV_UPLOAD_STUB, ba8f370) can never activate in production — even with its own variable set — and is fail-closed
 * for any NODE_ENV that is not exactly `development` or `test`.
 */
describe('dev upload stub is fail-closed', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    DEV_UPLOAD_STUB: process.env.DEV_UPLOAD_STUB,
  };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.DEV_UPLOAD_STUB === undefined) delete process.env.DEV_UPLOAD_STUB;
    else process.env.DEV_UPLOAD_STUB = saved.DEV_UPLOAD_STUB;
    jest.restoreAllMocks();
  });

  it.each([
    'production',
    'Production',
    'PRODUCTION',
    ' production',
    'prod',
    'staging',
    '',
    undefined,
  ])('NODE_ENV=%p with DEV_UPLOAD_STUB=true → stub OFF', (nodeEnv) => {
    expect(
      devUploadStubActive({
        NODE_ENV: nodeEnv,
        DEV_UPLOAD_STUB: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it.each(['development', 'test'])(
    'NODE_ENV=%p: on only when DEV_UPLOAD_STUB is exactly "true"',
    (nodeEnv) => {
      expect(
        devUploadStubActive({
          NODE_ENV: nodeEnv,
          DEV_UPLOAD_STUB: 'true',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
      for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
        expect(
          devUploadStubActive({
            NODE_ENV: nodeEnv,
            DEV_UPLOAD_STUB: v,
          } as NodeJS.ProcessEnv),
        ).toBe(false);
      }
    },
  );

  const file = {
    mimetype: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    originalname: 'x.png',
    size: 4,
  } as Express.Multer.File;
  const service = () =>
    new UploadService({ get: () => undefined } as unknown as ConfigService);

  it('UploadService with NODE_ENV=production and DEV_UPLOAD_STUB=true goes to real storage (no placeholder URL)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_UPLOAD_STUB = 'true';
    const real = jest
      .spyOn(cloudinary.uploader, 'upload_stream')
      .mockImplementation(((
        _opts: unknown,
        cb: (e: unknown, r: unknown) => void,
      ) => {
        cb(null, {
          secure_url: 'https://res.cloudinary.com/x/real.png',
          public_id: 'receipt-logos/s1/real',
          width: 1,
          height: 1,
        });
        return {
          write: () => true,
          end: () => undefined,
          on: () => undefined,
          once: () => undefined,
          emit: () => true,
        } as never;
      }) as never);
    const r = await service().uploadFile(file, { folder: 'receipt-logos/s1' });
    expect(real).toHaveBeenCalledTimes(1);
    expect(r.url).toBe('https://res.cloudinary.com/x/real.png');
    expect(r.url).not.toContain('dev-upload.invalid');
  });

  it('UploadService in development with DEV_UPLOAD_STUB=true returns the placeholder and never calls storage', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_UPLOAD_STUB = 'true';
    const real = jest.spyOn(cloudinary.uploader, 'upload_stream');
    const r = await service().uploadFile(file, { folder: 'receipt-logos/s1' });
    expect(real).not.toHaveBeenCalled();
    expect(r.url).toMatch(
      /^https:\/\/dev-upload\.invalid\/receipt-logos\/s1\//,
    );
  });
});
