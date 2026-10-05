/* eslint-disable prettier/prettier */
import type { NextFunction, Request, Response } from 'express';
import type { AdminConfigService } from './admin-config.service';

/** Paths that must keep working while the platform is in maintenance mode:
 *  health probes, every payment/integration webhook (Stripe & gateways retry, but a missed money event is worse than
 *  a brief maintenance), authentication, and the whole admin API (so the admin can log in and switch maintenance off). */
function isAllowedDuringMaintenance(path: string): boolean {
  return (
    path.startsWith('/health') ||
    path.startsWith('/api/auth') ||
    path.startsWith('/api/admin') ||
    /webhook/i.test(path)
  );
}

/** Platform maintenance mode (admin → Platform config → Maintenance). While ON every other request gets a 503 with
 *  `maintenance: true` — the web app's axios interceptor already turns a 503 into its /maintenance page. Never blocks on
 *  a config read error (a broken config read must not take the platform down). */
export function createMaintenanceMiddleware(adminConfig: AdminConfigService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS' || isAllowedDuringMaintenance(req.path)) return next();
    try {
      if (await adminConfig.isMaintenanceMode()) {
        res.setHeader('Retry-After', '300');
        return res.status(503).json({
          success: false,
          maintenance: true,
          statusCode: 503,
          message: 'Solvexo is undergoing scheduled maintenance. Please try again shortly.',
        });
      }
    } catch {
      // fall through
    }
    return next();
  };
}
