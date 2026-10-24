export const MICRO_USD_PER_USD = 1_000_000;

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const preciseUsdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** `9_989_916` → "$9.99". For balances. */
export const formatUsd = (microUsd: number) => usdFormat.format(microUsd / MICRO_USD_PER_USD);

/** `84` → "$0.000084". For per-call charges, which are often fractions of a cent. */
export const formatPreciseUsd = (microUsd: number) => preciseUsdFormat.format(microUsd / MICRO_USD_PER_USD);

/** A node's token price: "Free", or "$2.50 per million tokens". */
export const formatTokenPrice = (microUsdPerMillionTokens: number) =>
  microUsdPerMillionTokens === 0 ? 'Free' : `${formatPreciseUsd(microUsdPerMillionTokens)} per million tokens`;

export const formatCents = (cents: number) => usdFormat.format(cents / 100);

// UTC, so server-rendered dates don't depend on the server's time zone. Pages say so.
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** "Oct 23, 2026". */
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

/** "Oct 23, 5:12 AM". */
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

/** A public key is long; show its distinctive tail. */
export const shortKey = (publicKey: string) => `…${publicKey.slice(-12)}`;
