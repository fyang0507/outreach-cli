# Contacts Channel

Use this note for lookup semantics and match judgment, not command syntax.

## What It Is For

`contacts find` turns a human description into a channel identifier. It is the step that gets an agent from "the HVAC guy" to a phone number it can actually dial.

It is read-only and sends nothing. Resolution is deliberately a separate step from sending: resolve first, then pass the literal identifier to `sms send`, `email send`, or `call place`, so every send carries an unambiguous, logged identifier.

## One Query Field, Three Routes

`--query` takes a name, organization, phone number, or email address. The CLI detects which and routes accordingly — there are no per-type flags.

- **Phone** (digits only, 4+): matched on longest shared trailing digits. Any formatting works: `+1 (551) 261-3888`, `5512613888`, `551-261-3888`, `2613888`.
- **Email**: canonicalized before comparison — case-insensitive, `+tag` stripped, dots stripped in the local part for gmail/googlemail only.
- **Text**: fuzzy across name, organization, and job title together. Tolerates typos, swapped first/last names, and partial names.

A phone or email query that finds nothing falls back to a text search, so a number pasted into `--query` still finds a contact whose *name* contains those digits.

Matching is field-agnostic on purpose: the address book contains real errors, so a query can match a person whose first and last names are stored backwards, or whose company is misspelled.

## Reading the Result

Array order is the rank — the first match is the best one. Ranking internals are hidden unless you pass `--verbose`, which adds `score` (0–1), `matched_on`, and the free-text `note` field.

`confidence` is the field to act on:

- **`high`** — safe to use directly. A full phone number, an exact or near-exact email, or a strong text match.
- **`low`** — do not chain it into a send or a call without confirming. Common causes: a bare last-four that several contacts share, an email matched only on a local-part substring, or a weak text match.

Two matches with the same confidence means genuine ambiguity. Say what you found and let the operator pick rather than guessing — near-collisions are common in practice, since "Home Insulation Expert" and "Handyman From Home Expert Insulation" are different businesses.

`count: 0` is an ordinary result, not an error. It usually means the person is not in Contacts on this Mac, not that they do not exist.

## Caveats

Only contacts synced to *this* Mac are visible; a contact that lives only on a phone will not be found. Reading requires Full Disk Access — the same grant `sms history` needs. `outreach health` reports a `contacts` key with the store and contact count, so diagnose a missing grant there rather than at first use.

Contacts that exist in more than one account are merged into a single result. Two entries sharing a name are not necessarily a duplicate — they may be two different people.

Matching is lexical, not semantic. It will not get from "the HVAC guy" to a company whose name never mentions HVAC; it matches the words that are actually stored.
