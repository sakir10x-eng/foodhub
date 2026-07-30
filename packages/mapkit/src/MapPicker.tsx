'use client';

import { useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '@foodhub/shared';
import { BaseMap } from './BaseMap';
import { DEFAULT_CENTER, type View } from './projection';

/** What the geocoder gives back. Identical whichever provider answered. */
export interface GeoPlace {
  label: string;
  addressLine: string;
  area: string;
  city: string;
  lat: number;
  lng: number;
}

export interface MapPickerProps {
  /** Where the pin is now. Null opens on the vendor, or on Dhaka. */
  value: GeoPoint | null;
  onChange: (point: GeoPoint, place: GeoPlace | null) => void;
  /** Where to open when nothing is chosen yet — the restaurant, usually. */
  origin?: GeoPoint | null;
  /** Prefix for the API, e.g. "" for same-origin. */
  apiBase?: string;
  /** Rendered under the map: the resolved address, a warning, whatever the caller needs. */
  footer?: React.ReactNode;
  heightClass?: string;
}

/**
 * Drop a pin, get an address.
 *
 * The pin is fixed to the centre of the box and the map moves under it, rather than a
 * marker you drag. On a phone that is the difference between a one-thumb gesture and
 * trying to grab a 20px target that your finger is covering — and it is what every
 * ride-hailing and delivery app in Dhaka has trained people to expect.
 *
 * Typing is offered as well as dragging, because somebody who knows their address should
 * not have to hunt for their roof.
 */
export function MapPicker({
  value, onChange, origin, apiBase = '', footer, heightClass = 'h-64',
}: MapPickerProps) {
  const [view, setView] = useState<View>({
    center: value ?? origin ?? DEFAULT_CENTER,
    zoom: value ? 17 : origin ? 15 : 12,
  });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * Where the map opened. Until the centre actually moves away from it, nothing has been
   * chosen — and reporting it as a choice would be the picker quietly pinning every
   * customer to the restaurant's own front door, which for a vendor who delivers to a
   * drawn area would mark them "inside it" without them touching anything.
   *
   * A caller that passed a value already has a real pin, so that counts as chosen.
   */
  const opened = useRef(value ?? origin ?? DEFAULT_CENTER);
  const [chosen, setChosen] = useState(value != null);

  /*
   * Reverse-geocode the centre once the map stops moving.
   *
   * Debounced hard: a pan fires a hundred view changes and every one of them would
   * otherwise be a request to a third-party geocoder. The pin is authoritative either
   * way — the address is a convenience laid on top of coordinates we already have.
   */
  useEffect(() => {
    const moved =
      Math.abs(view.center.lat - opened.current.lat) > 1e-5 ||
      Math.abs(view.center.lng - opened.current.lng) > 1e-5;
    if (!moved && !chosen) return;
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(async () => {
      setChosen(true);
      const point = { lat: round(view.center.lat), lng: round(view.center.lng) };
      let place: GeoPlace | null = null;
      try {
        const res = await fetch(`${apiBase}/api/geo/reverse?lat=${point.lat}&lng=${point.lng}`);
        place = res.ok ? ((await res.json()).place ?? null) : null;
      } catch {
        // Offline, blocked, or the geocoder is down. The coordinates still stand.
      }
      onChange(point, place);
    }, 600);
    return () => {
      if (settle.current) clearTimeout(settle.current);
    };
    // `onChange` is intentionally not a dependency: callers pass an inline closure and
    // re-running this on every parent render would geocode forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.center.lat, view.center.lng, apiBase, chosen]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 3) return;
    setSearching(true);
    try {
      const res = await fetch(`${apiBase}/api/geo/search?q=${encodeURIComponent(query.trim())}`);
      setResults(res.ok ? ((await res.json()).places ?? []) : []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setView({ center: { lat: pos.coords.latitude, lng: pos.coords.longitude }, zoom: 17 });
        setLocating(false);
      },
      // Denied or unavailable. The map still works; there is nothing to say about it.
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div>
      <form onSubmit={search} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a road, area or landmark"
          className="field flex-1"
        />
        <button type="submit" disabled={searching} className="btn-ghost min-h-0 px-3 text-[13px]">
          {searching ? '…' : 'Find'}
        </button>
      </form>

      {results.length > 0 && (
        <ul className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-surface-line">
          {results.map((place, i) => (
            <li key={`${place.lat},${place.lng},${i}`}>
              <button
                type="button"
                onClick={() => {
                  setView({ center: { lat: place.lat, lng: place.lng }, zoom: 17 });
                  setResults([]);
                  setQuery('');
                }}
                className="block w-full border-b border-surface-line px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-surface-sunk"
              >
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={`relative mt-2 overflow-hidden rounded-xl border border-surface-line ${heightClass}`}>
        <BaseMap view={view} onView={setView} className="h-full w-full" />

        {/* The pin. Fixed to the centre, offset up by its own height so the point of the
            needle is what lands on the map, not the middle of the balloon. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-full"
        >
          <svg width="32" height="40" viewBox="0 0 32 40" fill="none">
            <path
              d="M16 39s13-13.4 13-23A13 13 0 1 0 3 16c0 9.6 13 23 13 23Z"
              fill="rgb(var(--brand, 215 15 100))"
              stroke="#fff"
              strokeWidth="2.5"
            />
            <circle cx="16" cy="15.5" r="4.5" fill="#fff" />
          </svg>
        </div>

        <button
          type="button"
          onClick={useMyLocation}
          className="absolute bottom-2 left-2 z-[3] rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold shadow-float"
        >
          {locating ? 'Locating…' : '◎ My location'}
        </button>
      </div>

      {!chosen && (
        <p className="mt-1.5 text-[11.5px] font-semibold text-ink-faint">
          Drag the map so the pin sits on your gate, or search for your road above.
        </p>
      )}

      {footer}
    </div>
  );
}

/** Five decimals is about a metre. Anything past that is noise in a URL. */
const round = (n: number) => Math.round(n * 1e5) / 1e5;
