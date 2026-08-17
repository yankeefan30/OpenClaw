import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  closeServer,
  createStudioServer,
  listen,
  shouldProxy,
} from "../server.mjs";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";

function listenLocal(server) {
  return listen(server, { host: "127.0.0.1", port: 0 }).then((bound) => {
    const address = bound.address();
    return { server: bound, port: address.port, origin: `http://127.0.0.1:${address.port}` };
  });
}

async function withServers({ backendHandler, timeoutMs, publicDir } = {}, run) {
  const backend = http.createServer(backendHandler ?? ((req, res) => {
    res.writeHead(404);
    res.end();
  }));
  const backendBound = await listenLocal(backend);
  const studio = createStudioServer({
    backend: backendBound.origin,
    timeoutMs: timeoutMs ?? 2_000,
    publicDir,
  });
  const studioBound = await listenLocal(studio);
  try {
    await run({ studio: studioBound, backend: backendBound });
  } finally {
    await closeServer(studioBound.server);
    await closeServer(backendBound.server);
  }
}

function request(origin, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, origin);
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            text: raw.toString("utf8"),
            json() {
              return JSON.parse(raw.toString("utf8"));
            },
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body != null) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

test("shouldProxy only forwards health and /v1 routes", () => {
  assert.equal(shouldProxy("/health"), true);
  assert.equal(shouldProxy("/v1/models"), true);
  assert.equal(shouldProxy("/v1/images/generations"), true);
  assert.equal(shouldProxy("/studio/config"), false);
  assert.equal(shouldProxy("/index.html"), false);
  assert.equal(shouldProxy("/etc/passwd"), false);
});

test("serves the studio UI from the public folder", async () => {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), "rico2-studio-"));
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>Studio</title>", "utf8");

  await withServers({ publicDir }, async ({ studio }) => {
    const home = await request(studio.origin, "/");
    assert.equal(home.status, 200);
    assert.match(home.headers["content-type"], /text\/html/);
    assert.match(home.text, /Studio/);

    const missing = await request(studio.origin, "/no-such-file.css");
    assert.equal(missing.status, 404);
  });
});

test("refuses path traversal for static files", async () => {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), "rico2-studio-"));
  await writeFile(path.join(publicDir, "index.html"), "ok", "utf8");

  await withServers({ publicDir }, async ({ studio }) => {
    const res = await request(studio.origin, "/../server.mjs");
    assert.ok(res.status === 403 || res.status === 404);
    assert.doesNotMatch(res.text, /createStudioServer/);
  });
});

test("GET /studio/config describes the proxied backend", async () => {
  await withServers({}, async ({ studio, backend }) => {
    const res = await request(studio.origin, "/studio/config");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), {
      backend: backend.origin,
      timeoutSeconds: 2,
      model: MODEL_ID,
      modelLabel: "Flux.2 Klein 4B",
    });
  });
});

test("proxies GET /health and GET /v1/models to the mock backend", async () => {
  const seen = [];
  await withServers({
    backendHandler(req, res) {
      seen.push({ method: req.method, url: req.url, host: req.headers.host });
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL_ID }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  }, async ({ studio, backend }) => {
    const health = await request(studio.origin, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { status: "ok" });

    const models = await request(studio.origin, "/v1/models");
    assert.equal(models.status, 200);
    assert.equal(models.json().data[0].id, MODEL_ID);

    assert.deepEqual(seen, [
      { method: "GET", url: "/health", host: new URL(backend.origin).host },
      { method: "GET", url: "/v1/models", host: new URL(backend.origin).host },
    ]);
  });
});

test("proxies POST /v1/images/generations body and returns b64_json", async () => {
  let received = null;
  await withServers({
    backendHandler(req, res) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received = {
          method: req.method,
          url: req.url,
          type: req.headers["content-type"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          created: 1_700_000_000,
          data: [{ b64_json: PIXEL_PNG, path: "/tmp/mock.png" }],
        }));
      });
    },
  }, async ({ studio }) => {
    const payload = {
      prompt: "a contact sheet of brass tools on black linen",
      model: MODEL_ID,
      n: 1,
      size: "512x512",
      response_format: "b64_json",
      steps: 4,
      seed: 1,
    };
    const res = await request(studio.origin, "/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().data[0].b64_json, PIXEL_PNG);
    assert.deepEqual(received, {
      method: "POST",
      url: "/v1/images/generations",
      type: "application/json",
      body: payload,
    });
  });
});

test("returns a plain-English 502 when the backend is down", async () => {
  const studio = createStudioServer({
    backend: "http://127.0.0.1:1",
    timeoutMs: 500,
    publicDir: await mkdtemp(path.join(os.tmpdir(), "rico2-studio-")),
  });
  const bound = await listenLocal(studio);
  try {
    const res = await request(bound.origin, "/v1/models");
    assert.equal(res.status, 502);
    assert.equal(res.json().error.code, "backend_down");
    assert.match(res.json().error.message, /not reachable/i);
  } finally {
    await closeServer(bound.server);
  }
});

test("returns a plain-English 504 when the backend exceeds the timeout", async () => {
  await withServers({
    timeoutMs: 80,
    backendHandler(_req, res) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "late" }));
      }, 400);
    },
  }, async ({ studio }) => {
    const res = await request(studio.origin, "/health");
    assert.equal(res.status, 504);
    assert.equal(res.json().error.code, "timeout");
    assert.match(res.json().error.message, /too long/i);
  });
});

test("does not proxy unrelated paths to the backend", async () => {
  let backendHits = 0;
  const publicDir = await mkdtemp(path.join(os.tmpdir(), "rico2-studio-"));
  await writeFile(path.join(publicDir, "index.html"), "ui", "utf8");

  await withServers({
    publicDir,
    backendHandler(_req, res) {
      backendHits += 1;
      res.writeHead(200);
      res.end("backend");
    },
  }, async ({ studio }) => {
    const res = await request(studio.origin, "/secret");
    assert.equal(res.status, 404);
    assert.equal(res.text, "Not found");
    assert.equal(backendHits, 0);
  });
});

test("package entrypoint is the local studio server", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await import("node:fs/promises").then((fs) => (
    fs.readFile(path.join(here, "../package.json"), "utf8")
  )));
  assert.equal(pkg.scripts.start, "node server.mjs");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
});
