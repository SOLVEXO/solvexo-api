/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AttachVerificationDocumentDto, UpdateVerificationDto, VERIFICATION_LIMITS } from './update-verification.dto';

const check = async (cls: any, body: unknown) => (await validate(plainToInstance(cls, body) as object)).flatMap((e) => collect(e));
const collect = (e: any): string[] => [e.property, ...(e.children ?? []).flatMap((c: any) => collect(c).map((p: string) => `${e.property}.${p}`))].filter(Boolean) as string[];
const bad = async (body: unknown, cls: any = UpdateVerificationDto) => (await check(cls, body)).length > 0;
const long = (n: number) => 'x'.repeat(n);

describe('UpdateVerificationDto', () => {
  it('accepts exactly what the seller form sends (including empty drafts)', async () => {
    expect(await bad({
      legalBusinessName: 'Ali Traders', registrationNumber: '', businessAddress: 'Shop 4, Karachi', businessType: 'individual',
      authorizedContact: { name: 'Ali', designation: '', email: '', phone: '0300 1234567' },
      idDocumentType: 'cnic', cnicNumber: '42101-1234567-1', taxId: '42101-1234567-1', strn: '',
    })).toBe(false);
    expect(await bad({})).toBe(false);
  });

  it('accepts null for the optional identifiers (a seller clearing a field)', async () => {
    expect(await bad({ taxId: null, cnicNumber: null, strn: null })).toBe(false);
  });

  it('rejects text longer than its limit', async () => {
    expect(await bad({ legalBusinessName: long(VERIFICATION_LIMITS.legalBusinessName + 1) })).toBe(true);
    expect(await bad({ businessAddress: long(VERIFICATION_LIMITS.businessAddress + 1) })).toBe(true);
    expect(await bad({ registrationNumber: long(VERIFICATION_LIMITS.registrationNumber + 1) })).toBe(true);
    expect(await bad({ taxId: long(VERIFICATION_LIMITS.taxId + 1) })).toBe(true);
    expect(await bad({ cnicNumber: long(VERIFICATION_LIMITS.idNumber + 1) })).toBe(true);
    expect(await bad({ strn: long(VERIFICATION_LIMITS.strn + 1) })).toBe(true);
    expect(await bad({ authorizedContact: { name: long(VERIFICATION_LIMITS.contactName + 1) } })).toBe(true);
    expect(await bad({ authorizedContact: { phone: long(VERIFICATION_LIMITS.contactPhone + 1) } })).toBe(true);
  });

  it('accepts text exactly at the limit', async () => {
    expect(await bad({ legalBusinessName: long(VERIFICATION_LIMITS.legalBusinessName), businessAddress: long(VERIFICATION_LIMITS.businessAddress) })).toBe(false);
  });

  it('rejects wrong types (number, object, array where text is expected)', async () => {
    expect(await bad({ legalBusinessName: 123 })).toBe(true);
    expect(await bad({ businessAddress: { $gt: '' } })).toBe(true);
    expect(await bad({ taxId: ['1'] })).toBe(true);
    expect(await bad({ authorizedContact: 'Ali' })).toBe(true);
    expect(await bad({ authorizedContact: { email: { $ne: null } } })).toBe(true);
    expect(await bad({ businessProfile: 'x' })).toBe(true);
    expect(await bad({ documents: 'x' })).toBe(true);
  });

  it('rejects an unknown business type, ID type or document type', async () => {
    expect(await bad({ businessType: 'ngo' })).toBe(true);
    expect(await bad({ idDocumentType: 'driving_licence' })).toBe(true);
    expect(await bad({ documents: [{ type: 'selfie', publicId: 'p/a', fileName: 'a.pdf' }] })).toBe(true);
  });

  it('checks the contact email format but lets an empty draft through', async () => {
    expect(await bad({ authorizedContact: { email: 'not-an-email' } })).toBe(true);
    expect(await bad({ authorizedContact: { email: 'ali@example.com' } })).toBe(false);
    expect(await bad({ authorizedContact: { email: '' } })).toBe(false);
  });

  it('limits the documents list and each document\'s fields and resource type', async () => {
    const d = (i: number) => ({ type: 'owner_id', publicId: `private/kyc-documents/u1/${i}`, resourceType: 'raw', fileName: 'a.pdf' });
    expect(await bad({ documents: [d(1)] })).toBe(false);
    expect(await bad({ documents: Array.from({ length: VERIFICATION_LIMITS.maxDocuments + 1 }, (_, i) => d(i)) })).toBe(true);
    expect(await bad({ documents: [{ ...d(1), resourceType: 'video' }] })).toBe(true);
    expect(await bad({ documents: [{ ...d(1), publicId: long(VERIFICATION_LIMITS.publicId + 1) }] })).toBe(true);
    expect(await bad({ documents: [{ ...d(1), fileName: long(VERIFICATION_LIMITS.fileName + 1) }] })).toBe(true);
    expect(await bad({ documents: [{ type: 'owner_id', fileName: 'a.pdf' }] })).toBe(true);
  });
});

describe('AttachVerificationDocumentDto', () => {
  const ok = { type: 'owner_id', publicId: 'private/kyc-documents/u1/abc', resourceType: 'raw', fileName: 'id.pdf' };
  it('accepts a valid attach body', async () => {
    expect(await bad(ok, AttachVerificationDocumentDto)).toBe(false);
  });
  it('rejects a missing or wrong field', async () => {
    expect(await bad({ ...ok, type: 'x' }, AttachVerificationDocumentDto)).toBe(true);
    expect(await bad({ ...ok, publicId: undefined }, AttachVerificationDocumentDto)).toBe(true);
    expect(await bad({ ...ok, resourceType: 'video' }, AttachVerificationDocumentDto)).toBe(true);
    expect(await bad({ ...ok, fileName: long(VERIFICATION_LIMITS.fileName + 1) }, AttachVerificationDocumentDto)).toBe(true);
    expect(await bad({}, AttachVerificationDocumentDto)).toBe(true);
  });
});
