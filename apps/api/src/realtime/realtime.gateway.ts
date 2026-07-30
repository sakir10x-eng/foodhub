import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import type { OrderDto } from '@foodhub/shared';

/**
 * Live order status for both sides of an order.
 *
 *   room `tenant:<id>` — the vendor's live queue. Joining requires a vendor JWT for
 *                        that exact tenant, so nobody can listen to a competitor's
 *                        order feed.
 *   room `order:<code>` — one customer tracking one order. Guests have no JWT, so the
 *                        room key is the order code plus the phone they ordered with.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  path: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    this.logger.debug(`ws connect ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`ws disconnect ${client.id}`);
  }

  /** Vendor panel subscribing to its own queue. */
  @SubscribeMessage('vendor:subscribe')
  async subscribeVendor(client: Socket, payload: { token?: string }) {
    try {
      const claims = await this.jwt.verifyAsync<{ tenantId?: string; role?: string }>(payload?.token ?? '');
      if (!claims?.tenantId) return { ok: false, error: 'not a vendor session' };
      await client.join(`tenant:${claims.tenantId}`);
      return { ok: true, room: `tenant:${claims.tenantId}` };
    } catch {
      return { ok: false, error: 'invalid token' };
    }
  }

  /** Customer (or guest) tracking one order. */
  @SubscribeMessage('order:subscribe')
  async subscribeOrder(client: Socket, payload: { code?: string; phone?: string }) {
    const code = (payload?.code ?? '').trim().toUpperCase();
    const phone = (payload?.phone ?? '').replace(/\D/g, '').slice(-10);
    if (!code || phone.length < 10) return { ok: false, error: 'code and phone required' };
    await client.join(`order:${code}:${phone}`);
    return { ok: true };
  }

  emitNewOrder(order: OrderDto) {
    this.server?.to(`tenant:${order.tenantId}`).emit('order:new', order);
    this.emitOrderUpdate(order);
  }

  emitOrderUpdate(order: OrderDto) {
    const phone = (order.deliveryAddress?.phone ?? '').replace(/\D/g, '').slice(-10);
    this.server?.to(`tenant:${order.tenantId}`).emit('order:updated', order);
    this.server?.to(`order:${order.code}:${phone}`).emit('order:status', {
      code: order.code,
      status: order.status,
      paymentStatus: order.paymentStatus,
      events: order.events,
    });
  }

  /** Menu availability flips, pushed to open storefronts. */
  emitAvailability(tenantId: string, productId: string, isAvailable: boolean) {
    this.server?.to(`tenant:${tenantId}`).emit('menu:availability', { productId, isAvailable });
  }
}
