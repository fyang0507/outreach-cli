/**
 * The searchable projection of a contact: its atoms, their bigrams and the
 * structured keys the phone and email routes compare against.
 */

import { fold, ngrams, phoneDigits } from "./similarity.js";
import type { Contact } from "./types.js";

/** Which atom a match came from; surfaced as `matched_on`. */
export type ContactField =
  | "name"
  | "organization"
  | "job_title"
  | "phone"
  | "email"
  | "name_organization"
  | "note";

interface ContactAtom {
  value: string;
  field: ContactField;
  folded: string;
}

export interface ContactIndexEntry {
  contact: Contact;
  atoms: ContactAtom[];
  /** Union of every atom's bigrams; drives the text-route prefilter. */
  grams: Set<string>;
  phoneDigits: string[];
  emails: string[];
}

/**
 * Width of the n-grams on both sides of the prefilter. The index's atom grams
 * and the query's grams must be the same width or every overlap is 0 and the
 * candidate cut silently falls back to load order, so both sides read this.
 * A query shorter than this cannot be prefiltered at all; see `matchText`.
 */
export const GRAM_SIZE = 2;

/**
 * Precompute the searchable atoms, their bigrams and the structured keys.
 * Scoring is field-agnostic: an atom is just a string to compare against, and
 * a contact's score for one similarity is its best atom under that similarity.
 */
export function buildContactIndex(
  contacts: Contact[],
  options: {
    /** Make notes searchable. Off by default — notes are `--verbose`-only. */
    includeNotes?: boolean;
  } = {},
): ContactIndexEntry[] {
  const includeNotes = options.includeNotes ?? false;

  return contacts.map((contact) => {
    const atoms: ContactAtom[] = [];
    const push = (value: string | null | undefined, field: ContactField): void => {
      if (!value || !value.trim()) return;
      atoms.push({ value, field, folded: fold(value) });
    };

    push(contact.name, "name");
    push(contact.first_name, "name");
    push(contact.last_name, "name");
    push(contact.organization, "organization");
    push(contact.job_title, "job_title");
    // Pooled blob so "Fred Yang Acme" scores against one string rather than
    // splitting its evidence across two atoms.
    push([contact.name, contact.organization].filter(Boolean).join(" "), "name_organization");
    for (const phone of contact.phones) push(phone.number, "phone");
    for (const email of contact.emails) {
      push(email.address, "email");
      push(email.address.split("@")[0], "email");
    }
    if (includeNotes) push(contact.note, "note");

    const grams = new Set<string>();
    for (const atom of atoms) {
      for (const gram of ngrams(atom.value, GRAM_SIZE)) grams.add(gram);
    }

    return {
      contact,
      atoms,
      grams,
      phoneDigits: contact.phones.map((phone) => phoneDigits(phone.number)),
      emails: contact.emails.map((email) => email.address),
    };
  });
}
