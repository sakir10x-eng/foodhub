/**
 * One inline icon set for the whole panel.
 *
 * Inline SVG rather than an icon font or a package: the set is small, it costs no extra
 * request, it inherits `currentColor`, and there is no flash of missing glyphs. Every
 * icon is drawn on the same 24px grid with a 1.8 stroke so they sit together evenly.
 */
export type IconName =
  | 'home' | 'menu' | 'orders' | 'chart' | 'money' | 'store' | 'globe'
  | 'shield' | 'users' | 'wallet' | 'sparkles' | 'clock' | 'check' | 'alert'
  | 'pause' | 'play' | 'search' | 'chevron' | 'plus' | 'minus' | 'close'
  | 'bike' | 'pin' | 'phone' | 'star' | 'tag' | 'bag'
  | 'copy' | 'gift' | 'lock' | 'cash' | 'bell' | 'calendar' | 'share' | 'back';

const PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10',
  menu: 'M4 6h16M4 12h16M4 18h10',
  orders: 'M5 7h14l-1 13H6L5 7Zm3 0a4 4 0 0 1 8 0',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  money: 'M3 7h18v10H3zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  store: 'M4 9h16l-1 11H5L4 9Zm-1 0 2-5h14l2 5M9 20v-6h6v6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-3 3-3 15 0 18m0-18c3 3 3 15 0 18M3.5 9h17M3.5 15h17',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Zm-3 9 2 2 4-4',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1a4 4 0 0 0-3-3.9',
  wallet: 'M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm14 4h3v3h-3a1.5 1.5 0 0 1 0-3Z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM18 16l.9 2.3 2.3.9-2.3.9L18 22l-.9-2.3-2.3-.9 2.3-.9L18 16Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  check: 'M4 12.5 9 18 20 6',
  alert: 'M12 4 2.5 20h19L12 4Zm0 6v4m0 3h.01',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5 19 12 7 19.5v-15Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4.5-4.5',
  chevron: 'm9 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  bike: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 16l4-9h4l3 9M9 7h5',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z',
  star: 'm12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8L12 4Z',
  tag: 'M3 11V4h7l10 10-7 7L3 11Zm4-3.5h.01',
  bag: 'M6 8h12l-1 12H7L6 8Zm3 0a3 3 0 0 1 6 0',
  copy: 'M9 9h10v12H9V9Zm-4 6H3V3h12v2',
  bell: 'M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3ZM10 22h4',
  calendar: 'M4 7h16v13H4V7Zm0 4h16M8 3v4m8-4v4',
  gift: 'M3 11h18v10H3V11Zm0-4h18v4H3V7Zm9 0v14M12 7S9.5 3 7.5 4.5 9 7 12 7Zm0 0s2.5-4 4.5-2.5S15 7 12 7Z',
  lock: 'M6 11h12v9H6v-9Zm2.5 0V8a3.5 3.5 0 1 1 7 0v3',
  cash: 'M3 7h18v10H3V7Zm9 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 10v.01M18 14v.01',
  share: 'M18 8a2.4 2.4 0 1 0 0-4.8A2.4 2.4 0 0 0 18 8ZM6 14.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM18 20.8a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM8.2 10.9l7.6-4.4M8.2 13.1l7.6 4.4',
  back: 'm15 5-7 7 7 7',
};

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // Decorative by default: the adjacent label is what a screen reader should read.
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
