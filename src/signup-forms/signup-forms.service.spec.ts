import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SignupFormsService } from './signup-forms.service';

const STORE = '64b000000000000000000001';

function setup(opts: { form?: any; storeLive?: boolean; couponExists?: boolean } = {}) {
  const updates: any[] = [];
  const subscribed: any[] = [];
  const form = opts.form === undefined ? { storeId: STORE, enabled: true, heading: 'Hi', body: 'b', buttonLabel: 'Go', successHeading: 's', successMessage: 'm', showAfterPageViews: 2, delaySeconds: 5, exitIntent: true, teaser: true, teaserText: 'T', discountCode: 'WELCOME10', views: 7, submissions: 3 } : opts.form;
  const repos: any = {
    storeModel: { exists: async () => (opts.storeLive === false ? null : { _id: STORE }), findOne: async () => ({ _id: STORE }) },
    couponModel: { exists: async () => (opts.couponExists ? { _id: 'c' } : null) },
    signupFormModel: {
      findOne: () => ({ lean: async () => (form && form.enabled !== false ? form : null) }),
      updateOne: async (...a: any[]) => { updates.push(a); return { modifiedCount: 1 }; },
      findOneAndUpdate: (_f: any, u: any) => ({ lean: async () => ({ ...(form ?? {}), ...(u.$set ?? {}) }) }),
    },
  };
  const newsletter: any = { subscribe: async (email: string, o: any) => { subscribed.push({ email, ...o }); return { success: true, message: 'ok', data: { pendingConfirmation: false } }; } };
  const svc = new SignupFormsService({ repositories: repos } as any, newsletter);
  return { svc, updates, subscribed };
}

describe('SignupFormsService', () => {
  it('shows shoppers the popup settings only — never the counters or the discount code', async () => {
    const { svc } = setup();
    const res: any = await svc.getPublic(STORE);
    expect(res.data.heading).toBe('Hi');
    expect(res.data.showAfterPageViews).toBe(2);
    expect(res.data.views).toBeUndefined();
    expect(res.data.submissions).toBeUndefined();
    expect(res.data.discountCode).toBeUndefined();
  });

  it('shows nothing when the form is off, the store is not live, or the id is not a real store id', async () => {
    expect(((await setup({ form: { enabled: false } }).svc.getPublic(STORE)) as any).data).toBeNull();
    expect(((await setup({ storeLive: false }).svc.getPublic(STORE)) as any).data).toBeNull();
    expect(((await setup().svc.getPublic('nope')) as any).data).toBeNull();
  });

  it('a submission joins the store list as a popup signup, is counted, and returns the discount code', async () => {
    const { svc, subscribed, updates } = setup();
    const res: any = await svc.submit(STORE, 'sana@example.com');
    expect(subscribed).toEqual([{ email: 'sana@example.com', storeId: STORE, source: 'store_popup' }]);
    expect(updates.some(u => JSON.stringify(u[1]) === JSON.stringify({ $inc: { submissions: 1 } }))).toBe(true);
    expect(res.data.discountCode).toBe('WELCOME10');
  });

  it('a submission to a form that is off is refused and nobody is subscribed', async () => {
    const { svc, subscribed } = setup({ form: { enabled: false } });
    await expect(svc.submit(STORE, 'sana@example.com')).rejects.toBeInstanceOf(NotFoundException);
    expect(subscribed).toHaveLength(0);
  });

  it('only an existing, active discount code of the store can be shown on the success step', async () => {
    await expect(setup({ couponExists: false }).svc.update('seller1', STORE, { discountCode: 'TYPO' })).rejects.toBeInstanceOf(BadRequestException);
    const ok: any = await setup({ couponExists: true }).svc.update('seller1', STORE, { discountCode: ' welcome10 ' });
    expect(ok.data.discountCode).toBe('WELCOME10');
    const cleared: any = await setup().svc.update('seller1', STORE, { discountCode: '' });
    expect(cleared.data.discountCode).toBeNull();
  });

  it('REGRESSION: counters and the store id can not be set through the update body', async () => {
    const { svc } = setup();
    const hostile: any = { heading: 'New', views: 999999, submissions: 999999, storeId: 'another-store' };
    const res: any = await svc.update('seller1', STORE, hostile);
    expect(res.data.heading).toBe('New');
    expect(res.data.views).toBe(7);
    expect(res.data.submissions).toBe(3);
    expect(res.data.storeId).toBe(STORE);
  });
});
