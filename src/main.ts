/* eslint-disable prettier/prettier */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';


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

  // Vite auto-picks the next free port when 3000 is taken (3001, 3002, ...) — rather than
  // chase that in the whitelist, allow any localhost/127.0.0.1 port outside production.
  const isLocalDevOrigin = (origin: string) =>
    process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

  app.enableCors({
    origin: (origin, cb) => {

      if (!origin) return cb(null, true);
      if (whitelist.includes(origin) || isLocalDevOrigin(origin)) return cb(null, true);
      console.log('Blocked Origin:', origin);
      return cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true, // << required if withCredentials on client
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin'],
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
