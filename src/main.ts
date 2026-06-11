/* eslint-disable prettier/prettier */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';


async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  


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
  'http://127.0.0.1:3000',
    'https://api.edudeen.com',
    

    
  ];

  app.enableCors({
    origin: (origin, cb) => {
    
      if (!origin) return cb(null, true);
      if (whitelist.includes(origin)) return cb(null, true);
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

  await app.listen(3002, '0.0.0.0');
  console.log('Server running on http://localhost:3002');
}
bootstrap();
