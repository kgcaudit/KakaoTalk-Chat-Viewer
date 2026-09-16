// End-to-end checks for index.html, run against a real static host.
//   node tests/verify.mjs
// Requires Playwright's Chromium. The suite asserts the two guarantees that matter
// operationally: nothing a user imports reaches the server, and a large conversation
// stays responsive.
import { chromium } from 'playwright';
import { deflateRawSync, crc32 } from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(root, '..', 'index.html'));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

// --- a minimal deflate ZIP writer, so the suite carries its own fixtures ---
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(body);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(body) >>> 0, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    locals.push(head, nameBytes, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(body) >>> 0, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), dirBytes, end]);
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
  '9c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

function chatText(count, { attachEvery = 0 } = {}) {
  const people = ['홍길동', '김철수', '이영희', '박민수'];
  const lines = ['홍길동 님과 카카오톡 대화', '저장한 날짜 : 2024-01-05 10:00:00', ''];
  const HOSTILE = '</script><img src=x onerror="window.__pwned=1">';
  const BARE_PLACEHOLDER = '사진';   // what KakaoTalk writes for a photo, and what a person may simply type
  const attachments = [];
  for (let i = 0; i < count; i++) {
    if (i % 200 === 0) lines.push(`--------------- 2024년 ${1 + (i / 6000 | 0)}월 ${1 + (i / 200 | 0) % 28}일 월요일 ---------------`);
    const who = people[i % people.length], clock = `오전 10:${String(i % 60).padStart(2, '0')}`;
    if (attachEvery && i % attachEvery === 0) {
      const name = `photo_${String(i).padStart(5, '0')}.jpg`;
      attachments.push(name);
      lines.push(`[${who}] [${clock}] ${name}`);
    } else if (i === 7) {
      lines.push(`[${who}] [${clock}] ${HOSTILE}`);
    } else if (i === 11) {
      lines.push(`[${who}] [${clock}] ${BARE_PLACEHOLDER}`);
    } else {
      lines.push(`[${who}] [${clock}] 메시지 본문 ${i} 입니다.`);
    }
  }
  return { text: Buffer.from(lines.join('\n'), 'utf8'), attachments, hostile: HOSTILE };
}

const small = chatText(400, { attachEvery: 50 });
const smallZip = zip([['c/KakaoTalkChats.txt', small.text], ...small.attachments.map(n => [`c/${n}`, PNG])]);
// A second, differently sized conversation, so a cross-write between the app and an
// exported file is actually visible rather than masked by identical content.
const other = chatText(250);
const otherZip = zip([['c/KakaoTalkChats.txt', other.text]]);
const big = chatText(50000, { attachEvery: 120 });
const bigZip = zip([['c/KakaoTalkChats.txt', big.text], ...big.attachments.map(n => [`c/${n}`, PNG])]);

// --- host it the way production does ---
let exported = Buffer.from('');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/exported') ? exported : page);
});
await new Promise(r => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 }, acceptDownloads: true });
const errors = [];
const offSite = [];
// The CSP probes below deliberately trip the policy; every other refusal is a real fault.
let probing = false;
const expectedRefusal = text => probing && /Refused to|Content Security Policy/i.test(text);
ctx.on('page', p => {
  p.on('pageerror', e => errors.push(`${p.url()}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !expectedRefusal(m.text())) errors.push(`${p.url()}: ${m.text()}`); });
  // blob: and data: never leave the browser; anything else would be an upload path.
  p.on('request', r => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) offSite.push(u); });
});

const app = await ctx.newPage();
await app.goto(origin);
await app.waitForTimeout(400);

// The policy pins every inline script by hash; 'unsafe-inline' would defeat it.
const csp = page.toString('utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
check('script-src carries no unsafe-inline', !/script-src[^;]*'unsafe-inline'/.test(csp));
check('script-src pins hashes', (csp.match(/sha256-/g) || []).length >= 10, `${(csp.match(/sha256-/g) || []).length} hashes`);

probing = true;
check('the page refuses an injected inline script and style', await app.evaluate(async () => {
  const s = document.createElement('script'); s.textContent = 'window.__injected=1'; document.head.append(s);
  const t = document.createElement('style'); t.textContent = 'body{display:none}'; document.head.append(t);
  await new Promise(r => setTimeout(r, 150));
  const blocked = window.__injected === undefined && getComputedStyle(document.body).display !== 'none';
  s.remove(); t.remove();
  // the app writes element.style directly, which style-src-attr must still allow
  const probe = document.createElement('div'); probe.style.color = 'rgb(1, 2, 3)';
  return blocked && probe.style.color === 'rgb(1, 2, 3)';
}) === true);

check('the page cannot reach any other origin', await app.evaluate(async () => {
  try { await fetch('https://example.com'); return false; } catch { return true; }
}) === true);
await app.waitForTimeout(150);
probing = false;

check('no duplicate element ids', (await app.evaluate(() => {
  const seen = new Map();
  document.querySelectorAll('[id]').forEach(e => seen.set(e.id, (seen.get(e.id) || 0) + 1));
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
})).length === 0);

// --- import a ZIP entirely client-side ---
const requestsBefore = offSite.length;
await app.setInputFiles('#txt', { name: 'chat.zip', mimeType: 'application/zip', buffer: smallZip });
await app.waitForFunction(() => $('review').open, null, { timeout: 60000 });
await app.click('#save');
await app.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
check('ZIP import parses every message', (await app.textContent('#count')).includes('전체 400개 메시지'), await app.textContent('#count'));
check('import links its attachments', (await app.textContent('#attachmentCount')).includes('연결됨 8'), await app.textContent('#attachmentCount'));
check('import sends nothing off-origin', offSite.length === requestsBefore, offSite.slice(requestsBefore).join(', '));

// '사진' on its own may be KakaoTalk's photo placeholder or a real message. Keep both.
check('a bare 사진 message keeps its text and still offers the picker', await app.evaluate(() => {
  const bubble = [...document.querySelectorAll('.message .bubble')]
    .find(b => b.firstChild?.nodeType === Node.TEXT_NODE && b.firstChild.textContent === '사진');
  return !!bubble && !!bubble.querySelector('.missing-attachment button');
}) === true);

check('enlarged image survives a re-render', await app.evaluate(async () => {
  const button = document.querySelector('#messages .image-attachment');
  if (!button) return 'no image on screen';
  button.click();
  renderMessages();                       // revokes every object URL the message list made
  await new Promise(r => setTimeout(r, 250));
  const img = $('largeImage');
  const ok = $('viewer').open && img.complete && img.naturalWidth > 0;
  $('viewer').close();
  return ok;
}) === true);


// --- export, then reopen the exported file from the same origin ---
await app.click('#infoToggle');
await app.waitForTimeout(300);
const [download] = await Promise.all([
  app.waitForEvent('download', { timeout: 30000 }),
  app.click('#portableActions button'),
]);
exported = fs.readFileSync(await download.path());
check('export produces a standalone file', exported.length > page.length);

// Replace the app's conversation, so it differs from the file just exported.
await app.setInputFiles('#txt', { name: 'other.zip', mimeType: 'application/zip', buffer: otherZip });
await app.waitForFunction(() => $('review').open, null, { timeout: 60000 });
await app.click('#save');
await app.waitForFunction(() => !$('review').open, null, { timeout: 60000 });

// Scrolling used to persist the room title to localStorage on a 250ms debounce.
await app.evaluate(() => { const b = $('messages'); b.scrollTop = 200; b.dispatchEvent(new Event('scroll')); });
await app.waitForTimeout(700);
check('scrolling writes no position record to localStorage',
  await app.evaluate(() => localStorage.getItem('drawer-position')) === null);

const saved = await app.evaluate(() => new Promise(res => {
  const req = indexedDB.open('conversation-drawer-empty-viewer', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('data');
  req.onerror = () => res(null);
  req.onsuccess = () => {
    const get = req.result.transaction('data', 'readonly').objectStore('data').get('chat');
    get.onsuccess = () => res(get.result ? get.result.messages.length : null);
    get.onerror = () => res(null);
  };
}));
check('app keeps its conversation in IndexedDB', saved === 250, `${saved} messages`);

// A fresh profile shows what an exported file leaves behind on its own.
const clean = await browser.newContext({ viewport: { width: 1280, height: 850 } });
const soloViewer = await clean.newPage();
await soloViewer.goto(`${origin}/exported`);
await soloViewer.waitForTimeout(1200);
check('exported file reopens with its conversation', (await soloViewer.textContent('#count')).includes('전체 400개 메시지'));
check('a message containing </script> survives the export intact',
  await soloViewer.evaluate(t => [...document.querySelectorAll('.bubble')].some(b => b.textContent === t), small.hostile));
check('no markup from message text is executed', await soloViewer.evaluate(() => window.__pwned === undefined));
check('exported file asks not to be indexed',
  await soloViewer.evaluate(() => document.querySelector('meta[name="robots"]')?.content.includes('noindex') === true));
await soloViewer.evaluate(() => { $('me').value = '김철수'; $('me').dispatchEvent(new Event('change')); });
await soloViewer.waitForTimeout(600);
check('exported file creates no database, even after an edit',
  (await soloViewer.evaluate(async () => (await indexedDB.databases()).map(d => d.name))).length === 0);
check('exported file stores no conversation in localStorage',
  (await soloViewer.evaluate(() => Object.keys(localStorage))).every(k => k === 'conversation-drawer-sidebar-width'));
await clean.close();

// Files exported by the earlier build carried the whole payload as one base64 blob.
const payloadOf = html => html.toString('utf8').match(/<script id="embedded-chat" type="application\/octet-stream">([^<]*)<\/script>/)[1];
check('the new export embeds plain JSON', payloadOf(exported).startsWith('{'));
const legacyShell = Buffer.from(page.toString('utf8').replace(
  '<script id="embedded-chat" type="application/octet-stream"></script>',
  `<script id="embedded-chat" type="application/octet-stream">${Buffer.from(payloadOf(exported), 'utf8').toString('base64')}</script>`), 'utf8');
const legacyCtx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
const legacyPage = await legacyCtx.newPage();
await legacyPage.route('**/legacy', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: legacyShell }));
await legacyPage.goto(`${origin}/legacy`);
await legacyPage.waitForTimeout(1500);
check('a file exported by the earlier build still opens',
  (await legacyPage.textContent('#count')).includes('전체 400개 메시지'), await legacyPage.textContent('#count'));
await legacyCtx.close();

// Alongside a saved conversation on the same origin, its writes must not reach that store.
const viewer = await ctx.newPage();
await viewer.goto(`${origin}/exported`);
await viewer.waitForTimeout(1200);
await viewer.evaluate(() => { $('me').value = '김철수'; $('me').dispatchEvent(new Event('change')); });
await viewer.waitForTimeout(600);
await app.reload();
await app.waitForTimeout(1200);
check('exported file cannot overwrite the app\'s saved conversation',
  (await app.textContent('#count')).includes('전체 250개 메시지'), await app.textContent('#count'));

// --- a long conversation has to stay interactive ---
const heavy = await ctx.newPage();
await heavy.goto(origin);
await heavy.waitForTimeout(300);
await heavy.setInputFiles('#txt', { name: 'big.zip', mimeType: 'application/zip', buffer: bigZip });
await heavy.waitForFunction(() => $('review').open, null, { timeout: 180000 });
await heavy.click('#save');
await heavy.waitForFunction(() => !$('review').open, null, { timeout: 180000 });
const timings = await heavy.evaluate(() => {
  const time = fn => { const t = performance.now(); fn(); return Math.round(performance.now() - t); };
  return { render: time(() => renderMessages()), turn: time(() => { start = 160; renderMessages(); }), panel: time(() => renderAttachmentPanel()) };
});
check('50,000 messages render under 2s', timings.render < 2000, `${timings.render}ms`);
check('paging through 50,000 messages stays under 2s', timings.turn < 2000, `${timings.turn}ms`);
check('attachment panel rebuilds under 2s', timings.panel < 2000, `${timings.panel}ms`);

check('download filenames stay safe', await app.evaluate(() =>
  JSON.stringify(['', '  ..  ', 'CON', 'a/b:c*d?e'].map(downloadName)) ===
  JSON.stringify(['대화기록.html', '대화기록.html', '대화기록.html', 'a_b_c_d_e.html'])));

check('no page or console errors anywhere', errors.length === 0, errors.join(' | '));
check('nothing at all left the origin', offSite.length === 0, offSite.join(', '));

await browser.close();
server.close();

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
