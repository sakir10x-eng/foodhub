import type { Request } from 'express';
import type { Plan, PlanStatus } from '@foodhub/shared';
import type { AuthedUser } from './decorators';

/** The slice of a tenant every request needs — cached, so keep it small. */
export interface RequestTenant {
  id: string;
  slug: string;
  name: string;
  plan: Plan;
  planStatus: PlanStatus;
  isOpen: boolean;
  listedOnMarketplace: boolean;
  commissionRateBps: number;
  /** How we got here: a custom domain, the platform subdomain, or the caller's JWT. */
  via: 'custom-domain' | 'subdomain' | 'jwt' | 'explicit';
}

export interface FoodhubRequest extends Request {
  user?: AuthedUser;
  tenant?: RequestTenant;
  /**
   * Lower-cased Host without port. Named separately from Express's own read-only
   * `hostname` getter, which cannot be assigned to.
   */
  resolvedHost: string;
}
