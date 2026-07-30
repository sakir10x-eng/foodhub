import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InvoiceDto, Plan, PLAN_PRICING } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { PlanService } from '../tenancy/plan.service';

/**
 * Mode A revenue: a fixed monthly fee per vendor, enforced by suspending the storefront.
 *
 * This is deliberately NOT per-order. On a vendor's own store the money goes customer ->
 * vendor directly and we never see it, so an order-based commission would rely on the
 * vendor self-reporting their turnover. The only lever that actually works is switching
 * the storefront off, which is what the dunning cycle below does.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly resolver: TenantResolverService,
    private readonly plans: PlanService,
  ) {}

  /** Daily: raise invoices that fall due, then run the dunning cycle. */
  @Cron(process.env.BILLING_CRON || '0 2 * * *')
  async runScheduled() {
    await this.issueDueInvoices();
    await this.runDunning();
  }

  async issueDueInvoices() {
    const now = new Date();
    const due = await TenantContext.runAsPlatform('billing run spans all vendors', () =>
      this.prisma.db.subscription.findMany({
        where: { status: 'ACTIVE', nextBillingAt: { lte: now }, amount: { gt: 0 } },
        select: { id: true, tenantId: true, plan: true, amount: true, nextBillingAt: true, graceDays: true },
      }),
    );

    for (const sub of due) {
      try {
        await TenantContext.runAsTenant(sub.tenantId, async () => {
          const periodStart = sub.nextBillingAt;
          const periodEnd = addMonths(periodStart, 1);
          const dueAt = addDays(periodStart, sub.graceDays);

          const invoice = await this.prisma.db.invoice.create({
            data: {
              tenantId: sub.tenantId,
              number: 'PENDING',
              amount: sub.amount,
              periodStart,
              periodEnd,
              dueAt,
              status: 'UNPAID',
            },
          });
          await this.prisma.db.invoice.update({
            where: { id: invoice.id },
            data: { number: invoiceNumber(invoice.seq, periodStart) },
          });
          await this.prisma.db.subscription.update({
            where: { id: sub.id },
            data: { currentPeriodStart: periodStart, nextBillingAt: periodEnd },
          });
        });
        this.logger.log(`Invoice raised for tenant ${sub.tenantId} (${sub.plan})`);
      } catch (err) {
        this.logger.error(`Invoicing failed for ${sub.tenantId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Overdue -> PAST_DUE (warning, store still live) -> SUSPENDED (store dark).
   * The admin panel stays reachable while suspended so the vendor can pay and come back.
   */
  async runDunning() {
    const now = new Date();
    const overdue = await TenantContext.runAsPlatform('dunning spans all vendors', () =>
      this.prisma.db.invoice.findMany({
        where: { status: { in: ['UNPAID', 'OVERDUE'] }, dueAt: { lt: now } },
        select: { id: true, tenantId: true, dueAt: true, status: true },
      }),
    );

    for (const invoice of overdue) {
      const daysLate = Math.floor((now.getTime() - invoice.dueAt.getTime()) / 86_400_000);
      await TenantContext.runAsTenant(invoice.tenantId, async () => {
        if (invoice.status !== 'OVERDUE') {
          await this.prisma.db.invoice.update({ where: { id: invoice.id }, data: { status: 'OVERDUE' } });
        }
        const nextStatus = daysLate >= 14 ? 'SUSPENDED' : 'PAST_DUE';
        await this.prisma.db.tenant.update({
          where: { id: invoice.tenantId },
          data: { planStatus: nextStatus },
        });
      });
      await this.resolver.invalidate(invoice.tenantId);
      this.logger.warn(`Tenant ${invoice.tenantId} is ${daysLate} days late on invoice ${invoice.id}`);
    }
  }

  async listInvoices(tenantId: string): Promise<InvoiceDto[]> {
    const rows = await this.prisma.db.invoice.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((i) => ({
      id: i.id,
      number: i.number,
      amount: i.amount,
      status: i.status,
      dueAt: i.dueAt.toISOString(),
      paidAt: i.paidAt?.toISOString() ?? null,
      periodLabel: `${i.periodStart.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`,
    }));
  }

  async getSubscription(tenantId: string) {
    const sub = await this.prisma.db.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription found');
    const tenant = await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, planStatus: true },
    });
    return { ...sub, planStatus: tenant?.planStatus, catalogue: PLAN_PRICING };
  }

  /**
   * Plan change. Upgrades take effect immediately and bill on the next cycle;
   * downgrades are blocked while the vendor is using a paid-plan feature.
   */
  async changePlan(tenantId: string, plan: Plan) {
    const pricing = PLAN_PRICING[plan];
    if (!pricing) throw new BadRequestException('Unknown plan');

    if (plan === 'FREE') {
      const customDomains = await this.prisma.db.domain.count({ where: { tenantId } });
      if (customDomains > 0) {
        throw new BadRequestException('Remove your custom domain before moving to the Free plan');
      }
    }

    await this.prisma.db.$transaction([
      this.prisma.db.tenant.update({ where: { id: tenantId }, data: { plan } }),
      this.prisma.db.subscription.update({
        where: { tenantId },
        data: { plan, amount: pricing.monthly },
      }),
    ]);

    // Downgrading has to switch off what the new plan no longer includes — otherwise a
    // vendor buys one month of Pro, turns everything on, drops to Free and keeps it.
    const disabled = await this.plans.reconcileAfterPlanChange(tenantId, plan);

    await this.resolver.invalidate(tenantId);
    return { plan, amount: pricing.monthly, disabled };
  }

  /** Records payment of a SaaS invoice and lifts any suspension. */
  async payInvoice(tenantId: string, invoiceId: string, paymentRef: string) {
    const invoice = await this.prisma.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'PAID') return { ok: true, alreadyPaid: true };

    await this.prisma.db.invoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt: new Date(), paymentRef },
    });

    const stillOwing = await this.prisma.db.invoice.count({
      where: { tenantId, status: { in: ['UNPAID', 'OVERDUE'] } },
    });
    if (stillOwing === 0) {
      await this.prisma.db.tenant.update({ where: { id: tenantId }, data: { planStatus: 'ACTIVE' } });
      await this.resolver.invalidate(tenantId);
    }
    return { ok: true, reactivated: stillOwing === 0 };
  }
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function invoiceNumber(seq: number, period: Date): string {
  const y = period.getFullYear().toString().slice(-2);
  const m = String(period.getMonth() + 1).padStart(2, '0');
  return `INV-${y}${m}-${String(1000 + seq)}`;
}
