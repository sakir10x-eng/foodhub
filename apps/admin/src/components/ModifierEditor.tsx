'use client';

import { useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { adminApi } from '../lib/auth';
import { Icon } from './Icon';

interface Option { id?: string; name: string; priceDelta: number; isAvailable: boolean }
interface Group { id?: string; name: string; minSelect: number; maxSelect: number; options: Option[] }

/**
 * The choices a dish offers: "Size", "Extras", "Spice level".
 *
 * Presented as two behaviours rather than four numbers, because `minSelect`/`maxSelect` is
 * how the server thinks and not how a restaurant owner does. A vendor picks "customer must
 * choose one" or "customer can add any" and the limits follow — the full numeric form is
 * one click away for the rare group that needs "pick up to 3".
 *
 * Saved as a whole set: partial edits are what produce a menu with two "Large" rows.
 */
export function ModifierEditor({ productId, onClose }: { productId: string; onClose: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi<Group[]>(`/vendor/menu/products/${productId}/modifiers`)
      .then((rows) =>
        setGroups(
          rows.map((g) => ({
            id: g.id,
            name: g.name,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            options: g.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, isAvailable: o.isAvailable })),
          })),
        ),
      )
      .catch((e) => setError((e as Error).message));
  }, [productId]);

  const save = async () => {
    if (!groups) return;
    setBusy(true);
    setError(null);
    try {
      const cleaned = groups
        .map((g) => ({ ...g, name: g.name.trim(), options: g.options.filter((o) => o.name.trim()) }))
        .filter((g) => g.name && g.options.length > 0);
      await adminApi(`/vendor/menu/products/${productId}/modifiers`, {
        method: 'PUT',
        body: JSON.stringify({ groups: cleaned }),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Group>) =>
    setGroups((gs) => gs!.map((g, idx) => (idx === i ? { ...g, ...patch } : g)));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choices for this item"
        className="relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-surface shadow-2xl sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-line px-4 py-3">
          <h2 className="font-bold">Choices</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-muted">
            <Icon name="close" size={18} strokeWidth={2.2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="text-sm text-ink-muted">
            Sizes, extras and options. Every choice can add to the price — this is the main
            way an average order gets bigger.
          </p>

          {!groups ? (
            <div className="mt-4 space-y-2">
              {[0, 1].map((i) => <div key={i} className="skeleton h-24 w-full rounded-xl" />)}
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {groups.map((group, gi) => (
                <div key={gi} className="rounded-xl border border-surface-line bg-white p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="field h-9 min-h-0 flex-1 py-0 text-sm"
                      placeholder="e.g. Size"
                      value={group.name}
                      onChange={(e) => update(gi, { name: e.target.value })}
                    />
                    <button
                      type="button"
                      aria-label="Remove this group"
                      onClick={() => setGroups((gs) => gs!.filter((_, i) => i !== gi))}
                      className="grid h-9 w-9 place-items-center rounded-lg text-red-600 hover:bg-red-50"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>

                  {/* The two shapes a vendor actually thinks in. */}
                  <div className="mt-2 flex gap-1 rounded-lg bg-surface-sunk p-1">
                    <ModeButton
                      on={group.minSelect === 1 && group.maxSelect === 1}
                      onClick={() => update(gi, { minSelect: 1, maxSelect: 1 })}
                      label="Must choose one"
                    />
                    <ModeButton
                      on={!(group.minSelect === 1 && group.maxSelect === 1)}
                      onClick={() => update(gi, { minSelect: 0, maxSelect: Math.max(2, group.options.length) })}
                      label="Can add any"
                    />
                  </div>

                  <div className="mt-2 flex flex-col gap-1.5">
                    {group.options.map((option, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input
                          className="field h-9 min-h-0 flex-1 py-0 text-sm"
                          placeholder="e.g. Large"
                          value={option.name}
                          onChange={(e) =>
                            update(gi, {
                              options: group.options.map((o, i) => (i === oi ? { ...o, name: e.target.value } : o)),
                            })
                          }
                        />
                        <span className="flex w-28 items-center rounded-xl border border-surface-line bg-white focus-within:border-brand">
                          <span className="pl-2 text-xs text-ink-faint">+৳</span>
                          <input
                            type="number"
                            min={0}
                            className="h-9 w-0 flex-1 bg-transparent px-1.5 text-sm tabular-nums outline-none"
                            value={option.priceDelta / 100}
                            onChange={(e) =>
                              update(gi, {
                                options: group.options.map((o, i) =>
                                  i === oi
                                    ? { ...o, priceDelta: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) }
                                    : o,
                                ),
                              })
                            }
                          />
                        </span>
                        <button
                          type="button"
                          aria-label="Remove this option"
                          onClick={() =>
                            update(gi, { options: group.options.filter((_, i) => i !== oi) })
                          }
                          className="grid h-9 w-9 place-items-center rounded-lg text-ink-faint hover:bg-surface-sunk"
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      update(gi, { options: [...group.options, { name: '', priceDelta: 0, isAvailable: true }] })
                    }
                    className="btn-ghost mt-2 h-8 min-h-0 gap-1 px-2 text-[13px]"
                  >
                    <Icon name="plus" size={13} /> Option
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() =>
                  setGroups((gs) => [
                    ...gs!,
                    { name: '', minSelect: 1, maxSelect: 1, options: [{ name: '', priceDelta: 0, isAvailable: true }] },
                  ])
                }
                className="btn-ghost h-10 min-h-0 gap-1.5 text-sm"
              >
                <Icon name="plus" size={15} /> Add a group of choices
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
        </div>

        <div className="flex shrink-0 gap-2 border-t border-surface-line p-4">
          <button onClick={onClose} className="btn-ghost h-11 min-h-0 flex-1 text-sm">Cancel</button>
          <button onClick={save} disabled={busy || !groups} className="btn-brand h-11 min-h-0 flex-1 text-sm">
            {busy ? 'Saving…' : 'Save choices'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex-1 rounded-md px-2 py-1.5 text-[12.5px] font-semibold transition ${
        on ? 'bg-white text-ink shadow-card' : 'text-ink-muted'
      }`}
    >
      {label}
    </button>
  );
}

/** Compact read-only summary for the menu list row. */
export function ModifierSummary({ groups }: { groups: { name: string; options: { priceDelta: number }[] }[] }) {
  if (groups.length === 0) return null;
  const top = Math.max(...groups.flatMap((g) => g.options.map((o) => o.priceDelta)), 0);
  return (
    <span className="text-[11.5px] text-ink-faint">
      {groups.length} choice{groups.length === 1 ? '' : 's'}
      {top > 0 && <> · up to +{formatBDT(top)}</>}
    </span>
  );
}
