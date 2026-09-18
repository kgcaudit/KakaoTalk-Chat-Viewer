// End-to-end checks for index.html, run against a real static host.
//   node tests/verify.mjs
// Requires Playwright's Chromium. The suite asserts the two guarantees that matter
// operationally: nothing a user imports reaches the server, and a large conversation
// stays responsive.
import { chromium } from 'playwright';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
  for (const [name, content] of entries) {
    // Declared sizes are in BYTES; a Korean string's length is characters, and the
    // reader rejects an entry that decompresses past the size the archive claims.
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
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

// A solid PNG of any shape, so the layout checks can see a real aspect ratio.
// Width and height only ever reach the browser through the file itself, never CSS.
function solidPng(width, height) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;   // 8 bits per sample, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
  '9c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

function chatText(count, { attachEvery = 0, title = '홍길동' } = {}) {
  const people = ['홍길동', '김철수', '이영희', '박민수'];
  const lines = [`${title} 카카오톡 대화`, '저장한 날짜 : 2024-01-05 10:00:00', ''];
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
const other = chatText(250, { title: '다른방' });
const otherZip = zip([['c/KakaoTalkChats.txt', other.text]]);
// Two conversation folders in one archive — what KakaoTalk produces when several
// rooms are exported together.
const roomA = chatText(120, { attachEvery: 40, title: '가군' });
const roomB = chatText(90, { attachEvery: 30, title: '나군' });
// The same conversation exported again later: identical opening, 30 further messages.
const roomAlonger = chatText(150, { attachEvery: 40, title: '가군' });
const roomAlongerZip = zip([
  ['Chats/KakaoTalk_Chats_A_later/KakaoTalkChats.txt', roomAlonger.text],
  ...roomAlonger.attachments.map(n => [`Chats/KakaoTalk_Chats_A_later/${n}`, PNG]),
]);
const soloB = zip([['solo/KakaoTalkChats.txt', roomB.text]]);
const pairZip = zip([
  ['Chats/KakaoTalk_Chats_A/KakaoTalkChats.txt', roomA.text],
  ...roomA.attachments.map(n => [`Chats/KakaoTalk_Chats_A/${n}`, PNG]),
  ['Chats/KakaoTalk_Chats_B/KakaoTalkChats.txt', roomB.text],
  ...roomB.attachments.map(n => [`Chats/KakaoTalk_Chats_B/${n}`, PNG]),
]);
const big = chatText(50000, { attachEvery: 120 });
const bigZip = zip([['c/KakaoTalkChats.txt', big.text], ...big.attachments.map(n => [`c/${n}`, PNG])]);

// --- host it the way production does ---
let exported = Buffer.from('');
let pairExport = Buffer.from('');
const worker = fs.readFileSync(path.join(root, '..', 'sw.js'));
// Serve the worker the way a real host does; a wrong media type makes registration fail.
let online = true;
const server = http.createServer((req, res) => {
  if (!online) { req.socket.destroy(); return; }
  if (req.url.startsWith('/sw.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    res.end(worker);
    return;
  }
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
  // blob:, data: and file: never leave the browser; anything else would be an upload path.
  // (file: is the downloaded viewer being opened from disk, below.)
  p.on('request', r => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('file:')) offSite.push(u); });
});

// Imports stack onto what is already stored, so each scenario gets its own profile.
async function freshPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ...options });
  const created = await context.newPage();
  created.on('pageerror', e => errors.push(`${created.url()}: ${e.message}`));
  created.on('console', m => { if (m.type() === 'error' && !expectedRefusal(m.text())) errors.push(`${created.url()}: ${m.text()}`); });
  created.on('request', r => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('file:')) offSite.push(u); });
  await created.goto(origin);
  await created.waitForTimeout(300);
  return { context, page: created };
}

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


// --- an archive holding two conversations opens as two rooms ---
{
  const { context: manyContext, page: many } = await freshPage({ acceptDownloads: true });
  await many.setInputFiles('#txt', { name: 'pair.zip', mimeType: 'application/zip', buffer: pairZip });
  await many.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  check('an archive with two conversations is accepted',
    (await many.textContent('#summary')).includes('대화방 2개'), await many.textContent('#summary'));
  await many.click('#save');
  await many.waitForFunction(() => !$('review').open, null, { timeout: 60000 });

  check('both conversations appear in the sidebar',
    await many.evaluate(() => document.querySelectorAll('#rooms .room').length) === 2);
  check('the room counter shows both', (await many.textContent('#roomCount')) === '2');
  check('the first room opens', (await many.textContent('#count')).includes('전체 120개 메시지'),
    await many.textContent('#count'));

  await many.click('#infoToggle');
  await many.waitForTimeout(300);
  check('the open room links only its own attachments',
    (await many.textContent('#attachmentCount')).includes('연결됨 3'), await many.textContent('#attachmentCount'));

  await many.click('#rooms .room-row:nth-child(2) .room');
  await many.waitForTimeout(500);
  check('switching rooms shows the other conversation',
    (await many.textContent('#count')).includes('전체 90개 메시지'), await many.textContent('#count'));
  await many.click('#infoToggle');
  await many.waitForTimeout(300);
  check('the second room links its own attachments',
    (await many.textContent('#attachmentCount')).includes('연결됨 3'), await many.textContent('#attachmentCount'));

  // Exporting carries every room, and the copy reopens with all of them.
  await many.evaluate(() => setConversationTools(true));
  await many.waitForTimeout(300);
  const [pairDownload] = await Promise.all([
    many.waitForEvent('download', { timeout: 60000 }),
    many.click('#portableActions button'),
  ]);
  pairExport = fs.readFileSync(await pairDownload.path());

  // A later export of the same conversation adds only what is genuinely new.
  await many.setInputFiles('#txt', { name: 'a-later.zip', mimeType: 'application/zip', buffer: roomAlongerZip });
  await many.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  check('a later export of the same conversation reports only the new messages',
    (await many.textContent('#sample')).includes('30개 추가'), (await many.textContent('#sample')).split('\n')[0]);
  await many.click('#save');
  await many.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  await many.waitForTimeout(300);
  check('the conversation grew instead of being replaced',
    await many.evaluate(() => library.rooms.map(r => `${r.title}:${r.messages.length}`).join(',')) === '가군:150,나군:90',
    await many.evaluate(() => library.rooms.map(r => `${r.title}:${r.messages.length}`).join(',')));
  check('merged messages keep contiguous ids',
    await many.evaluate(() => library.rooms.every(r => r.messages.every((m, i) => m.id === i))));

  // Bringing the very same archive back in changes nothing.
  await many.setInputFiles('#txt', { name: 'a-again.zip', mimeType: 'application/zip', buffer: roomAlongerZip });
  await many.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  check('re-importing the same export offers nothing to add',
    await many.evaluate(() => $('save').disabled) === true, await many.textContent('#warnings'));
  await many.click('#cancel');
  await many.waitForTimeout(200);

  // A separate archive for a room already held stacks on rather than wiping the rest.
  await many.setInputFiles('#txt', { name: 'solo-b.zip', mimeType: 'application/zip', buffer: soloB });
  await many.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await many.click('#cancel');
  await many.waitForTimeout(200);
  check('a separate archive leaves the other rooms in place',
    await many.evaluate(() => library.rooms.length) === 2);

  await manyContext.close();

  const reopened = await ctx.newPage();
  await reopened.route('**/pair-export', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: pairExport }));
  await reopened.goto(`${origin}/pair-export`);
  await reopened.waitForTimeout(1500);
  check('an exported copy keeps both rooms',
    await reopened.evaluate(() => document.querySelectorAll('#rooms .room').length) === 2);
  check('an exported copy still switches rooms', await (async () => {
    await reopened.click('#rooms .room-row:nth-child(2) .room');
    await reopened.waitForTimeout(400);
    return (await reopened.textContent('#count')).includes('전체 90개 메시지');
  })(), await reopened.textContent('#count'));
  await reopened.close();
}

// On a phone the sidebar collapses to a bar, so rooms are reached through a picker.
{
  const phoneView = { viewport: { width: 414, height: 840 }, isMobile: true, hasTouch: true };

  // One conversation needs no picker, so the bar stays exactly as it was.
  const lone = await freshPage(phoneView);
  await lone.page.setInputFiles('#txt', { name: 'chat.zip', mimeType: 'application/zip', buffer: smallZip });
  await lone.page.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await lone.page.click('#save');
  await lone.page.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  check('a single conversation shows no picker on a phone',
    await lone.page.evaluate(() => $('roomPicker').hidden) === true);
  await lone.context.close();

  const { context: phone, page: small } = await freshPage(phoneView);
  await small.setInputFiles('#txt', { name: 'pair.zip', mimeType: 'application/zip', buffer: pairZip });
  await small.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await small.click('#save');
  await small.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  await small.waitForTimeout(400);

  check('two conversations put a picker in the bar',
    await small.evaluate(() => !$('roomPicker').hidden && getComputedStyle($('rooms')).display === 'none'));
  check('the picker names the open room',
    (await small.textContent('#roomPicker')).includes(await small.textContent('#title')));

  await small.click('#roomPicker');
  await small.waitForTimeout(300);
  check('tapping the picker reveals both rooms',
    await small.evaluate(() => [...document.querySelectorAll('#rooms .room')].filter(b => b.offsetParent !== null).length) === 2);

  await small.click('#rooms .room-row:nth-child(2) .room');
  await small.waitForTimeout(500);
  check('choosing a room on a phone switches and closes the list',
    (await small.textContent('#count')).includes('전체 90개 메시지') &&
    await small.evaluate(() => !$('rooms').classList.contains('open')), await small.textContent('#count'));

  await small.click('#roomPicker');
  await small.waitForTimeout(200);
  await small.click('#messages', { position: { x: 100, y: 300 } });
  await small.waitForTimeout(200);
  check('tapping the conversation closes the picker',
    await small.evaluate(() => !$('rooms').classList.contains('open')));
  await phone.close();
}

// A conversation saved by the earlier single-room build must survive the upgrade.
{
  const upgraded = await ctx.newPage();
  await upgraded.goto(origin);
  await upgraded.waitForTimeout(300);
  await upgraded.evaluate(() => new Promise(res => {
    const req = indexedDB.open('conversation-drawer-empty-viewer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('data');
    req.onsuccess = () => {
      const legacy = { title: '예전 대화', me: '홍길동', demo: false, files: [], unparsed: [],
        participants: ['홍길동', '김철수'],
        messages: [{ id: 0, date: '2024-01-01', sender: '홍길동', time: '오전 10:01', text: '이전 버전이 저장한 대화' }] };
      const tx = req.result.transaction('data', 'readwrite');
      tx.objectStore('data').put(legacy, 'chat');
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    };
    req.onerror = () => res();
  }));
  await upgraded.reload();
  await upgraded.waitForTimeout(1200);
  check('a conversation saved by the earlier build still opens',
    (await upgraded.textContent('#title')) === '예전 대화' &&
    (await upgraded.textContent('#count')).includes('전체 1개 메시지'), await upgraded.textContent('#count'));
  check('the upgraded conversation shows as one room',
    await upgraded.evaluate(() => document.querySelectorAll('#rooms .room').length) === 1);
  await upgraded.close();
}

// --- export, then reopen the exported file from the same origin ---
await app.click('#infoToggle');
await app.waitForTimeout(300);
const [download] = await Promise.all([
  app.waitForEvent('download', { timeout: 30000 }),
  app.click('#portableActions button'),
]);
exported = fs.readFileSync(await download.path());
check('export produces a standalone file', exported.length > page.length);

// Bring in a second conversation, so what the app holds differs from the file just exported.
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
    get.onsuccess = () => res((get.result?.rooms ?? []).map(r => `${r.title}:${r.messages.length}`).join(','));
    get.onerror = () => res(null);
  };
}));
check('importing stacks conversations rather than replacing them',
  saved === '홍길동:400,다른방:250', String(saved));

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
check('the new export embeds a room list', JSON.parse(payloadOf(exported)).rooms?.length === 1);
// The earlier build embedded ONE conversation, base64-wrapped, with no room list.
const legacyPayload = Buffer.from(JSON.stringify(JSON.parse(payloadOf(exported)).rooms[0]), 'utf8').toString('base64');
const legacyShell = Buffer.from(page.toString('utf8').replace(
  '<script id="embedded-chat" type="application/octet-stream"></script>',
  `<script id="embedded-chat" type="application/octet-stream">${legacyPayload}</script>`), 'utf8');
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

// --- the device keeps the work: where you were, and the app itself ---
{
  const { context: kept, page: keeper } = await freshPage();
  await keeper.setInputFiles('#txt', { name: 'pair.zip', mimeType: 'application/zip', buffer: pairZip });
  await keeper.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await keeper.click('#save');
  await keeper.waitForFunction(() => !$('review').open, null, { timeout: 60000 });

  await keeper.click('#rooms .room-row:nth-child(2) .room');
  await keeper.waitForTimeout(400);
  await keeper.evaluate(() => { $('messages').scrollTop = 300; $('messages').dispatchEvent(new Event('scroll')); });
  await keeper.waitForTimeout(800);

  const before = await keeper.textContent('#title');
  await keeper.reload();
  await keeper.waitForTimeout(1500);
  check('a reload reopens the room you were reading',
    (await keeper.textContent('#title')) === before, `${before} -> ${await keeper.textContent('#title')}`);
  check('a reload restores the scroll position',
    Math.abs(await keeper.evaluate(() => $('messages').scrollTop) - 300) < 20,
    String(await keeper.evaluate(() => Math.round($('messages').scrollTop))));

  check('the offline shell is installed',
    await keeper.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active) === true);
  check('the sidebar reports what the device holds',
    (await keeper.textContent('#storageState')).includes('오프라인 준비됨'),
    await keeper.textContent('#storageState'));

  // With the host unreachable, a brand-new tab must still open the app and the chats.
  online = false;
  const offline = await kept.newPage();
  await offline.goto(origin, { waitUntil: 'load' }).catch(() => {});
  await offline.waitForTimeout(1500);
  check('the app opens with the host unreachable',
    (await offline.title().catch(() => '')).includes('대화서랍'), await offline.title().catch(() => '(no title)'));
  check('the conversations are there offline',
    await offline.evaluate(() => document.querySelectorAll('#rooms .room').length).catch(() => 0) === 2);
  online = true;
  await kept.close();
}

// --- removing one conversation leaves the others alone ---
{
  const { context: trimming, page: trim } = await freshPage();
  trim.on('dialog', d => d.accept());
  await trim.setInputFiles('#txt', { name: 'pair.zip', mimeType: 'application/zip', buffer: pairZip });
  await trim.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await trim.click('#save');
  await trim.waitForFunction(() => !$('review').open, null, { timeout: 60000 });

  check('the picker stays out of the way on a wide screen',
    await trim.evaluate(() => getComputedStyle($('roomPicker')).display) === 'none');
  check('every room offers a remove',
    await trim.evaluate(() => document.querySelectorAll('#rooms .room-row .room-remove').length) === 2);

  // Open the second room, then remove the first: the open one must stay open.
  await trim.click('#rooms .room-row:nth-child(2) .room');
  await trim.waitForTimeout(400);
  const reading = await trim.textContent('#title');
  await trim.click('#rooms .room-row:nth-child(1) .room-remove');
  await trim.waitForTimeout(700);
  check('removing another room keeps the one you are reading open',
    (await trim.textContent('#title')) === reading, `${reading} -> ${await trim.textContent('#title')}`);
  check('only the removed room is gone',
    await trim.evaluate(() => library.rooms.map(r => r.title).join(',')) === '나군',
    await trim.evaluate(() => library.rooms.map(r => r.title).join(',')));
  check('the room counter follows', (await trim.textContent('#roomCount')) === '1');

  await trim.reload();
  await trim.waitForTimeout(1200);
  check('the removal survives a reload',
    await trim.evaluate(() => library.rooms.length) === 1);

  // Removing the last one returns the empty state, not a broken view.
  await trim.click('#rooms .room-row:nth-child(1) .room-remove');
  await trim.waitForTimeout(700);
  check('removing the last room empties the drawer',
    await trim.evaluate(() => library.rooms.length === 0 && $('count').textContent === '0개 메시지' && $('roomPicker').hidden) === true);
  await trim.reload();
  await trim.waitForTimeout(1200);
  check('the empty drawer stays empty after a reload',
    await trim.evaluate(() => library.rooms.length) === 0);
  await trimming.close();
}

// --- a photo sits in a bubble that fits it, whichever way round it is ---
// A landscape photo used to land in a bubble sized from max-height x aspect ratio while
// the photo itself drew at the width cap, leaving a wide empty margin down both sides.
{
  const { context: shaped, page: shot } = await freshPage();
  // Bigger than both caps in every direction, or the caps never come into play and the
  // regression this guards against cannot show itself.
  const shapes = [['portrait.png', solidPng(600, 800)], ['landscape.png', solidPng(800, 450)],
                  ['wide.png', solidPng(1500, 500)]];
  const lines = ['사진방 카카오톡 대화', '저장한 날짜 : 2024-01-05 10:00:00', '',
    '--------------- 2024년 1월 1일 월요일 ---------------',
    ...shapes.map(([name], i) => `[홍길동] [오전 10:0${i + 1}] ${name}`), ''].join('\n');
  await shot.setInputFiles('#txt', { name: 'shapes.zip', mimeType: 'application/zip',
    buffer: zip([['사진방/KakaoTalkChats.txt', lines], ...shapes.map(([n, b]) => [`사진방/${n}`, b])]) });
  await shot.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await shot.click('#save');
  await shot.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  await shot.waitForTimeout(600);

  const framed = () => shot.evaluate(() => [...document.querySelectorAll('#messages .bubble')]
    .map(bubble => {
      const img = bubble.querySelector('img');
      if (!img || !img.naturalWidth) return null;
      const outer = bubble.getBoundingClientRect(), inner = img.getBoundingClientRect();
      return { name: img.alt,
        side: Math.round(inner.left - outer.left), other: Math.round(outer.right - inner.right),
        above: Math.round(inner.top - outer.top), below: Math.round(outer.bottom - inner.bottom),
        width: Math.round(inner.width), height: Math.round(inner.height) };
    }).filter(Boolean));

  const wide = await framed();
  check('every shape of photo is drawn', wide.length === 3, wide.map(f => f.name).join(','));
  check('a photo bubble hugs the photo on every side',
    wide.every(f => f.side === f.other && Math.abs(f.side - f.above) <= 6),
    wide.map(f => `${f.name} ${f.width}x${f.height} L${f.side} R${f.other} T${f.above}`).join(' | '));
  check('a photo wider than tall is capped by width, not shrunk further',
    wide.filter(f => f.name !== 'portrait.png').every(f => f.width === 220)
      && wide.find(f => f.name === 'portrait.png').height === 240,
    wide.map(f => `${f.name} ${f.width}x${f.height}`).join(', '));

  // A narrow bubble must shrink the photo rather than push it out of the bubble.
  await shot.setViewportSize({ width: 300, height: 740 });
  await shot.waitForTimeout(400);
  const narrow = await framed();
  check('a photo never overflows a narrow bubble',
    narrow.every(f => f.side >= 0 && f.other >= 0 && f.side === f.other),
    narrow.map(f => `${f.name} ${f.width}x${f.height} L${f.side} R${f.other}`).join(' | '));
  check('nothing scrolls sideways on a narrow screen',
    await shot.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth) === true);
  await shaped.close();
}

// --- the viewer downloads as a blank file that runs from disk ---
// Saved to a USB stick or a laptop, it has to open with no network and no site, and it
// must carry none of the conversation that was on screen when it was saved.
{
  const { context: portable, page: source } = await freshPage({ acceptDownloads: true });
  await source.setInputFiles('#txt', { name: 'other.zip', mimeType: 'application/zip', buffer: otherZip });
  await source.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await source.click('#save');
  await source.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  await source.waitForTimeout(400);

  const [copy] = await Promise.all([
    source.waitForEvent('download', { timeout: 30000 }),
    source.click('#saveViewer'),
  ]);
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drawer-')), 'viewer.html');
  await copy.saveAs(saved);
  const copied = fs.readFileSync(saved, 'utf8');

  check('the downloaded viewer carries no conversation',
    !copied.includes('다른방') && !copied.includes('메시지 본문')
      && /<script id="embedded-chat"[^>]*><\/script>/.test(copied),
    `${(copied.length / 1024).toFixed(0)}KB`);

  const offline = await portable.newPage();
  await offline.goto('file://' + saved);
  await offline.waitForTimeout(600);
  check('the downloaded viewer opens from disk',
    (await offline.title()).includes('대화서랍'), await offline.title());
  check('the downloaded viewer starts empty',
    await offline.evaluate(() => document.querySelectorAll('#rooms .room').length === 0
      && $('title').textContent === '내 대화' && $('roomCount').textContent === '0') === true);

  await offline.setInputFiles('#txt', { name: 'other.zip', mimeType: 'application/zip', buffer: otherZip });
  await offline.waitForFunction(() => $('review').open, null, { timeout: 60000 });
  await offline.click('#save');
  await offline.waitForFunction(() => !$('review').open, null, { timeout: 60000 });
  await offline.waitForTimeout(600);
  check('the downloaded viewer imports with no server at all',
    await offline.evaluate(() => document.querySelectorAll('#messages .bubble').length) > 0,
    await offline.textContent('#count'));

  await offline.reload();
  await offline.waitForTimeout(1200);
  check('what the downloaded viewer holds survives a reload',
    await offline.evaluate(() => library.rooms.length) === 1);
  await portable.close();
}

check('no page or console errors anywhere', errors.length === 0, errors.join(' | '));
check('nothing at all left the origin', offSite.length === 0, offSite.join(', '));

await browser.close();
server.close();

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
