import assert from "node:assert/strict";
import test from "node:test";

import { latestCallSummary } from "../../dist/logs/sessionLog.js";

const speech = { type: "speech", speaker: "remote", text: "hi", ts: "t1", flush_reason: "turn_change" };
const callEnded = { type: "call_ended", ts: "t2", reason: "media stream closed", duration_ms: 1000 };
const summary = { type: "call_summary", ts: "t3", duration_ms: 1000 };

test("returns undefined when no call_summary event exists", () => {
  assert.equal(latestCallSummary([speech, callEnded]), undefined);
});

test("returns the summary when omitIfVisibleIn is not passed", () => {
  assert.equal(latestCallSummary([speech, callEnded, summary]), summary);
});

test("returns the summary when omitIfVisibleIn does not include it (since narrowed past it)", () => {
  assert.equal(latestCallSummary([speech, callEnded, summary], []), summary);
});

test("returns undefined when omitIfVisibleIn already contains it (a full/bare read)", () => {
  const fullTranscript = [speech, callEnded, summary];
  assert.equal(latestCallSummary(fullTranscript, fullTranscript.slice(0)), undefined);
});

test("returns the last call_summary if more than one exists", () => {
  const laterSummary = { type: "call_summary", ts: "t4", duration_ms: 2000 };
  assert.equal(latestCallSummary([speech, summary, laterSummary]), laterSummary);
});
