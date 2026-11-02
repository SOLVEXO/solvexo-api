// @ts-nocheck
/* eslint-disable */
jest.mock('../otp/services/email.service', () => ({ EmailService: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));
jest.mock('../sales-ops/sales-capture.service', () => ({ SalesCaptureService: class {} }));
jest.mock('./schemas/contact-submission.schema', () => ({ ContactSubmission: { name: 'ContactSubmission' } }));

import { ContactService } from './contact.service';

describe('ContactService.submit', () => {
  function make() {
    const created = { name: 'Jane', email: 'jane@x.com', topic: 'Order or delivery', message: 'Hello' };
    const model = { create: jest.fn().mockResolvedValue(created) };
    const email = { sendMail: jest.fn().mockResolvedValue(true) };
    const notifications = { notifyAdmins: jest.fn().mockResolvedValue(2) };
    return { svc: new ContactService(model, email, notifications), model, email, notifications };
  }

  it('saves the message, thanks the sender and alerts every admin', async () => {
    const { svc, model, email, notifications } = make();
    const res = await svc.submit({ name: ' Jane ', email: ' JANE@x.com ', topic: 'Order or delivery', message: ' Hello ' });
    expect(res.success).toBe(true);
    expect(model.create).toHaveBeenCalledWith({ name: 'Jane', email: 'jane@x.com', topic: 'Order or delivery', message: 'Hello' });
    expect(email.sendMail.mock.calls[0][0]).toBe('jane@x.com');
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: 'admin_contact_message', data: { link: '/admin/content' } }));
  });

  it('still answers the visitor when alerting the admins fails', async () => {
    const { svc, notifications } = make();
    notifications.notifyAdmins.mockRejectedValue(new Error('queue down'));
    await expect(svc.submit({ name: 'Jane', email: 'jane@x.com', topic: 't', message: 'm' })).resolves.toMatchObject({ success: true });
  });

  it('sends sales conversations (Selling on Solvexo, General question) to Sales Ops, and nothing else', async () => {
    const { model, email, notifications } = make();
    const sales = { fromContactMessage: jest.fn().mockResolvedValue({ leadId: 'l1', created: true }) };
    const svc = new ContactService(model, email, notifications, sales);
    for (const topic of ['Selling on Solvexo', 'General question', 'Order or delivery', 'Billing & payments', 'Report a problem']) {
      model.create.mockResolvedValueOnce({ name: 'Jane', email: 'jane@x.com', topic, message: 'Hi' });
      await svc.submit({ name: 'Jane', email: 'jane@x.com', topic, message: 'Hi' });
    }
    expect(sales.fromContactMessage.mock.calls.map((c) => c[0].topic)).toEqual(['Selling on Solvexo', 'General question']);
  });
});
