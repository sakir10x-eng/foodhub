import type { GeoPoint } from '@foodhub/shared';

/** Web Mercator tile size, in CSS pixels. Both providers below use 256. */
export const TILE_SIZE = 256;

/** World width in pixels at a given zoom. */
export const worldSize = (zoom: number) => TILE_SIZE * 2 ** zoom;

export const lngToWorldX = (lng: number, zoom: number) => ((lng + 180) / 360) * worldSize(zoom);

export function latToWorldY(lat: number, zoom: number): number {
  // Clamped to the Mercator limit: the projection is undefined at the poles and a stray
  // 91 would otherwise produce Infinity and a blank map.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(zoom);
}

export const worldXToLng = (x: number, zoom: number) => (x / worldSize(zoom)) * 360 - 180;

export function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export interface View {
  center: GeoPoint;
  zoom: number;
}

/**
 * Turns coordinates into pixels inside a specific box, and back.
 *
 * This is the whole reason the overlays (the delivery circle, the drawn boundary) can be
 * one piece of code for both map providers: Google and OpenStreetMap use the same Web
 * Mercator projection at the same tile size, so given a centre, a zoom and a box size,
 * "where does this point land on screen" has one answer either way.
 */
export interface Projector {
  toPixel(point: GeoPoint): { x: number; y: number };
  toPoint(pixel: { x: number; y: number }): GeoPoint;
  /** Length of one kilometre, in pixels, at the current centre latitude. */
  kmToPixels(km: number): number;
}

export function createProjector(view: View, width: number, height: number): Projector {
  const originX = lngToWorldX(view.center.lng, view.zoom) - width / 2;
  const originY = latToWorldY(view.center.lat, view.zoom) - height / 2;

  return {
    toPixel(point) {
      return {
        x: lngToWorldX(point.lng, view.zoom) - originX,
        y: latToWorldY(point.lat, view.zoom) - originY,
      };
    },
    toPoint(pixel) {
      return {
        lng: worldXToLng(pixel.x + originX, view.zoom),
        lat: worldYToLat(pixel.y + originY, view.zoom),
      };
    },
    kmToPixels(km) {
      // Mercator stretches east–west with latitude, so a kilometre is worth more pixels
      // the further from the equator you are. At Dhaka's latitude that is about 9%.
      const metresPerPixel =
        (156543.03392 * Math.cos((view.center.lat * Math.PI) / 180)) / 2 ** view.zoom;
      return (km * 1000) / metresPerPixel;
    },
  };
}

/** Dhaka. Where a map with nothing else to go on should open. */
export const DEFAULT_CENTER: GeoPoint = { lat: 23.7806, lng: 90.4074 };
