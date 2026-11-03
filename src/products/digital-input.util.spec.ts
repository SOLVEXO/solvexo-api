import { normalizeDigital } from './digital-input.util';

const f = (n: string, u: string, size = 10) => ({ url: 'private/digital-products/' + u, name: n, size });

describe('normalizeDigital', () => {
  it('keeps indexes stable, archives removed files, appends new', () => {
    const a = normalizeDigital({ files: [f('a.pdf', 'a'), f('b.zip', 'b')], downloadLimit: '3', linkExpiryDays: 7 });
    const b = normalizeDigital({ files: [f('b.zip', 'b'), f('c.mp3', 'c')] }, a);
    expect(b.files.map((x: any) => `${x.url.slice(-1)}:${x.archived}:${x.position}`)).toEqual(['a:true:0', 'b:false:0', 'c:false:1']);
    expect(b.downloadLimit).toBe('3');
  });

  it('accepts every allowed type', () => {
    for (const ext of ['pdf', 'zip', 'epub', 'mp3', 'wav', 'mp4', 'mov', 'ttf', 'otf', 'woff2', 'png', 'jpg', 'svg', 'psd', 'ai', 'fig', 'docx', 'xlsx', 'pptx', 'txt', 'csv']) {
      expect(normalizeDigital({ files: [f(`x.${ext}`, 'x')] }).files.length).toBe(1);
    }
  });

  it('blocks executables and unlisted types, whatever the case', () => {
    for (const name of ['x.exe', 'x.EXE', 'x.bat', 'x.sh', 'x.msi', 'x.apk', 'x.ps1', 'x.jar', 'x.dmg', 'x.unknown', 'noext', 'x.pdf.exe']) {
      expect(() => normalizeDigital({ files: [f(name, 'x')] })).toThrow();
    }
  });

  it('rejects oversize files, external links, other folders and path tricks', () => {
    expect(() => normalizeDigital({ files: [f('a.pdf', 'a', 3 * 1024 * 1024 * 1024)] })).toThrow('2 GB');
    for (const url of ['https://evil.example/x.pdf', 'private/kyc-documents/x', 'private/digital-products/../kyc/x', '/etc/passwd']) {
      expect(() => normalizeDigital({ files: [{ url, name: 'a.pdf', size: 1 }] })).toThrow('uploaded through');
    }
  });

  it('validates the delivery settings', () => {
    expect(() => normalizeDigital({ files: [f('a.pdf', 'a')], downloadLimit: '9' })).toThrow('downloadLimit');
    expect(() => normalizeDigital({ files: [f('a.pdf', 'a')], linkExpiryDays: 0 })).toThrow('linkExpiryDays');
    expect(() => normalizeDigital({ files: [f('a.pdf', 'a')], linkExpiryDays: 4000 })).toThrow('linkExpiryDays');
    expect(() => normalizeDigital({ files: [] })).toThrow('At least one file');
    expect(() => normalizeDigital({ files: [f('a.pdf', 'a')], licenseKeys: { enabled: true, activationLimit: 0 } })).toThrow('activationLimit');
    expect(() => normalizeDigital('nope')).toThrow('digital must be an object');
  });

  it('a legacy file url already on the product stays valid on edit', () => {
    const legacy = { files: [{ url: 'https://old.example/x.pdf', name: 'x.pdf', size: 1 }] };
    expect(normalizeDigital({ files: [{ url: 'https://old.example/x.pdf', name: 'x.pdf', size: 1 }] }, legacy).files.length).toBe(1);
  });

  it('only descriptive fields are taken from the client for server-managed parts', () => {
    const r = normalizeDigital({ files: [f('a.pdf', 'a')], preview: { enabled: true, sourceFileIndex: 0, previewSourcePublicId: 'attacker' } });
    expect(JSON.stringify(r.preview)).toBe(JSON.stringify({ enabled: true, sourceFileIndex: 0 }));
  });
});
