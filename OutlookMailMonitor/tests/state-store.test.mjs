import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MonitorStateStore, initialState } from "../state-store.mjs";

test("state store is private and atomic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-mail-state-"));
  try {
    const file = path.join(root, "private", "state.json");
    const store = new MonitorStateStore(file);
    store.save(initialState());
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.load(), initialState());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
