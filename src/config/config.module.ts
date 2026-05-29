import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import configuration, { type AppConfig } from './configuration';
import { validateEnv } from './env.validation';
import { APP_CONFIG } from './app-config.token';

// Re-export so existing imports from this module keep working.
export { APP_CONFIG };

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [configuration],
      // .env.local takes precedence in dev; production injects real env vars.
      envFilePath: ['.env.local', '.env'],
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (cs: ConfigService) => cs.getOrThrow<AppConfig>('app'),
      inject: [ConfigService],
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
