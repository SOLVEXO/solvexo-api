/* eslint-disable prettier/prettier */
// Must be the very first thing that runs, before any other import — this
// codebase uses bare `from 'src/...'` imports everywhere (baseUrl-relative,
// not actual relative paths). TypeScript only resolves those at type-check
// time; it never rewrites them in the emitted JS, so plain Node's
// require() sees a literal package name "src" and throws MODULE_NOT_FOUND
// the moment ANY such file loads (e.g. category.schema.ts → seo-meta.schema).
// This was already broken pre-existing; tsconfig-paths was installed as a
// dependency but never actually registered for start/start:dev/start:prod,
// only for test:debug.
import 'tsconfig-paths/register';
import dns from 'dns';

// On this machine Windows advertises stale fec0::/IPv6 site-local addresses as DNS
// servers on some virtual adapters (Wi-Fi Direct, etc). The OS resolver skips them
// and falls back to a working server, but Node's resolver (c-ares) does not, causing
// ECONNREFUSED/EAI_AGAIN on the Mongo SRV lookup and Redis hostname lookup at startup.
// Pinning known-good public resolvers here bypasses that adapter-ordering issue.
dns.setServers(['8.8.8.8', '1.1.1.1']);

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SeoMonitoringService } from './seo/services/seo-monitoring.service';
import { AdminConfigService } from './admin-config/admin-config.service';


async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Global request validation — previously several controllers (Rating, Analytics,
  // AdminFinance, AdminAnalytics) each applied their own local ValidationPipe while
  // others (notably Subscriptions) applied none at all, meaning class-validator
  // decorators on those DTOs were silently never enforced. A single global pipe
  // closes that gap for every controller uniformly. whitelist strips unknown
  // properties instead of rejecting the request, so existing clients that send a
  // few extra fields keep working; forbidNonWhitelisted stays off for the same
  // backward-compatibility reason.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));

  app.use(cookieParser());

  // Crawl-hit logging (SeoMonitoringService buffers + batches the actual DB
  // write — see architecture plan Refinement #5) — attached here rather than
  // as a per-controller interceptor so it observes every route uniformly,
  // including the public SEO delivery routes bots actually hit.
  const seoMonitoringService = app.get(SeoMonitoringService);
  app.use((req: any, res: any, next: () => void) => {
    res.on('finish', () => {
      seoMonitoringService.recordHitIfBot(req.headers['user-agent'], req.path, res.statusCode, null, req.ip);
    });
    next();
  });

  // Platform-wide maintenance mode (admin-config feature) — short-circuits
  // every request with a 503 the frontend recognizes and redirects to a
  // maintenance page for, EXCEPT admin/auth/health routes so an admin can
  // still log in and turn it back off. AdminConfigService caches the flag
  // in-memory for a few seconds, so this adds no real per-request DB cost.
  const adminConfigService = app.get(AdminConfigService);
  app.use(async (req: any, res: any, next: () => void) => {
    if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth') || req.path.startsWith('/health') || req.path === '/api') {
      return next();
    }
    if (await adminConfigService.isMaintenanceMode()) {
      return res.status(503).json({
        success: false,
        maintenanceMode: true,
        message: 'Solvexo is currently undergoing scheduled maintenance. Please check back shortly.',
      });
    }
    next();
  });

  const config = new DocumentBuilder()
    .setTitle('Qchicken API')
    .setDescription('Qchicken API')
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
    'http://localhost:5174',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'https://staging.solvexo.store',
    'https://solvexo.store',
    'https://api.edudeen.com',
  ];

  // Vite auto-picks the next free port when 3000 is taken (3001, 3002, ...) —
  // rather than chase that in the whitelist, allow any localhost/127.0.0.1
  // port outside production. Also covers a store subdomain in dev
  // (`hello.localhost:3000`), since that's a real, separate origin too.
  const isLocalDevOrigin = (origin: string) =>
    process.env.NODE_ENV !== 'production' && /^https?:\/\/([a-z0-9-]+\.)?(localhost|127\.0\.0\.1):\d+$/.test(origin);

  // A seller's storefront lives on its own subdomain (`hello.solvexo.store`)
  // — every store needs this, so it's a pattern match rather than another
  // static whitelist entry per store.
  const isStoreSubdomainOrigin = (origin: string) =>
    /^https:\/\/[a-z0-9-]+\.solvexo\.store$/.test(origin);

  app.enableCors({
    origin: (origin, cb) => {

      if (!origin) return cb(null, true);
      if (whitelist.includes(origin) || isLocalDevOrigin(origin) || isStoreSubdomainOrigin(origin)) return cb(null, true);
      console.log('Blocked Origin:', origin);
      return cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true, // << required if withCredentials on client
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin','Idempotency-Key'],
    exposedHeaders: ['Content-Length','X-Request-Id'],
  });

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = process.env.PORT || 3002;
  const server = await app.listen(port, '0.0.0.0');
  server.setTimeout(300000);
  console.log(`Server running on http://localhost:${port}`);
}
bootstrap();
