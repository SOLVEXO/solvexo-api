process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
import { BadRequestException } from '@nestjs/common';
import { AbandonedCartService } from './abandoned-cart.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** The designed (drag-and-drop) abandoned checkout email: saved with its HTML, validated, and sent instead of the plain text. */

const HOUR = 3_600_000;
const DESIGN = { version: 1, previewText: '', styles: {}, blocks: [{ type: 'heading', text: 'Come back' }] };
const HTML = '<table><tr><td><h1>Come back, {{customerName}}!</h1><a href="{{cartUrl}}">Return to your cart</a></td></tr></table>';

function setup(settings: any = {}, couponCodes: string[] = ['COMEBACK10']) {
  const m: any = {
    checkoutModel: new FakeModel(), storeModel: new FakeModel(), userModel: new FakeModel(), couponModel: new FakeModel(),
    abandonedCartSettingsModel: new FakeModel(), newsletterSubscriberModel: new FakeModel(),
  };
  m.storeModel.rows.push({ _id: 's1', name: 'Shop One', contactEmail: null, mailingAddress: '12 Main Street', isDelete: false, sellerId: 'seller1' });
  m.userModel.rows.push({ _id: 'u1', name: 'Sana', email: 'sana@x.com', isDelete: false });
  m.newsletterSubscriberModel.rows.push({ storeId: 's1', email: 'sana@x.com', isActive: true });
  for (const code of couponCodes) m.couponModel.rows.push({ storeId: 's1', code, isActive: true, isDelete: false, scope: 'seller' });
  m.abandonedCartSettingsModel.rows.push({ storeId: 's1', isDelete: false, enabled: true, delayMinutes: 5, subject: 'Hi', message: 'Back {{cartUrl}}', ...settings });
  const sent: { to: string; subject: string; html: string }[] = [];
  const email: any = { sendMail: async (to: string, subject: string, html: string) => { sent.push({ to, subject, html }); return true; } };
  const ent: any = { getLimits: async () => ({ abandonedCartRecoveryAllowed: true }), getEmailRoom: async () => 100, assertFeatureAllowed: async () => undefined };
  const svc = new AbandonedCartService({ repositories: m } as any, { log: () => undefined } as any, email, ent);
  return { svc, m, sent };
}
const cart = () => ({
  _id: '000000000000000000000001', userId: 'u1', status: 'pending', isDelete: false, recoveredAt: null, items: [{ storeId: 's1', quantity: 1 }],
  abandonedEmailSentAt: null, abandonedSecondEmailSentAt: null, abandonedEmailSuppressedAt: null, abandonedRecoveryToken: null, abandonedEmailStoreId: null,
  updatedAt: new Date(Date.now() - 12 * HOUR),
});

describe('designed abandoned checkout email', () => {
  it('is sent instead of the plain text: tags filled, store address and unsubscribe in the footer', async () => {
    const k = setup({ design: DESIGN, html: HTML, discountCode: null });
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent.length).toBe(1);
    expect(k.sent[0].html).toContain('Come back, Sana!');
    expect(k.sent[0].html).toContain('/api/abandoned-cart/click/');
    expect(k.sent[0].html).not.toContain('{{');
    expect(k.sent[0].html).toContain('12 Main Street');
    expect(k.sent[0].html).toContain('/api/abandoned-cart/unsubscribe/');
  });

  it("a buyer's name can not inject HTML into the design", async () => {
    const k = setup({ design: DESIGN, html: HTML });
    k.m.userModel.rows[0].name = '<img src=x onerror=alert(1)>';
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent[0].html).not.toContain('<img src=x');
    expect(k.sent[0].html).toContain('&lt;img');
  });

  it('without a design the plain text email is sent as before', async () => {
    const k = setup({});
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent[0].html).toContain('Back');
    expect(k.sent[0].html).toContain('Return to your cart');
  });

  it('the test email uses the design too', async () => {
    const k = setup({ design: DESIGN, html: HTML });
    await k.svc.sendTest('seller1', 's1', 'owner@x.com');
    expect(k.sent[0].subject.startsWith('[Test]')).toBe(true);
    expect(k.sent[0].html).toContain('Come back, Alex!');
  });
});

describe('saving a design', () => {
  it('needs its rendered HTML, a real design, and only real discount codes of the store', async () => {
    const k = setup();
    await expect(k.svc.updateSettings('seller1', 's1', { design: DESIGN } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(k.svc.updateSettings('seller1', 's1', { design: { version: 2, blocks: [] }, html: HTML } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(k.svc.updateSettings('seller1', 's1', { design: { version: 1, blocks: [{ type: 'discount', code: 'NOPE' }] }, html: HTML } as any)).rejects.toBeInstanceOf(BadRequestException);
    const ok: any = await k.svc.updateSettings('seller1', 's1', { design: { version: 1, blocks: [{ type: 'discount', code: 'COMEBACK10' }] }, html: HTML } as any);
    expect(ok.data.html).toBe(HTML);
  });

  it('null clears the design and its HTML together; HTML alone is never stored', async () => {
    const k = setup({ design: DESIGN, html: HTML });
    const cleared: any = await k.svc.updateSettings('seller1', 's1', { design: null } as any);
    expect(cleared.data.design).toBeNull();
    expect(cleared.data.html).toBeNull();
    const alone: any = await k.svc.updateSettings('seller1', 's1', { html: '<p>evil</p>' } as any);
    expect(alone.data.html ?? null).toBeNull();
  });
});
