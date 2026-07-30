'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '@foodhub/shared';
import {
  DEFAULT_CENTER,
  TILE_SIZE,
  createProjector,
  latToWorldY,
  lngToWorldX,
  worldXToLng,
  worldYToLat,
  type Projector,
  type View,
} from './projection';

export interface BaseMapProps {
  view: View;
  onView: (view: View) => void;
  /** Fired with the coordinates of a tap that was not a drag. */
  onMapClick?: (point: GeoPoint) => void;
  /** Overlay layer, given a projector for the current view and box. */
  children?: (projector: Projector, size: { width: number; height: number }) => React.ReactNode;
  className?: string;
  minZoom?: number;
  maxZoom?: number;
}

/**
 * The map, from whichever provider is configured.
 *
 * Google is used when `NEXT_PUBLIC_GOOGLE_MAPS_KEY` is set — its Bangladeshi road and
 * building data is better, and it is what a vendor asks for by name. Without a key the
 * component falls back to OpenStreetMap tiles rather than showing the grey "this page
 * can't load Google Maps correctly" box, because a checkout that cannot take an address
 * is worse than one drawn from a free tile server.
 *
 * Both report the same {centre, zoom}, so everything drawn on top — the delivery circle,
 * the vendor's boundary, the pin — is one piece of code either way.
 */
export function BaseMap(props: BaseMapProps) {
  const key = googleKey();
  return key ? <GoogleBase {...props} apiKey={key} /> : <OsmBase {...props} />;
}

export function googleKey(): string {
  // Read through a guard rather than destructured: Next inlines the literal member
  // expression at build time, and a destructured `process.env` is not replaced.
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? '';
}

/** Which provider is actually drawing. Shown as attribution, which OSM requires. */
export const mapProvider = (): 'google' | 'osm' => (googleKey() ? 'google' : 'osm');

/* ══════════════════════════════════════════════════════ shared plumbing ══ */

/** Tracks the rendered size of the map box so the projector can be built from it. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function Overlay({
  view, size, children,
}: {
  view: View;
  size: { width: number; height: number };
  children?: BaseMapProps['children'];
}) {
  if (!children || size.width === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {children(createProjector(view, size.width, size.height), size)}
    </div>
  );
}

/* ═════════════════════════════════════════════════════ openstreetmap ══ */

/**
 * A slippy map in about a hundred lines.
 *
 * Hand-rolled rather than pulled from a library because the entire requirement is "pan,
 * zoom, tell me the centre" — and a mapping library brings its own CSS, its own DOM
 * ownership model and its own React wrapper, all of which fight the overlay above. The
 * projection is fifteen lines of arithmetic and does not change.
 */
function OsmBase({
  view, onView, onMapClick, children, className, minZoom = 5, maxZoom = 19,
}: BaseMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useBoxSize(ref);
  // Pointer bookkeeping lives in a ref: a pan updates on every frame and re-rendering
  // React state per pointermove would drop the map to single-digit frames on a phone.
  const drag = useRef<{ pointers: Map<number, { x: number; y: number }>; moved: number; pinch: number }>({
    pointers: new Map(),
    moved: 0,
    pinch: 0,
  });

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const x = lngToWorldX(view.center.lng, view.zoom) - dx;
      const y = latToWorldY(view.center.lat, view.zoom) - dy;
      onView({
        zoom: view.zoom,
        center: { lng: worldXToLng(x, view.zoom), lat: worldYToLat(y, view.zoom) },
      });
    },
    [view, onView],
  );

  const zoomTo = useCallback(
    (zoom: number) => onView({ center: view.center, zoom: Math.max(minZoom, Math.min(maxZoom, zoom)) }),
    [view, onView, minZoom, maxZoom],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current.moved = 0;
    drag.current.pinch = pinchDistance(drag.current.pointers);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const state = drag.current;
    const previous = state.pointers.get(e.pointerId);
    if (!previous) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pointers.size >= 2) {
      const distance = pinchDistance(state.pointers);
      if (state.pinch > 0 && distance > 0) {
        const factor = Math.log2(distance / state.pinch);
        if (Math.abs(factor) > 0.02) {
          zoomTo(view.zoom + factor);
          state.pinch = distance;
        }
      }
      return;
    }

    const dx = e.clientX - previous.x;
    const dy = e.clientY - previous.y;
    state.moved += Math.abs(dx) + Math.abs(dy);
    panBy(dx, dy);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const state = drag.current;
    state.pointers.delete(e.pointerId);
    state.pinch = pinchDistance(state.pointers);
    // A tap is a press that went nowhere. Ten pixels of slack, because a thumb on a phone
    // never lands perfectly still.
    if (state.pointers.size === 0 && state.moved < 10 && onMapClick && size.width) {
      const box = ref.current!.getBoundingClientRect();
      const projector = createProjector(view, size.width, size.height);
      onMapClick(projector.toPoint({ x: e.clientX - box.left, y: e.clientY - box.top }));
    }
  };

  const tiles = size.width ? tileGrid(view, size.width, size.height) : [];

  return (
    <div
      ref={ref}
      className={className}
      // Without this the browser claims the gesture and scrolls the checkout page out
      // from under the customer's thumb while they are trying to move the map.
      style={{ touchAction: 'none', position: 'relative', overflow: 'hidden', background: '#E8EBE6' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={(e) => zoomTo(view.zoom - Math.sign(e.deltaY) * 0.5)}
    >
      {tiles.map((tile) => (
        <img
          key={`${tile.z}/${tile.x}/${tile.y}`}
          src={`https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`}
          alt=""
          draggable={false}
          width={TILE_SIZE}
          height={TILE_SIZE}
          style={{
            position: 'absolute',
            left: tile.left,
            top: tile.top,
            width: TILE_SIZE,
            height: TILE_SIZE,
            userSelect: 'none',
          }}
        />
      ))}

      <Overlay view={view} size={size}>{children}</Overlay>

      <ZoomButtons onZoom={(delta) => zoomTo(view.zoom + delta)} />

      {/* Required by the OpenStreetMap tile usage policy, and fair regardless. */}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
        style={{
          position: 'absolute', right: 0, bottom: 0, zIndex: 3,
          background: 'rgba(255,255,255,.75)', font: '10px system-ui', padding: '1px 4px',
          color: '#333', textDecoration: 'none',
        }}
      >
        © OpenStreetMap
      </a>
    </div>
  );
}

function pinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  if (pointers.size < 2) return 0;
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Every tile that intersects the visible box, with its pixel offset. */
function tileGrid(view: View, width: number, height: number) {
  // Tiles only exist at whole zooms; a fractional zoom (mid-pinch) renders the level
  // below, which is why the grid rounds down rather than to nearest.
  const z = Math.max(0, Math.min(19, Math.floor(view.zoom)));
  const scale = 2 ** (view.zoom - z);
  const tileSpan = TILE_SIZE * scale;

  const centreX = lngToWorldX(view.center.lng, z) * scale;
  const centreY = latToWorldY(view.center.lat, z) * scale;
  const left = centreX - width / 2;
  const top = centreY - height / 2;

  const first = { x: Math.floor(left / tileSpan), y: Math.floor(top / tileSpan) };
  const last = { x: Math.floor((left + width) / tileSpan), y: Math.floor((top + height) / tileSpan) };
  const max = 2 ** z;

  const out: { x: number; y: number; z: number; left: number; top: number }[] = [];
  for (let x = first.x; x <= last.x; x++) {
    for (let y = first.y; y <= last.y; y++) {
      if (y < 0 || y >= max) continue;
      out.push({
        // Horizontal wrap, so panning past the date line does not leave a void.
        x: ((x % max) + max) % max,
        y,
        z,
        left: x * tileSpan - left,
        top: y * tileSpan - top,
      });
    }
  }
  return out;
}

function ZoomButtons({ onZoom }: { onZoom: (delta: number) => void }) {
  const style: React.CSSProperties = {
    width: 30, height: 30, display: 'grid', placeItems: 'center', cursor: 'pointer',
    background: '#fff', border: 'none', font: '600 17px system-ui', color: '#17171C',
  };
  return (
    <div
      style={{
        position: 'absolute', right: 8, top: 8, zIndex: 3, borderRadius: 8, overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(20,20,30,.2)', display: 'grid',
      }}
      // The buttons sit inside the pan surface, so their presses must not also drag it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" aria-label="Zoom in" style={style} onClick={() => onZoom(1)}>+</button>
      <span style={{ height: 1, background: '#E2E2E8' }} />
      <button type="button" aria-label="Zoom out" style={style} onClick={() => onZoom(-1)}>−</button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════ google ══ */

let googleLoader: Promise<void> | null = null;

/** Loads the Maps JS API once per page, however many maps ask for it. */
function loadGoogle(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).google?.maps) return Promise.resolve();
  if (googleLoader) return googleLoader;

  googleLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(script);
  });
  return googleLoader;
}

function GoogleBase({
  view, onView, onMapClick, children, className, minZoom = 5, maxZoom = 20, apiKey,
}: BaseMapProps & { apiKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const size = useBoxSize(box);
  const map = useRef<any>(null);
  const [failed, setFailed] = useState(false);
  // Set while WE are moving the map, so the resulting change event does not echo back as
  // a user gesture and fight whatever set it.
  const applying = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadGoogle(apiKey)
      .then(() => {
        if (cancelled || !host.current || map.current) return;
        const google = (window as any).google;
        map.current = new google.maps.Map(host.current, {
          center: { lat: view.center.lat, lng: view.center.lng },
          zoom: view.zoom,
          minZoom,
          maxZoom,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
        map.current.addListener('bounds_changed', () => {
          if (applying.current) return;
          const centre = map.current.getCenter();
          if (!centre) return;
          onView({ center: { lat: centre.lat(), lng: centre.lng() }, zoom: map.current.getZoom() ?? view.zoom });
        });
        map.current.addListener('click', (e: any) => {
          if (e.latLng && onMapClick) onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        });
      })
      // A blocked key, an ad blocker, a dead network: fall back rather than leave a hole
      // in the middle of checkout.
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
    // Deliberately once: the map instance owns its own state after creation and is driven
    // by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Push external changes (a search result, "use my location") into the map.
  useEffect(() => {
    if (!map.current) return;
    const centre = map.current.getCenter();
    const moved =
      !centre ||
      Math.abs(centre.lat() - view.center.lat) > 1e-6 ||
      Math.abs(centre.lng() - view.center.lng) > 1e-6;
    if (!moved && map.current.getZoom() === view.zoom) return;
    applying.current = true;
    map.current.setCenter({ lat: view.center.lat, lng: view.center.lng });
    map.current.setZoom(view.zoom);
    // Released after the event loop turn so the change events this caused are ignored.
    setTimeout(() => {
      applying.current = false;
    }, 0);
  }, [view]);

  if (failed) return <OsmBase view={view} onView={onView} onMapClick={onMapClick} className={className}>{children}</OsmBase>;

  return (
    <div ref={box} className={className} style={{ position: 'relative', overflow: 'hidden', background: '#E8EBE6' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <Overlay view={view} size={size}>{children}</Overlay>
    </div>
  );
}
