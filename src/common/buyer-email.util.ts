/* eslint-disable prettier/prettier */

/** The email to show / send to for a buyer row. A guest-checkout session has a synthetic, undeliverable login `email`
 *  (see GuestSessionService); their real address is `contactEmail`. A guest who never gave one has no usable email. */
export function buyerEmail(u: { email?: string | null; contactEmail?: string | null; isGuest?: boolean } | null | undefined): string | null {
  if (!u) return null;
  if (u.contactEmail) return u.contactEmail;
  return u.isGuest ? null : (u.email ?? null);
}
