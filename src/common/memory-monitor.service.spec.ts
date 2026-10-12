// @ts-nocheck
/* eslint-disable */
jest.mock('@/notifications/notifications.service', () => ({ NotificationsService: class {} }));
import { MemoryMonitorService } from './memory-monitor.service';

describe('MemoryMonitorService', () => {
  const MB = 1024 * 1024;
  const heap = (usedMb, limitMb = 1000) => ({ used_heap_size: usedMb * MB, heap_size_limit: limitMb * MB });

  it('stays quiet below 80% of the heap limit', () => {
    const n = { notifyAdmins: jest.fn().mockResolvedValue(2) };
    const svc = new MemoryMonitorService(n);
    expect(svc.sample(undefined, heap(500)).ratio).toBeCloseTo(0.5);
    expect(n.notifyAdmins).not.toHaveBeenCalled();
  });

  it('alerts the admins once past 80%, then not again for 2 hours', () => {
    const n = { notifyAdmins: jest.fn().mockResolvedValue(2) };
    const svc = new MemoryMonitorService(n);
    const t0 = 1_000_000_000_000;
    svc.sample(t0, heap(850));
    svc.sample(t0 + 60_000, heap(850));
    expect(n.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(n.notifyAdmins.mock.calls[0][0]).toMatchObject({ type: 'admin_memory_pressure', title: 'Server memory is almost full' });
    svc.sample(t0 + 2 * 60 * 60 * 1000 + 1, heap(850));
    expect(n.notifyAdmins).toHaveBeenCalledTimes(2);
  });

  it('never throws if alerting fails', () => {
    const n = { notifyAdmins: jest.fn().mockRejectedValue(new Error('down')) };
    expect(() => new MemoryMonitorService(n).sample(undefined, heap(900))).not.toThrow();
  });

  it('does nothing when switched off', () => {
    process.env.MEMORY_MONITOR = 'off';
    const svc = new MemoryMonitorService({ notifyAdmins: jest.fn() });
    svc.onModuleInit();
    expect(svc['timer']).toBeNull();
    delete process.env.MEMORY_MONITOR;
  });
});
