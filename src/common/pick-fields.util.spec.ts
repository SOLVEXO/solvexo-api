import { pickFields } from './pick-fields.util';

describe('pickFields — the body is never spread into a Mongo write', () => {
  const ALLOWED = ['enabled', 'subject'] as const;

  it('REGRESSION: keys outside the allow-list (storeId, status, totals…) are dropped', () => {
    const hostile: any = { enabled: true, subject: 'Hi', storeId: 'another-store', status: 'sent', sentCount: 999, isDelete: true };
    expect(pickFields(hostile, ALLOWED)).toEqual({ enabled: true, subject: 'Hi' });
  });

  it('keeps explicit false / empty / null values, drops only undefined', () => {
    expect(pickFields({ enabled: false, subject: '' }, ALLOWED)).toEqual({ enabled: false, subject: '' });
    expect(pickFields({ enabled: undefined, subject: null } as any, ALLOWED)).toEqual({ subject: null });
  });

  it('a missing body gives nothing', () => {
    expect(pickFields(undefined, ALLOWED)).toEqual({});
    expect(pickFields(null, ALLOWED)).toEqual({});
  });

  it('inherited keys are ignored', () => {
    const body = Object.create({ enabled: true });
    expect(pickFields(body, ALLOWED)).toEqual({});
  });
});
