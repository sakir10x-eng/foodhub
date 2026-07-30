'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  formatBDT,
  type ComboDto,
  type PublicCategory,
  type PublicProduct,
  type PublicTenant,
} from '@foodhub/shared';
import { Dish } from './Media';
import { Icon } from './Icon';
import { ModifierSheet } from './ModifierSheet';
import { CartSheet, useBasketSheet } from './CartSheet';
import { toast } from './Toast';
import { lineKey, useCart } from '../lib/cart';

/**
 * The menu. Rendered from a server-fetched, edge-cached payload, then made interactive
 * here — the list itself is HTML on first paint, so the food is visible before any JS
 * has run.
 */
export function Menu({
  tenant,
  categories,
  combos = [],
}: {
  tenant: PublicTenant;
  categories: PublicCategory[];
  combos?: ComboDto[];
}) {
  const [active, setActive] = useState(categories[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const sections = useRef(new Map<string, HTMLElement>());
  const rail = useRef<HTMLUListElement>(null);

  /*
   * Menu search.
   *
   * Purely client-side: the whole menu is already in memory from the cached payload, so a
   * round-trip per keystroke would be slower and would cost the vendor nothing but load.
   * Matching covers name and description, because "spicy" is in the description of three
   * dishes and in the name of none.
   */
  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    const needle = query.trim().toLowerCase();
    return categories
      .flatMap((c) => c.products)
      .filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(needle));
  }, [categories, query, searching]);

  // Highlight the category whose section is currently under the sticky rail.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-64px 0px -70% 0px', threshold: 0 },
    );
    sections.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [categories, searching]);

  // Keep the active chip on screen: with eight categories the one you are reading is
  // otherwise scrolled off the left of the rail with no way to know it is selected.
  useEffect(() => {
    const chip = rail.current?.querySelector<HTMLElement>('[data-on="true"]');
    if (chip) rail.current?.scrollTo({ left: Math.max(0, chip.offsetLeft - 100), behavior: 'smooth' });
  }, [active]);

  return (
    <>
      {combos.length > 0 && !searching && <ComboStrip tenant={tenant} combos={combos} />}

      {/* Above the sticky rail rather than inside it: a rail that grows a text field when
          scrolled is a moving target on a phone. */}
      <label className="mt-3.5 flex items-center gap-2.5 rounded-xl border border-surface-edge bg-white px-3 focus-within:border-brand">
        <Icon name="search" size={17} className="shrink-0 text-ink-faint" strokeWidth={2} />
        <input
          id="menu-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${tenant.name}`}
          className="h-11 w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
        />
        {searching && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-ink-faint">
            <Icon name="close" size={15} strokeWidth={2.2} />
          </button>
        )}
      </label>

      {searching ? (
        <div className="py-4">
          <p className="mb-2 text-[13px] text-ink-muted">
            {results.length === 0
              ? `Nothing on the menu matches “${query.trim()}”.`
              : `${results.length} ${results.length === 1 ? 'item' : 'items'} for “${query.trim()}”`}
          </p>
          <ul className="divide-y divide-surface-line">
            {results.map((product) => (
              <li key={product.id}>
                <Row tenant={tenant} product={product} priority={false} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <nav className="no-bar sticky top-0 z-20 -mx-3 mt-1 border-b border-surface-edge bg-surface-page/95 px-3 backdrop-blur">
            <ul ref={rail} className="no-bar flex gap-1.5 overflow-x-auto py-2.5" style={{ touchAction: 'pan-x' }}>
              {categories.map((c) => (
                <li key={c.id}>
                  <a
                    href={`#${c.id}`}
                    data-on={active === c.id}
                    className={clsx(
                      'inline-block whitespace-nowrap rounded-full border px-3.5 py-2 text-[13.5px] font-semibold transition',
                      active === c.id
                        ? 'border-ink bg-ink text-white'
                        : 'border-surface-edge bg-white text-ink-muted',
                    )}
                  >
                    {c.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="pb-2">
            {categories.map((category, ci) => (
              <section
                key={category.id}
                id={category.id}
                ref={(el) => {
                  if (el) sections.current.set(category.id, el);
                }}
                className="scroll-mt-14 pt-5"
              >
                <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
                  {category.name}
                  <span className="text-[12px] font-semibold text-ink-faint">
                    {category.products.length} items
                  </span>
                </h2>
                <ul className="mt-1 divide-y divide-surface-line">
                  {category.products.map((product, pi) => (
                    <li key={product.id}>
                      <Row tenant={tenant} product={product} priority={ci === 0 && pi < 3} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Bundles, above the menu.
 *
 * A combo is a fixed price for a fixed set, so it adds its parts to the cart as ordinary
 * lines tagged with the bundle name — the kitchen sees the dishes it has to cook, not an
 * opaque "Combo #3", and the saving is applied as the price the vendor set.
 */
function ComboStrip({ tenant, combos }: { tenant: PublicTenant; combos: ComboDto[] }) {
  const add = useCart((s) => s.add);

  return (
    <section aria-label="Meal deals" className="pt-4">
      <h2 className="text-[17px] font-bold tracking-tight">Meal deals</h2>
      <ul className="rail mt-2">
        {combos.map((combo) => (
          <li key={combo.id} className="w-56 shrink-0 snap-start">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-surface-edge bg-white shadow-card">
              <div className="relative h-24 bg-surface-sunk">
                <Dish image={combo.image} alt={combo.name} sizes="224px" className="h-full w-full" />
                {combo.saving > 0 && (
                  <span className="absolute left-2 top-2 rounded-md bg-brand px-1.5 py-0.5 text-[10.5px] font-extrabold text-white">
                    Save {formatBDT(combo.saving)}
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col p-2.5">
                <p className="text-[13.5px] font-bold leading-tight">{combo.name}</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">
                  {combo.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}
                </p>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="text-[14.5px] font-extrabold tabular-nums">
                    {formatBDT(combo.price)}
                    {combo.saving > 0 && (
                      <span className="ml-1.5 text-[11.5px] font-medium text-ink-faint line-through">
                        {formatBDT(combo.partsTotal)}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={!tenant.isOpen}
                    onClick={() => {
                      // The bundle price is spread across its lines so the cart total
                      // matches what the card promised, down to the poisha. The remainder
                      // from the division lands on the last line rather than being lost.
                      const totalQty = combo.items.reduce((a, i) => a + i.qty, 0);
                      const per = Math.floor(combo.price / totalQty);
                      let allocated = 0;
                      let replacedAnother = false;
                      combo.items.forEach((item, idx) => {
                        const isLast = idx === combo.items.length - 1;
                        const unit = isLast ? Math.round((combo.price - allocated) / item.qty) : per;
                        allocated += unit * item.qty;
                        const result = add(
                          { id: tenant.id, name: tenant.name, slug: tenant.slug },
                          {
                            productId: item.productId,
                            name: item.name,
                            price: unit,
                            imageUrl: null,
                            comboName: combo.name,
                          },
                          item.qty,
                        );
                        // Only the first line can displace another vendor's basket; the
                        // rest are landing in a basket this bundle already owns.
                        if (idx === 0 && result === 'replaced') replacedAnother = true;
                      });
                      if (replacedAnother) toast(`Your basket now holds ${tenant.name} only`);
                      if (navigator.vibrate) navigator.vibrate(8);
                    }}
                    className="btn-brand h-8 min-h-0 rounded-lg px-3 text-[12.5px]"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({
  tenant,
  product,
  priority,
}: {
  tenant: PublicTenant;
  product: PublicProduct;
  priority: boolean;
}) {
  const add = useCart((s) => s.add);
  const setQty = useCart((s) => s.setQty);
  const [bumped, setBumped] = useState(false);
  // Total across every variant of this dish, so a row showing "2" means two of it in the
  // basket whether or not they were configured differently.
  const qty = useCart((s) =>
    s.lines.filter((l) => l.productId === product.id).reduce((a, l) => a + l.qty, 0),
  );
  const plainLine = useCart((s) =>
    s.lines.find((l) => l.productId === product.id && !(l.optionIds?.length) && !l.comboName),
  );

  const [sheetOpen, setSheetOpen] = useState(false);

  const disabled = !product.isAvailable || !tenant.isOpen;
  const hasChoices = (product.modifierGroups?.length ?? 0) > 0;

  const onAdd = () => {
    if (disabled) return;
    // A dish with choices cannot be added in one tap — the vendor's required groups have
    // to be answered, and guessing on the customer's behalf produces wrong orders.
    if (hasChoices) {
      setSheetOpen(true);
      return;
    }
    // Optimistic: the UI updates on this tick. Nothing is awaited.
    const result = add(
      { id: tenant.id, name: tenant.name, slug: tenant.slug },
      { productId: product.id, name: product.name, price: product.price, imageUrl: product.image?.url ?? null },
    );
    // Silently wiping a basket built at another restaurant is the one cart behaviour a
    // customer cannot see happen, so it is the one that gets said out loud.
    if (result === 'replaced') toast(`Your basket now holds ${tenant.name} only`);
    setBumped(true);
    setTimeout(() => setBumped(false), 320);
    if (navigator.vibrate) navigator.vibrate(8);
  };

  return (
    <div className={clsx('flex items-start gap-3 py-3.5', disabled && 'opacity-55')}>
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15.5px] font-bold leading-tight">
          {product.name}
          {product.popular && !disabled && (
            <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-brand">
              Popular
            </span>
          )}
        </h3>
        {product.description && (
          <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-muted">
            {product.description}
          </p>
        )}

        {/* What the people who actually ate this said. Only appears once enough of them
            have — the API withholds the figure below five votes rather than let a dish
            wear "100% (1)". */}
        {product.approval && (
          <p className="mt-1.5 text-[11.5px] font-bold text-emerald-700">
            👍 {product.approval.percent}%{' '}
            <span className="font-semibold text-ink-faint">({product.approval.count})</span>
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[15.5px] font-extrabold tabular-nums">
            {hasChoices && <span className="text-[12.5px] font-semibold text-ink-faint">from </span>}
            {formatBDT(product.price)}
          </span>
          {/* Both halves of the claim or neither: the old price alone makes a reader do
              the subtraction, and the saving alone is a number with nothing to check. */}
          {product.compareAtPrice != null && product.compareAtPrice > product.price && (
            <>
              <span className="text-[12.5px] font-semibold text-ink-faint line-through tabular-nums">
                {formatBDT(product.compareAtPrice)}
              </span>
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-extrabold text-emerald-700">
                Save {formatBDT(product.compareAtPrice - product.price)}
              </span>
            </>
          )}
        </div>
        {!product.isAvailable && <p className="mt-1 text-[12px] font-semibold text-ink-faint">Sold out</p>}
      </div>

      <div className="relative h-[104px] w-[104px] shrink-0">
        <Dish
          image={product.image}
          alt={product.name}
          priority={priority}
          sizes="104px"
          className="h-full w-full rounded-xl"
        />
        {qty === 0 ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={disabled}
            aria-label={`Add ${product.name}`}
            className={clsx(
              'dish-ctrl w-9 justify-center border border-surface-edge bg-white text-[22px] font-normal leading-none text-brand transition active:scale-90',
              bumped && 'animate-bump',
            )}
          >
            +
          </button>
        ) : (
          <div className="dish-ctrl bg-brand text-white shadow-pill">
            <button
              type="button"
              onClick={() => plainLine && setQty(lineKey(plainLine), plainLine.qty - 1)}
              disabled={!plainLine}
              aria-label={`Remove one ${product.name}`}
              className="grid h-9 w-[30px] place-items-center rounded-l-xl text-[18px] leading-none disabled:opacity-40"
            >
              −
            </button>
            <span className="min-w-[16px] text-center text-[13.5px] font-extrabold tabular-nums">{qty}</span>
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Add one ${product.name}`}
              className="grid h-9 w-[30px] place-items-center rounded-r-xl text-[18px] leading-none"
            >
              +
            </button>
          </div>
        )}
      </div>

      {sheetOpen && (
        <ModifierSheet
          product={product}
          onClose={() => setSheetOpen(false)}
          onAdd={(choice) => {
            const result = add(
              { id: tenant.id, name: tenant.name, slug: tenant.slug },
              {
                productId: product.id,
                name: product.name,
                price: choice.unitPrice,
                imageUrl: product.image?.url ?? null,
                optionIds: choice.optionIds,
                modifierSummary: choice.summary,
              },
            );
            if (result === 'replaced') toast(`Your basket now holds ${tenant.name} only`);
            setSheetOpen(false);
            setBumped(true);
            setTimeout(() => setBumped(false), 320);
            if (navigator.vibrate) navigator.vibrate(8);
          }}
        />
      )}
    </div>
  );
}

/**
 * The floating basket.
 *
 * A pill rather than a full-width bar: it is the only route to checkout so it has to stay
 * under the thumb, but it also sits on top of the last menu row, and a solid bar across
 * the bottom hides a dish rather than floating over it. Tapping it opens the basket in
 * place — a customer checking what they have added should not have to leave the menu and
 * find their way back.
 */
export function CartBar({ tenant }: { tenant?: PublicTenant }) {
  const lines = useCart((s) => s.lines);
  const open = useBasketSheet((s) => s.open);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
  const [mounted, setMounted] = useState(false);

  // Cart lives in localStorage, so render it only after hydration to avoid a mismatch.
  useEffect(() => setMounted(true), []);

  return (
    <>
      {mounted && count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(14px,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={open}
            className="animate-slide-up flex w-full max-w-[420px] items-center gap-3 rounded-[15px] bg-brand px-4 py-3 text-white shadow-pill transition active:scale-[.99]"
          >
            <span className="grid h-6 min-w-6 place-items-center rounded-lg bg-white px-1.5 text-[13px] font-extrabold tabular-nums text-brand">
              {count}
            </span>
            <span className="flex-1 text-left text-[15px] font-bold">View basket</span>
            <span className="text-[16px] font-extrabold tabular-nums">{formatBDT(subtotal)}</span>
          </button>
        </div>
      )}
      <CartSheet tenant={tenant} />
    </>
  );
}
