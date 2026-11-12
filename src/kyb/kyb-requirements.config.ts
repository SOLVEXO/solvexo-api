/* eslint-disable prettier/prettier */
import { KybBusinessType, KybDocumentType } from './kyb.schemas';

/**
 * ONE source of truth for "what must be submitted before a KYB can be submitted?". The owner portal renders it (`GET …/kyb` returns it) and
 * `KybService.submit` re-validates it server-side. When the provider's own onboarding rules are confirmed, change them HERE only.
 */
export interface KybRequirementSet {
  businessType: KybBusinessType | null;
  requiredFields: string[];
  requiredDocuments: KybDocumentType[];
  optionalDocuments: KybDocumentType[];
}

const BASE_FIELDS = ['businessType', 'legalBusinessName', 'businessAddress', 'contact.name', 'contact.email', 'contact.phone', 'cnic', 'bankName', 'accountTitle', 'iban'];
const BASE_DOCS: KybDocumentType[] = ['owner_cnic', 'bank_proof'];
const BUSINESS_FIELDS = ['ntn'];
const BUSINESS_DOCS: KybDocumentType[] = ['business_registration', 'tax_registration'];

export function getKybRequirements(businessType: KybBusinessType | null): KybRequirementSet {
  const registered = businessType === 'company' || businessType === 'partnership';
  return {
    businessType,
    requiredFields: [...BASE_FIELDS, ...(registered ? BUSINESS_FIELDS : [])],
    requiredDocuments: [...BASE_DOCS, ...(registered ? BUSINESS_DOCS : [])],
    optionalDocuments: registered ? ['address_proof'] : ['address_proof', 'tax_registration'],
  };
}
