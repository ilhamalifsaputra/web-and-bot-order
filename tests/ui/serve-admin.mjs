import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const staticRoot = resolve("apps/web-admin/static");
const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path.startsWith("/api/")) { res.writeHead(500); res.end("API must be mocked by the UI test"); return; }
  try {
    if (path.startsWith("/static/")) {
      const target = resolve(staticRoot, decodeURIComponent(path.slice("/static/".length)));
      if (!target.startsWith(staticRoot + sep)) throw new Error("invalid path");
      res.setHeader("Content-Type", types[extname(target)] ?? "application/octet-stream");
      res.end(await readFile(target));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end((await readFile(resolve(staticRoot, "dashboard-app/index.html"), "utf8")).replaceAll("__CSRF_TOKEN__", "ui-test-token"));
    }
  } catch { res.writeHead(404); res.end("Build the admin client before running this harness."); }
}).listen(8221, "127.0.0.1");
