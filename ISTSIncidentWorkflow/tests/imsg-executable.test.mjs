import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveIMsgExecutable,
  resolveManagedIMsgExecutable,
} from "../imsg-executable.mjs";

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rico-imsg-executable-")));
  const prefix = path.join(directory, "homebrew");
  const cellarRoot = path.join(prefix, "Cellar", "imsg");
  const target = path.join(cellarRoot, "0.14.1", "bin", "imsg");
  const linkPath = path.join(prefix, "bin", "imsg");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o555 });
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
  return {
    directory,
    linkPath,
    cellarRoot,
    target,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("the exact managed Homebrew imsg link resolves to one secure versioned binary", () => {
  const value = fixture();
  try {
    assert.equal(resolveManagedIMsgExecutable(value), value.target);
    assert.throws(() => resolveIMsgExecutable(value.linkPath), /imsg_unavailable/u);
  } finally {
    value.cleanup();
  }
});

test("managed imsg resolution rejects an escaped target and writable binary", () => {
  const value = fixture();
  try {
    fs.unlinkSync(value.linkPath);
    const escaped = path.join(value.directory, "escaped-imsg");
    fs.writeFileSync(escaped, "#!/bin/sh\n", { mode: 0o555 });
    fs.symlinkSync(path.relative(path.dirname(value.linkPath), escaped), value.linkPath);
    assert.throws(() => resolveManagedIMsgExecutable(value), /imsg_unavailable/u);

    fs.unlinkSync(value.linkPath);
    fs.symlinkSync(path.relative(path.dirname(value.linkPath), value.target), value.linkPath);
    fs.chmodSync(value.target, 0o775);
    assert.throws(() => resolveManagedIMsgExecutable(value), /imsg_unavailable/u);
  } finally {
    value.cleanup();
  }
});
