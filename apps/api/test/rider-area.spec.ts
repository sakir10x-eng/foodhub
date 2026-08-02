import {
  isAddressMatchable,
  riderCoversDelivery,
  shapeContainsPoint,
  shapeCoversArea,
  shapeHasGeometry,
  type GeoShape,
} from '@foodhub/shared';

/**
 * Whose delivery is this?
 *
 * In a city the answer is "whoever is nearest" and being slightly wrong costs a few
 * minutes. In a village the next settlement is kilometres away, so an offer shown to the
 * wrong rider is a wasted trip — and a list that is wrong twice is a list riders stop
 * reading. These rules therefore refuse to guess, and that refusal is what is tested here.
 */

const BAZAR: GeoShape = { areas: ['Bazar', 'চর কাদিরপুর'] };
const DRAWN: GeoShape = { center: { lat: 23.75, lng: 90.38 }, radiusKm: 2 };
const POLY: GeoShape = {
  polygon: [
    { lat: 23.70, lng: 90.30 },
    { lat: 23.70, lng: 90.40 },
    { lat: 23.80, lng: 90.40 },
    { lat: 23.80, lng: 90.30 },
  ],
};

describe('what a shape can answer', () => {
  it('knows whether it can speak about coordinates at all', () => {
    expect(shapeHasGeometry(BAZAR)).toBe(false);
    expect(shapeHasGeometry(DRAWN)).toBe(true);
    expect(shapeHasGeometry(POLY)).toBe(true);
    expect(shapeHasGeometry({ center: { lat: 1, lng: 1 }, radiusKm: 0 })).toBe(false);
  });

  it('matches a circle by distance', () => {
    expect(shapeContainsPoint(DRAWN, { lat: 23.755, lng: 90.385 })).toBe(true);
    expect(shapeContainsPoint(DRAWN, { lat: 23.90, lng: 90.60 })).toBe(false);
  });

  it('matches a polygon by containment', () => {
    expect(shapeContainsPoint(POLY, { lat: 23.75, lng: 90.35 })).toBe(true);
    expect(shapeContainsPoint(POLY, { lat: 23.65, lng: 90.35 })).toBe(false);
  });

  it('matches area names regardless of case and stray spaces', () => {
    expect(shapeCoversArea(BAZAR, 'bazar')).toBe(true);
    expect(shapeCoversArea(BAZAR, '  BAZAR ')).toBe(true);
    expect(shapeCoversArea(BAZAR, 'চর কাদিরপুর')).toBe(true);
    expect(shapeCoversArea(BAZAR, 'Mirpur')).toBe(false);
    expect(shapeCoversArea(BAZAR, '   ')).toBe(false);
  });
});

describe('whose delivery is this', () => {
  it('gives it to the rider whose drawn patch contains the pin', () => {
    expect(riderCoversDelivery([DRAWN], { point: { lat: 23.755, lng: 90.385 } })).toBe(true);
    expect(riderCoversDelivery([DRAWN], { point: { lat: 24.5, lng: 91.5 } })).toBe(false);
  });

  // The ordinary village order. Nobody dropped a pin; an area name is all there is.
  it('falls back to the written area when there is no pin', () => {
    expect(riderCoversDelivery([BAZAR], { area: 'Bazar' })).toBe(true);
    expect(riderCoversDelivery([BAZAR], { area: 'Somewhere else' })).toBe(false);
  });

  // A rider who wrote down an area name and never drew anything meant it, so a pin landing
  // outside everyone's drawn boundary must not throw the name away.
  it('still checks the name when a pin misses every drawn boundary', () => {
    const rider = [DRAWN, BAZAR];
    expect(riderCoversDelivery(rider, { point: { lat: 24.5, lng: 91.5 }, area: 'Bazar' })).toBe(true);
  });

  it('refuses when nothing about the address can be matched', () => {
    expect(riderCoversDelivery([DRAWN, BAZAR], {})).toBe(false);
    expect(riderCoversDelivery([DRAWN, BAZAR], { point: null, area: null })).toBe(false);
  });

  // A rider with no patch set up is not "available everywhere" — they are not on the
  // rota yet, and showing them the whole village would be the opposite of the point.
  it('offers nothing to a rider who has no patch', () => {
    expect(riderCoversDelivery([], { area: 'Bazar', point: { lat: 23.75, lng: 90.38 } })).toBe(false);
  });

  it('separates "nobody covers it" from "we cannot read the address"', () => {
    expect(isAddressMatchable({ area: 'Bazar' })).toBe(true);
    expect(isAddressMatchable({ point: { lat: 1, lng: 1 } })).toBe(true);
    expect(isAddressMatchable({ area: '   ' })).toBe(false);
    expect(isAddressMatchable({})).toBe(false);
  });
});
