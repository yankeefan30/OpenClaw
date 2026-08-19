import readline from "node:readline";
import { MAX_LINE_BYTES } from "./constants.mjs";

export async function serveStdio({
  mcpServer,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    let response;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      response = rpcError(null, -32700, "Message too large");
    } else {
      try {
        const message = JSON.parse(line);
        if (Array.isArray(message)) {
          response = rpcError(null, -32600, "JSON-RPC batches are not supported");
        } else {
          response = await mcpServer.handle(message);
        }
      } catch {
        response = rpcError(null, -32700, "Parse error");
      }
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
