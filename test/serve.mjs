// Minimaler statischer Webserver für die Browser-Tests (Projektordner als Wurzel).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

const STRICT_CSP = "default-src 'none'; script-src 'self'; media-src 'self'; style-src 'self'";

export function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.includes("..")) return res.writeHead(403).end();
    try {
      const body = await readFile(join(ROOT, path));
      const headers = { "content-type": TYPES[extname(path)] || "application/octet-stream" };
      // Testseite mit strenger CSP wie bei großen Videoplattformen
      if (path.endsWith("e2e.html")) headers["content-security-policy"] = STRICT_CSP;
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, server })),
  );
}
