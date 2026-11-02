/* eslint-disable prettier/prettier */
import {
  autoStage,
  bodyToHtml,
  fillTemplate,
  leadScope,
  phoneKey,
  salesActor,
  stageTotals,
} from './sales-ops.util';

describe('sales-ops.util', () => {
  it('lets owners, Super Admins and sales managers see every lead, and reps only their own', () => {
    expect(salesActor({ userId: 'a1' })).toEqual({
      adminId: 'a1',
      canSeeAll: true,
    });
    expect(
      salesActor({
        userId: 'a2',
        teamAdmin: true,
        permissions: ['sales.access', 'sales.manage'],
      }).canSeeAll,
    ).toBe(true);
    const rep = salesActor({
      userId: 'a3',
      teamAdmin: true,
      permissions: ['sales.access'],
    });
    expect(rep.canSeeAll).toBe(false);
    expect(leadScope(rep)).toEqual({ ownerAdminId: 'a3' });
  });

  it('matches phone numbers written in different ways', () => {
    expect(phoneKey('+92 300 1234567')).toBe('3001234567');
    expect(phoneKey('0300-1234567')).toBe('3001234567');
    expect(phoneKey('12')).toBeNull();
  });

  it('only moves a lead forward on its own', () => {
    expect(autoStage('contacted', 'trial')).toBe('trial');
    expect(autoStage('lost', 'trial')).toBe('trial');
    expect(autoStage('trial', 'trial')).toBeNull();
    expect(autoStage('demo', 'paying')).toBe('won');
    expect(autoStage('won', 'paying')).toBeNull();
    expect(autoStage('new', 'signed_up')).toBeNull();
    expect(autoStage('won', 'not_paying')).toBeNull();
  });

  it('fills template fields, keeps unknown ones, and escapes the email body', () => {
    expect(
      fillTemplate('Hi {{name}}, {{ businessName }} {{oops}}', {
        name: 'Sara',
        businessName: 'Noor Crafts',
      }),
    ).toBe('Hi Sara, Noor Crafts {{oops}}');
    expect(bodyToHtml('Hello <b>\nthere\n\nBye')).toBe(
      '<p style="margin:0 0 12px;">Hello &lt;b&gt;<br>there</p><p style="margin:0 0 12px;">Bye</p>',
    );
  });

  it('totals leads per stage in pipeline order', () => {
    expect(
      stageTotals(
        [
          { stage: 'demo', dealValuePKR: 5000 },
          { stage: 'demo', dealValuePKR: null },
          { stage: 'new' },
        ],
        ['new', 'demo', 'won'],
      ),
    ).toEqual([
      { stage: 'new', count: 1, valuePKR: 0 },
      { stage: 'demo', count: 2, valuePKR: 5000 },
      { stage: 'won', count: 0, valuePKR: 0 },
    ]);
  });
});
