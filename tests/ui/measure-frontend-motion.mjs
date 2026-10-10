import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const evidence = "docs/audits/frontend-motion-evidence";
const baseline = JSON.parse(readFileSync(`${evidence}/bundle-before.json`, "utf8"));
function stats(files) {
  const js = files.filter(file => file.file.endsWith(".js"));
  const css = files.filter(file => file.file.endsWith(".css"));
  return {
    jsChunks: js.length,
    jsBytes: js.reduce((sum, file) => sum + file.bytes, 0),
    jsGzip: js.reduce((sum, file) => sum + file.gzip, 0),
    cssGzip: css.reduce((sum, file) => sum + file.gzip, 0),
    largestIndexChunk: js.filter(file => /^index-/.test(file.file)).sort((a, b) => b.bytes - a.bytes)[0],
  };
}
const summary = {};
for (const [app, bundle] of [["storefront", "shop-app"], ["web-admin", "dashboard-app"]]) {
  const directory = `apps/${app}/static/${bundle}/assets`;
  const files = readdirSync(directory).filter(file => /\.(js|css)$/.test(file)).map(file => {
    const content = readFileSync(join(directory, file));
    return { file, bytes: content.length, gzip: gzipSync(content).length };
  });
  summary[app] = { before: stats(baseline[app]), after: stats(files) };
}
function luminance(hex) {
  const rgb = hex.match(/\w\w/g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
const contrasts = [
  ["blue guidance text", "1d4ed8", "e6effe"],
  ["success banner text", "5a6473", "e7f6ec"],
  ["warning banner text", "5a6473", "fdedcf"],
  ["success icon (nontext)", "15803d", "e7f6ec"],
  ["warning icon (nontext)", "b45c0a", "fdedcf"],
  ["error text", "b91c1c", "fde7e7"],
  ["muted text on inset", "5a6473", "eef1f6"],
  ["legacy faint on inset (deferred)", "677288", "eef1f6"],
  ["primary button text", "ffffff", "2563eb"],
].map(([role, foreground, background]) => {
  const a = luminance(foreground), b = luminance(background);
  return { role, foreground: `#${foreground}`, background: `#${background}`, ratio: Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)) };
});
mkdirSync(evidence, { recursive: true });
const result = { method: "Production Vite bundles; raw bytes and node gzip per file. Summed gzip is an inventory, not one page transfer. Largest index chunk recorded separately. Contrast uses WCAG sRGB relative luminance for listed opaque pairs only.", summary, contrasts };
writeFileSync(`${evidence}/metrics.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
