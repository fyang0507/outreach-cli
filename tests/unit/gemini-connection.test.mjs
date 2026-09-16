import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setDefaultBaseUrls } from "@google/genai";
import { WebSocketServer } from "ws";
import { parse } from "yaml";

import { GeminiLiveSession } from "../../dist/audio/geminiLive.js";

const example = parse(await readFile(new URL("../../outreach.config.dev.yaml.example", import.meta.url), "utf8"));
const TEST_TIMEOUT_MS = 3000;

// Exercise the installed SDK's real handshake, message conversion, and transport.
// A loopback server prevents these lifecycle tests from contacting Gemini.
async function startServer(t, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, ...options });
  await once(server, "listening");
  setDefaultBaseUrls({ geminiUrl: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => {
    setDefaultBaseUrls({});
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return server;
}

function createSession(t) {
  const events = [];
  let notifyEnd;
  const ended = new Promise((resolve) => { notifyEnd = resolve; });
  const session = new GeminiLiveSession({
    apiKey: "loopback-test-key",
    geminiConfig: example.gemini,
    systemInstruction: "Test connection lifecycle.",
    onAudio() {},
    onTranscript() {},
    onToolCall() {},
    onError: (message) => events.push({ error: message }),
    onEnd: () => {
      events.push({ ended: true });
      notifyEnd();
    },
  });
  t.after(() => session.close());
  return { session, events, ended };
}

test("cancelling an SDK setup that never completes closes its open transport", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const server = await startServer(t);
  const accepted = once(server, "connection");
  const { session, events } = createSession(t);
  let settled = false;
  const connecting = session.connect().finally(() => { settled = true; });
  const rejected = assert.rejects(connecting, /closed before setup/i);
  const [socket] = await accepted;
  const [data] = await once(socket, "message");
  assert.equal(JSON.parse(data.toString()).setup.model, "models/gemini-3.8-live");
  assert.equal(settled, false, "opening the socket must not finish session setup");
  // Deliberately never send setupComplete, even after cancellation.
  const disconnected = once(socket, "close");
  session.close();
  await rejected;
  await disconnected;
  assert.equal(session.isClosed, true);
  assert.deepEqual(events, [], "local setup cancellation is not a runtime failure");
});

test("the real SDK rejects a remote close during setup without runtime callbacks", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const server = await startServer(t);
  const accepted = once(server, "connection");
  const { session, events } = createSession(t);
  const rejected = assert.rejects(session.connect(), /model rejected/);
  const [socket] = await accepted;
  await once(socket, "message");
  const disconnected = once(socket, "close");
  socket.close(1008, "model rejected");
  await rejected;
  await disconnected;
  assert.equal(session.isClosed, true);
  assert.equal(session.closeReason, "model rejected");
  assert.deepEqual(events, []);
});

test("an HTTP failure before WebSocket open rejects the real SDK connection", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await startServer(t, {
    verifyClient(_info, callback) { callback(false, 503, "Temporarily unavailable"); },
  });
  const { session, events } = createSession(t);
  await assert.rejects(session.connect(), /503/);
  assert.equal(session.isClosed, true);
  assert.deepEqual(events, []);
});

test("the real SDK completes setup, sends explicit user content, and reports remote close", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const server = await startServer(t);
  const accepted = once(server, "connection");
  const { session, events, ended } = createSession(t);
  const connecting = session.connect();
  const [socket] = await accepted;
  await once(socket, "message");
  socket.send(JSON.stringify({ setupComplete: {} }));
  await connecting;
  assert.equal(session.isClosed, false);
  const content = once(socket, "message");
  session.sendTextTurn("Hello.");
  const [data] = await content;
  assert.deepEqual(JSON.parse(data.toString()), {
    clientContent: {
      turns: [{ role: "user", parts: [{ text: "Hello." }] }],
      turnComplete: true,
    },
  });
  const disconnected = once(socket, "close");
  socket.close(1000, "session ended");
  await Promise.all([disconnected, ended]);
  assert.equal(session.isClosed, true);
  assert.equal(session.closeReason, "session ended");
  assert.deepEqual(events, [{ ended: true }]);
});
