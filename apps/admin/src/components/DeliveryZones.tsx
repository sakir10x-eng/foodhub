'use client';

import { useEffect, useState } from 'react';
import { formatBDT, zoneHasShape, type DeliveryZone, type GeoPoint } from '@foodhub/shared';
import { AreaEditor } from '@foodhub/mapkit';
import { Icon } from './Icon';

/**
 * The delivery-zone editor.
 *
 * Zones are stored as one JSON array on the tenant, so the whole set is saved together
 * rather than row by row. That shapes the UX: edits are staged locally and committed with
 * an explicit Save, unlike the save-on-blur fields elsewhere on this page — a half-applied
 * zone list would silently change what every customer is charged for delivery.
 *
 * Order is load-bearing. The first zone is the fallback for any area the vendor has not
 * listed, which is why it cannot be deleted and can be moved.
 */
export function DeliveryZones({
  zones: initial,
  busy,
  origin,
  onSave,
}: {
  zones: DeliveryZone[];
  busy: boolean;
  /** The shop's own pin, so a distance is measured from somewhere real. */
  origin: GeoPoint | null;
  onSave: (zones: DeliveryZone[]) => Promise<void>;
}) {
  const [mapFor, setMapFor] = useState<string | null>(null);
  const [zones, setZones] = useState<DeliveryZone[]>(initial);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the parent reloads settings, but only while there is nothing to lose.
  useEffect(() => {
    if (!dirty) setZones(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const dirty = JSON.stringify(zones) !== JSON.stringify(initial);

  const update = (i: number, patch: Partial<DeliveryZone>) =>
    setZones((zs) => zs.map((z, idx) => (idx === i ? { ...z, ...patch } : z)));

  const move = (i: number, dir: -1 | 1) =>
    setZones((zs) => {
      const next = [...zs];
      const j = i + dir;
      if (j < 0 || j >= next.length) return zs;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const add = () =>
    setZones((zs) => [
      ...zs,
      { id: `zone-${Date.now().toString(36)}`, label: '', fee: 6000, minOrder: 0, areas: [] },
    ]);

  const save = async () => {
    setError(null);
    const cleaned = zones.map((z) => ({
      ...z,
      label: z.label.trim(),
      areas: z.areas.map((a) => a.trim()).filter(Boolean),
    }));
    if (cleaned.some((z) => !z.label)) {
      setError('Give every zone a name — customers see it at checkout.');
      return;
    }
    try {
      await onSave(cleaned);
      setZones(cleaned);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">Delivery areas</h2>
          <p className="mt-1 text-sm text-ink-muted">
            A customer's area decides their delivery fee. Draw a zone on the map to limit how
            far you go — anyone outside every drawn zone is told you do not deliver to them.
            A zone with no map area still accepts every address, so keep one if you want a
            catch-all.
          </p>
        </div>
        <button onClick={add} className="btn-ghost h-9 min-h-0 shrink-0 gap-1.5 px-3 text-sm">
          <Icon name="plus" size={15} /> Add
        </button>
      </div>

      <ul className="mt-4 space-y-3">
        {zones.map((zone, i) => (
          <li key={zone.id} className="rounded-xl border border-surface-line bg-surface-sunk p-3">
            <div className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  i === 0 ? 'bg-brand/12 text-brand' : 'bg-white text-ink-faint'
                }`}
              >
                {i === 0 ? 'Default' : `Zone ${i + 1}`}
              </span>
              <input
                className="field h-9 min-h-0 flex-1 bg-white py-0 text-sm"
                placeholder="e.g. Inside Dhaka"
                value={zone.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
              <div className="flex shrink-0 gap-0.5">
                <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="chevron-up" size={15} />
                </IconButton>
                <IconButton
                  label="Move down"
                  disabled={i === zones.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon name="chevron-down" size={15} />
                </IconButton>
                <IconButton
                  label="Remove zone"
                  // The fallback zone cannot go: with it gone, an unlisted area would have
                  // no fee at all and checkout would refuse the order outright.
                  disabled={zones.length === 1 || i === 0}
                  danger
                  onClick={() => setZones((zs) => zs.filter((_, idx) => idx !== i))}
                >
                  <Icon name="trash" size={15} />
                </IconButton>
              </div>
            </div>

            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <MoneyField
                label="Delivery fee"
                value={zone.fee}
                onChange={(fee) => update(i, { fee })}
                hint={zone.fee === 0 ? 'Shown as a Free delivery offer' : undefined}
              />
              <MoneyField
                label="Minimum order"
                value={zone.minOrder}
                onChange={(minOrder) => update(i, { minOrder })}
                hint={zone.minOrder === 0 ? 'No minimum' : undefined}
              />
            </div>

            <label className="mt-2 block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Areas in this zone
              </span>
              <input
                className="field h-9 min-h-0 bg-white py-0 text-sm"
                placeholder={
                  zoneHasShape(zone)
                    ? 'Not used — this zone is decided by the map'
                    : i === 0
                      ? 'Leave blank — this zone catches everything else'
                      : 'Gulshan, Banani, Baridhara'
                }
                defaultValue={zone.areas.join(', ')}
                onBlur={(e) => update(i, { areas: e.target.value.split(',') })}
              />
            </label>

            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMapFor(mapFor === zone.id ? null : zone.id)}
                className="btn-ghost h-8 min-h-0 gap-1.5 px-2.5 text-[12.5px]"
              >
                <Icon name="pin" size={14} />
                {mapFor === zone.id ? 'Hide map' : zoneHasShape(zone) ? 'Edit area' : 'Set area on map'}
              </button>
              <span className="text-[12px] font-semibold text-ink-faint">{shapeSummary(zone)}</span>
              {zoneHasShape(zone) && (
                <button
                  type="button"
                  onClick={() => update(i, { center: null, radiusKm: null, polygon: null })}
                  className="text-[12px] font-semibold text-red-600"
                >
                  Remove area
                </button>
              )}
            </div>

            {mapFor === zone.id && (
              <div className="mt-2">
                <AreaEditor
                  origin={origin}
                  value={{ center: zone.center, radiusKm: zone.radiusKm, polygon: zone.polygon }}
                  onChange={(shape) => update(i, shape)}
                  // The other zones, drawn faintly — a vendor setting up "2km ৳60, 5km
                  // ৳120" needs to see the rings against each other to get them right.
                  siblings={zones
                    .filter((z) => z.id !== zone.id && zoneHasShape(z))
                    .map((z) => ({ label: z.label, shape: { center: z.center, radiusKm: z.radiusKm, polygon: z.polygon } }))}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {dirty && (
        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => setZones(initial)} className="btn-ghost h-10 min-h-0 flex-1 text-sm">
            Discard
          </button>
          <button onClick={save} disabled={busy} className="btn-brand h-10 min-h-0 flex-1 text-sm">
            Save areas
          </button>
        </div>
      )}
    </section>
  );
}

/** What this zone's map area amounts to, in one phrase. */
function shapeSummary(zone: DeliveryZone): string {
  if ((zone.polygon?.length ?? 0) >= 3) return `Drawn area · ${zone.polygon!.length} points`;
  if (zone.center && (zone.radiusKm ?? 0) > 0) return `${zone.radiusKm} km around your pin`;
  return 'Everywhere (no map limit)';
}

/**
 * Money is stored in poisha and shown in taka. The conversion lives here so no caller can
 * accidentally send ৳60 as 60 poisha and undercharge every delivery by a factor of 100.
 */
function MoneyField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (poisha: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <span className="flex items-center rounded-xl border border-surface-line bg-white focus-within:border-brand">
        <span className="pl-3 text-sm text-ink-faint">৳</span>
        <input
          type="number"
          min={0}
          className="h-9 w-0 flex-1 bg-transparent px-2 text-sm tabular-nums outline-none"
          value={value / 100}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value || 0) * 100)))}
        />
      </span>
      <span className="mt-0.5 block text-[11px] text-ink-faint">
        {hint ?? formatBDT(value)}
      </span>
    </label>
  );
}

function IconButton({
  children, label, onClick, disabled, danger,
}: {
  children: React.ReactNode; label: string; onClick: () => void;
  disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-9 w-9 place-items-center rounded-lg transition disabled:opacity-30 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-ink-muted hover:bg-white'
      }`}
    >
      {children}
    </button>
  );
}
