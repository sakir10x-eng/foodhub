'use client';

import { useState } from 'react';
import type { GeoPoint } from '@foodhub/shared';
import { BaseMap } from './BaseMap';
import { DEFAULT_CENTER, type Projector, type View } from './projection';

export interface AreaShape {
  center?: GeoPoint | null;
  radiusKm?: number | null;
  polygon?: GeoPoint[] | null;
}

export interface AreaEditorProps {
  /** The shop's own pin. The circle is drawn around it by default. */
  origin: GeoPoint | null;
  value: AreaShape;
  onChange: (shape: AreaShape) => void;
  /** Other zones, drawn faintly so a vendor can see how their areas fit together. */
  siblings?: { label: string; shape: AreaShape }[];
  heightClass?: string;
}

/**
 * Where a vendor says their riders go.
 *
 * Two ways, because vendors are two kinds of people. A circle is one slider and covers
 * "we deliver about 3km around the shop", which is what almost everyone means. A drawn
 * boundary is for the cases a circle gets wrong and a vendor already knows it does: the
 * far bank of the river is 2km away and forty minutes; the flyover means one side of the
 * road is a different trip entirely.
 *
 * What is drawn here is exactly what checkout enforces — the same containment test runs
 * server-side when the order is placed.
 */
export function AreaEditor({ origin, value, onChange, siblings = [], heightClass = 'h-72' }: AreaEditorProps) {
  const centre = value.center ?? origin ?? DEFAULT_CENTER;
  const [view, setView] = useState<View>({ center: centre, zoom: 12 });
  const drawing = (value.polygon?.length ?? 0) > 0;
  const [mode, setMode] = useState<'circle' | 'polygon'>(drawing ? 'polygon' : 'circle');

  const radius = value.radiusKm ?? 3;

  const setCircle = (next: Partial<{ center: GeoPoint; radiusKm: number }>) =>
    onChange({
      ...value,
      polygon: null,
      center: next.center ?? value.center ?? origin ?? view.center,
      radiusKm: next.radiusKm ?? radius,
    });

  const addVertex = (point: GeoPoint) => {
    if (mode !== 'polygon') return;
    onChange({ ...value, center: null, radiusKm: null, polygon: [...(value.polygon ?? []), point] });
  };

  const polygon = value.polygon ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-surface-edge bg-surface-sunk p-0.5">
          <ModeButton on={mode === 'circle'} onClick={() => { setMode('circle'); setCircle({}); }}>
            Distance
          </ModeButton>
          <ModeButton on={mode === 'polygon'} onClick={() => setMode('polygon')}>
            Draw the area
          </ModeButton>
        </div>

        {mode === 'circle' ? (
          <label className="flex flex-1 items-center gap-2 text-[13px] font-semibold">
            <input
              type="range"
              min={0.5}
              max={20}
              step={0.5}
              value={radius}
              onChange={(e) => setCircle({ radiusKm: Number(e.target.value) })}
              className="min-w-[120px] flex-1 accent-brand"
            />
            <span className="tabular-nums">{radius} km</span>
          </label>
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            <span>{polygon.length < 3 ? 'Tap the map to trace the boundary' : `${polygon.length} points`}</span>
            {polygon.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...value, polygon: polygon.slice(0, -1) })}
                className="rounded-md border border-surface-edge px-2 py-1 font-semibold"
              >
                Undo
              </button>
            )}
            {polygon.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...value, polygon: null })}
                className="rounded-md border border-surface-edge px-2 py-1 font-semibold"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`relative mt-2 overflow-hidden rounded-xl border border-surface-line ${heightClass}`}>
        <BaseMap view={view} onView={setView} onMapClick={addVertex} className="h-full w-full">
          {(projector) => (
            <svg className="absolute inset-0 h-full w-full" aria-hidden>
              {siblings.map((sibling, i) => (
                <Shape key={i} shape={sibling.shape} projector={projector} faint />
              ))}
              <Shape
                shape={mode === 'circle' ? { center: value.center ?? origin, radiusKm: radius } : { polygon }}
                projector={projector}
              />
              {mode === 'polygon' &&
                polygon.map((point, i) => {
                  const p = projector.toPixel(point);
                  return <circle key={i} cx={p.x} cy={p.y} r={5} fill="#fff" stroke="rgb(var(--brand))" strokeWidth={2.5} />;
                })}
              {origin && <Origin point={origin} projector={projector} />}
            </svg>
          )}
        </BaseMap>

        {mode === 'circle' && (
          <button
            type="button"
            onClick={() => setCircle({ center: view.center })}
            className="absolute bottom-2 left-2 z-[3] rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold shadow-float"
          >
            Centre here
          </button>
        )}
      </div>

      <p className="mt-1.5 text-[11.5px] text-ink-faint">
        {mode === 'circle'
          ? 'Customers outside this circle are told you do not deliver to them yet.'
          : polygon.length < 3
            ? 'Three points or more make an area. Until then this zone still accepts every address.'
            : 'Only addresses inside this shape can order from this zone.'}
      </p>
    </div>
  );
}

function ModeButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[6px] px-2.5 py-1.5 text-[12.5px] font-bold transition ${
        on ? 'bg-white text-brand shadow-card' : 'text-ink-muted'
      }`}
    >
      {children}
    </button>
  );
}

/** One zone, drawn. A circle or a polygon; never both, because the data never has both. */
function Shape({ shape, projector, faint }: { shape: AreaShape; projector: Projector; faint?: boolean }) {
  const stroke = faint ? '#9797A5' : 'rgb(var(--brand))';
  const fill = faint ? 'rgba(151,151,165,.10)' : 'rgb(var(--brand) / .14)';

  if (shape.polygon && shape.polygon.length >= 2) {
    const points = shape.polygon.map((p) => projector.toPixel(p)).map((p) => `${p.x},${p.y}`).join(' ');
    return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={2} strokeLinejoin="round" />;
  }
  if (shape.center && (shape.radiusKm ?? 0) > 0) {
    const c = projector.toPixel(shape.center);
    return <circle cx={c.x} cy={c.y} r={projector.kmToPixels(shape.radiusKm!)} fill={fill} stroke={stroke} strokeWidth={2} />;
  }
  return null;
}

/** The shop itself, so a vendor can see what they are measuring from. */
function Origin({ point, projector }: { point: GeoPoint; projector: Projector }) {
  const p = projector.toPixel(point);
  return (
    <g>
      <circle cx={p.x} cy={p.y} r={7} fill="#17171C" stroke="#fff" strokeWidth={3} />
    </g>
  );
}
