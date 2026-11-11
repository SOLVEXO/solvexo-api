import type { BusinessType, VerificationDocumentType, VerificationLevel } from './schemas/store.schema';

// ── ONE central source of truth for "what does this seller need to submit?" ──
// Both `StoreService.getVerificationRequirements` (what the frontend renders)
// and `StoreService.submitVerification` (what the backend independently
// re-validates) call the same function here — there is no second copy of
// this logic anywhere, by design (a frontend-only requirement list would be
// a security bypass, see StoreService.submitVerification).

export interface VerificationRequirementSet {
  country: string;
  businessType: BusinessType | null;
  verificationLevel: VerificationLevel;
  /** Dot-paths into the seller's verification data, e.g. 'authorizedContact.email'. */
  requiredFields: string[];
  /** Fields the form shows but that never block a submit (e.g. PK STRN). */
  optionalFields: string[];
  requiredDocuments: VerificationDocumentType[];
  optionalDocuments: VerificationDocumentType[];
}

/** Subset of `verification.businessProfile` that changes which documents are required. */
export interface RequirementProfileInput {
  sellsBrandedGoods?: boolean | null;
  regulatedCategories?: string[] | null;
}

const BASIC_REQUIRED_FIELDS = [
  'legalBusinessName', 'businessAddress', 'idDocumentType',
  'authorizedContact.name', 'authorizedContact.email', 'authorizedContact.phone',
];
const BUSINESS_EXTRA_FIELDS = ['registrationNumber', 'taxId'];

/** The products & services questionnaire — required for every country before submit.
 *  `regulatedCategories` (empty = none), `otherChannels` and `couriers` are optional. */
export const QUESTIONNAIRE_REQUIRED_FIELDS = [
  'businessProfile.sourcing', 'businessProfile.sellsBrandedGoods', 'businessProfile.premises',
  'businessProfile.yearsSelling', 'businessProfile.dispatchTime', 'businessProfile.returnPolicy',
  'businessProfile.monthlyOrders', 'businessProfile.bankAccountInOwnName',
];

const BASIC_REQUIRED_DOCS: VerificationDocumentType[] = ['owner_id', 'address_proof'];
const BUSINESS_EXTRA_DOCS: VerificationDocumentType[] = ['business_registration', 'tax_registration'];
const OPTIONAL_DOCS: VerificationDocumentType[] = ['authorization_proof'];

export const GCC_COUNTRIES = ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'] as const;
export const isGccCountry = (country: string | null | undefined) => !!country && (GCC_COUNTRIES as readonly string[]).includes(country.toUpperCase());

type CountryRule = (businessType: BusinessType | null) => Pick<VerificationRequirementSet, 'requiredFields' | 'optionalFields' | 'requiredDocuments' | 'optionalDocuments'>;

const isEntity = (bt: BusinessType | null) => bt === 'company' || bt === 'partnership';

// Pakistan: NTN + CNIC for EVERY seller (individuals too), STRN optional;
// companies/partnerships also need a registration number + certificate.
const PK_RULE: CountryRule = (bt) => ({
  requiredFields: [...BASIC_REQUIRED_FIELDS, 'taxId', 'cnicNumber', ...(isEntity(bt) ? ['registrationNumber'] : [])],
  optionalFields: ['strn'],
  requiredDocuments: ['owner_id', 'tax_registration', 'address_proof', ...(isEntity(bt) ? ['business_registration' as const] : [])],
  optionalDocuments: [...OPTIONAL_DOCS],
});

// GCC: trade licence number (registrationNumber) + VAT TRN (taxId) + an ID
// (Emirates ID / national ID / passport). No NTN/CNIC.
const GCC_RULE: CountryRule = () => ({
  requiredFields: [...BASIC_REQUIRED_FIELDS, 'registrationNumber', 'taxId'],
  optionalFields: ['cnicNumber'],
  requiredDocuments: ['owner_id', 'business_registration', 'address_proof'],
  optionalDocuments: ['tax_registration', ...OPTIONAL_DOCS],
});

const COUNTRY_RULES: Record<string, CountryRule> = {
  PK: PK_RULE,
  ...Object.fromEntries(GCC_COUNTRIES.map((c) => [c, GCC_RULE])),
};

/** Pure function of (country, businessType, level, questionnaire answers).
 *  `enhanced` level is architecturally supported but nothing assigns it yet.
 *  Countries without a rule keep the original level-based set unchanged. */
export function getVerificationRequirements(
  country: string,
  businessType: BusinessType | null,
  level: VerificationLevel,
  profile?: RequirementProfileInput | null,
): VerificationRequirementSet {
  const rule = COUNTRY_RULES[(country ?? '').toUpperCase()];
  let base: ReturnType<CountryRule>;
  if (rule) {
    base = rule(businessType);
  } else {
    base = {
      requiredFields: [...BASIC_REQUIRED_FIELDS, ...(level === 'business' ? BUSINESS_EXTRA_FIELDS : [])],
      optionalFields: [],
      requiredDocuments: [...BASIC_REQUIRED_DOCS, ...(level === 'business' ? BUSINESS_EXTRA_DOCS : [])],
      optionalDocuments: [...OPTIONAL_DOCS],
    };
  }

  const requiredDocuments = [...base.requiredDocuments];
  if (profile?.sellsBrandedGoods === true) requiredDocuments.push('brand_authorization');
  if ((profile?.regulatedCategories ?? []).length > 0) requiredDocuments.push('product_licence');
  // Brand authorization / product licence are always offered as optional uploads otherwise.
  const optionalDocuments = [...new Set([...base.optionalDocuments, 'brand_authorization', 'product_licence'] as VerificationDocumentType[])]
    .filter((d) => !requiredDocuments.includes(d));

  return {
    country,
    businessType,
    verificationLevel: level,
    requiredFields: [...base.requiredFields, ...QUESTIONNAIRE_REQUIRED_FIELDS],
    optionalFields: base.optionalFields,
    requiredDocuments,
    optionalDocuments,
  };
}

/** Reads a dot-path (e.g. 'authorizedContact.email') off the verification
 *  data blob and reports whether it's a non-empty value. */
export function isFieldSatisfied(verification: Record<string, any>, path: string): boolean {
  const value = path.split('.').reduce<any>((acc, key) => acc?.[key], verification);
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}
