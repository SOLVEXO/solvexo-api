/* eslint-disable prettier/prettier */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CustomDomainsService } from './store/custom-domains.service';
import { AdminConfigService } from './admin-config/admin-config.service';
import { createMaintenanceMiddleware } from './admin-config/maintenance.middleware';
import { StorefrontAccessService, createStorefrontAccessMiddleware } from './store/storefront-access.service';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  // rawBody: true is required for every webhook route that verifies a
  // provider signature over the exact raw bytes (Stripe checkout, Stripe
  // subscriptions, and the new integrations-module gateway webhooks) — each
  // reads `req.rawBody`, which Nest only populates when this flag is set.
  // Without it those routes always throw "Raw request body unavailable".
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Express's default JSON limit is 100 KB — too small for an email campaign
  // (editor design JSON + its rendered HTML) or a subscriber CSV chunk.
  // useBodyParser keeps the rawBody capture above working.
  app.useBodyParser('json', { limit: '1mb' });

  // Behind Railway/Vercel/any reverse proxy: trust the first hop so req.ip (throttler, login limits, logs)
  // is the real client IP instead of the proxy's.
  app.set('trust proxy', 1);

  // Security headers (nosniff, frameguard, HSTS, no X-Powered-By…). CSP is off: this is a JSON API and Swagger's UI
  // needs inline scripts. CORP is cross-origin because the web app (another origin) loads files/images from the API.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.use(cookieParser());

  // Platform maintenance mode (admin switch) — 503 for everything except health, webhooks, auth and the admin API.
  app.use(createMaintenanceMiddleware(app.get(AdminConfigService)));

  // Shopify password page, enforced server-side for buyer-facing storefront routes.
  app.use(createStorefrontAccessMiddleware(app.get(StorefrontAccessService)));

  // Global validation: every `@Body()/@Query()/@Param()` typed with a
  // class-validator DTO is now actually checked (previously only the ~36
  // controllers that opted in with @UsePipes were — e.g. the cart's `@Min`
  // quantity rule never ran). Deliberately `transform: false` and no
  // `whitelist`: it only REJECTS invalid input and never rewrites or strips
  // the payload, so handlers keep receiving the exact plain objects they
  // always did (class instances would carry `undefined` props under
  // ES2023 class fields). Controller-level pipes with their own options
  // still run on top of this. Untyped (`any`) bodies are not covered — those
  // handlers must whitelist fields themselves.
  app.useGlobalPipes(new ValidationPipe({ transform: false }));

  const config = new DocumentBuilder()
    .setTitle('Solvexo API')
    .setDescription('Solvexo Marketplace API')
    .addBearerAuth(
      {
        in: 'Header',
        scheme: 'Bearer',
        name: 'Authorization',
        type: 'http',
        bearerFormat: 'JWT',
      },
      'accessToken',
    )
    .build();

  const whitelist = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'https://solvexo.store',
    'https://www.solvexo.store',
    'https://solvexo-web.vercel.app',
    'https://api.edudeen.com',
  ];

  // Every seller store is served from its OWN subdomain
  // (`<slug>.solvexo.store`) or, in dev, `<slug>.localhost:<port>` — there's
  // no way to enumerate those individually in a static whitelist, so any
  // origin under either base domain is allowed regardless of subdomain.
  // (A seller's own connected Custom Domain is a separate, still-open gap —
  // an arbitrary domain can't be pattern-matched here; it would need an
  // async DB lookup against verified custom domains, not implemented yet.)
  const isAllowedOrigin = (origin: string): boolean => {
    if (whitelist.includes(origin)) return true;
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    return (
      hostname === 'solvexo.store' ||
      hostname.endsWith('.solvexo.store') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost')
    );
  };

  const customDomains = app.get(CustomDomainsService);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      // A store's VERIFIED custom domain is a legitimate storefront origin (cached lookup, refreshed every minute).
      customDomains.isVerifiedOrigin(origin).then((ok) => {
        if (ok) return cb(null, true);
        console.log('Blocked Origin:', origin);
        return cb(new Error('Not allowed by CORS'), false);
      }).catch(() => cb(new Error('Not allowed by CORS'), false));
    },
    credentials: true,
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    // `Idempotency-Key` must be listed: the web app sends it on every charge-bearing
    // mutation (plan change, add-ons, manual payment, stock counts, purchase orders…).
    // Without it the browser's CORS preflight is rejected and the call surfaces only as
    // a generic "Network Error" — no request ever reaches the API.
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin','Idempotency-Key'],
    exposedHeaders: ['Content-Length','X-Request-Id'],
  });

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // Railway injects PORT env var — use it, fall back to 3002 for local dev
  const port = process.env.PORT || 3002;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://localhost:${port}`);
}
bootstrap();
