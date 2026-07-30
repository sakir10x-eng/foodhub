import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { QueueService } from './queue.service';
import { NotificationsService } from './notifications.service';
import { SmsTransport } from './transports/sms.transport';
import { WhatsAppTransport } from './transports/whatsapp.transport';
import { EmailTransport } from './transports/email.transport';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Global()
@Module({
  providers: [
    CacheService, QueueService, NotificationsService, RealtimeGateway,
    SmsTransport, WhatsAppTransport, EmailTransport,
  ],
  exports: [CacheService, QueueService, NotificationsService, RealtimeGateway],
})
export class InfraModule {}
