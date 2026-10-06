import { assertFileSignature, detectFileKind, publicUploadFileFilter } from './upload-file-validation';

const file = (name: string, bytes: number[] | string, mimetype = 'application/octet-stream') => ({
  originalname: name,
  mimetype,
  buffer: typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes),
});
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

describe('upload magic-byte validation', () => {
  it('detects common signatures', () => {
    expect(detectFileKind(Buffer.from(PNG))).toBe('png');
    expect(detectFileKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectFileKind(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(detectFileKind(Buffer.from('GIF89a....'))).toBe('gif');
    expect(detectFileKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(detectFileKind(Buffer.from('\0\0\0\x20ftypisom'))).toBe('mp4');
    expect(detectFileKind(Buffer.from('<svg xmlns="x"></svg>'))).toBeNull();
  });

  it('accepts a real PNG named .png', () => {
    expect(() => assertFileSignature(file('a.png', PNG, 'image/png'))).not.toThrow();
  });

  it('rejects HTML/script disguised as an image', () => {
    expect(() => assertFileSignature(file('a.png', '<html><script>alert(1)</script>', 'image/png'))).toThrow();
  });

  it('rejects a PNG renamed to .pdf', () => {
    expect(() => assertFileSignature(file('a.pdf', PNG))).toThrow();
  });

  it('rejects markup in txt/csv but accepts plain text', () => {
    expect(() => assertFileSignature(file('a.txt', '<svg onload=alert(1)>'))).toThrow();
    expect(() => assertFileSignature(file('a.csv', 'a,b\n1,2\n'))).not.toThrow();
  });

  it('rejects oversized images', () => {
    const big = Buffer.concat([Buffer.from(PNG), Buffer.alloc(11 * 1024 * 1024)]);
    expect(() => assertFileSignature({ originalname: 'a.png', mimetype: 'image/png', buffer: big })).toThrow();
  });

  it('filter rejects SVG by extension and mimetype', () => {
    const cb = jest.fn();
    publicUploadFileFilter({}, { originalname: 'x.svg', mimetype: 'image/svg+xml' } as any, cb);
    expect(cb.mock.calls[0][1]).toBe(false);
  });
});
