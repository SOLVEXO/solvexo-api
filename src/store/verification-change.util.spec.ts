import { describeChange, mergeVerificationChange } from './verification-change.util';

const live = {
  legalBusinessName: 'Ali Traders', businessAddress: 'Old Street', taxId: '1234567-8', strn: null,
  authorizedContact: { name: 'Ali', email: 'ali@x.pk', phone: '0300', designation: 'Owner' },
  documents: [
    { type: 'owner_id', publicId: 'private/kyc-documents/u1/old-id', resourceType: 'raw', fileName: 'id.pdf' },
    { type: 'address_proof', publicId: 'private/kyc-documents/u1/old-addr', resourceType: 'raw', fileName: 'bill.pdf' },
  ],
};
const doc = (type: string, publicId: string) => ({ type: type as any, publicId, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date('2026-11-20') });

describe('mergeVerificationChange', () => {
  it('applies only the changed fields and leaves the rest and the input untouched', () => {
    const copy = JSON.parse(JSON.stringify(live));
    const { merged } = mergeVerificationChange(live, { fields: { businessAddress: 'New Street', strn: '17-00-1234-567-89' }, documents: [] });
    expect(merged).toMatchObject({ legalBusinessName: 'Ali Traders', businessAddress: 'New Street', taxId: '1234567-8', strn: '17-00-1234-567-89' });
    expect(live).toEqual(copy);
  });

  it('merges the contact key by key, keeping the unchanged ones', () => {
    const { merged } = mergeVerificationChange(live, { fields: { authorizedContact: { phone: '0311' } }, documents: [] });
    expect(merged.authorizedContact).toEqual({ name: 'Ali', email: 'ali@x.pk', phone: '0311', designation: 'Owner' });
  });

  it('a new file replaces the live file of the same type and reports the replaced one; other types are kept', () => {
    const { merged, replaced } = mergeVerificationChange(live, { fields: {}, documents: [doc('owner_id', 'private/kyc-documents/u1/new-id')] });
    expect(merged.documents.find((d: any) => d.type === 'owner_id').publicId).toBe('private/kyc-documents/u1/new-id');
    expect(merged.documents.find((d: any) => d.type === 'address_proof').publicId).toBe('private/kyc-documents/u1/old-addr');
    expect(replaced).toEqual([{ type: 'owner_id', publicId: 'private/kyc-documents/u1/old-id', resourceType: 'raw' }]);
  });

  it('a file of a new type is added and replaces nothing', () => {
    const { merged, replaced } = mergeVerificationChange(live, { fields: {}, documents: [doc('tax_registration', 'private/kyc-documents/u1/ntn')] });
    expect(merged.documents).toHaveLength(3);
    expect(replaced).toEqual([]);
  });

  it('can clear an optional value (null)', () => {
    const { merged } = mergeVerificationChange({ ...live, strn: '17-00' }, { fields: { strn: null }, documents: [] });
    expect(merged.strn).toBeNull();
  });
});

describe('describeChange', () => {
  it('lists readable labels for fields, contact keys and files', () => {
    expect(describeChange({ fields: { businessAddress: 'x', authorizedContact: { phone: '1', email: 'a@b.c' } }, documents: [doc('owner_id', 'p')] }))
      .toEqual(['Business address', 'Contact email', 'Contact phone', 'New file: owner_id']);
  });
  it('is empty for an empty change', () => {
    expect(describeChange({ fields: {}, documents: [] })).toEqual([]);
  });
});

describe('director in a change request', () => {
  it('merges the director key by key and describes it', () => {
    const current = { director: { name: 'Bilal Khan', idNumber: '12345-1234567-1' } };
    const { merged } = mergeVerificationChange(current, { fields: { director: { idNumber: '54321-7654321-9' } }, documents: [] });
    expect(merged.director).toEqual({ name: 'Bilal Khan', idNumber: '54321-7654321-9' });
    expect(describeChange({ fields: { director: { name: 'X', idNumber: 'Y' } }, documents: [] })).toEqual(['Director name', 'Director ID number']);
  });
});
