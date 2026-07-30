'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT, taka } from '@foodhub/shared';
import { adminApi, uploadImage } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';
import { ModifierEditor } from '../../components/ModifierEditor';

interface Category { id: string; name: string; sortOrder: number; _count?: { products: number } }
interface Product {
  id: string; categoryId: string | null; name: string; description: string; price: number;
  compareAtPrice?: number | null;
  isAvailable: boolean; listedOnMarketplace: boolean; sortOrder: number;
  image: { id: string; url: string; blurhash: string | null } | null;
}

export default function MenuPage() {
  return (
    <Shell>
      <MenuManager />
    </Shell>
  );
}

function MenuManager() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const [choicesFor, setChoicesFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        adminApi<Category[]>('/vendor/menu/categories'),
        adminApi<Product[]>('/vendor/menu/products'),
      ]);
      setCategories(c);
      setProducts(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Availability is the control a vendor touches most — mid-service, one-handed, when
   * something runs out. It is optimistic and reverts if the server disagrees.
   */
  const toggleAvailability = async (product: Product) => {
    const next = !product.isAvailable;
    setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, isAvailable: next } : p)));
    try {
      await adminApi(`/vendor/menu/products/${product.id}/availability`, {
        method: 'POST',
        body: JSON.stringify({ isAvailable: next }),
      });
    } catch (err) {
      setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, isAvailable: !next } : p)));
      setError((err as Error).message);
    }
  };

  const addCategory = async () => {
    const name = window.prompt('Category name');
    if (!name?.trim()) return;
    try {
      await adminApi('/vendor/menu/categories', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), sortOrder: categories.length }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const archive = async (product: Product) => {
    if (!window.confirm(`Remove "${product.name}" from the menu?`)) return;
    try {
      await adminApi(`/vendor/menu/products/${product.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const grouped = [
    ...categories.map((c) => ({ category: c, items: products.filter((p) => p.categoryId === c.id) })),
    { category: { id: 'none', name: 'Uncategorised', sortOrder: 9999 }, items: products.filter((p) => !p.categoryId) },
  ].filter((g) => g.items.length > 0 || g.category.id !== 'none');

  return (
    <>
      <PageHeader
        title="Menu"
        action={
          <div className="flex gap-2">
            <button onClick={addCategory} className="btn-ghost h-10 min-h-0 px-3 text-sm">Category</button>
            <button onClick={() => setEditing({ isAvailable: true, listedOnMarketplace: true })}
                    className="btn-brand h-10 min-h-0 px-3 text-sm">Add item</button>
          </div>
        }
      />

      <div className="space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}

        {loading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-20 w-full rounded-2xl" />)}
          </div>
        )}

        {!loading && products.length === 0 && (
          <Banner>Your menu is empty. Add your first item to open for orders.</Banner>
        )}

        {grouped.map(({ category, items }) => (
          <section key={category.id}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-faint">
              {category.name} <span className="font-normal normal-case">({items.length})</span>
            </h2>
            <ul className="space-y-2">
              {items.map((product) => (
                <li key={product.id}
                    className="flex items-center gap-3 rounded-2xl border border-surface-line bg-white p-3 shadow-card">
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-surface-sunk">
                    {product.image && (
                      <img src={`${product.image.url}-160.webp`} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{product.name}</p>
                    <p className="text-sm text-ink-muted tabular-nums">{formatBDT(product.price)}</p>
                    {!product.listedOnMarketplace && (
                      <p className="text-xs text-ink-faint">own store only</p>
                    )}
                  </div>
                  <button
                    onClick={() => toggleAvailability(product)}
                    aria-pressed={product.isAvailable}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                      product.isAvailable ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-sunk text-ink-muted'
                    }`}
                  >
                    {product.isAvailable ? 'In stock' : 'Sold out'}
                  </button>
                  {/* Choices are where average order value comes from, so the entry point
                      sits on the row rather than two levels down inside Edit. */}
                  <button
                    onClick={() => setChoicesFor(product.id)}
                    className="px-2 text-sm font-semibold text-ink-muted hover:text-brand"
                  >
                    Choices
                  </button>
                  <button onClick={() => setEditing(product)} className="px-2 text-sm font-semibold text-brand">Edit</button>
                  <button onClick={() => archive(product)} aria-label={`Remove ${product.name}`}
                          className="px-1 text-ink-faint">×</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {choicesFor && (
        <ModifierEditor productId={choicesFor} onClose={() => setChoicesFor(null)} />
      )}

      {editing && (
        <ProductDialog
          product={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </>
  );
}

function ProductDialog({
  product, categories, onClose, onSaved,
}: {
  product: Partial<Product>;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: product.name ?? '',
    description: product.description ?? '',
    // Prices are entered in taka and stored in poisha; the conversion happens once, here.
    priceTaka: product.price ? String(product.price / 100) : '',
    compareAtTaka: product.compareAtPrice ? String(product.compareAtPrice / 100) : '',
    categoryId: product.categoryId ?? categories[0]?.id ?? '',
    isAvailable: product.isAvailable ?? true,
    listedOnMarketplace: product.listedOnMarketplace ?? true,
    imageId: product.image?.id ?? null as string | null,
  });
  const [preview, setPreview] = useState(product.image?.url ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async (file: File) => {
    setBusy(true);
    try {
      const image = await uploadImage(file);
      setForm((f) => ({ ...f, imageId: image.id }));
      setPreview(image.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        price: taka(Number(form.priceTaka)),
        // Blank means "no offer", not zero — sending 0 would be a claim that the item
        // used to be free, and the API refuses anything at or below the live price.
        compareAtPrice: form.compareAtTaka.trim() ? taka(Number(form.compareAtTaka)) : null,
        categoryId: form.categoryId || null,
        isAvailable: form.isAvailable,
        listedOnMarketplace: form.listedOnMarketplace,
        imageId: form.imageId,
      };
      if (product.id) {
        await adminApi(`/vendor/menu/products/${product.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await adminApi('/vendor/menu/products', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-end bg-ink/40 sm:place-items-center" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        className="max-h-[92dvh] w-full max-w-md animate-pop-in overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
      >
        <h2 className="text-lg font-bold">{product.id ? 'Edit item' : 'New item'}</h2>

        <div className="mt-4 space-y-3">
          <label className="flex cursor-pointer items-center gap-3">
            <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-sunk text-xs text-ink-faint">
              {preview ? <img src={`${preview}-160.webp`} alt="" className="h-full w-full object-cover" /> : 'Photo'}
            </span>
            <span className="text-sm font-medium text-brand">
              {preview ? 'Change photo' : 'Add a photo'}
              <span className="block text-xs font-normal text-ink-faint">
                Resized and converted to WebP/AVIF automatically
              </span>
            </span>
            <input type="file" accept="image/*" className="hidden"
                   onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])} />
          </label>

          <input required className="field" placeholder="Item name" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <textarea className="field" rows={2} placeholder="Short description" value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <input required className="field" type="number" min="0" step="1" inputMode="decimal"
                   placeholder="Price in ৳" value={form.priceTaka}
                   onChange={(e) => setForm({ ...form, priceTaka: e.target.value })} />
            {/* The "was" price. Optional, and only believed when it is higher than what
                you are actually charging — a struck-through number that never was is the
                fastest way to lose a customer who checks. */}
            <input className="field" type="number" min="0" step="1" inputMode="decimal"
                   placeholder="Was ৳ (optional)" value={form.compareAtTaka}
                   onChange={(e) => setForm({ ...form, compareAtTaka: e.target.value })} />
          </div>
          {form.compareAtTaka.trim() && Number(form.compareAtTaka) <= Number(form.priceTaka) && (
            <p className="-mt-1 text-xs font-semibold text-amber-700">
              The old price has to be higher than the price you are charging.
            </p>
          )}
          <select className="field" value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={form.isAvailable} className="accent-[rgb(var(--brand))]"
                   onChange={(e) => setForm({ ...form, isAvailable: e.target.checked })} />
            Available right now
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={form.listedOnMarketplace} className="mt-1 accent-[rgb(var(--brand))]"
                   onChange={(e) => setForm({ ...form, listedOnMarketplace: e.target.checked })} />
            <span>
              Show on the FoodHub marketplace
              <span className="block text-xs text-ink-faint">
                Uncheck to keep this item exclusive to your own site.
              </span>
            </span>
          </label>
        </div>

        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button className="btn-brand flex-1" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
