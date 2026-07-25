// 망전 시세 자동 수집기 — GitHub Actions에서 하루 2회 실행
// (유지보수 노트) 출력 형식은 툴의 mergeRemote()와 계약:
//   data/prices.json = { updated, items:[{ apiName, match?, scale,
//                                          priceKeyUsed, entries:[{d,p,s}] }] }
// match = 레코드 부분 문자열 필터(인챈트 종류 구분용). 툴의 item.match와
// 같은 값이어야 병합된다(키 = apiName + match).
// 형식을 바꾸면 망전_시세_노트.html의 mergeRemote()도 함께 고칠 것.
// API 제약: 최근 1주 / 페이지당 500(next_cursor) / 24시간 10건 미만 거래
// 아이템은 빈 응답이 정상(예: 슬링샷). 키는 GitHub Secret NEXON_API_KEY.
import fs from 'fs';

const API = 'https://open.api.nexon.com/heroes/v2/marketplace/market-history';
const KEY = process.env.NEXON_API_KEY;
const MAX_PAGES = 5;          // 평상시(최근분 갱신)
const MAX_PAGES_FIRST = 60;   // 최초 수집: 1주치 전부(거래 많은 종목은 5p로 2일치뿐)
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!KEY) { console.error('NEXON_API_KEY 시크릿이 없습니다.'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync('items.json', 'utf8'));
const BASE = 'https://open.api.nexon.com';
const OUT = 'data/prices.json';
let db = { updated: '', items: [] };
if (fs.existsSync(OUT)) { try { db = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {} }
if (!Array.isArray(db.items)) db.items = [];

// ── 응답 스키마 추론(툴과 동일 로직의 축약판) ──
function findRecords(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.item)) return j.item;
  if (j && typeof j === 'object')
    for (const k in j)
      if (Array.isArray(j[k]) && j[k].length && typeof j[k][0] === 'object') return j[k];
  return [];
}
function detectPriceKey(rec) {
  const out = [];
  (function walk(o, path) {
    if (o && typeof o === 'object') { for (const k in o) walk(o[k], path ? path + '.' + k : k); return; }
    if (typeof o === 'number' && o > 0) {
      const key = path.split('.').pop();
      if (/price|가격|단가|amount|gold/i.test(key))
        out.push({ key: path, prio: /average|avg|평균/i.test(key) ? 0 : 1, v: o });
    }
  })(rec, '');
  out.sort((a, b) => a.prio - b.prio || b.v - a.v);
  return out.length ? out[0].key : null;
}
const getPath = (o, path) => { for (const k of path.split('.')) { if (o == null) return null; o = o[k]; } return o; };
function detectDateKey(rec) {
  for (const k in rec)
    if (/date|time|일자|기간/i.test(k) && typeof rec[k] === 'string' && /\d{4}-\d{2}-\d{2}/.test(rec[k])) return k;
  return null;
}
function detectCountKey(rec) {
  for (const k in rec)
    if (/count|건수|quantity|qty|거래|판매/i.test(k) && typeof rec[k] === 'number') return k;
  return null;
}

async function fetchAll(apiName, deep) {
  const cap = deep ? MAX_PAGES_FIRST : MAX_PAGES;
  let cursor = null, recs = [], pages = 0;
  do {
    const url = API + '?item_name=' + encodeURIComponent(apiName)
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await fetch(url, { headers: { 'x-nxopen-api-key': KEY } });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); if (j.error) detail = ' ' + (j.error.name || '') + ' ' + (j.error.message || ''); } catch (e) {}
      // 400 = 존재하지 않는 아이템명(이름 오타). 200+빈배열 = 이름은 맞고 24h 거래 10건 미달.
      throw new Error('HTTP ' + r.status + detail);
    }
    const j = await r.json();
    recs = recs.concat(findRecords(j));
    cursor = j && j.next_cursor ? j.next_cursor : null;
    pages++;
    if (cursor) await sleep(300);
  } while (cursor && pages < cap);
  if (deep) console.log('   (최초 수집 ' + pages + '페이지 / ' + recs.length + '건)');
  return recs;
}

let changed = false;
// 같은 apiName은 1회만 호출해 공유(인챈트 16종 = 호출 1회)
const cache = {};
for (const c of cfg.items) {
  const scale = c.scale || 1;
  const label = c.name || (c.apiName + (c.match ? '/' + c.match : ''));
  if (!(c.apiName in cache)) {
    // 이 이름으로 받아둔 기록이 하나도 없으면 최초 수집 → 1주치 전부
    const seen = db.items.some(x => x.apiName === c.apiName && x.entries && x.entries.length);
    try { cache[c.apiName] = await fetchAll(c.apiName, !seen); }
    catch (e) { cache[c.apiName] = { err: e.message }; }
    await sleep(300);
  }
  const got = cache[c.apiName];
  if (got && got.err) { console.log('✕', label, got.err); continue; }
  let recs = got;
  // 인챈트 종류는 item_option의 preset 필드로 정확히 구분(실측 스키마)
  if (c.match) {
    const opt = r => { const o = r && r.item_option; return !!o && (
      o.prefix_enchant_preset_1 === c.match || o.suffix_enchant_preset_1 === c.match ||
      o.prefix_enchant_preset_2 === c.match || o.suffix_enchant_preset_2 === c.match); };
    const byOpt = recs.filter(opt);
    recs = byOpt.length ? byOpt
      : recs.filter(r => { try { return JSON.stringify(r).includes(c.match); } catch (e) { return false; } });
  }
  let ent = db.items.find(x => x.apiName === c.apiName && (x.match || '') === (c.match || ''));
  if (!ent) { ent = { apiName: c.apiName, match: c.match || null, scale, priceKeyUsed: null, entries: [] }; db.items.push(ent); }
  if (!recs.length) { console.log('·', label, '거래 기록 없음(저유동/이름/필터 확인)'); continue; }
  // 확정: 거래소 응답의 평균가 필드는 average_price
  if (!ent.priceKeyUsed) ent.priceKeyUsed = c.priceKey
    || ('average_price' in recs[0] ? 'average_price' : detectPriceKey(recs[0]));
  if (!ent.priceKeyUsed) { console.log('✕', label, '가격 필드를 못 찾음'); continue; }
  const dk = detectDateKey(recs[0]), ck = detectCountKey(recs[0]);
  const byDay = {};
  for (const r of recs) {
    const p = getPath(r, ent.priceKeyUsed);
    if (typeof p !== 'number') continue;
    let d = new Date().toISOString().slice(0, 10);
    if (dk) { const m = String(r[dk]).match(/\d{4}-\d{2}-\d{2}/); if (m) d = m[0]; }
    if (!byDay[d]) byDay[d] = { sum: 0, n: 0, cnt: 0, lo: Infinity, hi: -Infinity };
    byDay[d].sum += p; byDay[d].n++;
    byDay[d].cnt += (ck && typeof r[ck] === 'number') ? r[ck] : 1;
    if (typeof r.min_price === 'number' && r.min_price > 0) byDay[d].lo = Math.min(byDay[d].lo, r.min_price);
    if (typeof r.max_price === 'number') byDay[d].hi = Math.max(byDay[d].hi, r.max_price);
  }
  let added = 0, updated = 0;
  for (const d in byDay) {
    // 응답은 시간당 스냅샷 → 하루치 p는 시간평균들의 평균, s는 거래가 잡힌 시간 수
    const p = Math.round(byDay[d].sum / byDay[d].n * scale);
    const e = { d, p, s: byDay[d].cnt };
    if (byDay[d].lo < Infinity) e.lo = Math.round(byDay[d].lo * scale);
    if (byDay[d].hi > -Infinity) e.hi = Math.round(byDay[d].hi * scale);
    const i = ent.entries.findIndex(x => x.d === d);
    if (i > -1) { if (ent.entries[i].p !== p || ent.entries[i].s !== e.s || ent.entries[i].lo !== e.lo) { ent.entries[i] = e; updated++; } }
    else { ent.entries.push(e); added++; }
  }
  ent.entries.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (added || updated) changed = true;
  console.log('✓', label, '신규', added, '갱신', updated, '(키:', ent.priceKeyUsed + ')');
}

if (changed || !fs.existsSync(OUT)) {
  db.updated = new Date().toISOString();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
  console.log('저장 완료:', OUT);
} else {
  console.log('변경 없음 — 저장 생략');
}


/* ══════════════════════════════════════════════════════════════
   이벤트 공지 수집 → data/events.json
   확정 스키마(사용자 제공):
     { "event_notice": [ { title, url, notice_id,
         date_event_start:"2023-12-14T08:28:35Z", date_event_end, ongoing_flag } ] }
   경로가 미확정이라 CANDIDATES를 순서대로 시도하고, 200이 뜨는 첫 경로를 쓴다.
   items.json에 "notices": ["/heroes/v1/..."] 를 넣으면 그 경로만 쓴다(권장 — 확정되면 고정).
   출력 계약(툴 mergeEvents와 세트): {updated, source, events:[{d,t,u,kind:'auto'}]}
   ══════════════════════════════════════════════════════════════ */
const NOTICE_CANDIDATES = [
  '/heroes/v1/notice-event',
  '/heroes/v2/notice-event',
  '/heroes/v1/event-notice',
  '/heroes/v1/notice/event'
];
function ymd(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
async function tryNotice(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  const r = await fetch(url, { headers: { 'x-nxopen-api-key': KEY } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const arr = Array.isArray(j.event_notice) ? j.event_notice : findRecords(j);
  if (!Array.isArray(arr)) throw new Error('형식 불일치');
  return arr;
}
async function collectNotices() {
  const paths = (Array.isArray(cfg.notices) && cfg.notices.length) ? cfg.notices : NOTICE_CANDIDATES;
  let arr = null, used = null;
  for (const p of paths) {
    try { arr = await tryNotice(p); used = p; console.log('✓ 공지 경로:', p, '(' + arr.length + '건)'); break; }
    catch (e) { console.log('· 공지 경로 실패', p, e.message); }
    await sleep(300);
  }
  if (!arr) { console.log('✕ 이벤트 공지: 사용 가능한 경로를 못 찾음 — items.json의 notices에 정확한 경로를 넣으세요'); return; }

  const out = [];
  for (const rec of arr) {
    const t = rec.title;
    if (!t) continue;
    const u = rec.url || '';
    const s0 = ymd(rec.date_event_start), e0 = ymd(rec.date_event_end);
    if (s0) out.push({ d: s0, t, u, kind: 'auto' });
    if (e0 && e0 !== s0) out.push({ d: e0, t: t + ' 종료', u, kind: 'auto' });
  }
  if (!out.length) { console.log('· 이벤트 공지: 날짜가 있는 항목 없음'); return; }

  const F = 'data/events.json';
  let db2 = { updated: '', source: '', events: [] };
  if (fs.existsSync(F)) { try { db2 = JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) {} }
  if (!Array.isArray(db2.events)) db2.events = [];
  let added = 0;
  for (const e of out) {
    if (!db2.events.some(x => x.d === e.d && x.t === e.t)) { db2.events.push(e); added++; }
  }
  db2.events.sort((a, b) => (a.d < b.d ? -1 : 1));
  db2.updated = new Date().toISOString();
  db2.source = used;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(F, JSON.stringify(db2, null, 1));
  console.log('이벤트 저장:', F, '신규', added, '총', db2.events.length);
}
/* ══════════════════════════════════════════════════════════════
   아이템명 검증기 — items.json의 "probe": ["후보명", ...]
   판정 규칙(실측 확인):
     400 → 그런 아이템명이 존재하지 않음(오타/추정 실패)
     200 + 기록 있음 → 사용 가능
     200 + 빈 배열 → 이름은 유효하나 최근 24h 거래 10건 미만
   결과를 로그에 표로 남긴다. 확정되면 items에 옮기고 probe는 비우면 된다.
   ══════════════════════════════════════════════════════════════ */
async function probeNames() {
  const list = Array.isArray(cfg.probe) ? cfg.probe : [];
  if (!list.length) return;
  console.log('\n──── 아이템명 검증 ────');
  const ok = [], low = [], bad = [];
  for (const nm of list) {
    const url = API + '?item_name=' + encodeURIComponent(nm);
    try {
      const r = await fetch(url, { headers: { 'x-nxopen-api-key': KEY } });
      if (r.status === 400) { bad.push(nm); console.log('✕ 없음     ', nm); }
      else if (!r.ok) { console.log('? HTTP' + r.status, nm); }
      else {
        const j = await r.json();
        const n = findRecords(j).length;
        if (n) { ok.push(nm); console.log('✓ 사용가능 ', nm, '(' + n + '건)'); }
        else { low.push(nm); console.log('△ 이름OK   ', nm, '(24h 거래 10건 미만)'); }
      }
    } catch (e) { console.log('✕ 오류     ', nm, e.message); }
    await sleep(300);
  }
  console.log('\n요약: 사용가능 ' + ok.length + ' / 이름만OK ' + low.length + ' / 없음 ' + bad.length);
  if (ok.length) console.log('사용가능: ' + ok.join(' | '));
  if (low.length) console.log('이름OK(거래적음): ' + low.join(' | '));
  console.log('────────────────────\n');
}
/* ══════════════════════════════════════════════════════════════
   넥슨마켓 API 주소 자동 탐색 (items.json에 "marketDiscover": true 일 때)
   넥슨마켓은 JS로 목록을 그리는 SPA라 HTML엔 아이템이 없다. 대신
   페이지가 불러오는 JS 번들 안에 API 경로 문자열이 들어 있으므로,
   ① 페이지 HTML → <script src> 수집  ② 번들 내려받아 /api/... 패턴 추출
   ③ 후보 주소를 실제로 호출해 JSON이 오는지 확인
   서버(Actions)에서 도니 CORS 제약이 없다. 개인 기록용이므로 호출은
   최소로(실행당 1회) 유지할 것.
   ══════════════════════════════════════════════════════════════ */
const MARKET_PAGE = 'https://market.nexon.com/ko/trade-list/MHERO?order=register&list=1';
const GD_HOST = 'https://public.api.nexon.com';   // ★실측: 넥슨마켓 백엔드 호스트
const GD_BASE = '/gdweb/goodeal/v1';              // ★실측: 경로 접두어
/* 로그인이 필요한 개인 엔드포인트는 {"code":2,"message":"x-inface-user-uid 헤더가 없습니다"}를
   돌려준다. 판매 목록은 비로그인 조회가 되므로 그 응답을 찾는 게 목표. */
const GD_GUESS = [
  '/products', '/products/search', '/product/list',
  '/trades', '/trade/list', '/trade-list', '/tradeList',
  '/items', '/item/list', '/goods', '/goods/list',
  '/sales', '/sale/list', '/market/products', '/search/products'
];
const GD_QS = [
  '?gameCode=MHERO&page=1&size=20&order=register',
  '?gameCode=MHERO&page=1&pageSize=20',
  '?gameCode=MHERO',
  ''
];
function shortBody(t){ return t.slice(0, 400).replace(/\s+/g, ' '); }
async function tryGd(url){
  try{
    const r = await fetch(url, { headers: {
      'user-agent': 'Mozilla/5.0', 'accept': 'application/json', 'accept-language': 'ko' } });
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    const isJson = /json/.test(ct);
    let verdict = '';
    if (isJson) {
      if (/x-inface-user-uid/.test(body)) verdict = '🔒 로그인 필요';
      else if (/"code"\s*:\s*0|"data"\s*:\s*[\[{]/.test(body)) verdict = '✅ 데이터 응답';
      else verdict = 'ℹ️ JSON';
    }
    console.log(`  [${r.status}] ${verdict} ${url}`);
    if (isJson && verdict !== '🔒 로그인 필요') console.log('        ↳', shortBody(body));
    return verdict === '✅ 데이터 응답';
  }catch(e){ console.log('  [✕]', url, e.message); return false; }
}
async function discoverMarket() {
  if (!cfg.marketDiscover) return;
  console.log('\n──── 넥슨마켓 API 탐색 ────');

  // ① 페이지 JS 번들에서 실제 경로 문자열 추출 (가장 정확)
  let srcs = [];
  try {
    const r = await fetch(MARKET_PAGE, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'ko' } });
    const html = await r.text();
    console.log('페이지 응답:', r.status);
    srcs = [...html.matchAll(/<script[^>]+src=["\']([^"\']+)["\']/g)].map(m => m[1])
      .map(u => u.startsWith('http') ? u : ('https://market.nexon.com' + (u.startsWith('/') ? '' : '/') + u))
      .filter(u => /market\.nexon\.com/.test(u));
  } catch (e) { console.log('✕ 페이지 로드 실패', e.message); }
  console.log('스크립트', srcs.length + '개');

  const found = new Set();
  for (const u of srcs.slice(0, 10)) {
    try {
      const t = await (await fetch(u)).text();
      for (const m of t.matchAll(/["\'`](\/gdweb\/[^"\'`\s]{3,160})["\'`]/g)) found.add(m[1]);
      for (const m of t.matchAll(/["\'`](https:\/\/public\.api\.nexon\.com\/[^"\'`\s]{0,160})["\'`]/g)) found.add(m[1]);
      for (const m of t.matchAll(/["\'`](\/api\/[^"\'`\s]{3,120})["\'`]/g)) found.add(m[1]);
    } catch (e) {}
    await sleep(200);
  }
  const paths = [...found];
  console.log('번들에서 찾은 경로', paths.length + '개');
  paths.slice(0, 40).forEach(p => console.log('   ', p));

  // ② 번들 경로 중 목록스러운 것 실제 호출
  const likely = paths.filter(p => /trade|list|product|goods|item|sale|search/i.test(p)).slice(0, 10);
  if (likely.length) {
    console.log('\n[번들 경로 호출]');
    for (const p of likely) {
      const url = p.startsWith('http') ? p : GD_HOST + p;
      await tryGd(url + (url.includes('?') ? '' : GD_QS[0]));
      await sleep(400);
    }
  }

  // ③ 못 찾았으면 알려진 규칙으로 후보 조합 시도
  console.log('\n[추정 경로 시도]');
  let hit = 0;
  for (const g of GD_GUESS) {
    for (const qs of GD_QS.slice(0, 2)) {
      const ok = await tryGd(GD_HOST + GD_BASE + g + qs);
      if (ok) { hit++; break; }
      await sleep(350);
    }
    if (hit >= 2) break;
  }
  console.log('────────────────────────\n');
}
await discoverMarket();
await probeNames();
await collectNotices();
