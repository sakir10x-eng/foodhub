import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { formatBDT } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { CheckoutService } from '../orders/checkout.service';
import { OrdersService } from '../orders/orders.service';
import { MetricsService, METRICS } from '../observability/metrics.service';

/** Opus 5. Thinking is on by default on this model; low effort keeps a chat turn snappy. */
const MODEL = 'claude-opus-5';

export interface AssistantReply {
  conversationId: string;
  text: string;
  cart: { productId: string; name: string; qty: number; price: number }[];
  cartTotal: number;
  orderCode: string | null;
  actions: string[];
}

/**
 * Conversational ordering — the same vendor catalog, reachable from a chat bubble on the
 * storefront or from WhatsApp/Messenger.
 *
 * Two design decisions carry the reliability:
 *
 *   1. The real menu — with real product ids and prices — is injected into the system
 *      prompt rather than left for the model to recall or search for. A food bot that
 *      invents a dish or a price is worse than no bot, and this removes the failure mode
 *      at the source. The menu block is marked `cache_control: ephemeral`, so repeat
 *      turns read it from the prompt cache at ~10% of input cost instead of re-paying
 *      for it every message.
 *
 *   2. The model never writes to the database. Its tools mutate a draft cart, and the
 *      order is placed through the same CheckoutService the web checkout uses — which
 *      re-prices everything from the database. Every product id the model emits is
 *      validated against the vendor's catalog before it is honoured.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly client: Anthropic | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
    private readonly metrics: MetricsService,
  ) {
    // No key configured is a supported state, exactly like the payment gateway: the
    // feature reports itself unavailable instead of crashing the API on boot.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!apiKey) {
      this.logger.log('AI assistant: disabled (set ANTHROPIC_API_KEY to enable)');
    }
  }

  get available(): boolean {
    return this.client !== null;
  }

  async chat(input: {
    tenantId: string;
    channel: 'WEB' | 'WHATSAPP' | 'MESSENGER';
    externalId: string;
    message: string;
    phone?: string;
  }): Promise<AssistantReply> {
    if (!this.client) {
      throw new BadRequestException('The ordering assistant is not available right now.');
    }

    return TenantContext.runAsTenant(input.tenantId, async () => {
      const tenant = await this.prisma.db.tenant.findUnique({ where: { id: input.tenantId } });
      if (!tenant) throw new NotFoundException('Store not found');
      if (!tenant.aiAssistantEnabled) {
        throw new BadRequestException('This store has not enabled the ordering assistant.');
      }

      const conversation = await this.prisma.db.conversation.upsert({
        where: {
          tenantId_channel_externalId: {
            tenantId: input.tenantId,
            channel: input.channel,
            externalId: input.externalId,
          },
        },
        create: {
          tenantId: input.tenantId,
          channel: input.channel,
          externalId: input.externalId,
          customerPhone: input.phone ?? '',
        },
        update: {
          lastMessageAt: new Date(),
          ...(input.phone ? { customerPhone: input.phone } : {}),
        },
      });

      const menu = await this.loadMenu(input.tenantId);
      if (menu.length === 0) {
        throw new BadRequestException('This store has no items on its menu yet.');
      }

      // Draft cart lives on the conversation row, so a WhatsApp customer can walk away
      // mid-order and come back to it.
      let cart: { productId: string; qty: number }[] = Array.isArray(conversation.draftCart)
        ? (conversation.draftCart as any)
        : [];
      const actions: string[] = [];
      let placedCode: string | null = null;

      const menuById = new Map(menu.map((m) => [m.id, m]));

      const tools = [
        betaTool({
          name: 'add_to_cart',
          description:
            'Add a menu item to the customer’s cart. Use the exact product_id from the menu in the system prompt.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'The product_id exactly as listed in the menu' },
              quantity: { type: 'integer', minimum: 1, maximum: 20, description: 'How many to add' },
            },
            required: ['product_id', 'quantity'],
          },
          run: async ({ product_id, quantity }: any) => {
            const item = menuById.get(product_id);
            // The model's id is never trusted — an unknown or unavailable id comes back
            // as a tool error so it can correct itself in the same turn.
            if (!item) return `No such item: ${product_id}. Only use product_ids from the menu.`;
            if (!item.isAvailable) return `${item.name} is sold out right now.`;

            const existing = cart.find((c) => c.productId === product_id);
            if (existing) existing.qty = Math.min(20, existing.qty + quantity);
            else cart.push({ productId: product_id, qty: quantity });

            actions.push(`add:${item.name}x${quantity}`);
            return `Added ${quantity} × ${item.name} (${formatBDT(item.price)}). Cart total: ${formatBDT(
              this.cartTotal(cart, menuById),
            )}`;
          },
        }),

        betaTool({
          name: 'remove_from_cart',
          description: 'Remove an item from the cart entirely.',
          inputSchema: {
            type: 'object',
            properties: { product_id: { type: 'string' } },
            required: ['product_id'],
          },
          run: async ({ product_id }: any) => {
            const before = cart.length;
            cart = cart.filter((c) => c.productId !== product_id);
            if (cart.length === before) return 'That item was not in the cart.';
            actions.push(`remove:${product_id}`);
            return `Removed. Cart total: ${formatBDT(this.cartTotal(cart, menuById))}`;
          },
        }),

        betaTool({
          name: 'view_cart',
          description: 'Show what is currently in the cart with the running total.',
          inputSchema: { type: 'object', properties: {} },
          run: async () => {
            if (cart.length === 0) return 'The cart is empty.';
            const lines = cart.map((c) => {
              const item = menuById.get(c.productId)!;
              return `${c.qty} × ${item.name} = ${formatBDT(item.price * c.qty)}`;
            });
            return `${lines.join('\n')}\nSubtotal: ${formatBDT(this.cartTotal(cart, menuById))}`;
          },
        }),

        betaTool({
          name: 'place_order',
          description:
            'Place the order once the cart is correct and you have the customer’s name, full delivery address, area and phone number. Confirm the total with them before calling this.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Customer name' },
              phone: { type: 'string', description: 'Bangladeshi mobile number, e.g. 01712345678' },
              address_line: { type: 'string', description: 'House, road, flat' },
              area: { type: 'string', description: 'Area/neighbourhood, e.g. Dhanmondi' },
              note: { type: 'string', description: 'Optional note for the rider' },
            },
            required: ['name', 'phone', 'address_line', 'area'],
          },
          run: async (args: any) => {
            if (cart.length === 0) return 'The cart is empty — add items before placing the order.';
            try {
              // Straight through the normal checkout path: prices, stock, zones,
              // minimums and the tenant guard all apply exactly as on the web.
              const result = await this.checkout.placeOrder(
                {
                  items: cart.map((c) => ({ productId: c.productId, qty: c.qty })),
                  address: {
                    name: args.name,
                    phone: args.phone,
                    addressLine: args.address_line,
                    area: args.area ?? '',
                    city: 'Dhaka',
                    note: args.note ?? '',
                  },
                  paymentMethod: 'COD',
                } as any,
                { channel: 'OWN_STORE', tenantId: input.tenantId, customerId: null },
              );
              placedCode = result.order.code;
              cart = [];
              actions.push(`order:${result.order.code}`);
              return `Order ${result.order.code} placed. Total ${formatBDT(
                result.order.total,
              )} (including ${formatBDT(result.order.deliveryFee)} delivery), cash on delivery.`;
            } catch (err) {
              // Surface the real reason — "closed", "below minimum", "sold out" — so the
              // assistant can explain it rather than apologising vaguely.
              return `Could not place the order: ${(err as Error).message}`;
            }
          },
        }),

        betaTool({
          name: 'check_order_status',
          description: 'Look up an existing order by its code and the phone it was placed with.',
          inputSchema: {
            type: 'object',
            properties: { code: { type: 'string' }, phone: { type: 'string' } },
            required: ['code', 'phone'],
          },
          run: async ({ code, phone }: any) => {
            try {
              const order = await this.orders.trackGuest(code, phone);
              return `Order ${order.code} is ${order.status}. Total ${formatBDT(order.total)}.`;
            } catch {
              return 'No order found with that number and phone.';
            }
          },
        }),
      ];

      const history = await this.prisma.db.conversationMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { seq: 'asc' },
        // Enough for the assistant to hold the thread without unbounded prompt growth.
        take: 20,
        select: { role: true, text: true },
      });

      const messages: Anthropic.Beta.BetaMessageParam[] = [
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
        { role: 'user' as const, content: input.message },
      ];

      const runner = this.client!.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 4096,
        // Low effort: taking a food order is a scoped task, and latency is what the
        // customer feels. Thinking stays on (the default on this model) — disabling it
        // risks tool calls being written as plain text, which would silently drop an item.
        output_config: { effort: 'low' },
        system: this.systemPrompt(tenant, menu),
        tools,
        messages,
        max_iterations: 8,
      });

      const final = await runner.runUntilDone();

      const text = final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const usage = final.usage;
      this.metrics.inc(METRICS.AI_TOKENS, { kind: 'input' }, usage?.input_tokens ?? 0, 'Assistant tokens used');
      this.metrics.inc(METRICS.AI_TOKENS, { kind: 'output' }, usage?.output_tokens ?? 0);
      this.metrics.inc(METRICS.AI_TOKENS, { kind: 'cache_read' }, usage?.cache_read_input_tokens ?? 0);

      await this.prisma.db.conversationMessage.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', text: input.message },
          {
            conversationId: conversation.id,
            role: 'assistant',
            text: text || '…',
            toolCalls: actions.length ? (actions as any) : undefined,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cachedTokens: usage?.cache_read_input_tokens ?? 0,
          },
        ],
      });

      await this.prisma.db.conversation.update({
        where: { id: conversation.id },
        data: {
          draftCart: cart as any,
          lastMessageAt: new Date(),
          ...(placedCode ? { status: 'ORDERED' } : {}),
        },
      });

      return {
        conversationId: conversation.id,
        text,
        cart: cart.map((c) => {
          const item = menuById.get(c.productId)!;
          return { productId: c.productId, name: item.name, qty: c.qty, price: item.price };
        }),
        cartTotal: this.cartTotal(cart, menuById),
        orderCode: placedCode,
        actions,
      };
    });
  }

  private cartTotal(
    cart: { productId: string; qty: number }[],
    menu: Map<string, { price: number }>,
  ): number {
    return cart.reduce((sum, c) => sum + (menu.get(c.productId)?.price ?? 0) * c.qty, 0);
  }

  private async loadMenu(tenantId: string) {
    return this.prisma.db.product.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: 'asc' }],
      select: {
        id: true, name: true, description: true, price: true, isAvailable: true,
        category: { select: { name: true } },
      },
    });
  }

  /**
   * System prompt: rules first, then the live menu as a cacheable block.
   *
   * Order matters for prompt caching — the stable instructions and menu sit ahead of the
   * breakpoint, and only the conversation varies per turn.
   */
  private systemPrompt(
    tenant: { name: string; tagline: string; isOpen: boolean; prepMinutes: number; deliveryZones: any; aiPersona: string },
    menu: { id: string; name: string; description: string; price: number; isAvailable: boolean; category: { name: string } | null }[],
  ): Anthropic.Beta.BetaTextBlockParam[] {
    const zones = (Array.isArray(tenant.deliveryZones) ? tenant.deliveryZones : []) as {
      label: string; fee: number; minOrder: number; areas: string[];
    }[];

    const menuText = menu
      .map((m) => {
        const status = m.isAvailable ? '' : ' [SOLD OUT]';
        const category = m.category?.name ? `${m.category.name} — ` : '';
        return `- product_id: ${m.id} | ${category}${m.name} | ${formatBDT(m.price)}${status}${
          m.description ? ` | ${m.description}` : ''
        }`;
      })
      .join('\n');

    const zoneText = zones.length
      ? zones
          .map(
            (z) =>
              `- ${z.label}: ${formatBDT(z.fee)} delivery${
                z.minOrder ? `, minimum order ${formatBDT(z.minOrder)}` : ''
              }${z.areas.length ? ` (areas: ${z.areas.join(', ')})` : ''}`,
          )
          .join('\n')
      : '- Delivery details will be confirmed at checkout.';

    return [
      {
        type: 'text',
        text: `You are the ordering assistant for ${tenant.name}${
          tenant.tagline ? `, ${tenant.tagline}` : ''
        }, a restaurant in Dhaka, Bangladesh. You take food orders by chat.

HOW TO BEHAVE
- Be warm, brief and practical. Two or three short sentences per reply. This is a chat, not an email.
- The customer may write in English, Bangla or Banglish. Reply in whichever they used.
- Prices are in Bangladeshi Taka.
- The kitchen is currently ${tenant.isOpen ? 'OPEN' : 'CLOSED'}. ${
          tenant.isOpen
            ? `Typical preparation time is about ${tenant.prepMinutes} minutes.`
            : 'Tell the customer they can browse and you will note their interest, but orders cannot be placed until it reopens.'
        }

HARD RULES
- Only ever offer items from the MENU below. Never invent a dish, a price, a size, or a variation that is not listed.
- If someone asks for something not on the menu, say it is not available and suggest the closest thing that is.
- Never quote a price you have not read from the MENU. Never estimate or round.
- Never claim an order is placed until place_order has returned an order code. Give them that code.
- Before calling place_order, read the cart and total back to the customer and get a clear yes.
- Collect name, full address, area and phone number before placing an order. Ask for whatever is missing.
- If a tool returns an error, tell the customer plainly what went wrong. Do not retry silently or make something up.

DELIVERY
${zoneText}
${tenant.aiPersona ? `\nADDITIONAL GUIDANCE FROM THE RESTAURANT\n${tenant.aiPersona}` : ''}

MENU
${menuText}`,
        // The instructions and menu are identical across turns, so cache them: repeat
        // messages in a conversation re-read this prefix at a fraction of the cost.
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  /** Vendor-facing: read the conversations the assistant has been having. */
  async listConversations(tenantId: string, limit = 50) {
    return this.prisma.db.conversation.findMany({
      where: { tenantId },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      include: {
        messages: { orderBy: { seq: 'desc' }, take: 1, select: { text: true, role: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
    });
  }

  async getConversation(tenantId: string, id: string) {
    const conversation = await this.prisma.db.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { seq: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}
