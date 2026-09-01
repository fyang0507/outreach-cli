/**
 * The router: pick a route for the query, fall back to text when a structured
 * route finds nothing, cap the confidence a fallback may claim, and cut to the
 * caller's limit.
 */

import {
  TEXT_CANDIDATE_LIMIT,
  classifyQuery,
  matchEmail,
  matchPhone,
  matchText,
  type QueryKind,
  type RoutedHit,
} from "./routes.js";
import type { ContactField, ContactIndexEntry } from "./searchIndex.js";
import { phoneDigits } from "./similarity.js";
import type { Contact } from "./types.js";

/** `text_fallback` is the text route reached after a structured route found nothing. */
export type MatchRoute = "phone" | "email" | "text" | "text_fallback";

export interface ContactMatch {
  contact: Contact;
  /** 0..1. Structured routes report query coverage; the text route reports the ensemble mean. */
  score: number;
  confidence: "high" | "low";
  matched_on: ContactField[];
  route: MatchRoute;
}

export interface FindContactsResult {
  query: string;
  kind: QueryKind;
  route: MatchRoute;
  count: number;
  /** Array order is the rank. */
  matches: ContactMatch[];
}

const DEFAULT_LIMIT = 10;

function toMatches(hits: RoutedHit[], route: MatchRoute, limit: number): ContactMatch[] {
  return hits.slice(0, limit).map((hit) => ({
    contact: hit.entry.contact,
    score: hit.score,
    confidence: hit.confidence,
    matched_on: hit.matched_on,
    route,
  }));
}

/**
 * Cap a fallback hit that "matched" the very field the structured route just
 * rejected.
 *
 * The phone route is exact: it either shares a subscriber tail with a stored
 * number or it does not. When it does not, `matchText` still scores the query's
 * digit string against the phone atoms as characters, and one mistyped digit
 * scores well above the high-confidence threshold — so a query that matches
 * *nothing* came back as `high` while the same query fully covered by a stored
 * number correctly came back as `low`. `high` is the field the skill doc calls
 * "safe to use directly", so this is the difference between an agent dialing a
 * stranger and asking the operator.
 *
 * Only evidence entirely from that field is capped. A fallback that matched the
 * contact's *name* (`ashley.parker@nowhere.example` -> Ashley Parker) is a
 * legitimate high-confidence answer; character similarity between two identifier
 * strings never is.
 */
function capFallbackConfidence(hits: RoutedHit[], kind: QueryKind): RoutedHit[] {
  if (kind !== "phone" && kind !== "email") return hits;
  const rejected: ContactField = kind;
  return hits.map((hit) =>
    hit.matched_on.length > 0 && hit.matched_on.every((field) => field === rejected)
      ? { ...hit, confidence: "low" as const }
      : hit,
  );
}

/**
 * Route the query, then rank. A structured route that finds nothing falls back
 * to text: a phone-shaped query with no suffix hit may still be an extension
 * or an account number written in a name, and an unknown address often shares
 * a token with the contact's name.
 */
export function findContacts(
  index: ContactIndexEntry[],
  query: string,
  options: {
    limit?: number;
    /** Score note atoms too (they are only present if the index was built with them). */
    verbose?: boolean;
  } = {},
): FindContactsResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const includeNotes = options.verbose === true;
  const kind = classifyQuery(query);
  // The prefilter must never be the thing that caps the answer: a caller asking
  // for 500 matches gets at least 500 candidates scored.
  const candidates = Math.max(TEXT_CANDIDATE_LIMIT, limit);

  if (kind === "empty") {
    return { query, kind, route: "text", count: 0, matches: [] };
  }

  const textFallback = (): FindContactsResult => {
    const matches = toMatches(
      capFallbackConfidence(matchText(index, query, { includeNotes, candidates }), kind),
      "text_fallback",
      limit,
    );
    return { query, kind, route: "text_fallback", count: matches.length, matches };
  };

  if (kind === "phone") {
    const hits = matchPhone(index, phoneDigits(query));
    if (!hits.length) return textFallback();
    const matches = toMatches(hits, "phone", limit);
    return { query, kind, route: "phone", count: matches.length, matches };
  }

  if (kind === "email") {
    const hits = matchEmail(index, query);
    if (!hits.length) return textFallback();
    const matches = toMatches(hits, "email", limit);
    return { query, kind, route: "email", count: matches.length, matches };
  }

  const matches = toMatches(
    matchText(index, query, { includeNotes, candidates }),
    "text",
    limit,
  );
  return { query, kind, route: "text", count: matches.length, matches };
}
