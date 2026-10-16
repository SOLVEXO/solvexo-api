import { Module } from '@nestjs/common';
import { I18nModule, AcceptLanguageResolver, QueryResolver, HeaderResolver } from 'nestjs-i18n';
import * as path from 'path';

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: path.join(__dirname, '/locales/'),
        watch: process.env.NODE_ENV !== 'production',
      },
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        new HeaderResolver(['accept-language']),
        AcceptLanguageResolver,
      ],
    }),
  ],
  exports: [I18nModule],
})
export class AppI18nModule {}
