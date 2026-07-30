'use client';

import { useMemo, useState } from 'react';
import { formatBDT, type ModifierGroupDto, type PublicProduct } from '@foodhub/shared';
import { Dish } from './Media';
import { Icon } from './Icon';

export interface ModifierChoice {
  optionIds: string[];
  /** Unit price with the chosen options added — what the cart line will cost. */
  unitPrice: number;
  /** "Large · Extra cheese" for the cart row. */
  summary: string;
}

/**
 * The sheet that opens when a dish has choices to make.
 *
 * Groups behave differently depending on how the vendor configured them: `maxSelect: 1`
 * is a radio (size), anything higher is a checkbox list (extras). Rather than storing a
 * separate "type" the vendor has to understand, the behaviour is derived from the limits
 * they already set — one fewer concept in the admin panel, one fewer way to configure a
 * contradiction.
 *
 * The button stays disabled until every required group is satisfied, and it says what is
 * missing rather than just being grey.
 */
export function ModifierSheet({
  product,
  onClose,
  onAdd,
}: {
  product: PublicProduct;
  onClose: () => void;
  onAdd: (choice: ModifierChoice) => void;
}) {
  const groups = product.modifierGroups ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);

  const toggle = (group: ModifierGroupDto, optionId: string) => {
    setPicked((prev) => {
      const current = prev[group.id] ?? [];
      if (group.maxSelect === 1) {
        // A single-choice group swaps rather than accumulates, and tapping the chosen one
        // again clears it only if the group is optional.
        const next = current[0] === optionId && group.minSelect === 0 ? [] : [optionId];
        return { ...prev, [group.id]: next };
      }
      if (current.includes(optionId)) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }
      if (current.length >= group.maxSelect) return prev; // at the limit — ignore, don't swap
      return { ...prev, [group.id]: [...current, optionId] };
    });
  };

  const { unitPrice, summary, missing } = useMemo(() => {
    let price = product.price;
    const labels: string[] = [];
    const unmet: string[] = [];

    for (const group of groups) {
      const chosen = picked[group.id] ?? [];
      if (chosen.length < group.minSelect) unmet.push(group.name);
      for (const id of chosen) {
        const option = group.options.find((o) => o.id === id);
        if (!option) continue;
        price += option.priceDelta;
        labels.push(option.name);
      }
    }
    return { unitPrice: price, summary: labels.join(' · '), missing: unmet };
  }, [groups, picked, product.price]);

  const optionIds = Object.values(picked).flat();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={product.name}
        className="relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl"
      >
        <div className="relative h-36 shrink-0 bg-surface-sunk">
          <Dish image={product.image} alt="" sizes="512px" className="h-full w-full" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-ink shadow-card backdrop-blur"
          >
            <Icon name="close" size={17} strokeWidth={2.2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3.5">
          <h2 className="text-lg font-extrabold leading-tight">{product.name}</h2>
          {product.description && (
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{product.description}</p>
          )}

          <div className="mt-4 flex flex-col gap-4">
            {groups.map((group) => {
              const chosen = picked[group.id] ?? [];
              const required = group.minSelect > 0;
              return (
                <fieldset key={group.id} className="border-0 p-0">
                  <legend className="mb-2 flex w-full items-baseline justify-between gap-2">
                    <span className="text-[15px] font-bold">{group.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        required && chosen.length < group.minSelect
                          ? 'bg-brand/10 text-brand'
                          : 'bg-surface-sunk text-ink-faint'
                      }`}
                    >
                      {required ? 'Required' : group.maxSelect > 1 ? `Up to ${group.maxSelect}` : 'Optional'}
                    </span>
                  </legend>

                  <div className="flex flex-col gap-1.5">
                    {group.options.map((option) => {
                      const on = chosen.includes(option.id);
                      const atLimit = !on && chosen.length >= group.maxSelect && group.maxSelect > 1;
                      return (
                        <label
                          key={option.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                            on ? 'border-brand bg-brand/5' : 'border-surface-line'
                          } ${atLimit ? 'opacity-45' : ''}`}
                        >
                          <input
                            type={group.maxSelect === 1 ? 'radio' : 'checkbox'}
                            name={group.id}
                            checked={on}
                            disabled={atLimit}
                            onChange={() => toggle(group, option.id)}
                            className="accent-[rgb(var(--brand))]"
                          />
                          <span className="min-w-0 flex-1 text-[14px]">{option.name}</span>
                          {option.priceDelta > 0 && (
                            <span className="text-[13px] font-semibold tabular-nums text-ink-muted">
                              +{formatBDT(option.priceDelta)}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 border-t border-surface-line bg-white/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-full border border-surface-line px-1">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label="One less"
                className="grid h-8 w-8 place-items-center rounded-full text-ink-muted active:scale-90"
              >
                −
              </button>
              <span className="w-5 text-center text-sm font-bold tabular-nums">{qty}</span>
              <button
                type="button"
                onClick={() => setQty((q) => Math.min(50, q + 1))}
                aria-label="One more"
                className="grid h-8 w-8 place-items-center rounded-full text-brand active:scale-90"
              >
                +
              </button>
            </div>

            <button
              onClick={() => onAdd({ optionIds, unitPrice, summary })}
              disabled={missing.length > 0}
              className="btn-brand h-12 min-h-0 flex-1 justify-between disabled:opacity-50"
            >
              {/* Naming what is missing beats a grey button with no explanation. */}
              <span>{missing.length ? `Choose ${missing[0].toLowerCase()}` : 'Add to cart'}</span>
              {missing.length === 0 && (
                <span className="tabular-nums">{formatBDT(unitPrice * qty)}</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
