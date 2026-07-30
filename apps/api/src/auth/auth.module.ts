import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessGuard } from './access.guard';
import { CryptoService } from '../common/crypto.service';
import { TenancyModule } from '../tenancy/tenancy.module';

@Global()
@Module({
  imports: [
    TenancyModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret') as string,
        // jsonwebtoken types the TTL as a template-literal union; ours comes from env.
        signOptions: { expiresIn: (config.get<string>('jwt.accessTtl') ?? '15m') as any },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccessGuard, CryptoService],
  exports: [AuthService, AccessGuard, CryptoService, JwtModule],
})
export class AuthModule {}
