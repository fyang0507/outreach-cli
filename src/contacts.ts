import { readContact } from "./logs/sessionLog.js";
import { normalizePhone } from "./providers/messages.js";

export interface Contact {
  id: string;
  phone?: string;
  sms_phone?: string;
  email?: string;
  name?: string;
  tags?: string[];
  notes?: string;
  created?: string;
  updated?: string;
}

/**
 * Resolve the channel-appropriate address from a contact record.
 * - call → contact.phone
 * - sms  → contact.sms_phone ?? contact.phone
 * - email → contact.email
 *
 * Phone numbers are normalized to E.164.
 */
export async function resolveContactAddress(
  contactId: string,
  channel: "call" | "sms" | "email",
): Promise<string> {
  const contact = await readContact(contactId);

  switch (channel) {
    case "call": {
      if (!contact.phone) {
        throw new Error(
          `Contact ${contactId} has no phone number. Provide --to or update the contact record.`,
        );
      }
      return normalizePhone(contact.phone);
    }
    case "sms": {
      const phone = contact.sms_phone ?? contact.phone;
      if (!phone) {
        throw new Error(
          `Contact ${contactId} has no phone number for SMS. Provide --to or update the contact record.`,
        );
      }
      return normalizePhone(phone);
    }
    case "email": {
      if (!contact.email) {
        throw new Error(
          `Contact ${contactId} has no email address. Provide --to or update the contact record.`,
        );
      }
      return contact.email;
    }
  }
}
