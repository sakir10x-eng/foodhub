/**
 * Cuisine tags — the marketplace's filter chips.
 *
 * A SUGGESTED list, not an enum: vendors may type their own. Bangladesh's food scene
 * does not fit a fixed taxonomy (কাচ্চি is its own category here in a way it is nowhere
 * else), and a closed enum would mean a migration every time a vendor sells something
 * new. The list below is what the admin panel offers and what the marketplace shows as
 * chips, in the order customers actually look for them.
 */
const suggested = [
  'Biryani',
  'Kacchi',
  'Bangladeshi',
  'Chinese',
  'Fast Food',
  'Burger',
  'Pizza',
  'Kebab',
  'Seafood',
  'Indian',
  'Thai',
  'Desserts',
  'Bakery',
  'Tea & Coffee',
  'Juice',
  'Breakfast',
  'Healthy',
  'Snacks',
] as const;

export const SUGGESTED_CUISINES: readonly string[] = suggested;

/** Bengali labels for the chips. Missing keys fall back to the English tag. */
const cuisineBn: Record<string, string> = {
  Biryani: 'বিরিয়ানি',
  Kacchi: 'কাচ্চি',
  Bangladeshi: 'বাংলাদেশি',
  Chinese: 'চাইনিজ',
  'Fast Food': 'ফাস্ট ফুড',
  Burger: 'বার্গার',
  Pizza: 'পিৎজা',
  Kebab: 'কাবাব',
  Seafood: 'সি-ফুড',
  Indian: 'ইন্ডিয়ান',
  Thai: 'থাই',
  Desserts: 'মিষ্টি',
  Bakery: 'বেকারি',
  'Tea & Coffee': 'চা ও কফি',
  Juice: 'জুস',
  Breakfast: 'নাশতা',
  Healthy: 'হেলদি',
  Snacks: 'স্ন্যাকস',
};

export function cuisineLabel(tag: string, locale: 'en' | 'bn' = 'en'): string {
  return locale === 'bn' ? cuisineBn[tag] ?? tag : tag;
}

/**
 * Normalises what a vendor typed so "fast food", "Fast  Food" and "FAST FOOD" are one
 * chip rather than three. Matching against the suggested list is case-insensitive so a
 * vendor's own capitalisation never splits an existing chip.
 */
export function normaliseCuisine(input: string): string {
  const cleaned = input.trim().replace(/\s+/g, ' ');
  const known = suggested.find((c) => c.toLowerCase() === cleaned.toLowerCase());
  return known ?? cleaned;
}

/** How a marketplace feed may be ordered. `relevance` is the default house ranking. */
export const VENDOR_SORTS = ['relevance', 'rating', 'eta', 'fee', 'distance'] as const;
export type VendorSort = (typeof VENDOR_SORTS)[number];
