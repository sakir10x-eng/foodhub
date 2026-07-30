import { Body, Controller, Get, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AssistantService } from './assistant.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';
import { RateLimit } from '../infra/rate-limit.guard';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { OrdersModule } from '../orders/orders.module';

const chatSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  /** Browser session id — the conversation key for the web widget. */
  sessionId: z.string().trim().min(8).max(100),
  phone: z.string().trim().max(20).optional(),
});

@Controller('storefront/assistant')
class StorefrontAssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Public()
  @RequireTenant()
  @Get('status')
  status(@CurrentTenant() tenant: RequestTenant) {
    return { available: this.assistant.available, tenant: tenant.name };
  }

  /**
   * Chat turn from the storefront widget.
   *
   * Rate-limited hard: each turn is a model call the vendor pays for, so an abusive
   * client must not be able to run up their bill.
   */
  @Public()
  @RequireTenant()
  @RateLimit({ limit: 15, windowSeconds: 60 })
  @Post('chat')
  chat(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(chatSchema)) dto: any) {
    return this.assistant.chat({
      tenantId: tenant.id,
      channel: 'WEB',
      externalId: dto.sessionId,
      message: dto.message,
      phone: dto.phone,
    });
  }
}

@Controller('vendor/assistant')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorAssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('conversations')
  list(@CurrentUser() user: AuthedUser) {
    return this.assistant.listConversations(user.tenantId as string);
  }

  @Get('conversations/:id')
  one(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.assistant.getConversation(user.tenantId as string, id);
  }
}

/**
 * WhatsApp Business / Messenger intake.
 *
 * Both platforms use the same shape: a GET for subscription verification and a signed
 * POST for messages. The vendor is resolved from the phone-number id in the payload, so
 * one webhook URL serves every vendor on the platform.
 */
@Controller('webhooks')
class MessagingWebhookController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly resolver: TenantResolverService,
  ) {}

  @Public()
  @PlatformScope('webhook verification has no session')
  @Get('whatsapp')
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    // Meta's subscription handshake: echo hub.challenge if the token matches.
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    if (query['hub.mode'] === 'subscribe' && token && query['hub.verify_token'] === token) {
      res.status(200).send(query['hub.challenge']);
      return;
    }
    res.status(403).send('forbidden');
  }

  @Public()
  @PlatformScope('inbound message webhook arrives without a session')
  @Post('whatsapp')
  async inbound(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    // Acknowledge immediately — Meta retries aggressively on a slow response, and a
    // model call takes seconds. The reply is delivered out of band.
    res.status(200).send('EVENT_RECEIVED');

    if (!verifyMetaSignature(req)) return;

    try {
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];
      if (!message || message.type !== 'text') return;

      // Which vendor owns this WhatsApp number.
      const slug = process.env.WHATSAPP_TENANT_SLUG;
      const tenant = slug ? await this.resolver.bySlug(slug) : null;
      if (!tenant) return;

      const reply = await this.assistant.chat({
        tenantId: tenant.id,
        channel: 'WHATSAPP',
        externalId: message.from,
        message: message.text.body,
        phone: message.from,
      });

      await sendWhatsAppReply(message.from, reply.text);
    } catch {
      // Never rethrow: the 200 has already been sent, and Meta must not retry.
    }
  }
}

/** HMAC-SHA256 over the raw body, as Meta signs it. */
function verifyMetaSignature(req: Request): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  // Without a configured secret, refuse rather than trusting unsigned input.
  if (!secret) return false;

  const header = req.headers['x-hub-signature-256'];
  const raw = (req as any).rawBody as Buffer | undefined;
  if (typeof header !== 'string' || !raw) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendWhatsAppReply(to: string, text: string): Promise<void> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !text) return;

  await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  }).catch(() => undefined);
}

@Module({
  // The assistant places orders through the very same CheckoutService the web uses —
  // it gets no privileged write path of its own.
  imports: [OrdersModule],
  controllers: [StorefrontAssistantController, VendorAssistantController, MessagingWebhookController],
  providers: [AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
