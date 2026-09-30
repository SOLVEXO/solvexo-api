import type { PaymentGatewayService } from '@/subscriptions/payment-gateway/payment-gateway.service';

/**
 * Stripe customer ids are stored on the Seller and copied onto each store's
 * subscription. They go stale when the platform switches Stripe accounts or
 * modes (e.g. ids created under test keys, now running on live keys): every
 * call that touches them then fails with "No such customer".
 *
 * These helpers make a stored id safe to use — they check it exists in the
 * CURRENT Stripe account and, if not, replace it (and persist the replacement)
 * instead of letting the stale id break a charge, portal session or setup intent.
 */

/** The seller's Stripe customer id, guaranteed to exist now — recreated and saved on the seller when the stored one is stale or missing. `seller` must be a real (non-lean) document. */
export async function ensureSellerCustomerId(gateway: PaymentGatewayService, seller: any): Promise<string> {
  const existing: string | null = seller.stripeCustomerId ?? null;
  if (existing && (await gateway.customerExists(existing))) return existing;

  const { providerCustomerId } = await gateway.getOrCreateCustomer(
    seller._id.toString(), seller.email, seller.name ?? '', existing ?? undefined,
  );
  seller.stripeCustomerId = providerCustomerId;
  // A stale id's saved card went with it; the new customer has none yet.
  if (existing) seller.hasPlatformPaymentMethod = false;
  await seller.save();
  return providerCustomerId;
}

/**
 * The customer id a store subscription should charge. Returns the stored one if
 * it still exists; if it's stale, repoints the subscription at the seller's
 * (validated) customer and returns that. `undefined` when the subscription has
 * no customer anywhere (neither on the subscription nor on the seller).
 */
export async function resolveSubCustomerId(
  gateway: PaymentGatewayService,
  sellerModel: any,
  subModel: any,
  sub: any,
  sellerId: string,
): Promise<string | undefined> {
  const stored: string | null | undefined = sub?.stripeCustomerId;
  if (!stored) {
    // A store that was never billed through Stripe has no customer on its own
    // subscription, but its seller may have saved a card (e.g. just to buy an
    // add-on) — that card lives on the seller's customer.
    const owner = await sellerModel.findById(sellerId);
    const sellerCustomerId: string | null | undefined = owner?.stripeCustomerId;
    if (sellerCustomerId && (await gateway.customerExists(sellerCustomerId))) return sellerCustomerId;
    return undefined;
  }
  if (await gateway.customerExists(stored)) return stored;

  const seller = await sellerModel.findById(sellerId);
  if (!seller) return stored; // nothing to repoint to — let the provider report the real error
  const replacement = await ensureSellerCustomerId(gateway, seller);
  await subModel.updateOne({ _id: sub._id }, { $set: { stripeCustomerId: replacement } });
  sub.stripeCustomerId = replacement;
  return replacement;
}
