/* eslint-disable prettier/prettier */
import { optionLabel } from './field-visit.constants';

/** What a saved visit contains (the answers; identity and audit fields live on the document). */
export interface VisitAnswers {
  storeName: string;
  unit?: string | null;
  floor?: string | null;
  area?: string | null;
  category?: string | null;
  categoryOther?: string | null;
  priceRange?: string | null;
  wholesale?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  whatsapp?: string | null;
  waPermission?: boolean | null;
  bestTime?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  website?: string | null;
  sellsOn?: string[];
  ordersPerMonth?: string | null;
  payments?: string[];
  couriers?: string[];
  courierBooking?: string | null;
  billing?: string | null;
  billingSoftware?: string | null;
  khata?: string | null;
  seasons?: string[];
  bestSellers?: string | null;
  problem?: string | null;
  problemTags?: string[];
  objections?: string[];
  interest: string;
  nextStep: string;
  nextStepAt?: string | Date | null;
}

const list = (g: Parameters<typeof optionLabel>[0], keys?: string[]) => (keys ?? []).map((k) => optionLabel(g, k)).join(', ');

/** The plain-text summary written to the lead's timeline (one fact per line, blanks left out). */
export function visitSummary(v: VisitAnswers): string {
  const where = [v.unit, v.floor ? `${optionLabel('floor', v.floor)} floor` : null, v.area].filter(Boolean).join(' · ');
  const category = v.category === 'other' && v.categoryOther ? v.categoryOther : optionLabel('category', v.category);
  const contact = [v.contactName, v.contactRole ? `(${optionLabel('contactRole', v.contactRole)})` : null].filter(Boolean).join(' ');
  const billing = v.billing === 'software' && v.billingSoftware ? `Software: ${v.billingSoftware}` : optionLabel('billing', v.billing);
  const lines: [string, string | null | undefined][] = [
    ['Shop', [v.storeName, where].filter(Boolean).join(' — ')],
    ['Category', [category, optionLabel('priceRange', v.priceRange), optionLabel('wholesale', v.wholesale)].filter(Boolean).join(' · ')],
    ['Contact', contact],
    ['WhatsApp', v.whatsapp ? `${v.whatsapp}${v.waPermission ? ' (OK to message)' : ' (no permission to message)'}` : null],
    ['Best time', optionLabel('bestTime', v.bestTime)],
    ['Online', [v.instagram && `IG ${v.instagram}`, v.facebook && `FB ${v.facebook}`, v.website].filter(Boolean).join(' · ')],
    ['Sells on', list('sellsOn', v.sellsOn)],
    ['Online orders / month', optionLabel('ordersPerMonth', v.ordersPerMonth)],
    ['Payments', list('payments', v.payments)],
    ['Courier', [list('couriers', v.couriers), v.courierBooking ? `booked by ${optionLabel('courierBooking', v.courierBooking).toLowerCase()}` : null].filter(Boolean).join(', ')],
    ['Billing / POS', billing],
    ['Khata', optionLabel('khata', v.khata)],
    ['Busy seasons', list('seasons', v.seasons)],
    ['Best sellers', v.bestSellers],
    ['Biggest problem', [v.problem ? `“${v.problem}”` : null, list('problemTags', v.problemTags)].filter(Boolean).join(' · ')],
    ['Objections', list('objections', v.objections)],
    ['Interest', optionLabel('interest', v.interest)],
    ['Next step', [optionLabel('nextStep', v.nextStep), v.nextStepAt ? new Date(v.nextStepAt).toISOString().slice(0, 10) : null].filter(Boolean).join(' · ')],
  ];
  return lines.filter(([, val]) => val && String(val).trim()).map(([k, val]) => `${k}: ${val}`).join('\n');
}

/**
 * Where a lead moves after a visit. A visit is a contact, so a New lead becomes Contacted; "Not interested" closes an
 * open lead as Lost. Leads further along (demo, trial, won) are never moved back, and a lost lead that shows interest
 * again reopens as Contacted. Null = leave it.
 */
export function stageAfterVisit(current: string, interest: string): { stage: string; lost: boolean } | null {
  if (interest === 'not_interested') return ['new', 'contacted'].includes(current) ? { stage: 'lost', lost: true } : null;
  if (current === 'new' || current === 'lost') return { stage: 'contacted', lost: false };
  return null;
}

/** The follow-up task title for a next step, or null when there is nothing to follow up. */
export function followUpTitle(nextStep: string, storeName: string): string | null {
  if (!nextStep || nextStep === 'none') return null;
  return `${optionLabel('nextStep', nextStep)} — ${storeName}`;
}

/** Lower-cased, single-spaced, for "is this the same shop?" matching. */
export const storeKey = (s?: string | null) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Parses a `data:image/...;base64,...` photo from the phone. Null when it is not one. */
export function parsePhotoDataUrl(dataUrl?: string | null): { mimetype: string; buffer: Buffer; ext: string } | null {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return null;
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  return { mimetype: m[1], buffer: Buffer.from(m[3].replace(/\s/g, ''), 'base64'), ext };
}
