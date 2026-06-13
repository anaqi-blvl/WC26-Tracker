#!/usr/bin/env node
/**
 * deploy-html.js
 *
 * Reads public/index.html and pushes it into Cloudflare KV under the key "html".
 * Run after any frontend change:
 *   node deploy-html.js
 *
 * Requires wrangler to be authenticated (`wrangler login` or CLOUDFLARE_API_TOKEN env).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HTML_PATH = path.join(__dirname, "public", "index.html");

if (!fs.existsSync(HTML_PATH)) {
  console.error("❌  public/index.html not found. Build the frontend first.");
  process.exit(1);
}

const size = fs.statSync(HTML_PATH).size;
console.log(`📄  Uploading public/index.html (${(size / 1024).toFixed(1)} KB) → KV key "html"`);

try {
  execSync(
    `wrangler kv:key put --binding=WC26_KV --preview false "html" --path="${HTML_PATH}"`,
    { stdio: "inherit" }
  );
  console.log("✅  HTML deployed to KV");
} catch (err) {
  console.error("❌  Deploy failed:", err.message);
  process.exit(1);
}
