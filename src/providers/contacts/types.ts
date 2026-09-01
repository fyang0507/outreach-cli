/**
 * The contact data model every module in this subsystem shares: the wire shape
 * `contacts find` returns, the store descriptor the loader walks, and the
 * access error the whole stack throws.
 *
 * Deliberately import-free, so nothing declared here can close a cycle.
 */

export interface ContactPhone {
  /** E.164-ish, via the shared `normalizePhone()` used by the sms channel. */
  number: string;
  label: string | null;
  /**
   * Digits dialed *after* the call connects, split off the stored number before
   * normalization. `null` for the overwhelming majority of numbers; never
   * folded into `number`, which would produce an E.164 string that dials
   * nowhere (`(201) 820-1234 ext. 56` -> `+201820123456`, a valid-looking
   * Egyptian number) and that the phone route could never match on suffix.
   */
  extension: string | null;
}

export interface ContactEmail {
  address: string;
  label: string | null;
}

export interface Contact {
  /** "First Last", falling back to the organization; null when both are empty. */
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  phones: ContactPhone[];
  emails: ContactEmail[];
  note: string | null;
  /** Source store directory names this contact was assembled from. */
  sources: string[];
}

export interface ContactStore {
  /** The `Sources/<uuid>` directory name. */
  source: string;
  path: string;
}

/** One store that could not be read, so a partial answer can say what it missed. */
export interface ContactStoreFailure {
  source: string;
  message: string;
  /** True when the failure looks like a permission denial rather than damage. */
  permission: boolean;
}

/** Raised when stores are present but unreadable — almost always Full Disk Access. */
export class ContactsAccessError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "ContactsAccessError";
    this.hint = hint;
  }
}
