import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowStore, newWorkflowId } from "./store.js";

test("private store round-trips a workflow record", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rico-workflow-"));
  await fs.promises.chmod(directory, 0o700);
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkflowStore(path.join(directory, "rico-workflows.json"));
  const record = { id: newWorkflowId(), name: "rico-wf-test", recipient: "+16469433060" };
  store.save(record);
  assert.equal(store.list().length, 1);
  store.remove(record.id);
  assert.equal(store.list().length, 0);
});
