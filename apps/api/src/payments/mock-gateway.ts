import type { ConfigService } from '@nestjs/config';

/**
 * Whether the built-in mock gateway may stand in for a real one here.
 *
 * Development always allows it — otherwise the money pipeline could not be exercised
 * without a merchant account. Production refuses unless the deployment opts in by name
 * (`DEMO_ALLOW_MOCK_PAYMENTS`), which only a demo box should ever do.
 *
 * Lives on its own so the tenant settings guard and the payments service agree on the
 * answer. They ask the same question — "can an online payment be taken here?" — and if
 * they ever disagreed, a vendor could turn on an advance the storefront cannot collect.
 */
export function mockGatewayAvailable(config: ConfigService): boolean {
  if (config.get<string>('env') !== 'production') return true;
  return config.get<boolean>('payments.allowMockInProduction') === true;
}
