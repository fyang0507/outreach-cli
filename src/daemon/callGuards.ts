import type { CallSession } from "./sessions.js";

export const CALL_INACTIVITY_MS = 60 * 1000; // 60 seconds
export const VOICEMAIL_SILENCE_MS = 90 * 1000; // 90 seconds without a transcript fragment = likely voicemail/hold

/**
 * G3: voicemail/hold-music detection — audio is flowing (G2 hasn't already fired)
 * but Gemini's ASR hasn't produced a transcript fragment in VOICEMAIL_SILENCE_MS.
 * Gated on fragment *arrival* (`lastTranscriptFragmentAt`), not on when the
 * transcript batcher happens to flush, so a long uninterrupted turn on either side
 * can't leave this frozen for the length of the turn. Extracted from server.ts
 * (which has import-time side effects — `ipcServer.listen`/`httpServer.listen` at
 * module scope) so it can be unit-tested directly.
 */
export function isVoicemailSilence(
  session: Pick<CallSession, "lastActivityTime" | "lastTranscriptFragmentAt">,
  now: number,
): boolean {
  return (
    now - session.lastActivityTime < CALL_INACTIVITY_MS
    && now - session.lastTranscriptFragmentAt > VOICEMAIL_SILENCE_MS
  );
}
