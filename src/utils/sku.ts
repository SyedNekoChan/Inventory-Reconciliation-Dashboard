/**
 * SKU normalization and similarity.
 *
 * Normalization exists ONLY for lookup and suggestion purposes. The complete
 * original SKU is always what gets stored and displayed — nothing here ever
 * rewrites a stored SKU value.
 */

/** Case/whitespace/separator-insensitive form used for safe exact-ish matching. */
export function normalizeSku(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[‐-―]/g, '-');
}

/** Aggressive form: strips every non-alphanumeric character. */
export function compactSku(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Strips a trailing marketplace listing suffix to recover the probable base SKU.
 *
 * Marketplace listings for one master SKU commonly differ only by a trailing
 * variant tag, e.g. for master `TP Link Archer_T7+AA`:
 *   TP Link Archer_T7+AA_1, _2, _01, _02, _1A, _2A, -3, #4
 *
 * Only a short, variant-looking tail is removed. Returns null when nothing
 * suffix-like was found, so callers can tell "stripped" from "unchanged".
 */
export function stripListingSuffix(raw: string): string | null {
  const trimmed = raw.trim();
  // _1 / _01 / _1A / -2B / #3 / .04  — digits, optionally followed by 1-2 letters
  const match = trimmed.match(/^(.*?)[\s._\-#]+(\d{1,3}[a-zA-Z]{0,2}|[a-zA-Z]{1,2}\d{1,3})$/);
  if (!match || !match[1]) return null;
  const base = match[1].trim();
  // Guard against chopping a short SKU down to nothing meaningful.
  if (base.length < 3) return null;
  return base;
}

/** All plausible base-SKU candidates for a marketplace SKU, best first. */
export function baseSkuCandidates(raw: string): string[] {
  const out: string[] = [raw.trim()];
  let current = raw.trim();
  // Peel up to two suffix levels (e.g. ABC_1_2).
  for (let i = 0; i < 2; i += 1) {
    const stripped = stripListingSuffix(current);
    if (!stripped || out.includes(stripped)) break;
    out.push(stripped);
    current = stripped;
  }
  return out;
}

/** Damerau-free Levenshtein distance with an early-exit ceiling. */
export function levenshtein(a: string, b: string, ceiling = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0] as number;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > ceiling) return ceiling + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] as number;
}

/** Similarity in 0..1 based on normalized edit distance. */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const longest = Math.max(a.length, b.length);
  const distance = levenshtein(a, b);
  return 1 - distance / longest;
}

/**
 * Scores a marketplace SKU against a candidate master SKU.
 * Returns 0..1. High scores are reserved for structurally safe matches.
 */
export function scoreSkuMatch(listingSku: string, masterSku: string): number {
  const nl = normalizeSku(listingSku);
  const nm = normalizeSku(masterSku);
  if (nl === nm) return 1;

  const cl = compactSku(listingSku);
  const cm = compactSku(masterSku);
  if (cl === cm) return 0.99;

  // A listing whose base SKU equals the master is a very strong signal.
  for (const candidate of baseSkuCandidates(listingSku)) {
    if (normalizeSku(candidate) === nm) return 0.97;
    if (compactSku(candidate) === cm) return 0.95;
  }

  // Master is a prefix of the listing: typical suffixed-variant shape.
  if (cl.startsWith(cm) && cm.length >= 4) {
    const extra = cl.length - cm.length;
    if (extra <= 4) return 0.93 - extra * 0.01;
  }

  return similarity(cl, cm);
}
