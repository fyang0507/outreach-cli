import { google, calendar_v3 } from "googleapis";
import { getAuthClient, checkGoogleAuth, getTokenPath } from "./googleAuth.js";

// --- Types ---

export interface AddEventOptions {
  summary: string;          // Google Calendar API uses "summary" for event title
  start: string;            // ISO 8601 datetime with timezone offset
  end: string;              // ISO 8601 datetime with timezone offset
  description?: string;
  location?: string;
  attendees?: string[];     // email addresses
}

export interface AddEventResult {
  event_id: string;
  html_link: string;
  summary: string;
  start: string;
  end: string;
}

export interface RemoveEventResult {
  event_id: string;
  status: "removed";
}

// --- Client ---

let _calendarClient: calendar_v3.Calendar | null = null;

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  if (_calendarClient) return _calendarClient;

  const auth = await getAuthClient();
  _calendarClient = google.calendar({ version: "v3", auth });
  return _calendarClient;
}

// --- Helpers ---

function hasTimezoneOffset(dt: string): boolean {
  // Matches trailing Z, +HH:MM, -HH:MM, +HHMM, -HHMM
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(dt);
}

// --- Operations ---

export async function addCalendarEvent(
  opts: AddEventOptions,
): Promise<AddEventResult> {
  const calendar = await getCalendarClient();

  // If datetime has no timezone offset, resolve to local IANA timezone
  const needsTimeZone =
    !hasTimezoneOffset(opts.start) || !hasTimezoneOffset(opts.end);
  const localTz = needsTimeZone
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined;

  const event: calendar_v3.Schema$Event = {
    summary: opts.summary,
    start: { dateTime: opts.start, ...(localTz && { timeZone: localTz }) },
    end: { dateTime: opts.end, ...(localTz && { timeZone: localTz }) },
  };

  if (opts.description) event.description = opts.description;
  if (opts.location) event.location = opts.location;
  if (opts.attendees && opts.attendees.length > 0) {
    event.attendees = opts.attendees.map((email) => ({ email }));
  }

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });

  return {
    event_id: res.data.id ?? "",
    html_link: res.data.htmlLink ?? "",
    summary: res.data.summary ?? "",
    start: res.data.start?.dateTime ?? opts.start,
    end: res.data.end?.dateTime ?? opts.end,
  };
}

export async function removeCalendarEvent(
  eventId: string,
): Promise<RemoveEventResult> {
  const calendar = await getCalendarClient();

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return {
    event_id: eventId,
    status: "removed",
  };
}

// --- Health check ---

export async function checkCalendarAuth(): Promise<{
  ok: boolean;
  error?: string;
  hint?: string;
}> {
  const googleAuth = await checkGoogleAuth();
  if (!googleAuth.ok) return googleAuth;

  try {
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.list({ calendarId: "primary", maxResults: 1 });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    const tokenPath = await getTokenPath();
    return {
      ok: false,
      error: "auth_failed",
      hint: msg.includes("insufficient")
        ? `Calendar scope missing. Delete ${tokenPath} and re-authorize to grant calendar access`
        : `Calendar auth check failed: ${msg}`,
    };
  }
}
