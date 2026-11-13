// XRP 대시보드 수집기 - 계산 로직 (네트워크 없이 테스트 가능한 순수 함수들)

export const RIPPLE_EPOCH = 946684800;
export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const RLUSD_HEX = "524C555344000000000000000000000000000000";

export const isXRP = a => typeof a === "string";
export const curKey = a => isXRP(a) ? "XRP" : (a && a.currency ? a.currency + "." + a.issuer : "?");

export function curName(c) {
  if (!c) return "?";
  if (c.length === 40 && /^[0-9A-F]+$/i.test(c)) {
    let t = "";
    for (let i = 0; i < 40; i += 2) { const v = parseInt(c.substr(i, 2), 16); if (v >= 32 && v < 127) t += String.fromCharCode(v); }
    return t.trim() || c.slice(0, 8) + "…";
  }
  return c;
}

// 거래 한 건에서 주문장·AMM을 통해 실제로 오간 XRP 양
export function xrpFlow(meta) {
  let offer = 0, amm = 0;
  for (const n of (meta.AffectedNodes || [])) {
    const node = n.ModifiedNode || n.DeletedNode; if (!node) continue;
    const f = node.FinalFields || {}, pv = node.PreviousFields || {};
    if (node.LedgerEntryType === "Offer") {
      for (const k of ["TakerGets", "TakerPays"]) if (isXRP(f[k]) && isXRP(pv[k])) offer += Math.abs(Number(pv[k]) - Number(f[k])) / 1e6;
    } else if (node.LedgerEntryType === "AccountRoot" && f.AMMID && pv.Balance != null) {
      amm += Math.abs(Number(pv.Balance) - Number(f.Balance)) / 1e6;
    }
  }
  return offer + amm;
}

export function delivered(tx, meta) {
  return meta.delivered_amount != null ? meta.delivered_amount
    : (meta.DeliveredAmount != null ? meta.DeliveredAmount : (tx.DeliverMax || tx.Amount));
}

function deletedEscrow(meta) {
  for (const n of (meta.AffectedNodes || [])) {
    const d = n.DeletedNode;
    if (d && d.LedgerEntryType === "Escrow" && d.FinalFields) return d.FinalFields;
  }
  return null;
}

// 거래 1건 분류 → 실사용 지표용 결과 + 알림 후보
export function classify(tx, meta) {
  const type = tx.TransactionType || "";
  const ok = meta.TransactionResult === "tesSUCCESS";
  const out = { type, ok, k: "other", x: 0, trade: 0, nw: 0, cur: null, xrpPay: 0, rlusd: 0, esc: null };
  if (!ok) return out;
  for (const n of (meta.AffectedNodes || [])) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === "AccountRoot" && !(c.NewFields && c.NewFields.AMMID)) out.nw++;
  }
  if (type === "Payment") {
    const d = delivered(tx, meta);
    const src = tx.SendMax != null ? tx.SendMax : (tx.DeliverMax || tx.Amount || d);
    const dX = isXRP(d), sX = isXRP(src);
    const flow = xrpFlow(meta);
    if (dX && sX) {
      const x = Number(d) / 1e6;
      out.xrpPay = x;
      if (tx.Account === tx.Destination) out.k = "self";
      else if (x < 1) out.k = "dust";
      else { out.k = "xrp"; out.x = x; }
    } else if (dX || sX) {
      out.k = "conv"; out.x = dX ? Number(d) / 1e6 : flow; out.trade = flow;
    } else if (curKey(d) !== curKey(src) && flow > 0) {
      out.k = "bridge"; out.x = flow / 2; out.trade = flow / 2;
    } else {
      out.k = tx.Account === tx.Destination ? "self" : "token";
    }
    if (!dX && d && d.currency) {
      out.cur = curName(d.currency);
      if (d.currency === RLUSD_HEX && d.issuer === RLUSD_ISSUER) out.rlusd = Number(d.value) || 0;
    }
  } else if (type === "OfferCreate") {
    out.k = "offer"; out.trade = xrpFlow(meta);
  } else if (type.startsWith("Escrow")) {
    if (type === "EscrowCreate" && isXRP(tx.Amount)) out.esc = { kind: "잠금", amt: Number(tx.Amount) / 1e6 };
    else if (type !== "EscrowCreate") {
      const f = deletedEscrow(meta);
      if (f && isXRP(f.Amount)) out.esc = { kind: type === "EscrowFinish" ? "해제" : "취소", amt: Number(f.Amount) / 1e6 };
    }
  }
  return out;
}

// ---------- 분 단위 기록 ----------
// 기록 한 줄: [t, n, x, bN, bV, cN, cV, tr, act, nw, tx, burn, pay, real]
export const FIELDS = ["t", "n", "x", "bN", "bV", "cN", "cV", "tr", "act", "nw", "tx", "burn", "pay", "real"];
const r2 = v => Math.round(v * 100) / 100;

export function newBucket(t) {
  return { t, n: 1, x: 0, bN: 0, bV: 0, cN: 0, cV: 0, tr: 0, act: 0, nw: 0, tx: 0, burn: 0, pay: 0, real: 0, s: new Set() };
}

export function addTx(b, tx, c) {
  b.tx++;
  if (tx.Fee) b.burn += Number(tx.Fee) / 1e6 || 0;
  if (!c.ok) return;
  if (tx.Account) b.s.add(tx.Account);
  b.nw += c.nw; b.tr += c.trade;
  if (c.type === "Payment") { b.pay++; if (["xrp", "bridge", "conv", "token"].includes(c.k)) b.real++; }
  if (c.k === "xrp") b.x += c.x;
  else if (c.k === "bridge") { b.bN++; b.bV += c.x; }
  else if (c.k === "conv") { b.cN++; b.cV += c.x; }
}

export function finalize(b) {
  return [b.t, 1, r2(b.x), b.bN, r2(b.bV), b.cN, r2(b.cV), r2(b.tr), b.s.size, b.nw, b.tx, Math.round(b.burn * 1e6) / 1e6, b.pay, b.real];
}

// 진행 중인 분(아직 다 처리 안 된 분)은 state에 저장했다가 다음 실행에서 이어 붙임
export function bucketToState(b) { return b ? Object.assign({}, b, { s: [...b.s] }) : null; }
export function bucketFromState(o) { return o ? Object.assign(newBucket(o.t), o, { s: new Set(o.s || []) }) : null; }

// 기록 보관: 48시간은 1분, 30일까지는 15분, 1년까지는 1시간 단위로 합침
export function mergeRows(rows, step) {
  const m = new Map();
  for (const r of rows) {
    const k = Math.floor(r[0] / step) * step;
    const g = m.get(k);
    if (!g) m.set(k, [k, ...r.slice(1)]);
    else for (let i = 1; i < r.length; i++) g[i] = r2((g[i] || 0) + (r[i] || 0));
  }
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

export function compactHistory(h, now = Date.now()) {
  const H = 3600000, D = 24 * H;
  const all = [...(h.min || []), ...(h.q || []), ...(h.h || [])].filter(r => now - r[0] < 365 * D);
  // 같은 시각이 중복되면 n이 큰(더 많이 합쳐진) 쪽을 남김
  const byT = new Map();
  for (const r of all) { const o = byT.get(r[0]); if (!o || r[1] > o[1]) byT.set(r[0], r); }
  const rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
  const min = rows.filter(r => now - r[0] < 2 * D && r[1] === 1);
  const q = mergeRows(rows.filter(r => now - r[0] >= 2 * D && now - r[0] < 30 * D), 15 * 60000);
  const hh = mergeRows(rows.filter(r => now - r[0] >= 30 * D), H);
  return { v: 1, fields: FIELDS, min, q, h: hh, px: (h.px || []).filter(p => now - p[0] < 365 * D) };
}

// 한 줄에 기록 하나씩 저장 (git 변경분이 작아지도록)
export function serializeHistory(h) {
  const rows = arr => "[\n" + arr.map(r => JSON.stringify(r)).join(",\n") + "\n]";
  return `{"v":1,"fields":${JSON.stringify(h.fields)},\n"min":${rows(h.min)},\n"q":${rows(h.q)},\n"h":${rows(h.h)},\n"px":${rows(h.px)}\n}\n`;
}

// ---------- 표시용 ----------
const nf = (n, d = 0) => Number(n).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d });
export const xrpShort = n => n >= 1e8 ? nf(n / 1e8, 2) + "억 XRP" : n >= 1e4 ? nf(n / 1e4, 1) + "만 XRP" : nf(n, 2) + " XRP";
export const krwShort = n => n >= 1e12 ? nf(n / 1e12, 2) + "조원" : n >= 1e8 ? nf(n / 1e8, 1) + "억원" : n >= 1e4 ? nf(n / 1e4, 0) + "만원" : nf(n) + "원";
export const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
export { nf };
