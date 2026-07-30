import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../infra/cache.service';

/** One place, however we found it. */
export interface GeoPlace {
  /** Everything on one line, for a search result row. */
  label: string;
  /** House and road, for the address field. */
  addressLine: string;
  /** Neighbourhood — the thing our delivery zones are named after. */
  area: string;
  city: string;
  lat: number;
  lng: number;
}

/**
 * Addresses and coordinates, from whichever provider is configured.
 *
 * This lives on the server rather than in the browser for three reasons that all matter:
 * the Google key stays secret and IP-restricted instead of being readable in page source;
 * Nominatim's usage policy needs a real User-Agent and a cache, neither of which a browser
 * can be trusted to provide; and the storefront gets ONE response shape regardless of
 * which provider answered, so the map component never has to know.
 *
 * Everything is cached hard. A building does not move, and the free provider is a shared
 * community service we should not hammer.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {}

  private get googleKey(): string {
    return this.config.get<string>('geo.googleKey') ?? '';
  }

  /** Which provider is answering. The storefront shows nothing different either way. */
  get provider(): 'google' | 'osm' {
    return this.googleKey ? 'google' : 'osm';
  }

  /**
   * Pin → address.
   *
   * Rounded to five decimals (about a metre) before it becomes a cache key: a customer
   * nudging the map by a pixel should not be a fresh request to a third party.
   */
  async reverse(lat: number, lng: number): Promise<GeoPlace | null> {
    const key = `geo:rev:${this.provider}:${lat.toFixed(5)}:${lng.toFixed(5)}`;
    // Wrapped in an object because the cache treats a stored `null` as a miss — a pin on
    // a spot the geocoder has no address for would otherwise re-query a shared community
    // service on every single map nudge.
    const cached = await this.cache.wrap<{ place: GeoPlace | null }>(key, 86_400, async () => {
      try {
        const place = this.googleKey ? await this.googleReverse(lat, lng) : await this.osmReverse(lat, lng);
        return { place };
      } catch (err) {
        // A failed lookup must not block an order. The customer still has a pin and a
        // text box, which between them is everything the rider actually needs. Not cached:
        // an outage should not be remembered for a day.
        this.logger.warn(`Reverse geocode failed: ${(err as Error).message}`);
        throw err;
      }
    }).catch(() => ({ place: null }));
    return cached.place;
  }

  /** Text → places. Biased to Bangladesh so "Mirpur" means the one in Dhaka. */
  async search(query: string): Promise<GeoPlace[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const key = `geo:q:${this.provider}:${q.toLowerCase()}`;
    // An empty array is a real answer ("no such road") and is cached; a thrown error is
    // an outage and is not, so the next attempt tries again rather than serving nothing
    // for a day.
    return this.cache
      .wrap(key, 86_400, () => (this.googleKey ? this.googleSearch(q) : this.osmSearch(q)))
      .catch((err) => {
        this.logger.warn(`Geocode search failed: ${(err as Error).message}`);
        return [] as GeoPlace[];
      });
  }

  /* ───────────────────────────────────────────────────────────── google */

  private async googleReverse(lat: number, lng: number): Promise<GeoPlace | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('key', this.googleKey);
    const body = await this.fetchJson(url);
    const first = body?.results?.[0];
    if (!first) return null;
    return this.fromGoogle(first, lat, lng);
  }

  private async googleSearch(q: string): Promise<GeoPlace[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', q);
    url.searchParams.set('key', this.googleKey);
    url.searchParams.set('components', `country:${this.config.get<string>('geo.countryCode') ?? 'bd'}`);
    const body = await this.fetchJson(url);
    return (body?.results ?? [])
      .slice(0, 6)
      .map((r: any) => this.fromGoogle(r, r.geometry?.location?.lat, r.geometry?.location?.lng))
      .filter((p: GeoPlace | null): p is GeoPlace => !!p);
  }

  private fromGoogle(result: any, lat: number, lng: number): GeoPlace | null {
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const part = (type: string) =>
      result.address_components?.find((c: any) => c.types?.includes(type))?.long_name ?? '';
    const road = [part('street_number'), part('route')].filter(Boolean).join(' ');
    return {
      label: result.formatted_address ?? '',
      addressLine: road || result.formatted_address?.split(',')[0] || '',
      area: part('sublocality_level_1') || part('sublocality') || part('neighborhood') || '',
      city: part('locality') || part('administrative_area_level_2') || 'Dhaka',
      lat: Number(lat),
      lng: Number(lng),
    };
  }

  /* ────────────────────────────────────────────────────────────────── osm */

  private async osmReverse(lat: number, lng: number): Promise<GeoPlace | null> {
    const url = new URL('/reverse', this.config.get<string>('geo.nominatimBase'));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    const body = await this.fetchJson(url);
    return body ? this.fromOsm(body) : null;
  }

  private async osmSearch(q: string): Promise<GeoPlace[]> {
    const url = new URL('/search', this.config.get<string>('geo.nominatimBase'));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', q);
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '6');
    url.searchParams.set('countrycodes', this.config.get<string>('geo.countryCode') ?? 'bd');
    const body = await this.fetchJson(url);
    return (Array.isArray(body) ? body : [])
      .map((r: any) => this.fromOsm(r))
      .filter((p: GeoPlace | null): p is GeoPlace => !!p);
  }

  private fromOsm(result: any): GeoPlace | null {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const a = result.address ?? {};
    const road = [a.house_number, a.road].filter(Boolean).join(' ');
    return {
      label: result.display_name ?? '',
      addressLine: road || result.name || (result.display_name ?? '').split(',')[0] || '',
      area: a.suburb || a.neighbourhood || a.quarter || a.city_district || '',
      city: a.city || a.town || a.state_district || a.state || 'Dhaka',
      lat,
      lng,
    };
  }

  /* ──────────────────────────────────────────────────────────── plumbing */

  private async fetchJson(url: URL): Promise<any> {
    const controller = new AbortController();
    // A geocoder is a nicety on a checkout page. Five seconds and we move on rather than
    // holding a customer's form hostage to somebody else's outage.
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.config.get<string>('geo.userAgent') ?? 'FoodHub/1.0',
        },
      });
      if (!res.ok) throw new ServiceUnavailableException(`geocoder responded ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
