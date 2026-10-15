// @ts-nocheck
/* eslint-disable */
jest.mock('@/database/databaseservice', () => ({ DatabaseService: class {} }));
jest.mock('@/firebase/firebase.config', () => ({ FirebaseAdminService: class {} }));
jest.mock('@/integrations/whatsapp-sender.service', () => ({ WhatsAppSenderService: class {} }));
jest.mock('./notifications.gateway', () => ({ NotificationsGateway: class {} }));
jest.mock('@/otp/services/email.service', () => ({ EmailService: class {} }));
jest.mock('@/activity-log/activity-log.service', () => ({ ActivityLogService: class {} }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
import { BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { StoreNotificationSettingsService } from './store-notification-settings.service';

const STORE_ID = '64b000000000000000000001';
const SELLER_ID = 'seller-1';

function leanQuery(value) {
  const q = { select: () => q, lean: () => Promise.resolve(value) };
  return q;
}

describe('StoreNotificationSettingsService.update', () => {
  function make() {
    const settingsModel = { findOne: jest.fn(() => leanQuery(null)), findOneAndUpdate: jest.fn(() => Promise.resolve({})) };
    // verifyStoreOwnershipStrict does `await storeModel.findById(id)` and reads the document directly.
    const storeModel = { findById: jest.fn(() => Promise.resolve({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, name: 'First Store', contactEmail: 'support@first.store' })) };
    const db = { repositories: { storeModel, storeNotificationSettingsModel: settingsModel } };
    const log = { log: jest.fn() };
    return { svc: new StoreNotificationSettingsService(db, log, { sendMail: jest.fn().mockResolvedValue(true) }), settingsModel };
  }

  it('rejects an unknown email event', async () => {
    const { svc } = make();
    await expect(svc.update(SELLER_ID, STORE_ID, { events: { bogus: { enabled: false } } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a placeholder the event cannot fill', async () => {
    const { svc } = make();
    await expect(svc.update(SELLER_ID, STORE_ID, { events: { order_delivered: { body: 'Tracking {{trackingNumber}}' } } })).rejects.toThrow(/unknown placeholder/i);
  });

  it('rejects a store that belongs to another seller', async () => {
    const { svc } = make();
    await expect(svc.update('someone-else', STORE_ID, { senderName: 'X' })).rejects.toBeDefined();
  });

  it('saves the switch, own text and sender, and unsets a blanked field', async () => {
    const { svc, settingsModel } = make();
    await svc.update(SELLER_ID, STORE_ID, {
      senderName: ' First "Store" <x> ',
      replyToEmail: 'Help@First.Store',
      staffOrderEmails: ['A@x.com', 'a@x.com', 'b@x.com'],
      events: { order_shipped: { enabled: false, subject: 'Shipped {{orderNumber}}', body: '' } },
    });
    const [filter, update] = settingsModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ storeId: STORE_ID });
    expect(update.$set.senderName).toBe('First Store x');
    expect(update.$set.replyToEmail).toBe('help@first.store');
    expect(update.$set.staffOrderEmails).toEqual(['a@x.com', 'b@x.com']);
    expect(update.$set['events.order_shipped.enabled']).toBe(false);
    expect(update.$set['events.order_shipped.subject']).toBe('Shipped {{orderNumber}}');
    expect(update.$unset['events.order_shipped.body']).toBe('');
  });

  it("won't switch off an email that carries the only copy of something (gift card) or that the seller sends by hand (invoice)", async () => {
    const { svc, settingsModel } = make();
    await expect(svc.update(SELLER_ID, STORE_ID, { events: { gift_card: { enabled: false } } })).rejects.toThrow(/can't be switched off/);
    await expect(svc.update(SELLER_ID, STORE_ID, { events: { draft_order_invoice: { enabled: false } } })).rejects.toBeInstanceOf(BadRequestException);
    expect(settingsModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('retries once when two first writes race on the unique storeId index', async () => {
    const { svc, settingsModel } = make();
    settingsModel.findOneAndUpdate.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    await svc.update(SELLER_ID, STORE_ID, { senderName: 'X' });
    expect(settingsModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('reset clears the seller text for an event', async () => {
    const { svc, settingsModel } = make();
    await svc.update(SELLER_ID, STORE_ID, { events: { order_refunded: { reset: true } } });
    const [, update] = settingsModel.findOneAndUpdate.mock.calls[0];
    expect(update.$unset['events.order_refunded.subject']).toBe('');
    expect(update.$unset['events.order_refunded.body']).toBe('');
  });
});

describe('NotificationsService customer emails', () => {
  const store = { _id: STORE_ID, name: 'First Store', contactEmail: 'support@first.store', slug: 'first' };
  function make(settings, extra = {}, order = null) {
    const db = {
      repositories: {
        storeModel: { findById: () => leanQuery(store) },
        storeNotificationSettingsModel: { findOne: () => leanQuery(settings) },
        orderModel: { findById: () => leanQuery(order) },
        ...extra,
      },
    };
    const email = { sendMail: jest.fn(() => Promise.resolve(true)) };
    return { svc: new NotificationsService(db, {}, {}, email, {}, {}), email };
  }
  const vars = { customerName: 'Sara', orderNumber: '1001', carrier: 'TCS', trackingNumber: 'T1' };

  it('uses the built-in email, the store name and the store contact email when nothing is configured', async () => {
    const built = await make(null).svc.buildCustomerEmail({ storeId: STORE_ID, event: 'order_shipped', vars, orderId: '64b0000000000000000000aa' });
    expect(built).toMatchObject({ send: true, fromName: 'First Store', replyTo: 'support@first.store' });
    expect(built.subject).toBe('Your order #1001 from First Store has shipped');
    expect(built.html).toContain('Tracking number: T1');
    expect(built.html).toContain('/order-status/');
  });

  it('reports send:false when the seller switched the email off', async () => {
    const built = await make({ events: { order_shipped: { enabled: false } } }).svc.buildCustomerEmail({ storeId: STORE_ID, event: 'order_shipped', vars });
    expect(built.send).toBe(false);
  });

  it('applies the seller text, sender name and reply-to', async () => {
    const built = await make({
      senderName: 'First Store Team',
      replyToEmail: 'orders@first.store',
      events: { order_shipped: { subject: 'On its way, {{customerName}}!', body: 'Hello {{customerName}}, parcel {{trackingNumber}} is out.' } },
    }).svc.buildCustomerEmail({ storeId: STORE_ID, event: 'order_shipped', vars });
    expect(built).toMatchObject({ send: true, fromName: 'First Store Team', replyTo: 'orders@first.store', subject: 'On its way, Sara!' });
    expect(built.html).toContain('Hello Sara, parcel T1 is out.');
  });

  it('fills {{trackingUrl}} in a seller template (and always sends gift cards / invoices even if a switch was stored off)', async () => {
    const built = await make({ events: { order_shipped: { body: 'Track here: {{trackingUrl}}' }, gift_card: { enabled: false } } }).svc
      .buildCustomerEmail({ storeId: STORE_ID, event: 'order_shipped', vars, trackingUrl: 'https://track.test/T1' });
    expect(built.html).toContain('Track here: https://track.test/T1');
    const gift = await make({ events: { gift_card: { enabled: false } } }).svc.buildCustomerEmail({ storeId: STORE_ID, event: 'gift_card', vars: { giftCardCode: 'ABC' } });
    expect(gift.send).toBe(true);
  });

  it('links "Track your package" for a shipped email with a tracking URL', async () => {
    const built = await make(null).svc.buildCustomerEmail({ storeId: STORE_ID, event: 'order_shipped', vars, trackingUrl: 'https://track.test/T1', orderId: '64b0000000000000000000aa' });
    expect(built.html).toContain('https://track.test/T1');
    expect(built.html).toContain('Track your package');
  });

  it('records the real outcome on the order timeline and honours the off-switch unless forced', async () => {
    const orderModel = { updateOne: jest.fn(() => Promise.resolve({})) };
    const { svc, email } = make({ events: { order_confirmation: { enabled: false } } }, { orderModel });
    const args = { to: 'buyer@x.com', storeId: STORE_ID, event: 'order_confirmation', orderId: '64b0000000000000000000aa', vars: { orderNumber: '1' } };

    expect(await svc.sendCustomerEmail(args)).toBe('disabled');
    expect(email.sendMail).not.toHaveBeenCalled();

    expect(await svc.sendCustomerEmail({ ...args, force: true })).toBe('sent');
    expect(email.sendMail.mock.calls[0][0]).toBe('buyer@x.com');
    const pushed = orderModel.updateOne.mock.calls[0][1].$push.timeline;
    expect(pushed).toMatchObject({ type: 'email', actorRole: 'system' });
    expect(pushed.message).toBe('Order confirmation email sent to buyer@x.com');

    email.sendMail.mockResolvedValueOnce(false);
    expect(await svc.sendCustomerEmail({ ...args, force: true })).toBe('failed');
    expect(orderModel.updateOne.mock.calls[1][1].$push.timeline.message).toContain('could not be delivered');
  });
});

describe('NotificationsService admin + seller alerts', () => {
  function makeSvc(over: any = {}) {
    const queue = { add: jest.fn(() => Promise.resolve({})) };
    const gateway = { emitNewNotification: jest.fn(), emitUnreadCount: jest.fn() };
    const created: any[] = [];
    const db = {
      repositories: {
        notificationPreferenceModel: { findOne: () => leanQuery(null) },
        notificationModel: {
          create: jest.fn((doc) => { created.push(doc); return Promise.resolve({ toObject: () => doc }); }),
          countDocuments: jest.fn(() => Promise.resolve(1)),
        },
        adminModel: {
          find: () => leanQuery([{ _id: 'a1' }, { _id: 'a2' }]),
          findById: (id) => leanQuery({ email: `${id}@solvexo.test` }),
        },
        sellerModel: { findById: () => leanQuery({ email: 'seller@x.com' }) },
        ...over,
      },
    };
    const svc = new NotificationsService(db, gateway, { sendToUser: jest.fn() }, { sendMail: jest.fn() }, {}, queue);
    return { svc, queue, created, gateway };
  }
  const emailJobs = (queue) => queue.add.mock.calls.filter(([name]) => name === 'send-notification-email').map(([, data]) => data);

  it('notifyAdmins gives every admin an in-app notification and an email', async () => {
    const { svc, queue, created } = makeSvc();
    expect(await svc.notifyAdmins({ type: 'admin_new_seller', title: 'New seller signed up', body: 'Sara just joined', data: { link: '/admin/clients' } })).toBe(2);
    expect(created.map((c) => [c.recipientId, c.recipientRole])).toEqual([['a1', 'admin'], ['a2', 'admin']]);
    const jobs = emailJobs(queue);
    expect(jobs.map((j) => j.to).sort()).toEqual(['a1@solvexo.test', 'a2@solvexo.test']);
    expect(jobs[0].subject).toBe('New seller signed up');
    expect(jobs[0].html).toContain('/admin/clients');
  });

  it('an admin who turned their email off still gets the in-app notification only', async () => {
    const { svc, queue, created } = makeSvc({ notificationPreferenceModel: { findOne: () => leanQuery({ emailEnabled: false, pushEnabled: true, prefs: {} }) } });
    await svc.notifyAdmins({ type: 'admin_new_store', title: 'New store', body: 'x' });
    expect(created).toHaveLength(2);
    expect(emailJobs(queue)).toHaveLength(0);
  });

  it('emails a seller for an email-worthy alert without the caller passing an email, but not for chat', async () => {
    const a = makeSvc();
    await a.svc.notify({ recipientId: 's1', recipientRole: 'seller', storeId: 'st1', type: 'refund_requested', title: 'Refund requested', body: 'Order #5' });
    const jobs = emailJobs(a.queue);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].to).toBe('seller@x.com');
    expect(jobs[0].html).toContain('/store/st1');

    const b = makeSvc();
    await b.svc.notify({ recipientId: 's1', recipientRole: 'seller', storeId: 'st1', type: 'new_message', title: 'Hi', body: 'chat' });
    expect(emailJobs(b.queue)).toHaveLength(0);
  });

  it('the "emails are failing" alert is in-app only (an email about broken email would fail too)', async () => {
    const { svc, queue, created } = makeSvc();
    await svc.notifyAdmins({ type: 'admin_email_failure', title: 'Emails are failing to send', body: 'x' });
    expect(created).toHaveLength(2);
    expect(emailJobs(queue)).toHaveLength(0);
  });

  it('a seller who muted the topic gets no email', async () => {
    const { svc, queue } = makeSvc({ notificationPreferenceModel: { findOne: () => leanQuery({ emailEnabled: true, prefs: { orders: false } }) } });
    await svc.notify({ recipientId: 's1', recipientRole: 'seller', storeId: 'st1', type: 'refund_requested', title: 'Refund requested', body: 'x' });
    expect(emailJobs(queue)).toHaveLength(0);
  });
});

describe('customer email branding + delivery health', () => {
  const store = { _id: STORE_ID, name: 'First Store', contactEmail: 'support@first.store', slug: 'first', logo: 'https://cdn.test/logo.png' };
  function make(settings, extra = {}) {
    const db = { repositories: { storeModel: { findById: () => leanQuery(store) }, storeNotificationSettingsModel: { findOne: () => leanQuery(settings) }, ...extra } };
    return new NotificationsService(db, {}, {}, { sendMail: jest.fn(() => Promise.resolve(true)) }, {}, {});
  }

  it('shows the store logo, the accent colour and the footer line', async () => {
    const built = await make({ accentColor: '#112233', footerText: 'Karachi · Mon–Sat' }).buildCustomerEmail({ storeId: STORE_ID, event: 'order_delivered', vars: { orderNumber: '1', deliveryStatus: 'delivered' } });
    expect(built.html).toContain('https://cdn.test/logo.png');
    expect(built.html).toContain('#112233');
    expect(built.html).toContain('Karachi · Mon–Sat');
  });

  it('uses the store name instead when the logo is switched off, and ignores a bad colour', async () => {
    const built = await make({ showLogo: false, accentColor: 'red' }).buildCustomerEmail({ storeId: STORE_ID, event: 'order_delivered', vars: { orderNumber: '1', deliveryStatus: 'delivered' } });
    expect(built.html).not.toContain('logo.png');
    expect(built.html).toContain('<span>First Store</span>');
    expect(built.html).not.toContain('color: red');
  });

  it('counts failures in a row and resets them on success', async () => {
    const updateOne = jest.fn(() => Promise.resolve({}));
    const svc = make(null, { storeNotificationSettingsModel: { findOne: () => leanQuery(null), updateOne } });
    await svc.recordDeliveryResult(STORE_ID, false);
    expect(updateOne.mock.calls[0][1].$inc).toEqual({ consecutiveEmailFailures: 1 });
    expect(updateOne.mock.calls[0][2]).toEqual({ upsert: true });
    await svc.recordDeliveryResult(STORE_ID, true);
    expect(updateOne.mock.calls[1][1]).toEqual({ $set: { consecutiveEmailFailures: 0 } });
  });

  it('every customer email event has a template that only uses its own placeholders', () => {
    // covered in customer-email-template.util.spec.ts for the whole catalog — this guards the new events exist
    const { CUSTOMER_EMAIL_EVENTS } = require('./customer-email-events');
    for (const e of ['order_edited', 'return_update', 'draft_order_invoice', 'draft_order_overdue', 'gift_card']) expect(CUSTOMER_EMAIL_EVENTS).toContain(e);
  });
});

describe('NotificationsService.sendStaffOrderEmails', () => {
  function make(staff) {
    const sendMail = jest.fn(() => Promise.resolve(true));
    const db = {
      repositories: {
        storeNotificationSettingsModel: { findOne: () => leanQuery({ staffOrderEmails: staff }) },
        storeModel: { findById: () => leanQuery({ sellerId: 'seller-1' }) },
        sellerModel: { findById: () => leanQuery({ email: 'Owner@Shop.test' }) },
      },
    };
    return { svc: new NotificationsService(db, {}, {}, { sendMail }, {}, {}), sendMail };
  }

  it('mails the extra recipients but never the store owner twice', async () => {
    const { svc, sendMail } = make(['owner@shop.test', 'packing@shop.test', 'PACKING@shop.test']);
    expect(await svc.sendStaffOrderEmails(STORE_ID, 'New order', '<p>x</p>')).toBe(1);
    expect(sendMail.mock.calls.map((c) => c[0])).toEqual(['packing@shop.test']);
  });

  it('does nothing when no extra recipients are set', async () => {
    const { svc, sendMail } = make([]);
    expect(await svc.sendStaffOrderEmails(STORE_ID, 'New order', '<p>x</p>')).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('StoreNotificationSettingsService.sendTest / preview / group', () => {
  function build(settings = null, sellerEmail = 'owner@shop.test') {
    const sendMail = jest.fn().mockResolvedValue(true);
    const db = {
      repositories: {
        storeModel: { findById: jest.fn(() => Promise.resolve({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, name: 'First Store', contactEmail: 'support@first.store', logo: 'https://cdn.test/l.png' })) },
        storeNotificationSettingsModel: { findOne: jest.fn(() => leanQuery(settings)), findOneAndUpdate: jest.fn() },
        sellerModel: { findById: jest.fn(() => leanQuery({ email: sellerEmail })) },
      },
    };
    const svc = new StoreNotificationSettingsService(db, { log: jest.fn() }, { sendMail });
    StoreNotificationSettingsService.testSentAt.clear();
    return { svc, sendMail };
  }

  it('lists every email with its group (orders / returns / invoices)', async () => {
    const { svc } = build();
    const res = await svc.get(SELLER_ID, STORE_ID);
    const byKey = Object.fromEntries(res.data.events.map((e) => [e.key, e.group]));
    expect(byKey).toMatchObject({ order_confirmation: 'orders', order_edited: 'orders', return_update: 'returns', draft_order_invoice: 'invoices', gift_card: 'invoices' });
    expect(res.data.events.every((e) => ['orders', 'returns', 'invoices'].includes(e.group))).toBe(true);
  });

  it('sends the sample (with the unsaved draft text) only to the person who clicked, with the store sender + reply-to', async () => {
    const { svc, sendMail } = build({ senderName: 'First Store Team', replyToEmail: 'help@first.store' });
    const res = await svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_shipped', subject: 'Draft {{orderNumber}}', body: 'Hello {{customerName}}' }, 'me@shop.test');
    expect(res).toMatchObject({ success: true, data: { to: 'me@shop.test' } });
    const [to, subject, html, replyTo, , , fromName] = sendMail.mock.calls[0];
    expect(to).toBe('me@shop.test');
    expect(subject).toBe('[Test] Draft 1001');
    expect(html).toContain('Hello Alex');
    expect(replyTo).toBe('help@first.store');
    expect(fromName).toBe('First Store Team');
  });

  it("falls back to the owner's email when the caller's token has none", async () => {
    const { svc, sendMail } = build();
    await svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_delivered' }, undefined);
    expect(sendMail.mock.calls[0][0]).toBe('owner@shop.test');
  });

  it('rejects an unknown email, an unknown placeholder, and a store that is not yours — without sending', async () => {
    const { svc, sendMail } = build();
    await expect(svc.sendTest(SELLER_ID, STORE_ID, { event: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_delivered', body: 'x {{carrier}}' })).rejects.toThrow(/unknown placeholder/i);
    await expect(svc.sendTest('someone-else', STORE_ID, { event: 'order_delivered' })).rejects.toBeDefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('limits test emails to one per 10 seconds, and a failed send does not lock out the retry', async () => {
    const { svc, sendMail } = build();
    sendMail.mockResolvedValueOnce(false);
    await expect(svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_delivered' }, 'me@shop.test')).rejects.toThrow(/could not be sent/i);
    await expect(svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_delivered' }, 'me@shop.test')).resolves.toMatchObject({ success: true });
    await expect(svc.sendTest(SELLER_ID, STORE_ID, { event: 'order_delivered' }, 'me@shop.test')).rejects.toThrow(/just sent/i);
  });

  it('preview returns the same render and never sends anything', async () => {
    const { svc, sendMail } = build();
    const res = await svc.preview(SELLER_ID, STORE_ID, { event: 'order_confirmation' });
    expect(res.data.subject).toBe('Your order from First Store is confirmed');
    expect(res.data.html).toContain('https://cdn.test/l.png');
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("customer emails in the buyer's language", () => {
  const store = { _id: STORE_ID, name: 'First Store', contactEmail: 'support@first.store', slug: 'first' };
  const ORDER_ID = '64b0000000000000000000aa';
  function make(settings, order) {
    const db = {
      repositories: {
        storeModel: { findById: () => leanQuery(store) },
        storeNotificationSettingsModel: { findOne: () => leanQuery(settings) },
        orderModel: { findById: () => leanQuery(order) },
      },
    };
    return new NotificationsService(db, {}, {}, { sendMail: jest.fn(() => Promise.resolve(true)) }, {}, {});
  }
  const args = { storeId: STORE_ID, event: 'order_shipped', orderId: ORDER_ID, vars: { orderNumber: '1001', customerName: '' } };

  it('uses the built-in Urdu text, an RTL shell and Urdu fallbacks when the order was placed in Urdu', async () => {
    const built = await make(null, { locale: 'ur' }).buildCustomerEmail(args);
    expect(built.subject).toContain('روانہ ہو گیا ہے');
    expect(built.subject).toContain('First Store');
    expect(built.html).toContain('dir="rtl"');
    expect(built.html).toContain('lang="ur"');
    expect(built.html).toContain('سلام صارف');
    expect(built.html).toContain('اپنا آرڈر دیکھیں');
  });

  it('keeps English (and a left-to-right shell) for an order with no language', async () => {
    const built = await make(null, { locale: null }).buildCustomerEmail(args);
    expect(built.subject).toBe('Your order #1001 from First Store has shipped');
    expect(built.html).toContain('dir="ltr"');
    expect(built.html).toContain('Hi there');
  });

  it("prefers the seller's own translation, then the seller's English text, then the built-in text", async () => {
    const settings = {
      events: { order_shipped: { subject: 'English custom {{orderNumber}}' } },
      eventTranslations: { order_shipped: { ur: { subject: 'اردو اپنی {{orderNumber}}' } } },
    };
    const built = await make(settings, { locale: 'ur' }).buildCustomerEmail(args);
    expect(built.subject).toBe('اردو اپنی 1001');
    // body: no seller translation, no seller English body -> the built-in Urdu body
    expect(built.html).toContain('خوشخبری');

    const onlyEnglish = await make({ events: { order_shipped: { subject: 'English custom {{orderNumber}}' } } }, { locale: 'ur' }).buildCustomerEmail(args);
    expect(onlyEnglish.subject).toBe('English custom 1001');
  });

  it('falls back to English for a language it has no built-in text for', async () => {
    const built = await make(null, { locale: 'fr' }).buildCustomerEmail(args);
    expect(built.subject).toBe('Your order #1001 from First Store has shipped');
  });
});
