import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };

// Isolated production-bundle preview. Specs intercept every API request.
for (const [app, port, bundle] of [["web-admin", 8349, "dashboard-app"], ["storefront", 8350, "shop-app"]]) {
  const root = resolve("apps", app, "static");
  createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      if (pathname.startsWith("/api/")) {
        response.writeHead(500);
        response.end("Mock required");
        return;
      }
      const target = pathname.startsWith("/static/")
        ? resolve(root, decodeURIComponent(pathname.slice(8)))
        : resolve(root, bundle, "index.html");
      if (!target.startsWith(root + sep)) throw new Error("Invalid static path");
      response.setHeader("Content-Type", types[extname(target)] ?? "text/html");
      const body = await readFile(target);
      response.end(extname(target) === ".html"
        ? body.toString().replaceAll("__LANG__", "en").replaceAll("__CSRF_TOKEN__", "ui-test-token")
        : body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  }).listen(port, "127.0.0.1");
}
console.log("Mock-only preview on 8349 and 8350");
