import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone, loginSchema, password, refreshSchema, registerVendorSchema } from '@foodhub/shared';
import { AuthService } from './auth.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentUser, Public, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';

const registerCustomerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: bdPhone,
  password,
});

const staffSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password,
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register/vendor')
  registerVendor(@Body(new ZodBody(registerVendorSchema)) dto: any) {
    return this.auth.registerVendor(dto);
  }

  @Public()
  @Post('register/customer')
  registerCustomer(@Body(new ZodBody(registerCustomerSchema)) dto: any) {
    return this.auth.registerCustomer(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodBody(loginSchema)) dto: any) {
    return this.auth.login(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodBody(refreshSchema)) dto: { refreshToken: string }) {
    return this.auth.refresh(dto.refreshToken);
  }

  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() user: AuthedUser, @Body() body: { refreshToken?: string }) {
    await this.auth.logout(body?.refreshToken, user.id);
  }

  @Get('me')
  me(@CurrentUser() user: AuthedUser) {
    return user;
  }

  @Roles('VENDOR_OWNER')
  @Post('staff')
  createStaff(@CurrentUser() user: AuthedUser, @Body(new ZodBody(staffSchema)) dto: any) {
    return this.auth.createStaff(user.tenantId as string, dto);
  }
}
