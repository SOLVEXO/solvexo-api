/* eslint-disable prettier/prettier */
import type { StorePagePolicyType } from './schemas/store-page.schema';

export interface PolicyTemplateInfo {
  title: string;
  slug: string;
  /** Block rows of the rich-text section: a heading or a paragraph. */
  blocks: { type: 'heading' | 'paragraph'; text: string }[];
}

interface PolicyTemplateContext {
  storeName: string;
  contactEmail?: string | null;
}

const h = (text: string) => ({ type: 'heading' as const, text });
const p = (text: string) => ({ type: 'paragraph' as const, text });

/**
 * Starting-point texts for the standard store policies (Shopify offers the same: a generated draft the merchant reviews).
 * They are generic on purpose; the seller must read and adjust them for their own business and local law.
 */
export function policyTemplate(type: StorePagePolicyType, ctx: PolicyTemplateContext): PolicyTemplateInfo {
  const name = ctx.storeName || 'our store';
  const contact = ctx.contactEmail ? `Email us at ${ctx.contactEmail}.` : 'Contact us through the contact details on this website.';

  switch (type) {
    case 'privacy_policy':
      return {
        title: 'Privacy Policy',
        slug: 'privacy-policy',
        blocks: [
          p(`This Privacy Policy explains how ${name} collects, uses and protects your personal information when you visit our website or place an order.`),
          h('Information we collect'),
          p('We collect the details you give us, such as your name, email address, phone number, delivery and billing address, and your order history. We also collect basic technical data such as your device type and how you use the site, to keep it working well.'),
          h('How we use your information'),
          p('We use your information to process and deliver your orders, send order updates, provide customer support, prevent fraud, and improve our website. If you subscribe to our emails, we also use your email address to send news and offers. You can unsubscribe at any time.'),
          h('Sharing your information'),
          p('We only share your information with the services we need to run the store, such as payment providers, delivery partners and email services, and when the law requires it. We do not sell your personal information.'),
          h('Cookies'),
          p('We use cookies to remember your cart, keep you signed in, and understand how the site is used. You can control cookies in your browser settings.'),
          h('Your rights'),
          p('You can ask to see, correct or delete the personal information we hold about you. Please contact us and we will respond as soon as we can.'),
          h('Contact us'),
          p(contact),
        ],
      };
    case 'terms_of_service':
      return {
        title: 'Terms of Service',
        slug: 'terms-of-service',
        blocks: [
          p(`These Terms of Service apply to your use of the ${name} website and to any purchase you make from us. By using the site or placing an order, you agree to them.`),
          h('Products and prices'),
          p('We try to describe and photograph our products accurately, but colours and details may look slightly different on your screen. Prices and availability can change without notice. If we make an obvious pricing error, we may cancel the order and refund you.'),
          h('Orders and payment'),
          p('An order is confirmed when we accept it, and we may decline or cancel an order, for example when an item is out of stock or we suspect fraud. You agree to provide correct and complete information when you order and pay.'),
          h('Shipping and returns'),
          p('Delivery and returns follow our Shipping Policy and Refund Policy, which form part of these terms.'),
          h('Use of the website'),
          p('You agree not to misuse the website, attempt to gain unauthorised access, or use it for anything unlawful. All content on this site belongs to us or our partners and may not be copied without permission.'),
          h('Limitation of liability'),
          p('To the extent the law allows, we are not responsible for indirect or consequential loss arising from the use of this website or our products. Nothing in these terms limits any rights you have under consumer law.'),
          h('Changes to these terms'),
          p('We may update these terms from time to time. The version published on this page applies to your use of the site.'),
          h('Contact us'),
          p(contact),
        ],
      };
    case 'refund_policy':
      return {
        title: 'Refund Policy',
        slug: 'refund-policy',
        blocks: [
          p(`We want you to be happy with your purchase from ${name}. This policy explains when you can return an item and how refunds work.`),
          h('Returns'),
          p('You can ask to return an item within 14 days of receiving it. The item must be unused, in its original condition and packaging, and you must have your order number. Some items, such as personalised, perishable or digital products, may not be returnable.'),
          h('How to start a return'),
          p(`Contact us with your order number and the item you want to return. ${contact} We will tell you how and where to send it back.`),
          h('Refunds'),
          p('Once we receive and check your return, we will refund the item price to your original payment method, or as store credit if you prefer. Refunds usually appear within 5 to 10 business days, depending on your bank.'),
          h('Damaged or wrong items'),
          p('If your order arrives damaged, defective or not what you ordered, contact us within 7 days with photos. We will send a replacement or refund you in full, including the delivery cost.'),
          h('Late or missing refunds'),
          p('If you have not received your refund after 10 business days, first check with your bank, then contact us.'),
        ],
      };
    case 'shipping_policy':
      return {
        title: 'Shipping Policy',
        slug: 'shipping-policy',
        blocks: [
          p(`This policy explains how ${name} ships orders and what to expect after you check out.`),
          h('Processing time'),
          p('We prepare orders within 1 to 3 business days. Orders placed on weekends or public holidays are processed on the next business day. You will get an email when your order ships.'),
          h('Delivery time and cost'),
          p('Delivery time and shipping cost depend on your address and the delivery option you choose at checkout. The exact cost and estimated delivery date are shown before you pay.'),
          h('Tracking'),
          p('When your order ships, we email you a tracking link whenever the carrier provides one, so you can follow your parcel.'),
          h('International orders'),
          p('If we ship to your country, duties, import taxes or customs fees may apply and are charged by the carrier or customs office. They are the buyer\'s responsibility unless we tell you otherwise at checkout.'),
          h('Lost or damaged parcels'),
          p('If your parcel is delayed, lost or arrives damaged, please contact us as soon as possible and we will help resolve it with the carrier.'),
          h('Contact us'),
          p(contact),
        ],
      };
  }
}
