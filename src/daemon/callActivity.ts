import type { CallSession } from "./sessions.js";

// A flat window on raw audio energy can't tell a mid-conversation thinking
// pause (observed up to ~3s of silence while someone checks calendar
// availability) from real silence — both look identical: N seconds with no
// RMS activity. Biased toward the longer side deliberately: a false "quiet"
// risks repeating the incident's actual failure mode (a signal read as
// "nothing's happening" when something still might be), while a stale
// "recent" only costs an operator a few extra seconds before concluding real
// silence. Untuned — start from real call observations, not a derivation.
export const ACTIVITY_LOOKBACK_MS = 5000;

// Audio chunks arrive continuously while a turn is actually generating, so a
// gap this size is a strong signal the turn ended even without its Twilio
// mark coming back — see `speaking`'s doc comment below for why the mark
// itself can't be trusted.
export const LOCAL_SPEAKING_WINDOW_MS = 2000;

export type AudioOnLine = "recent" | "quiet" | "unknown";

/**
 * Deliberately not named/framed as "continuing" or "engaged". 8kHz mu-law RMS
 * above `REMOTE_AUDIO_RMS_THRESHOLD` is a low bar (~-36 dBFS) that hold music,
 * a voicemail greeting, a TV, an open speakerphone, road noise, or an echo of
 * our own outbound audio all clear continuously — this reports raw line
 * energy, not proof the callee is engaged. `"unknown"` (not `"quiet"`) before
 * any activity has ever been recorded, so the first second of a call doesn't
 * read as a false "quiet".
 */
export function remoteAudioOnLine(
  lastRemoteAudioActivityAt: string | undefined,
  now: number,
): AudioOnLine {
  if (!lastRemoteAudioActivityAt) return "unknown";
  const ageMs = now - new Date(lastRemoteAudioActivityAt).getTime();
  return ageMs <= ACTIVITY_LOOKBACK_MS ? "recent" : "quiet";
}

/**
 * Gated on recency, not on the raw presence of an in-flight outbound turn.
 * A turn is only cleared from the bridge once Twilio's mark comes back, and
 * `sendMark` silently no-ops once the stream is gone — so a lost mark (a
 * stream stall, a reconnect, a dropped Twilio message) would otherwise read
 * `speaking: true` for the rest of the call. This also self-corrects a
 * cleared (barged-over) turn, which would otherwise read as still speaking
 * until its mark eventually returns.
 */
export function isLocalSpeaking(lastAudioAtMs: number | null, now: number): boolean {
  return lastAudioAtMs !== null && now - lastAudioAtMs <= LOCAL_SPEAKING_WINDOW_MS;
}

function msAgo(flushedAt: number | undefined, now: number): number | null {
  return flushedAt === undefined ? null : now - flushedAt;
}

export interface ActivitySnapshot {
  remote: { last_turn_ms_ago: number | null; audio_on_line: AudioOnLine };
  local: { last_turn_ms_ago: number | null; speaking: boolean };
}

/**
 * Computed fresh on every `call listen`/`call status` read — no background
 * timer. `localLastAudioAtMs` comes from the bridge's active outbound turn
 * (`null` when there is no bridge, or nothing has ever played).
 */
export function computeActivity(
  session: Pick<CallSession, "lastRemoteTurnFlushedAt" | "lastLocalTurnFlushedAt" | "lastRemoteAudioActivityAt">,
  localLastAudioAtMs: number | null,
  now: number,
): ActivitySnapshot {
  return {
    remote: {
      last_turn_ms_ago: msAgo(session.lastRemoteTurnFlushedAt, now),
      audio_on_line: remoteAudioOnLine(session.lastRemoteAudioActivityAt, now),
    },
    local: {
      last_turn_ms_ago: msAgo(session.lastLocalTurnFlushedAt, now),
      speaking: isLocalSpeaking(localLastAudioAtMs, now),
    },
  };
}
