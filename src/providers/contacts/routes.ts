/**
 * Query classification and the three ranking routes it selects between: exact
 * digit-suffix for phones, canonicalized address for emails, and the four-voter
 * similarity ensemble for free text. Each returns hits in rank order; the
 * fallback and limit policy is `search.ts`'s.
 */

import {
  TEXT_SIMILARITIES,
  canonicalizeEmail,
  fold,
  meanScore,
  ngrams,
  phoneDigits,
  sharedSuffixLength,
} from "./similarity.js";
import { GRAM_SIZE, type ContactField, type ContactIndexEntry } from "./searchIndex.js";

/**
 * Default number of candidates surviving the bigram prefilter and scored by the
 * full ensemble. It is a speed knob, not a result cap: `findContacts` raises it
 * to at least the caller's `limit` so `--limit 500` can actually return 500.
 */
export const TEXT_CANDIDATE_LIMIT = 60;
/** Below this many digits a query is text, not a phone number. */
const MIN_PHONE_SUFFIX_DIGITS = 4;
/**
 * A phone query shorter than a subscriber number is a fragment: plenty of
 * unrelated numbers end in the same four digits, so covering the whole query
 * proves nothing. Below this, a suffix hit is never high confidence.
 */
const MIN_HIGH_CONFIDENCE_PHONE_DIGITS = 7;

/** Text scores at or above this are reported as high confidence. */
const HIGH_CONFIDENCE_TEXT_SCORE = 0.5;
/**
 * Text scores below this are not reported at all. Jaro-Winkler is non-zero for
 * essentially any pair of non-empty strings, so without a floor a nonsense
 * query ("zzzqqxk") fills the whole limit with 0.1-scored noise instead of
 * answering "no". Measured on the real book: nonsense tops out around 0.16
 * while a genuine typo'd query ("insultion expert") scores 0.67, so the gap is
 * wide and this sits in it.
 */
const MIN_TEXT_SCORE = 0.25;
/**
 * Shortest local part that may match on the email substring tier. A one- or
 * two-character local is a substring of half the address book, which fills the
 * limit with flat-scored noise and hides the text fallback that would have
 * answered the question — the same failure `MIN_TEXT_SCORE` exists to prevent.
 */
const MIN_EMAIL_SUBSTRING_LOCAL = 3;

export type QueryKind = "phone" | "email" | "text" | "empty";

/**
 * Route selection. An "@" with non-space on both sides is an address; an
 * all-numeric-ish query with enough digits is a phone number; everything else
 * is free text. Note that "551" (3 digits) is text, not a phone number.
 */
export function classifyQuery(query: string): QueryKind {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return "empty";
  if (trimmed.includes("@") && /\S@\S/.test(trimmed)) return "email";
  const digits = phoneDigits(trimmed);
  const nonPhoneChars = trimmed.replace(/[\d\s()+.\-]/g, "").length;
  if (digits.length >= MIN_PHONE_SUFFIX_DIGITS && nonPhoneChars === 0) return "phone";
  return "text";
}

/** A route's ranked hit, before `search.ts` cuts it to the caller's limit. */
export interface RoutedHit {
  entry: ContactIndexEntry;
  score: number;
  confidence: "high" | "low";
  matched_on: ContactField[];
}

/**
 * Rank by longest shared digit suffix (>= 4). Deterministic, no similarity
 * scoring: phone numbers either agree on a tail or they don't. `score` is the
 * fraction of the query that the tail covered, so a query fully contained in a
 * stored number scores 1.
 *
 * Full coverage alone is not enough for high confidence: it is trivially true
 * for the weakest possible query, and a bare last-four would otherwise report
 * every contact ending in those digits as a certain match. Confidence therefore
 * also requires the query to be at least a subscriber-length number, so a
 * number that merely happens to end in the same four digits stays low.
 */
export function matchPhone(index: ContactIndexEntry[], queryDigits: string): RoutedHit[] {
  if (queryDigits.length < MIN_PHONE_SUFFIX_DIGITS) return [];

  const hits: Array<RoutedHit & { suffix: number }> = [];
  for (const entry of index) {
    let best = 0;
    for (const digits of entry.phoneDigits) {
      const shared = sharedSuffixLength(queryDigits, digits);
      if (shared >= MIN_PHONE_SUFFIX_DIGITS && shared > best) best = shared;
    }
    if (!best) continue;
    const coversQuery = best === queryDigits.length;
    hits.push({
      entry,
      suffix: best,
      score: best / queryDigits.length,
      confidence:
        coversQuery && queryDigits.length >= MIN_HIGH_CONFIDENCE_PHONE_DIGITS
          ? "high"
          : "low",
      matched_on: ["phone"],
    });
  }

  return hits.sort((a, b) => b.suffix - a.suffix);
}

/**
 * Rank exact canonical address > equal local part > local-part substring.
 * A substring-only hit is a guess about a different domain, so it is reported
 * low confidence while the two equality tiers are high.
 *
 * The substring tier needs a local part of at least `MIN_EMAIL_SUBSTRING_LOCAL`
 * characters and scores by how much of the stored local the query covered, so
 * "a@nowhere.example" no longer returns every contact with an "a" in its
 * address at an identical 0.7 — which both filled the limit with noise (the
 * text fallback would have answered better) and broke the "array order is the
 * rank" contract, since a field of exact ties is in load order, not rank order.
 *
 * The two local-part tiers compare *dotless* locals whenever the domains
 * differ. Dot handling is a per-provider rule (only Google ignores dots), so
 * canonicalization can only apply it to the address's own domain — and then
 * comparing a dot-stripped gmail local against a dotted local at some other
 * domain misses the person entirely: stored `charles.devore@gmail.com` would
 * lose `charles.devore@newcompany.example` while matching the misspelled
 * `charlesdevore@newcompany.example`. Within one domain the canonical local
 * still rules, so `dcole@example.com` remains a different mailbox from
 * `d.cole@example.com`.
 */
export function matchEmail(index: ContactIndexEntry[], query: string): RoutedHit[] {
  const target = canonicalizeEmail(query);

  const hits: Array<RoutedHit & { rank: number }> = [];
  for (const entry of index) {
    let rank = 0;
    let coverage = 0;
    for (const address of entry.emails) {
      const candidate = canonicalizeEmail(address);
      const sameDomain = candidate.domain === target.domain;
      const targetLocal = sameDomain ? target.local : target.localDotless;
      const candidateLocal = sameDomain ? candidate.local : candidate.localDotless;
      if (candidate.canonical === target.canonical) rank = Math.max(rank, 3);
      else if (targetLocal && candidateLocal === targetLocal) rank = Math.max(rank, 2);
      else if (
        targetLocal.length >= MIN_EMAIL_SUBSTRING_LOCAL &&
        candidateLocal.includes(targetLocal)
      ) {
        rank = Math.max(rank, 1);
        coverage = Math.max(coverage, targetLocal.length / candidateLocal.length);
      }
    }
    if (!rank) continue;
    hits.push({
      entry,
      rank,
      // A substring hit stays under the equal-local tier's 0.9 whatever it
      // covered, so the score never contradicts the rank it was sorted by.
      score: rank === 3 ? 1 : rank === 2 ? 0.9 : 0.7 * coverage,
      confidence: rank >= 2 ? "high" : "low",
      matched_on: ["email"],
    });
  }

  return hits.sort((a, b) => b.rank - a.rank || b.score - a.score);
}

/**
 * Bigram-overlap prefilter, then the four-voter ensemble on the survivors.
 * The prefilter exists purely for speed; the substring bonus keeps short
 * queries ("Fred") from being crowded out by long, gram-rich candidates.
 *
 * A query too short to have a bigram skips the prefilter entirely and scores
 * the whole index. Its only "gram" is the one character itself, which can never
 * appear in an index built from bigrams, so every overlap would be 0 and the
 * candidate cut would fall back to load order — silently dropping contacts that
 * score better than the ones it kept.
 */
export function matchText(
  index: ContactIndexEntry[],
  query: string,
  options: { candidates?: number; includeNotes?: boolean } = {},
): RoutedHit[] {
  const candidateLimit = options.candidates ?? TEXT_CANDIDATE_LIMIT;
  const includeNotes = options.includeNotes ?? false;
  const queryGrams = ngrams(query, GRAM_SIZE);
  const queryFolded = fold(query);
  const prefilterable = queryFolded.replace(/\s+/g, "").length >= GRAM_SIZE;

  const prefiltered = prefilterable
    ? index
        .map((entry) => {
          let overlap = 0;
          for (const gram of queryGrams) if (entry.grams.has(gram)) overlap++;
          const substring = entry.atoms.some(
            (atom) => atom.folded.includes(queryFolded) || queryFolded.includes(atom.folded),
          );
          return {
            entry,
            prescore: (queryGrams.size ? overlap / queryGrams.size : 0) + (substring ? 0.5 : 0),
          };
        })
        .sort((a, b) => b.prescore - a.prescore)
        .slice(0, candidateLimit)
    : index.map((entry) => ({ entry }));

  const hits: RoutedHit[] = [];
  for (const { entry } of prefiltered) {
    const atoms = includeNotes
      ? entry.atoms
      : entry.atoms.filter((atom) => atom.field !== "note");
    if (!atoms.length) continue;

    // One score per voter: the contact's best atom under that voter. The final
    // score is their plain mean — measured, and not a trimmed mean.
    const perVoter: number[] = [];
    const matchedFields = new Set<ContactField>();
    for (const { fn } of TEXT_SIMILARITIES) {
      let best = 0;
      let bestField: ContactField | null = null;
      for (const atom of atoms) {
        const score = fn(query, atom.value);
        if (score > best) {
          best = score;
          bestField = atom.field;
        }
      }
      perVoter.push(best);
      if (bestField) matchedFields.add(bestField);
    }

    // Below the floor the "match" is coincidental character overlap, not a
    // candidate: report nothing rather than pad the limit with noise.
    const score = meanScore(perVoter);
    if (score < MIN_TEXT_SCORE) continue;
    hits.push({
      entry,
      score,
      confidence: score >= HIGH_CONFIDENCE_TEXT_SCORE ? "high" : "low",
      matched_on: [...matchedFields],
    });
  }

  return hits.sort((a, b) => b.score - a.score);
}
