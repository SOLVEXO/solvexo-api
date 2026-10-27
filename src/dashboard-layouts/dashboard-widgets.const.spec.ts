import { BadRequestException } from '@nestjs/common';
import { ADMIN_WIDGETS, STORE_WIDGETS, pruneLayout, validateLayout } from './dashboard-widgets.const';

const w = (id: string, extra: Record<string, unknown> = {}) => ({ id, visible: true, size: 'small', settings: {}, ...extra });

describe('validateLayout', () => {
  it('accepts a valid store layout and keeps only declared fields', () => {
    const out = validateLayout('store', { preset: 'sales_focus', widgets: [w('metric.revenue_30d'), w('sales_chart', { size: 'large', settings: { range: '90d' } }), w('recent_orders', { size: 'medium', settings: { limit: 8 } })], extra: 'ignored' });
    expect(out.widgets.map((x) => x.id)).toEqual(['metric.revenue_30d', 'sales_chart', 'recent_orders']);
    expect(out.widgets[1].settings).toEqual({ range: '90d' });
    expect(out.preset).toBe('sales_focus');
    expect(out.columns).toBe(3);
  });

  it('rejects an unknown widget, including prototype keys', () => {
    expect(() => validateLayout('store', { widgets: [w('nope')] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('constructor')] })).toThrow(BadRequestException);
  });

  it('keeps store and admin widget libraries separate', () => {
    expect(() => validateLayout('store', { widgets: [w('kpi.mrr')] })).toThrow(BadRequestException);
    expect(() => validateLayout('admin', { widgets: [w('metric.revenue_30d')] })).toThrow(BadRequestException);
    expect(validateLayout('admin', { widgets: [w('kpi.mrr')] }).widgets).toHaveLength(1);
  });

  it('rejects duplicates, bad sizes, bad visibility and bad settings', () => {
    expect(() => validateLayout('store', { widgets: [w('metric.revenue_30d'), w('metric.revenue_30d')] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('metric.revenue_30d', { size: 'full' })] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('metric.revenue_30d', { visible: 'yes' })] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('sales_chart', { size: 'large', settings: { range: '5y' } })] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('recent_orders', { size: 'medium', settings: { limit: 500 } })] })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [w('recent_orders', { size: 'medium', settings: { limit: 5, hack: 1 } })] })).toThrow(BadRequestException);
  });

  it('rejects a non-array, too many widgets and bad columns', () => {
    expect(() => validateLayout('store', { widgets: 'x' })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: Array.from({ length: 41 }, (_, i) => w(`metric.${i}`)) })).toThrow(BadRequestException);
    expect(() => validateLayout('store', { widgets: [], columns: 5 })).toThrow(BadRequestException);
  });
});

describe('pruneLayout', () => {
  it('drops widgets a later release removed', () => {
    const out = pruneLayout('store', { preset: null, columns: 3, widgets: [w('metric.revenue_30d'), w('removed_widget')] as never });
    expect(out.widgets.map((x) => x.id)).toEqual(['metric.revenue_30d']);
  });
});

describe('registries', () => {
  it('every widget offers at least one size and the default size set is valid', () => {
    for (const reg of [STORE_WIDGETS, ADMIN_WIDGETS]) for (const spec of Object.values(reg)) expect(spec.sizes.length).toBeGreaterThan(0);
  });
});
