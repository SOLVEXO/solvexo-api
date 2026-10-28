/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getHeapStatistics } from 'v8';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';

const SAMPLE_EVERY_MS = 60_000;
const LOG_EVERY_SAMPLES = 10; // one memory line in the logs every 10 minutes
const WARN_RATIO = 0.75;
const ALERT_RATIO = 0.8;
const ALERT_EVERY_MS = 2 * 60 * 60 * 1000;

const mb = (n: number) => Math.round(n / 1024 / 1024);

/**
 * Memory watchdog. A Node process that creeps up to its heap limit dies with "JavaScript heap out of memory" and every
 * request in flight returns 502. This writes one line to the logs every 10 minutes (so a slow leak shows up as a trend
 * you can read in Railway), warns past 75 % of the heap limit, and tells the admins (in-app + email) past 80 % — at most
 * once every 2 hours — so the process can be restarted or investigated BEFORE it crashes.
 */
@Injectable()
export class MemoryMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private samples = 0;
  private lastAlertAt = 0;

  constructor(private readonly notifications: NotificationsService) {}

  onModuleInit() {
    if (process.env.MEMORY_MONITOR === 'off') return;
    this.timer = setInterval(() => this.sample(), SAMPLE_EVERY_MS);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for tests. */
  sample(now: number = Date.now(), heap: { used_heap_size: number; heap_size_limit: number } = getHeapStatistics()) {
    const mem = process.memoryUsage();
    const ratio = heap.used_heap_size / heap.heap_size_limit;
    this.samples += 1;

    const line = `heapUsed=${mb(heap.used_heap_size)}MB limit=${mb(heap.heap_size_limit)}MB (${Math.round(ratio * 100)}%) rss=${mb(mem.rss)}MB external=${mb(mem.external)}MB arrayBuffers=${mb(mem.arrayBuffers)}MB uptime=${Math.round(process.uptime() / 60)}min`;
    if (ratio >= WARN_RATIO) this.logger.warn(`High memory: ${line}`);
    // Production only prints error/warn through Nest's logger (see main.ts), so the periodic line goes to stdout directly:
    // it is the memory trend the Railway logs need to show (one line every 10 minutes).
    else if (this.samples % LOG_EVERY_SAMPLES === 1) console.log(`[MemoryMonitor] ${line}`);

    if (ratio >= ALERT_RATIO && now - this.lastAlertAt > ALERT_EVERY_MS) {
      this.lastAlertAt = now;
      this.notifications
        .notifyAdmins({
          type: NOTIFICATION_TYPES.ADMIN_MEMORY_PRESSURE,
          title: 'Server memory is almost full',
          body: `The API server is using ${Math.round(ratio * 100)}% of its memory limit (${mb(heap.used_heap_size)} MB of ${mb(heap.heap_size_limit)} MB). It will crash and restart soon unless it is restarted or the cause is found. Check the "High memory" lines in the deploy logs.`,
          data: { link: '/admin/settings?tab=email' },
        })
        .catch(() => undefined);
    }
    return { ratio, line };
  }
}
