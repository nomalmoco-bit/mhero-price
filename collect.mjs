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
const MAX_PAGES = 5;
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

async function fetchAll(apiName) {
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
  } while (cursor && pages < MAX_PAGES);
  return recs;
}

let changed = false;
// 같은 apiName은 1회만 호출해 공유(인챈트 16종 = 호출 1회)
const cache = {};
for (const c of cfg.items) {
  const scale = c.scale || 1;
  const label = c.name || (c.apiName + (c.match ? '/' + c.match : ''));
  if (!(c.apiName in cache)) {
    try { cache[c.apiName] = await fetchAll(c.apiName); }
    catch (e) { cache[c.apiName] = { err: e.message }; }
    await sleep(300);
  }
  const got = cache[c.apiName];
  if (got && got.err) { console.log('✕', label, got.err); continue; }
  let recs = got;
  if (c.match) recs = recs.filter(r => { try { return JSON.stringify(r).includes(c.match); } catch (e) { return false; } });
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
    if (!byDay[d]) byDay[d] = { sum: 0, n: 0, cnt: 0 };
    byDay[d].sum += p; byDay[d].n++;
    byDay[d].cnt += (ck && typeof r[ck] === 'number') ? r[ck] : 1;
  }
  let added = 0, updated = 0;
  for (const d in byDay) {
    const p = Math.round(byDay[d].sum / byDay[d].n * scale);
    const e = { d, p, s: byDay[d].cnt };
    const i = ent.entries.findIndex(x => x.d === d);
    if (i > -1) { if (ent.entries[i].p !== p || ent.entries[i].s !== e.s) { ent.entries[i] = e; updated++; } }
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
await probeNames();
await collectNotices();
