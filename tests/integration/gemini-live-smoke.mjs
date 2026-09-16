// Manual, billable Gemini-only smoke test; no phone calls or daemon required.
// Build first, then run: node --env-file=.env tests/integration/gemini-live-smoke.mjs
// Uses only the public example config and synthetic prompts, never operator data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { GeminiLiveSession } from "../../dist/audio/geminiLive.js";

const TIMEOUT_MS = 30_000;

async function main() {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  assert.ok(apiKey, "GOOGLE_GENERATIVE_AI_API_KEY is required");
  const example = parse(await readFile(new URL("../../outreach.config.dev.yaml.example", import.meta.url), "utf8"));
  const started = Date.now();
  let audioBytes = 0;
  let transcript = "";
  let completedTurns = 0;
  const toolCalls = [];
  const toolResponses = [];
  let pendingTurn;
  let expectedTool;
  let fail;
  const failure = new Promise((_, reject) => { fail = reject; });
  const deadline = setTimeout(() => fail(new Error("Gemini smoke test exceeded 30 seconds")), TIMEOUT_MS);
  // An unfinished SDK handshake can retain a socket even after close(). This
  // unref'ed watchdog only fires if such a handle prevents natural process exit.
  const watchdog = setTimeout(() => {
    console.error("Gemini smoke test did not release its connection before the hard deadline");
    process.exit(1);
  }, TIMEOUT_MS + 2_000);
  watchdog.unref();

  function checkTurn() {
    if (pendingTurn?.ready()) {
      const { resolve } = pendingTurn;
      pendingTurn = undefined;
      resolve();
    }
  }

  const session = new GeminiLiveSession({
    apiKey,
    geminiConfig: example.gemini,
    systemInstruction: "You are a synthetic integration-test voice agent. Follow each test instruction exactly and keep speech to the short sentence requested. The tools are simulated: execute them when requested and wait for their result. Never call a tool unless the current instruction requests it.",
    onAudio: (data) => {
      audioBytes += Buffer.from(data, "base64").length;
      checkTurn();
    },
    onTranscript: (speaker, text) => {
      if (speaker === "local") transcript += text;
      checkTurn();
    },
    onToolCall: (name, args, id) => {
      try {
        assert.equal(name, expectedTool, "tool does not match the current test instruction");
        assert.equal(name, ["send_dtmf", "end_call"][toolCalls.length], "unexpected or repeated tool call");
        assert.ok(typeof id === "string" && id.trim(), "tool call needs a correlation ID");
        assert.ok(!toolCalls.some((call) => call.id === id), "tool call IDs must be distinct");
        if (name === "send_dtmf") assert.equal(args.digits, "1#");
        else assert.equal(args.reason, "smoke test complete");
        toolCalls.push({ name, args, id });
        // Echo the exact correlation ID and arguments; no Twilio action occurs.
        session.sendToolResponse(id, name, { ok: true, ...args });
        toolResponses.push({ name, id });
        checkTurn();
      } catch (error) {
        fail(error);
      }
    },
    onTurnComplete: () => {
      completedTurns += 1;
      checkTurn();
    },
    onError: (message) => fail(new Error(message.replaceAll(apiKey, "[redacted]"))),
    onEnd: () => fail(new Error(`Gemini ended unexpectedly: ${session.closeReason ?? "no reason"}`)),
  });

  function requestTurn(prompt, tool) {
    const previousTurns = completedTurns;
    const previousAudioBytes = audioBytes;
    const previousTranscriptLength = transcript.length;
    expectedTool = tool;
    return new Promise((resolve) => {
      pendingTurn = {
        resolve,
        ready: () => completedTurns > previousTurns && audioBytes > previousAudioBytes
          && transcript.slice(previousTranscriptLength).trim().length > 0
          && (!tool || toolResponses.some((response) => response.name === tool)),
      };
      session.sendTextTurn(prompt);
    });
  }

  try {
    await Promise.race([
      failure,
      (async () => {
        await session.connect();
        assert.equal(session.isClosed, false, "session closed during setup");
        await requestTurn('Say exactly "Ready." Do not call any tools.');
        await requestTurn('Simulated phone menu: press 1 followed by hash. Call send_dtmf with digits "1#" now. After its result, say exactly "Digits accepted." Do not end the call.', "send_dtmf");
        await requestTurn('The test objective is complete. In the same response, say exactly "Goodbye." and call end_call with reason "smoke test complete". After its result, say nothing further.', "end_call");
      })(),
    ]);
    assert.deepEqual(toolResponses, toolCalls.map(({ name, id }) => ({ name, id })));
    console.log(JSON.stringify({
      status: "passed",
      model: example.gemini.model,
      elapsed_ms: Date.now() - started,
      audio_bytes: audioBytes,
      output_transcript: transcript,
      completed_turns: completedTurns,
      tool_calls: toolCalls,
      tool_responses: toolResponses,
    }));
  } finally {
    clearTimeout(deadline);
    pendingTurn = undefined;
    session.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  console.error(JSON.stringify({ status: "failed", error: apiKey ? message.replaceAll(apiKey, "[redacted]") : message }));
  process.exitCode = 1;
});
