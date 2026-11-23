/* eslint-disable prettier/prettier */
import {
  BulkColumn, BulkRowError, parseBoolCell, parseEmailCell, runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const CUSTOMER_IMPORT_MAX_ROWS = 1000;

/**
 * Shopify's customer CSV layout, so a seller can move their list over as-is. The older Solvexo template
 * ("Name, Email, Phone, Accepts Email Marketing") still imports: "Name" is read as the full name.
 */
export const CUSTOMER_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'First Name', description: 'Customer first name. A file with one "Name" column also works.', example: 'Sample', aliases: ['Name', 'Full Name', 'Customer Name'] },
  { key: 'Last Name', description: 'Customer last name.', example: 'Customer' },
  { key: 'Email', description: 'Unique per store; a customer with this email that already exists is skipped. Leave it blank for a customer you only have a phone number for: they are added to your shop (POS) customers.', example: 'sample.customer@example.com' },
  { key: 'Accepts Email Marketing', description: 'yes/no. "yes" subscribes the customer to marketing emails and needs the consent box ticked.', example: 'no' },
  { key: 'Default Address Company', description: 'Company name; saved in the customer note.', example: '' },
  { key: 'Default Address Address1', description: 'Street address. The address is saved when Address1, City, Province Code, Zip and a phone are all filled.', example: '12 Main Boulevard' },
  { key: 'Default Address Address2', description: 'Apartment, suite, floor.', example: '' },
  { key: 'Default Address City', description: 'City.', example: 'Lahore' },
  { key: 'Default Address Province Code', description: 'Province or state, e.g. PB or Punjab.', example: 'PB' },
  { key: 'Default Address Country Code', description: 'Two-letter country code, e.g. PK.', example: 'PK' },
  { key: 'Default Address Zip', description: 'Postal code.', example: '54000' },
  { key: 'Default Address Phone', description: 'Phone for deliveries to this address. Also used as the customer phone when Phone is blank.', example: '' },
  { key: 'Phone', description: 'Customer phone number. Needed when there is no email.', example: '+92 300 1234567' },
  { key: 'Accepts SMS Marketing', description: 'yes/no. Recorded on the customer for SMS marketing; "yes" needs the consent box ticked.', example: 'no' },
  { key: 'Accepts WhatsApp Marketing', description: 'yes/no. Recorded on the customer for WhatsApp marketing; "yes" needs the consent box ticked.', example: 'no' },
  { key: 'Tags', description: 'Comma-separated, e.g. "VIP, Wholesale" (up to 20).', example: '' },
  { key: 'Note', description: 'Private note about the customer.', example: '' },
  { key: 'Tax Exempt', description: 'Accepted but not used yet: per-customer tax exemption is not available.', example: 'no' },
];

export interface ImportedAddress {
  recipientName: string;
  phoneNumber: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zipCode: string;
  country: string | null;
}

/** A customer with an email: a store customer account (the Customers page). */
export interface OnlineCustomerInput {
  name: string;
  email: string;
  phone?: string;
  marketingConsent?: boolean;
  smsConsent?: boolean;
  whatsappConsent?: boolean;
  tags?: string[];
  notes?: string;
  address?: ImportedAddress;
}

/** A customer with only a phone number: a shop (POS) customer, keyed by phone like the till does. */
export interface ShopCustomerInput {
  name: string;
  phone: string;
  address: string | null;
  notes: string | null;
  smsConsent: boolean;
  whatsappConsent: boolean;
}

export interface CustomerImportDeps {
  /** True when a (non-deleted) customer account with this email already exists in THIS store. */
  exists: (email: string) => Promise<boolean>;
  /** The real seller-create path (StoreService.createStoreCustomer) plus the imported extras. */
  create: (dto: OnlineCustomerInput) => Promise<unknown>;
  /** True when this store already has a shop (POS) customer with this phone. */
  shopExists: (phone: string) => Promise<boolean>;
  createShop: (dto: ShopCustomerInput) => Promise<unknown>;
}

/** Same rule as the till (PosCustomersService.validate): digits, optional leading +. */
export function normaliseShopPhone(raw: string): string | null {
  const p = raw.replace(/[\s().-]/g, '');
  return /^\+?\d{5,18}$/.test(p) ? p : null;
}

const splitTags = (raw: string) =>
  [...new Set(raw.split(',').map((t) => t.trim().slice(0, 50)).filter(Boolean))].slice(0, 20);

/**
 * `consentConfirmed`: the seller ticked "these customers agreed to receive marketing" — without it a "yes" in any
 * marketing column is rejected, never silently subscribed.
 */
export async function importCustomersCsv(deps: CustomerImportDeps, text: string, opts: { consentConfirmed?: boolean } = {}) {
  let shopCustomers = 0;
  let taxExemptRows = 0;
  let addressesNotSaved = 0;

  const res = await runBulkImport({
    text,
    columns: CUSTOMER_IMPORT_COLUMNS,
    maxRows: CUSTOMER_IMPORT_MAX_ROWS,
    label: 'customer',
    fileDedupeKey: (r) => (r.Email ? r.Email.trim().toLowerCase() : (normaliseShopPhone(r.Phone || r['Default Address Phone']) ?? null)),
    handler: async (r) => {
      const name = [r['First Name'], r['Last Name']].map((s) => s.trim()).filter(Boolean).join(' ');
      if (name.length > 200) throw new BulkRowError('Name is too long (max 200 characters)');
      const email = parseEmailCell(r.Email, 'Email', false);
      const phone = (r.Phone || r['Default Address Phone']).trim();
      if (phone.length > 40) throw new BulkRowError('Phone is too long (max 40 characters)');

      const acceptsEmail = parseBoolCell(r['Accepts Email Marketing'], 'Accepts Email Marketing');
      const acceptsSms = parseBoolCell(r['Accepts SMS Marketing'], 'Accepts SMS Marketing');
      const acceptsWhatsapp = parseBoolCell(r['Accepts WhatsApp Marketing'], 'Accepts WhatsApp Marketing');
      if ((acceptsEmail || acceptsSms || acceptsWhatsapp) && !opts.consentConfirmed) {
        throw new BulkRowError('A marketing column is "yes" — tick the consent box on the import screen to confirm these customers agreed');
      }
      if (parseBoolCell(r['Tax Exempt'], 'Tax Exempt')) taxExemptRows++;

      const tags = splitTags(r.Tags);
      const company = r['Default Address Company'].trim();
      const noteParts = [company ? `Company: ${company}` : '', r.Note.trim()].filter(Boolean);

      const a1 = r['Default Address Address1'].trim();
      const a2 = r['Default Address Address2'].trim();
      const city = r['Default Address City'].trim();
      const province = r['Default Address Province Code'].trim();
      const zip = r['Default Address Zip'].trim();
      const country = r['Default Address Country Code'].trim().toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) throw new BulkRowError('Default Address Country Code must be a two-letter code, e.g. PK');
      const addressPhone = (r['Default Address Phone'] || r.Phone).trim();

      if (!email) {
        if (!phone) throw new BulkRowError('Needs an email or a phone number');
        const shopPhone = normaliseShopPhone(phone);
        if (!shopPhone) throw new BulkRowError('Phone must contain digits only (spaces, dashes and brackets are fine)');
        if (await deps.shopExists(shopPhone)) return { outcome: 'skipped', note: 'Shop customer with this phone already exists' };
        const oneLine = [a1, a2, city, province, zip, country].filter(Boolean).join(', ');
        const notes = [...noteParts, tags.length ? `Tags: ${tags.join(', ')}` : ''].filter(Boolean).join('\n');
        await deps.createShop({
          name: (name || shopPhone).slice(0, 120),
          phone: shopPhone,
          address: oneLine ? oneLine.slice(0, 300) : null,
          notes: notes ? notes.slice(0, 500) : null,
          smsConsent: acceptsSms === true,
          whatsappConsent: acceptsWhatsapp === true,
        });
        shopCustomers++;
        return { outcome: 'created' };
      }

      if (await deps.exists(email)) return { outcome: 'skipped', note: 'Customer already exists' };

      let address: ImportedAddress | undefined;
      if (a1 || city) {
        if (a1 && city && province && zip && addressPhone) {
          address = {
            recipientName: (name || email).slice(0, 200), phoneNumber: addressPhone.slice(0, 40),
            addressLine1: a1.slice(0, 300), addressLine2: a2 ? a2.slice(0, 300) : null,
            city: city.slice(0, 100), state: province.slice(0, 100), zipCode: zip.slice(0, 20), country: country || null,
          };
        } else {
          addressesNotSaved++;
        }
      }

      await deps.create({
        name, email, phone: phone || undefined,
        marketingConsent: acceptsEmail ? true : undefined,
        smsConsent: acceptsSms ? true : undefined,
        whatsappConsent: acceptsWhatsapp ? true : undefined,
        tags: tags.length ? tags : undefined,
        notes: noteParts.length ? noteParts.join('\n').slice(0, 2000) : undefined,
        address,
      });
      return { outcome: 'created' };
    },
  });

  const notices: string[] = [];
  if (shopCustomers) {
    notices.push(`${shopCustomers} customer${shopCustomers === 1 ? '' : 's'} without an email ${shopCustomers === 1 ? 'was' : 'were'} added to your shop (POS) customers, found by phone at the till. They show on the Customers page once they have an email.`);
  }
  if (addressesNotSaved) {
    notices.push(`${addressesNotSaved} address${addressesNotSaved === 1 ? ' was' : 'es were'} not saved: an address needs Address1, City, Province Code, Zip and a phone. The customers themselves were added.`);
  }
  if (taxExemptRows) {
    notices.push(`Tax Exempt is not used yet: per-customer tax exemption is not available, so ${taxExemptRows} customer${taxExemptRows === 1 ? '' : 's'} marked "yes" will be charged tax as usual.`);
  }
  if (notices.length) res.data.notices = notices;
  return res;
}
