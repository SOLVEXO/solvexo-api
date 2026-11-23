/* eslint-disable prettier/prettier */
import type { VerificationDocument } from './schemas/store.schema';

// Pure helpers for the "change request" a VERIFIED seller sends instead of editing their details in place
// (see VerificationChangeRequest in store.schema.ts). No database, no Nest — so the rules are easy to test.

/** The plain fields a verified seller may ask to change. (Country and seller type are not: they decide the rules and the payment gateways.) */
export const CHANGE_SCALAR_FIELDS = ['legalBusinessName', 'registrationNumber', 'taxId', 'strn', 'cnicNumber', 'businessAddress'] as const;
export type ChangeScalarField = (typeof CHANGE_SCALAR_FIELDS)[number];
export const CHANGE_CONTACT_FIELDS = ['name', 'designation', 'email', 'phone'] as const;
export const CHANGE_DIRECTOR_FIELDS = ['name', 'idNumber'] as const;

export interface VerificationChangeInput {
  fields: Record<string, unknown>;
  documents: Pick<VerificationDocument, 'type' | 'publicId' | 'resourceType' | 'fileName' | 'uploadedAt'>[];
}

/** Applies a change request to a copy of the live verification data. `replaced` = live files that the new files take the place of. */
export function mergeVerificationChange(
  current: Record<string, any>,
  change: VerificationChangeInput,
): { merged: Record<string, any>; replaced: Pick<VerificationDocument, 'type' | 'publicId' | 'resourceType'>[] } {
  const merged: Record<string, any> = { ...current };
  for (const key of CHANGE_SCALAR_FIELDS) {
    if (change.fields?.[key] !== undefined) merged[key] = change.fields[key];
  }
  const contact = change.fields?.authorizedContact as Record<string, unknown> | undefined;
  if (contact && typeof contact === 'object') {
    merged.authorizedContact = { ...(current.authorizedContact ?? {}), ...contact };
  }

  const director = change.fields?.director as Record<string, unknown> | undefined;
  if (director && typeof director === 'object') {
    merged.director = { ...(current.director ?? {}), ...director };
  }

  const replaced: Pick<VerificationDocument, 'type' | 'publicId' | 'resourceType'>[] = [];
  if (change.documents?.length) {
    const byType = new Map<string, any>((current.documents ?? []).map((d: any) => [d.type, d]));
    for (const next of change.documents) {
      const old = byType.get(next.type);
      if (old && old.publicId !== next.publicId) replaced.push({ type: old.type, publicId: old.publicId, resourceType: old.resourceType });
      byType.set(next.type, { type: next.type, publicId: next.publicId, resourceType: next.resourceType, fileName: next.fileName, uploadedAt: next.uploadedAt ?? new Date() });
    }
    merged.documents = [...byType.values()];
  }
  return { merged, replaced };
}

const FIELD_LABELS: Record<string, string> = {
  legalBusinessName: 'Legal business name', registrationNumber: 'Registration number', taxId: 'Tax number (NTN)', strn: 'STRN',
  cnicNumber: 'ID number', businessAddress: 'Business address', 'authorizedContact.name': 'Contact name',
  'authorizedContact.designation': 'Contact designation', 'authorizedContact.email': 'Contact email', 'authorizedContact.phone': 'Contact phone',
  'director.name': 'Director name', 'director.idNumber': 'Director ID number',
};

/** Human labels of everything a request changes (for history and notifications), e.g. ["Business address", "New file: owner_id"]. */
export function describeChange(change: VerificationChangeInput): string[] {
  const out: string[] = [];
  for (const key of CHANGE_SCALAR_FIELDS) if (change.fields?.[key] !== undefined) out.push(FIELD_LABELS[key]);
  const contact = change.fields?.authorizedContact as Record<string, unknown> | undefined;
  if (contact) for (const key of CHANGE_CONTACT_FIELDS) if (contact[key] !== undefined) out.push(FIELD_LABELS[`authorizedContact.${key}`]);
  const director = change.fields?.director as Record<string, unknown> | undefined;
  if (director) for (const key of CHANGE_DIRECTOR_FIELDS) if (director[key] !== undefined) out.push(FIELD_LABELS[`director.${key}`]);
  for (const d of change.documents ?? []) out.push(`New file: ${d.type}`);
  return out;
}
