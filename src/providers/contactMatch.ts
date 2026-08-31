/**
 * String-similarity primitives and query normalization behind contact search.
 *
 * Deliberately free of filesystem and SQLite access so unit tests can drive
 * every scoring decision directly, without a real AddressBook on the machine.
 * `contacts.ts` owns the data model; this file owns the arithmetic.
 */

// --- Normalization ---

/**
 * Lowercase, strip diacritics, turn punctuation into spaces, collapse runs of
 * whitespace. Every similarity below compares folded strings, so "O'Neil" and
 * "ONeil" differ by one space rather than by a quote.
 */
export function fold(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Folded whitespace-separated tokens; `[]` for an empty/punctuation-only string. */
export function tokens(value: string | null | undefined): string[] {
  const folded = fold(value);
  return folded ? folded.split(" ") : [];
}

/**
 * Character n-grams over the folded, space-stripped string. Character grams
 * rather than word grams so CJK names (no spaces) and one-word organizations
 * are still decomposable. A string shorter than `n` contributes itself.
 */
export function ngrams(value: string | null | undefined, n = 2): Set<string> {
  const flat = fold(value).replace(/\s+/g, "");
  const out = new Set<string>();
  if (flat.length < n) {
    if (flat) out.add(flat);
    return out;
  }
  for (let i = 0; i <= flat.length - n; i++) out.add(flat.slice(i, i + n));
  return out;
}

// --- 1. Levenshtein ---

/** Edit distance between the folded forms, computed on a rolling row. */
export function levenshtein(a: string, b: string): number {
  const s1 = fold(a);
  const s2 = fold(b);
  if (s1 === s2) return 0;
  if (!s1.length || !s2.length) return Math.max(s1.length, s2.length);

  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s1.length; i++) {
    const cur = [i];
    for (let j = 1; j <= s2.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[s2.length];
}

/** Levenshtein distance rescaled to a 0..1 similarity. */
export function levenshteinSimilarity(a: string, b: string): number {
  const longest = Math.max(fold(a).length, fold(b).length);
  return longest ? 1 - levenshtein(a, b) / longest : 0;
}

// --- 2. Jaro-Winkler ---

/** Jaro similarity: matching characters within a sliding window, minus transpositions. */
export function jaro(a: string, b: string): number {
  const s1 = fold(a);
  const s2 = fold(b);
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;

  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const matched1 = new Array<boolean>(s1.length).fill(false);
  const matched2 = new Array<boolean>(s2.length).fill(false);
  let matches = 0;

  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (!matched2[j] && s1[i] === s2[j]) {
        matched1[i] = true;
        matched2[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!matched1[i]) continue;
    while (!matched2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions) / matches
  ) / 3;
}

/** Jaro with the standard prefix bonus (up to 4 leading characters). */
export function jaroWinkler(a: string, b: string): number {
  const score = jaro(a, b);
  const s1 = fold(a);
  const s2 = fold(b);
  let prefix = 0;
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) {
    prefix++;
  }
  return score + prefix * 0.1 * (1 - score);
}

// --- 3. Dice coefficient over character n-grams ---

export function dice(a: string, b: string, n = 2): number {
  const gramsA = ngrams(a, n);
  const gramsB = ngrams(b, n);
  if (!gramsA.size || !gramsB.size) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return (2 * shared) / (gramsA.size + gramsB.size);
}

// --- 4. Token-sort ratio ---

/** Edit similarity after sorting tokens, so "Yang Fred" scores like "Fred Yang". */
export function tokenSort(a: string, b: string): number {
  return levenshteinSimilarity(
    tokens(a).sort().join(" "),
    tokens(b).sort().join(" "),
  );
}

// --- 5. Substring containment ---

/**
 * Rewards a query that is contained in the candidate: whole-string containment
 * scores near 1, per-token containment degrades gracefully. This is the voter
 * that carries partial queries ("Fred" against "Fred Yang").
 */
export function containment(a: string, b: string): number {
  const needle = fold(a);
  const haystack = fold(b);
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) {
    return needle.length / haystack.length >= 0.999 ? 1 : 0.9;
  }
  const needleTokens = tokens(a);
  if (!needleTokens.length) return 0;
  const hits = needleTokens.filter((token) => haystack.includes(token)).length;
  return (hits / needleTokens.length) * 0.8;
}

// --- The text-route ensemble ---

export interface NamedSimilarity {
  name: string;
  fn: (a: string, b: string) => number;
}

/**
 * The four voters of the text route, in a fixed order. Measured against the
 * real AddressBook: four voters combined by a plain mean beat every larger
 * ensemble and every trimmed/max aggregation that was tried. Adding or
 * swapping a voter changes measured accuracy — don't, without re-measuring.
 */
export const TEXT_SIMILARITIES: readonly NamedSimilarity[] = [
  { name: "jaroWinkler", fn: jaroWinkler },
  { name: "tokenSort", fn: tokenSort },
  { name: "dice", fn: (a, b) => dice(a, b) },
  { name: "containment", fn: containment },
];

/** Plain (untrimmed) arithmetic mean — the measured aggregation. */
export function meanScore(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// --- Structured-route normalization ---

/** Every digit in the input, in order; the canonical form for phone comparison. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Length of the longest common suffix of two digit strings. Phones are matched
 * on shared suffix because stored numbers vary in country code and formatting
 * while the subscriber tail is stable.
 */
export function sharedSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export interface CanonicalEmail {
  /** Local part, plus-tag stripped (and dot-stripped for Google domains). */
  local: string;
  /**
   * `local` with every dot removed, whatever the domain. Only for comparing two
   * addresses at *different* domains, where the question is "same human?" and
   * dots are spelling noise. Within one domain `local` is authoritative: only
   * gmail ignores dots, so `dcole@example.com` and `d.cole@example.com` are two
   * different mailboxes and must not be conflated.
   */
  localDotless: string;
  domain: string;
  canonical: string;
}

/**
 * Lowercase, drop a `+tag`, and — only for gmail/googlemail, where the provider
 * itself ignores them — drop dots in the local part.
 */
export function canonicalizeEmail(address: string | null | undefined): CanonicalEmail {
  const trimmed = (address ?? "").trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at === -1) {
    return {
      local: trimmed,
      localDotless: trimmed.replace(/\./g, ""),
      domain: "",
      canonical: trimmed,
    };
  }

  const domain = trimmed.slice(at + 1);
  let local = trimmed.slice(0, at).split("+")[0] ?? "";
  if (/^(gmail|googlemail)\.com$/.test(domain)) local = local.replace(/\./g, "");
  return {
    local,
    localDotless: local.replace(/\./g, ""),
    domain,
    canonical: `${local}@${domain}`,
  };
}
