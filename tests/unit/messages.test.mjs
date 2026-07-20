import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  classifySendOutcome,
  pickService,
} from "../../dist/providers/messages.js";

function withMessagesDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "outreach-messages-test-"));
  const dbPath = join(dir, "chat.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT NOT NULL
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      handle_id INTEGER NOT NULL,
      service TEXT,
      is_from_me INTEGER NOT NULL,
      is_sent INTEGER NOT NULL DEFAULT 0,
      is_delivered INTEGER NOT NULL DEFAULT 0,
      error INTEGER NOT NULL DEFAULT 0,
      date INTEGER NOT NULL
    );
  `);

  try {
    run({ db, dbPath });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addMessage(db, values) {
  db.prepare(
    `INSERT INTO message
      (handle_id, service, is_from_me, is_sent, is_delivered, error, date)
     VALUES
      (@handle_id, @service, @is_from_me, @is_sent, @is_delivered, @error, @date)`,
  ).run({
    is_sent: 0,
    is_delivered: 0,
    error: 0,
    ...values,
  });
}

test("auto-routing preserves SMS for an all-SMS recipient", () => {
  withMessagesDb(({ db, dbPath }) => {
    db.prepare("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run(
      "+12018200370",
    );
    addMessage(db, {
      handle_id: 1,
      service: "SMS",
      is_from_me: 1,
      is_sent: 1,
      date: 10,
    });
    addMessage(db, {
      handle_id: 1,
      service: "SMS",
      is_from_me: 0,
      date: 20,
    });

    assert.equal(pickService("+1 (201) 820-0370", dbPath), "SMS");
  });
});

test("auto-routing prefers recent inbound iMessage", () => {
  withMessagesDb(({ db, dbPath }) => {
    db.prepare("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run(
      "+15551234567",
    );
    addMessage(db, {
      handle_id: 1,
      service: "SMS",
      is_from_me: 1,
      is_sent: 1,
      date: 10,
    });
    addMessage(db, {
      handle_id: 1,
      service: "iMessage",
      is_from_me: 0,
      is_delivered: 1,
      date: 20,
    });

    assert.equal(pickService("+15551234567", dbPath), "iMessage");
  });
});

test("auto-routing defaults unknown recipients to SMS", () => {
  withMessagesDb(({ dbPath }) => {
    assert.equal(pickService("+15557654321", dbPath), "SMS");
  });
});

test("successful SMS fallback wins over the preceding iMessage failure", () => {
  const outcome = classifySendOutcome(
    [
      {
        ROWID: 2,
        service: "SMS",
        is_sent: 1,
        is_delivered: 0,
        error: 0,
        date: 1_000_000_000,
      },
      {
        ROWID: 1,
        service: "iMessage",
        is_sent: 0,
        is_delivered: 0,
        error: 22,
        date: 0,
      },
    ],
    "iMessage",
    true,
  );

  assert.equal(outcome?.status, "sent");
  assert.equal(outcome?.service, "SMS");
  assert.equal(outcome?.error_code, undefined);
});

test("a failure is hidden during fallback grace and surfaced afterward", () => {
  const rows = [
    {
      ROWID: 1,
      service: "iMessage",
      is_sent: 0,
      is_delivered: 0,
      error: 22,
      date: 0,
    },
  ];

  assert.equal(classifySendOutcome(rows, "iMessage", false), null);
  assert.deepEqual(
    classifySendOutcome(rows, "iMessage", true),
    {
      status: "failed",
      service: "iMessage",
      error_code: 22,
      message_date: "2001-01-01T00:00:00.000Z",
    },
  );
});
