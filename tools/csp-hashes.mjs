// Rewrites the Content-Security-Policy <meta> in index.html with the SHA-256 hash of
// every inline <script> and <style>, so the policy no longer needs 'unsafe-inline'.
//
//   node tools/csp-hashes.mjs          rewrite index.html in place
//   node tools/csp-hashes.mjs --check  exit 1 if the policy is stale (used by the tests)
//
// Run this after ANY edit to an inline script or style block. A stale policy means the
// browser refuses to run the page, so `npm test` fails loudly rather than silently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const sha = text => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

// A <script> with a non-JavaScript type is never executed, so CSP does not check it —
// and its content (the embedded conversation) differs in every exported file.
const scripts = [...html.matchAll(/<script(?![^>]*type="application\/octet-stream")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);

const unique = list => [...new Set(list)];
const policy = [
  "default-src 'none'",
  `script-src ${unique(scripts.map(sha)).join(' ')}`,
  // Inline style ATTRIBUTES (element.style.setProperty, avatar.style.background) fall under
  // style-src-attr, which cannot be hashed. style-src-elem pins the two <style> blocks;
  // browsers without style-src-elem fall back to style-src and still work.
  "style-src 'unsafe-inline'",
  `style-src-elem ${unique(styles.map(sha)).join(' ')}`,
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const meta = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;
if (!meta.test(html)) {
  console.error('no Content-Security-Policy <meta> found in index.html');
  process.exit(1);
}

const current = html.match(meta)[2];
if (process.argv.includes('--check')) {
  if (current === policy) {
    console.log(`CSP is current (${scripts.length} scripts, ${styles.length} styles)`);
    process.exit(0);
  }
  console.error('CSP is stale. Run: node tools/csp-hashes.mjs');
  console.error(`  in file: ${current}`);
  console.error(`  expected: ${policy}`);
  process.exit(1);
}

fs.writeFileSync(file, html.replace(meta, (_, open, __, close) => open + policy + close));
console.log(current === policy ? 'CSP unchanged' : `CSP updated (${scripts.length} scripts, ${styles.length} styles)`);
