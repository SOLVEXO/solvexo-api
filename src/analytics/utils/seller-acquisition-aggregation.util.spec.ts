/* eslint-disable prettier/prettier */
import { aggregateSellerAcquisition, UNATTRIBUTED_LABEL } from './seller-acquisition-aggregation.util';

describe('aggregateSellerAcquisition — Phase 9 merchant acquisition breakdown', () => {
  it('groups sellers by the exact source/medium/campaign combination', () => {
    const rows = aggregateSellerAcquisition([
      { acquisitionSource: 'google', acquisitionMedium: 'cpc', acquisitionCampaign: 'spring_launch' },
      { acquisitionSource: 'google', acquisitionMedium: 'cpc', acquisitionCampaign: 'spring_launch' },
      { acquisitionSource: 'google', acquisitionMedium: 'cpc', acquisitionCampaign: 'summer_sale' },
    ]);

    expect(rows).toHaveLength(2);
    const spring = rows.find((r) => r.campaign === 'spring_launch')!;
    expect(spring.sellerCount).toBe(2);
    expect(spring.source).toBe('google');
    expect(spring.medium).toBe('cpc');
  });

  it('buckets a seller with no acquisitionSource at all as Organic / Direct — never a guess', () => {
    const rows = aggregateSellerAcquisition([
      { acquisitionSource: null, acquisitionMedium: null, acquisitionCampaign: null },
      {},
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe(UNATTRIBUTED_LABEL);
    expect(rows[0].sellerCount).toBe(2);
  });

  it('treats a blank/whitespace-only acquisitionSource the same as missing', () => {
    const rows = aggregateSellerAcquisition([{ acquisitionSource: '   ' }]);
    expect(rows[0].source).toBe(UNATTRIBUTED_LABEL);
  });

  it('sorts rows by sellerCount descending', () => {
    const rows = aggregateSellerAcquisition([
      { acquisitionSource: 'facebook' },
      { acquisitionSource: 'google' },
      { acquisitionSource: 'google' },
      { acquisitionSource: 'google' },
    ]);
    expect(rows[0].source).toBe('google');
    expect(rows[0].sellerCount).toBe(3);
    expect(rows[1].source).toBe('facebook');
  });

  it('returns an empty array for an empty input — never fabricates a row', () => {
    expect(aggregateSellerAcquisition([])).toEqual([]);
  });

  it('keeps distinct campaigns under the same source/medium as separate rows', () => {
    const rows = aggregateSellerAcquisition([
      { acquisitionSource: 'newsletter', acquisitionMedium: 'email', acquisitionCampaign: 'q1' },
      { acquisitionSource: 'newsletter', acquisitionMedium: 'email', acquisitionCampaign: 'q2' },
    ]);
    expect(rows).toHaveLength(2);
  });
});
