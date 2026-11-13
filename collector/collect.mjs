// XRP 대시보드 수집기
// GitHub Actions가 15분마다 실행: 지난 실행 이후 확정된 원장을 빠짐없이 읽어
// 분 단위 사용 지표를 기록하고, 조건에 맞는 이벤트를 텔레그램으로 보냅니다.
//
// 실행: node collector/collect.mjs   (Node 22 이상, 외부 패키지 필요 없음)
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (없으면 알림 없이 기록만)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const AMENDMENTS_INDEX = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const kstDate = t => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
const kstHour = t => new Date(t + 9 * 3600000).getUTCHours();
const scan = h => `<a href="https://xrpscan.com/tx/${h}">XRPScan</a>`;

async function readJSON(f, d) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } }

// ---------- XRPL 연결 ----------
export async function connectXRPL(urls) {
  for (const url of urls) {
    try {
      const ws = new WebSocket(url);
      await new Promise((ok, no) => {
        const t = setTimeout(() => no(new Error("timeout")), 15000);
        ws.addEventListener("open", () => { clearTimeout(t); ok(); });
        ws.addEventListener("error", () => { clearTimeout(t); no(new Error("error")); });
      });
      let id = 0; const pend = new Map();
      ws.addEventListener("message", ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        const f = pend.get(m.id); if (f) { pend.delete(m.id); f(m); }
      });
      ws.addEventListener("close", () => { for (const f of pend.values()) f({ status: "error", error: "closed" }); pend.clear(); });
      const once = cmd => new Promise((ok, no) => {
        const i = ++id;
        const t = setTimeout(() => { pend.delete(i); no(new Error("timeout " + cmd.command)); }, 30000);
        pend.set(i, m => { clearTimeout(t); m.status === "success" ? ok(m.result) : no(Object.assign(new Error(m.error || "error"), { xrpl: m })); });
        ws.send(JSON.stringify(Object.assign({ id: i }, cmd)));
      });
      const req = async cmd => {
        for (let a = 0; ; a++) {
          try { return await once(cmd); }
          catch (e) {
            const busy = /slowDown|tooBusy|timeout/.test(e.message);
            if (!busy || a >= 3) throw e;
            await sleep(1500 * (a + 1));
          }
        }
      };
      console.log("XRPL 연결:", url);
      return { req, close: () => ws.close(), url };
    } catch (e) { console.warn("연결 실패:", url, e.message); }
  }
  throw new Error("모든 XRPL 노드 연결 실패");
}

// ---------- 텔레그램 ----------
export function telegramSender(fetchFn = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  return async text => {
    if (!token || !chat) { console.log("[알림·미전송]", text.replace(/<[^>]+>/g, "")); return false; }
    try {
      const r = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!r.ok) console.warn("텔레그램 오류:", r.status, await r.text());
      return r.ok;
    } catch (e) { console.warn("텔레그램 전송 실패:", e.message); return false; }
  };
}

// ---------- 본 작업 ----------
export async function run({ client, fetchFn = fetch, send = telegramSender(fetchFn), now = Date.now(), cfg }) {
  cfg = cfg || await readJSON(path.join(ROOT, "config.json"), {});
  const A = Object.assign({ whaleXRP: 10000000, rlusdUSD: 5000000, escrowXRP: 100000000, priceHighKRW: 0, priceLowKRW: 0, kimchiPct: 0, maxPerRun: 15, dailySummaryHourKST: 9 }, cfg.alerts || {});
  const watch = (cfg.watch || []).filter(w => w && w.addr);
  await fs.mkdir(DATA, { recursive: true });
  const F = n => path.join(DATA, n);
  const hist = await readJSON(F("history.json"), { min: [], q: [], h: [], px: [] });
  const state = await readJSON(F("state.json"), {});
  const alertLog = await readJSON(F("alerts.json"), []);
  const snap = await readJSON(F("snapshot.json"), {});
  const msgs = []; // {key, text, kind}
  const sentKeys = new Set(state.sentKeys || []);
  const push = (key, text, kind) => { if (!sentKeys.has(key)) msgs.push({ key, text, kind }); };

  // 1) 처리할 원장 범위
  const v = await client.req({ command: "ledger", ledger_index: "validated" });
  const cur = Number(v.ledger_index || v.ledger.ledger_index);
  let start = state.lastLedger ? state.lastLedger + 1 : cur - (cfg.firstRunLedgers || 240);
  let gap = 0;
  const maxL = cfg.maxLedgersPerRun || 1500;
  if (cur - start + 1 > maxL) { gap = cur - start + 1 - maxL; start = cur - maxL + 1; }
  console.log(`원장 ${start} ~ ${cur} (${cur - start + 1}개)` + (gap ? `, 건너뜀 ${gap}개` : ""));

  // 2) 원장 읽기 (동시 4개) → 순서대로 처리
  let b = L.bucketFromState(state.bucket);
  const rows = [];
  let processed = 0, lastClose = null;
  const C = cfg.concurrency || 4;
  for (let i = start; i <= cur; i += C) {
    const idx = []; for (let j = i; j < i + C && j <= cur; j++) idx.push(j);
    const res = await Promise.all(idx.map(n => client.req({ command: "ledger", ledger_index: n, transactions: true, expand: true }).catch(e => ({ _err: e, n }))));
    for (const r of res) {
      if (r._err) { console.warn("원장 읽기 실패:", r.n, r._err.message); continue; }
      const led = r.ledger;
      const tms = (Number(led.close_time) + L.RIPPLE_EPOCH) * 1000;
      lastClose = tms;
      const m = Math.floor(tms / 60000) * 60000;
      if (!b) b = L.newBucket(m);
      else if (m > b.t) { rows.push(L.finalize(b)); b = L.newBucket(m); }
      for (const t of (led.transactions || [])) {
        const tx = t.tx_json || t.tx || t;
        const meta = t.metaData || t.meta || {};
        const hash = t.hash || tx.hash || "";
        const c = L.classify(tx, meta);
        L.addTx(b, tx, c);
        if (!c.ok) continue;
        if (c.xrpPay >= A.whaleXRP && A.whaleXRP > 0)
          push("w" + hash, `🐋 <b>고래 송금 ${L.xrpShort(c.xrpPay)}</b>\n${L.short(tx.Account)} → ${L.short(tx.Destination)}\n${scan(hash)}`, "고래");
        if (c.rlusd >= A.rlusdUSD && A.rlusdUSD > 0)
          push("r" + hash, `💵 <b>RLUSD 대량 전송 $${L.nf(c.rlusd)}</b>\n${L.short(tx.Account)} → ${L.short(tx.Destination)}\n${scan(hash)}`, "RLUSD");
        if (c.esc && c.esc.amt >= A.escrowXRP && A.escrowXRP > 0)
          push("e" + hash, `🔒 <b>에스크로 ${c.esc.kind} ${L.xrpShort(c.esc.amt)}</b>${c.esc.amt >= 1e8 ? " (리플 규모)" : ""}\n소유자 ${L.short(tx.Owner || tx.Account)}\n${scan(hash)}`, "에스크로");
        const wh = watch.find(w => w.addr === tx.Account || w.addr === tx.Destination);
        if (wh) {
          const dir = wh.addr === tx.Destination ? "입금" : "출금";
          push("a" + hash + wh.addr, `👛 <b>${esc(wh.label || L.short(wh.addr))} ${dir}</b>\n${c.type}${c.xrpPay ? " · " + L.xrpShort(c.xrpPay) : c.rlusd ? " · $" + L.nf(c.rlusd) + " RLUSD" : ""}\n${scan(hash)}`, "내 주소");
        }
      }
      processed++;
    }
  }
  state.bucket = L.bucketToState(b);   // 진행 중인 분은 다음 실행에서 마무리
  state.lastLedger = cur;
  hist.min = (hist.min || []).concat(rows);

  // 3) 시세
  let px = null;
  try {
    const r = await fetchFn("https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd,krw&include_24hr_change=true");
    const j = (await r.json()).ripple;
    px = { krw: j.krw, usd: j.usd, ch: j.krw_24h_change };
  } catch (e) { console.warn("시세 실패:", e.message); }
  let upbit = null;
  try { const r = await fetchFn("https://api.upbit.com/v1/ticker?markets=KRW-XRP"); upbit = (await r.json())[0].trade_price; } catch (e) { console.warn("업비트 실패:", e.message); }
  if (px || upbit) (hist.px = hist.px || []).push([now, px ? px.krw : null, px ? px.usd : null, upbit]);
  const pNow = upbit || (px && px.krw);
  if (pNow) {
    const side = (A.priceHighKRW > 0 && pNow >= A.priceHighKRW) ? "hi" : (A.priceLowKRW > 0 && pNow <= A.priceLowKRW) ? "lo" : "mid";
    if (state.priceSide && side !== state.priceSide) {
      if (side === "hi") push("ph" + now, `📈 <b>XRP 상한가 도달 ${L.nf(pNow)}원</b>\n설정 상한 ${L.nf(A.priceHighKRW)}원 이상`, "가격");
      if (side === "lo") push("pl" + now, `📉 <b>XRP 하한가 도달 ${L.nf(pNow)}원</b>\n설정 하한 ${L.nf(A.priceLowKRW)}원 이하`, "가격");
    }
    state.priceSide = side;
  }
  if (upbit && px && A.kimchiPct > 0) {
    const k = (upbit / px.krw - 1) * 100;
    if (Math.abs(k) >= A.kimchiPct && !state.kimpOn) { state.kimpOn = true; push("k" + now, `🇰🇷 <b>김치 프리미엄 ${k >= 0 ? "+" : ""}${L.nf(k, 2)}%</b>\n업비트 ${L.nf(upbit)}원 · 해외 ${L.nf(px.krw, 1)}원`, "가격"); }
    else if (Math.abs(k) < A.kimchiPct * 0.8) state.kimpOn = false;
  }

  // 4) RLUSD·AMM·업그레이드
  try {
    const g = await client.req({ command: "gateway_balances", account: L.RLUSD_ISSUER, ledger_index: "validated", strict: true });
    const ob = g.obligations || {};
    snap.rlusd = Number(ob[L.RLUSD_HEX] != null ? ob[L.RLUSD_HEX] : ob.RLUSD);
  } catch (e) { console.warn("RLUSD 실패:", e.message); }
  try {
    const a = (await client.req({ command: "amm_info", asset: { currency: "XRP" }, asset2: { currency: L.RLUSD_HEX, issuer: L.RLUSD_ISSUER }, ledger_index: "validated" })).amm;
    const xrp = (L.isXRP(a.amount) ? Number(a.amount) : Number(a.amount2)) / 1e6;
    const rl = Number(L.isXRP(a.amount) ? a.amount2.value : a.amount.value);
    snap.amm = { xrp, rl, px: rl / xrp, fee: a.trading_fee };
  } catch (e) { console.warn("AMM 실패:", e.message); }
  try {
    let names = {};
    try { const f = await client.req({ command: "feature" }); for (const [h, x] of Object.entries(f.features || {})) names[h] = x.name; } catch {}
    const node = (await client.req({ command: "ledger_entry", index: AMENDMENTS_INDEX, ledger_index: "validated" })).node || {};
    const enabled = new Set(node.Amendments || []);
    const maj = (node.Majorities || []).map(x => x.Majority || x);
    const prev = state.majorities || null;
    const nm = h => names[h] || (snap.amendNames || {})[h] || h.slice(0, 10) + "…";
    if (prev) {
      for (const x of maj) if (!prev[x.Amendment]) {
        const when = new Date((x.CloseTime + L.RIPPLE_EPOCH + 14 * 86400) * 1000);
        push("am" + x.Amendment + x.CloseTime, `⬆️ <b>업그레이드 80% 찬성 도달: ${esc(nm(x.Amendment))}</b>\n2주 유지 시 ${kstDate(when.getTime())} 활성화 예정`, "업그레이드");
      }
      for (const h of Object.keys(prev)) if (!maj.find(x => x.Amendment === h))
        push("ae" + h + now, enabled.has(h) ? `✅ <b>업그레이드 활성화: ${esc(nm(h))}</b>` : `⚠️ <b>업그레이드 지지 80% 아래로: ${esc(nm(h))}</b>`, "업그레이드");
    }
    state.majorities = Object.fromEntries(maj.map(x => [x.Amendment, x.CloseTime]));
    snap.amend = { enabled: enabled.size, majorities: maj.map(x => ({ h: x.Amendment, name: nm(x.Amendment), close: x.CloseTime })) };
    if (Object.keys(names).length) snap.amendNames = names;
  } catch (e) { console.warn("업그레이드 실패:", e.message); }

  // 5) 물량 분포 (몇 시간마다)
  const supEvery = (cfg.supplyEveryHours || 6) * 3600000;
  if (!snap.supply || now - snap.supply.at > supEvery) {
    try {
      const Lg = await client.req({ command: "ledger", ledger_index: "validated" });
      const total = Number((Lg.ledger || {}).total_coins) / 1e6;
      const li = Number(Lg.ledger_index || Lg.ledger.ledger_index);
      let marker, pages = 0, all = 0; const owners = {};
      do {
        const cmd = { command: "ledger_data", ledger_index: li, type: "escrow", limit: 400 }; if (marker) cmd.marker = marker;
        const r = await client.req(cmd);
        for (const o of (r.state || [])) {
          if (o.LedgerEntryType !== "Escrow" || !L.isXRP(o.Amount)) continue;
          const a = Number(o.Amount) / 1e6; all += a;
          const w = owners[o.Account] = owners[o.Account] || { sum: 0, list: [] };
          w.sum += a; w.list.push([a, o.FinishAfter || 0]);
        }
        marker = r.marker; pages++;
      } while (marker && pages < 500);
      let rip = 0, n = 0, acct = 0; const sched = {};
      for (const w of Object.values(owners)) {
        if (w.sum < 1e9) continue;
        rip += w.sum; acct++; n += w.list.length;
        for (const [a, fa] of w.list) if (fa) { const k = kstDate((fa + L.RIPPLE_EPOCH) * 1000).slice(0, 7); sched[k] = (sched[k] || 0) + a; }
      }
      snap.supply = { at: now, total, escAll: all, escRip: rip, nRip: n, nAcct: acct, sched };
      console.log(`물량 집계: 에스크로 ${L.xrpShort(all)} (리플 ${L.xrpShort(rip)})`);
    } catch (e) { console.warn("물량 집계 실패:", e.message); }
  }

  // 6) 하루 요약 (한국시간 기준 설정 시각 이후 첫 실행)
  const today = kstDate(now);
  if (A.dailySummaryHourKST >= 0 && kstHour(now) >= A.dailySummaryHourKST && state.lastDaily !== today) {
    const dayStart = Date.parse(today + "T00:00:00+09:00") - 86400000, dayEnd = dayStart + 86400000;
    const all = [...(hist.min || []), ...(hist.q || [])].filter(r => r[0] >= dayStart && r[0] < dayEnd);
    if (all.length) {
      const s = i => all.reduce((a, r) => a + (r[i] || 0), 0);
      const mins = s(1), pay = s(12), real = s(13);
      const pxs = (hist.px || []).filter(p => p[0] >= dayStart && p[0] < dayEnd && (p[3] || p[1]));
      const p0 = pxs.length ? (pxs[0][3] || pxs[0][1]) : null, p1 = pxs.length ? (pxs[pxs.length - 1][3] || pxs[pxs.length - 1][1]) : null;
      const lines = [
        `📊 <b>XRP 일일 요약 (${kstDate(dayStart).slice(5).replace("-", "/")})</b>`,
        p0 && p1 ? `• 가격: ${L.nf(p0)}원 → ${L.nf(p1)}원 (${p1 >= p0 ? "+" : ""}${L.nf((p1 / p0 - 1) * 100, 1)}%)` : null,
        `• 실제 XRP 송금: ${L.xrpShort(s(2))}`,
        `• XRP 경유 브릿지: ${L.nf(s(3))}건 · 환전 결제 ${L.nf(s(5))}건`,
        `• DEX·AMM 체결: ${L.xrpShort(s(7))}`,
        `• 신규 계정 ${L.nf(s(9))}개 · 평균 TPS ${L.nf(s(10) / Math.max(1, mins * 60), 1)}`,
        `• 소각: ${L.nf(s(11), 2)} XRP · 의미 있는 결제 ${pay ? L.nf(real / pay * 100, 0) : "—"}%`,
        snap.rlusd ? `• RLUSD(XRPL) 유통량: $${L.nf(snap.rlusd)}` : null,
        snap.supply ? `• 리플 에스크로: ${L.xrpShort(snap.supply.escRip)}` : null,
        `<i>수집률 ${L.nf(Math.min(100, mins / 1440 * 100), 0)}%</i>`,
      ].filter(Boolean);
      push("d" + today, lines.join("\n"), "일일 요약");
    }
    state.lastDaily = today;
  }

  // 7) 알림 전송 (너무 많으면 묶어서)
  const max = A.maxPerRun;
  let sendList = msgs;
  if (msgs.length > max) {
    const keep = msgs.filter(m => m.kind !== "고래").slice(0, max - 1);
    const rest = msgs.filter(m => !keep.includes(m));
    sendList = [...keep, { key: "bulk" + now, kind: "묶음", text: `📦 <b>그 밖의 알림 ${rest.length}건</b>\n` + rest.slice(0, 10).map(m => "• " + m.text.split("\n")[0].replace(/<[^>]+>/g, "")).join("\n") + (rest.length > 10 ? `\n… 외 ${rest.length - 10}건` : "") }];
    rest.forEach(m => sentKeys.add(m.key));
  }
  for (const m of sendList) {
    await send(m.text);
    sentKeys.add(m.key);
    alertLog.unshift({ t: now, kind: m.kind, text: m.text.replace(/<a [^>]*>[^<]*<\/a>/g, "").replace(/<[^>]+>/g, "").trim(), link: (m.text.match(/href="([^"]+)"/) || [])[1] || null });
    await sleep(400);
  }
  state.sentKeys = [...sentKeys].slice(-800);

  // 8) 저장
  const H = L.compactHistory(hist, now);
  await fs.writeFile(F("history.json"), L.serializeHistory(H));
  await fs.writeFile(F("state.json"), JSON.stringify(state));
  await fs.writeFile(F("alerts.json"), JSON.stringify(alertLog.slice(0, 300), null, 0).replace(/},{/g, "},\n{"));
  Object.assign(snap, { updatedAt: now, lastLedger: cur, lastClose, ledgersThisRun: processed, skipped: gap, node: client.url || null, price: px, upbit });
  await fs.writeFile(F("snapshot.json"), JSON.stringify(snap, null, 1));
  console.log(`완료: 원장 ${processed}개 처리, 기록 ${rows.length}분 추가, 알림 ${sendList.length}건`);
  return { processed, rows: rows.length, alerts: sendList.length, gap };
}

// 직접 실행했을 때
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = await readJSON(path.join(ROOT, "config.json"), {});
  const client = await connectXRPL(cfg.nodes || ["wss://xrplcluster.com/", "wss://s2.ripple.com/", "wss://s1.ripple.com/"]);
  try { await run({ client, cfg }); }
  finally { client.close(); }
  process.exit(0);
}
