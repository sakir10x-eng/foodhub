'use client';

import { useEffect, useMemo, useState } from 'react';
import { BaseMap, type View } from '@foodhub/mapkit';
import type { RiderPin } from '@foodhub/shared';
import { Icon } from './Icon';
import { useI18n, localiseDigits } from '../lib/i18n';

/**
 * Where the food is, right now.
 *
 * Shown only when the API has decided the customer is entitled to a position (see
 * `riderPin` in the orders service — the rule is ON_THE_WAY plus a fix recent enough to
 * still be true). This component never decides that for itself; it renders what it is
 * given and says so plainly when it is given nothing.
 *
 * Deliberately NOT a route line. Drawing a road route we have not computed would be a
 * guess presented as a plan, and the rider is the one who knows the lane. Two dots and
 * the distance between them is the honest version.
 */
export function TrackingMap({
  rider,
  destination,
}: {
  rider: RiderPin;
  destination: { lat: number; lng: number } | null;
}) {
  const { t, locale } = useI18n();
  const hasFix = typeof rider.lat === 'number' && typeof rider.lng === 'number';

  const points = useMemo(() => {
    const list: { lat: number; lng: number }[] = [];
    if (hasFix) list.push({ lat: rider.lat as number, lng: rider.lng as number });
    if (destination) list.push(destination);
    return list;
  }, [hasFix, rider.lat, rider.lng, destination]);

  const [view, setView] = useState<View>(() => fitView(points));

  // Re-frame when the rider moves, but let a customer who has panned or pinched keep
  // their view: `fitView` only re-centres when the new position would be off-screen.
  useEffect(() => {
    setView((current) => (contains(current, points) ? current : fitView(points)));
  }, [points]);

  if (!hasFix) {
    return (
      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center gap-3 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-sunk">
            <Icon name="bike" size={18} />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{rider.name}</p>
            <p className="text-[13px] text-ink-muted">{t('rider.noFix')}</p>
          </div>
          <a href={`tel:${rider.phone}`} className="btn-ghost ml-auto shrink-0 gap-1.5 px-3 py-2">
            <Icon name="phone" size={14} />
            {t('rider.call')}
          </a>
        </div>
      </section>
    );
  }

  const away = destination ? haversineKm({ lat: rider.lat as number, lng: rider.lng as number }, destination) : null;

  return (
    <section className="card mt-4 overflow-hidden">
      <div className="relative h-56 w-full">
        <BaseMap view={view} onView={setView} className="h-full w-full">
          {(projector) => {
            const bike = projector.toPixel({ lat: rider.lat as number, lng: rider.lng as number });
            const home = destination ? projector.toPixel(destination) : null;
            return (
              <>
                {home && (
                  <span
                    className="absolute -translate-x-1/2 -translate-y-full"
                    style={{ left: home.x, top: home.y }}
                    aria-label="Your address"
                  >
                    <svg width="26" height="32" viewBox="0 0 32 40" fill="none">
                      <path
                        d="M16 39s13-13.4 13-23A13 13 0 1 0 3 16c0 9.6 13 23 13 23Z"
                        fill="#1F2937"
                        stroke="#fff"
                        strokeWidth="2.5"
                      />
                      <circle cx="16" cy="16" r="4.5" fill="#fff" />
                    </svg>
                  </span>
                )}
                {/* The rider is a dot, not a pin: a pin says "this address", a dot says
                    "roughly here and moving", which is the truth about a GPS fix. */}
                <span
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: bike.x, top: bike.y }}
                  aria-label={rider.name}
                >
                  <span className="relative grid h-9 w-9 place-items-center rounded-full bg-brand text-white shadow-lg ring-4 ring-white">
                    <Icon name="bike" size={17} />
                    <span className="absolute inset-0 animate-ping rounded-full bg-brand/40" />
                  </span>
                </span>
              </>
            );
          }}
        </BaseMap>
      </div>

      <div className="flex items-center gap-3 border-t border-surface-line p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{rider.name}</p>
          <p className="text-[13px] text-ink-muted">
            {away !== null
              ? t('rider.away', { km: localiseDigits(away.toFixed(away < 1 ? 1 : 0), locale) })
              : t('rider.onTheWay')}
            {rider.locationAt && ` · ${t('rider.updated', { ago: sinceLabel(rider.locationAt, locale, t) })}`}
          </p>
        </div>
        <a href={`tel:${rider.phone}`} className="btn-ghost shrink-0 gap-1.5 px-3 py-2">
          <Icon name="phone" size={14} />
          {t('rider.call')}
        </a>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── geometry ─── */

const DHAKA = { lat: 23.8103, lng: 90.4125 };

/**
 * A view that holds every point.
 *
 * Zoom comes from a table rather than solving for the viewport, because the map is a
 * fixed-height band in a fixed-width column — the box is known, and a table is one
 * readable line per case instead of an inverse Mercator nobody will check.
 */
function fitView(points: { lat: number; lng: number }[]): View {
  if (points.length === 0) return { center: DHAKA, zoom: 13 };
  if (points.length === 1) return { center: points[0], zoom: 15 };

  const center = {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
  const span = haversineKm(points[0], points[1]);
  const zoom = span < 0.5 ? 16 : span < 1 ? 15 : span < 2 ? 14 : span < 4 ? 13 : span < 8 ? 12 : span < 16 ? 11 : 10;
  return { center, zoom };
}

/** Roughly: would these points still be on screen at this view? */
function contains(view: View, points: { lat: number; lng: number }[]): boolean {
  if (points.length === 0) return true;
  // Half-extent of a 460px-wide, 224px-tall box in degrees at this zoom, with margin.
  const degPerPixel = 360 / (256 * 2 ** view.zoom);
  const halfLng = (460 / 2) * degPerPixel * 0.8;
  const halfLat = (224 / 2) * degPerPixel * 0.8;
  return points.every(
    (p) => Math.abs(p.lat - view.center.lat) < halfLat && Math.abs(p.lng - view.center.lng) < halfLng,
  );
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function sinceLabel(iso: string, locale: 'en' | 'bn', t: (k: any, v?: any) => string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return t('rider.justNow');
  return t('rider.minutesAgo', { n: localiseDigits(Math.round(seconds / 60), locale) });
}
