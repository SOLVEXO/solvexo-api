import mongoose from 'mongoose';
import { CheckoutSchema } from './checkout.schema';
import { OrderSchema } from '../orders/schemas/order.schema';

describe('local delivery flags on checkout + order', () => {
  it('default to off / no window and keep the promised window text', () => {
    const C = mongoose.model('CheckoutLD', CheckoutSchema);
    const O = mongoose.model('OrderLD', OrderSchema);
    const c: any = new C({});
    expect(c.localDelivery).toBe(false);
    expect(c.localDeliveryEta).toBeNull();
    const o: any = new O({ localDelivery: true, localDeliveryEta: 'Same day, 2-4 pm' });
    expect(o.localDelivery).toBe(true);
    expect(o.localDeliveryEta).toBe('Same day, 2-4 pm');
    expect(new O({}).get('localDelivery')).toBe(false);
  });
  it('refuses a window longer than 120 characters', () => {
    const O = mongoose.model('OrderLD2', OrderSchema);
    const err = new O({ localDeliveryEta: 'x'.repeat(121) }).validateSync();
    expect(err?.errors?.localDeliveryEta).toBeDefined();
  });
});
