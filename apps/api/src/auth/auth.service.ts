import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import {
  AuthResponse,
  DEFAULT_ZONES,
  LoginInput,
  PLAN_PRICING,
  RegisterVendorInput,
  Role,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { TenantContext } from '../common/tenant-context';

const BCRYPT_ROUNDS = 10;
/** Reserved so a vendor can never take a slug that shadows a platform route. */
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'edge', 'cdn', 'static', 'media', 'mail', 'blog',
  'help', 'support', 'status', 'dashboard', 'marketplace', 'order', 'orders',
  'checkout', 'account', 'login', 'register', 'search', 'foodhub',
]);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Vendor self-service signup: creates the tenant, its owner and a FREE subscription
   * atomically. This is the front door of Mode A — everything else in the platform
   * assumes a tenant exists.
   */
  async registerVendor(input: RegisterVendorInput): Promise<AuthResponse> {
    if (RESERVED_SLUGS.has(input.slug)) {
      throw new ConflictException(`"${input.slug}" is reserved — pick another store address`);
    }

    return TenantContext.runAsPlatform('vendor self-registration creates a new tenant', async () => {
      const [slugTaken, emailTaken] = await Promise.all([
        this.prisma.db.tenant.findUnique({ where: { slug: input.slug }, select: { id: true } }),
        this.prisma.db.user.findUnique({ where: { email: input.email }, select: { id: true } }),
      ]);
      if (slugTaken) throw new ConflictException(`Store address "${input.slug}" is already taken`);
      if (emailTaken) throw new ConflictException('An account with this email already exists');

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const nextBillingAt = new Date();
      nextBillingAt.setMonth(nextBillingAt.getMonth() + 1);

      const { user } = await this.prisma.db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.businessName,
            phone: input.phone,
            deliveryZones: DEFAULT_ZONES as any,
            commissionRateBps: this.config.get<number>('marketplace.defaultCommissionBps') ?? 1500,
            // Mode B stays off until the vendor opts in — Mode A ships first, by design.
            listedOnMarketplace: false,
          },
        });

        const created = await tx.user.create({
          data: {
            tenantId: tenant.id,
            role: 'VENDOR_OWNER',
            name: input.ownerName,
            email: input.email,
            phone: input.phone,
            passwordHash,
          },
        });

        await tx.subscription.create({
          data: {
            tenantId: tenant.id,
            plan: 'FREE',
            amount: PLAN_PRICING.FREE.monthly,
            nextBillingAt,
            graceDays: this.config.get<number>('billing.graceDays') ?? 7,
          },
        });

        await tx.category.create({
          data: { tenantId: tenant.id, name: 'Popular', sortOrder: 0 },
        });

        return { tenant, user: created };
      });

      this.logger.log(`New vendor registered: ${input.slug}`);
      return this.issueSession(user);
    });
  }

  /** Marketplace customer signup. Customers are platform-level (tenantId = null). */
  async registerCustomer(input: {
    name: string;
    email: string;
    phone: string;
    password: string;
  }): Promise<AuthResponse> {
    return TenantContext.runAsPlatform('customer registration is platform-level', async () => {
      const existing = await this.prisma.db.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existing) throw new ConflictException('An account with this email already exists');

      const user = await this.prisma.db.user.create({
        data: {
          role: 'CUSTOMER',
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        },
      });
      return this.issueSession(user);
    });
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    return TenantContext.runAsPlatform('login looks up a user before any tenant is known', async () => {
      const user = await this.prisma.db.user.findUnique({ where: { email: input.email } });

      // Always run a hash comparison so a missing account and a wrong password take the
      // same time — otherwise the response time enumerates registered emails.
      const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
      const ok = await bcrypt.compare(input.password, hash);

      if (!user || !ok) throw new UnauthorizedException('Email or password is incorrect');
      if (!user.isActive) throw new UnauthorizedException('This account has been disabled');

      await this.prisma.db.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      return this.issueSession(user);
    });
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    return TenantContext.runAsPlatform('refresh token exchange', async () => {
      const tokenHash = this.crypto.hashToken(refreshToken);
      const stored = await this.prisma.db.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        throw new UnauthorizedException('Session expired — sign in again');
      }
      if (!stored.user.isActive) throw new UnauthorizedException('This account has been disabled');

      // Rotate: the presented token dies the moment it is redeemed, so a stolen refresh
      // token is usable at most once and the theft shows up as a failed refresh.
      await this.prisma.db.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      return this.issueSession(stored.user);
    });
  }

  async logout(refreshToken: string | undefined, userId: string): Promise<void> {
    await TenantContext.runAsPlatform('logout revokes refresh tokens', async () => {
      if (refreshToken) {
        await this.prisma.db.refreshToken.updateMany({
          where: { tokenHash: this.crypto.hashToken(refreshToken), userId },
          data: { revokedAt: new Date() },
        });
      } else {
        await this.prisma.db.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });
  }

  /** Owner invites a staff member into their own tenant. Never crosses tenants. */
  async createStaff(tenantId: string, input: { name: string; email: string; password: string }) {
    const existing = await TenantContext.runAsPlatform('staff email uniqueness is global', () =>
      this.prisma.db.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    );
    if (existing) throw new ConflictException('An account with this email already exists');
    if (input.password.length < 8) throw new BadRequestException('Password must be at least 8 characters');

    return this.prisma.db.user.create({
      data: {
        tenantId,
        role: 'VENDOR_STAFF',
        name: input.name,
        email: input.email,
        passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
  }

  private async issueSession(user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    tenantId: string | null;
  }): Promise<AuthResponse> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    });

    const { token, hash } = this.crypto.issueToken();
    const days = this.config.get<number>('jwt.refreshTtlDays') ?? 30;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await this.prisma.db.refreshToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt },
    });

    let tenantSlug: string | null = null;
    if (user.tenantId) {
      const tenant = await TenantContext.runAsPlatform('read own tenant slug for the session', () =>
        this.prisma.db.tenant.findUnique({
          where: { id: user.tenantId as string },
          select: { slug: true },
        }),
      );
      tenantSlug = tenant?.slug ?? null;
    }

    return {
      accessToken,
      refreshToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantSlug,
      },
    };
  }
}
