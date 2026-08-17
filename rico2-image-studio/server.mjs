import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BACKEND = "http://192.168.4.246:1240";
export const DEFAULT_PORT = 3840;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_TIMEOUT_MS = 180_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export function shouldProxy(pathname) {
  return pathname === "/health" || pathname.startsWith("/v1/");
}

export function createStudioServer(options = {}) {
  const backend = new URL(options.backend ?? process.env.RICO2_BACKEND ?? DEFAULT_BACKEND);
  const publicDir = path.resolve(options.publicDir ?? path.join(__dirname, "public"));
  const timeoutMs = Number(options.timeoutMs ?? process.env.TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/studio/config") {
      sendJson(res, 200, {
        backend: backend.origin,
        timeoutSeconds: Math.round(timeoutMs / 1000),
        model: "black-forest-labs/FLUX.2-klein-4B",
        modelLabel: "Flux.2 Klein 4B",
      });
      return;
    }

    if (shouldProxy(url.pathname)) {
      proxyToBackend(req, res, {
        backend,
        timeoutMs,
        targetPath: `${url.pathname}${url.search}`,
      });
      return;
    }

    serveStatic(url.pathname, publicDir, res);
  });
}

export function listen(server, { host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serveStatic(pathname, publicDir, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.normalize(path.join(publicDir, requested));
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  createReadStream(resolved).pipe(res);
}

function proxyToBackend(req, res, { backend, timeoutMs, targetPath }) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === "host") {
      continue;
    }
    headers[key] = value;
  }
  headers.host = backend.host;

  const proxyReq = http.request(
    {
      protocol: backend.protocol,
      hostname: backend.hostname,
      port: backend.port || (backend.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
    },
    (proxyRes) => {
      const outHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value == null || HOP_BY_HOP.has(key.toLowerCase())) {
          continue;
        }
        outHeaders[key] = value;
      }
      res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.setTimeout(timeoutMs, () => {
    proxyReq.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  });

  proxyReq.on("error", (error) => {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    if (error.code === "ETIMEDOUT") {
      sendJson(res, 504, {
        error: {
          message: `The image took too long. The studio waited ${Math.round(timeoutMs / 1000)} seconds and stopped.`,
          code: "timeout",
        },
      });
      return;
    }
    sendJson(res, 502, {
      error: {
        message: "Rico 2 is not reachable. The image service at 192.168.4.246:1240 may be down.",
        code: "backend_down",
      },
    });
  });

  req.pipe(proxyReq);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const backend = process.env.RICO2_BACKEND || DEFAULT_BACKEND;
  const server = createStudioServer();
  listen(server, { host, port }).then(() => {
    const bind = host === "0.0.0.0" ? `http://127.0.0.1:${port}` : `http://${host}:${port}`;
    process.stdout.write(`Rico 2 Image Studio\n  UI      ${bind}\n  proxy   /v1/* and /health → ${backend}\n`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
