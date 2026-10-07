"use strict";
// Histórico das posições "vindas do site": registro de mercados vistos + desempenho da carteira, guardados no Redis.
const { redis } = require("./store.js");
const DATA = "https://data-api.polymarket.com";
const K_SITE = "bonding:site", K_CARTEIRA = "bonding:wallet", DIA = 86400000;
const ENDERECO = /^0x[a-fA-F0-9]{40}$/;

async function getJson(path) {
  const r = await fetch(DATA + path, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("Data API HTTP " + r.status);
  return r.json();
}
function tradedVal(p) { const a = Number(p.avgPrice), b = Number(p.totalBought); if (isFinite(a) && isFinite(b) && b > 0) return a * b; const i = Number(p.initialValue); return isFinite(i) ? i : 0; }
function tsMs(p) { const t = Number(p.timestamp); if (isFinite(t) && t > 0) return t < 1e11 ? t * 1000 : t; const d = p.endDate ? new Date(p.endDate).getTime() : NaN; return isFinite(d) ? d : Date.now(); }
function lerHash(raw) { const o = {}; for (let i = 0; Array.isArray(raw) && i + 1 < raw.length; i += 2) o[raw[i]] = raw[i + 1]; return o; }

// Guarda os mercados que o site exibiu ou alertou (mantém a data da primeira vez).
async function registrarVistos(lista, origem) {
  const itens = (Array.isArray(lista) ? lista : []).filter((x) => x && typeof x.k === "string" && /^\d{5,100}$/.test(x.k)).slice(0, 400);
  if (!itens.length) return 0;
  const ja = await redis(["HMGET", K_SITE, ...itens.map((x) => x.k)]);
  const agora = Date.now(), escrever = [];
  itens.forEach((x, i) => {
    let o = null; try { o = ja[i] ? JSON.parse(ja[i]) : null; } catch (e) {}
    const s = Number(x.s) || 0;
    const v = o ? { t: o.t, u: agora, s: Math.max(Number(o.s) || 0, s), pr: o.pr, q: o.q, o: o.o || origem } : { t: agora, u: agora, s, pr: Number(x.pr) || null, q: String(x.q || "").slice(0, 80), o: origem || "pagina" };
    escrever.push(x.k, JSON.stringify(v));
  });
  await redis(["HSET", K_SITE, ...escrever]);
  return itens.length;
}
async function podarVistos() {
  const n = Number(await redis(["HLEN", K_SITE])) || 0;
  if (n < 4000) return 0;
  const todos = lerHash(await redis(["HGETALL", K_SITE])), lim = Date.now() - 120 * DIA, apagar = [];
  Object.keys(todos).forEach((k) => { try { if (JSON.parse(todos[k]).u < lim) apagar.push(k); } catch (e) { apagar.push(k); } });
  for (let i = 0; i < apagar.length; i += 200) await redis(["HDEL", K_SITE, ...apagar.slice(i, i + 200)]);
  return apagar.length;
}
async function carteira(addr) {
  const pos = await getJson("/positions?user=" + addr + "&sizeThreshold=0.01&limit=500").catch(() => []);
  const closed = [];
  for (let off = 0; off < 250; off += 50) {
    const l = await getJson("/closed-positions?user=" + addr + "&limit=50&offset=" + off).catch(() => null);
    if (!Array.isArray(l)) break;
    closed.push(...l);
    if (l.length < 50) break;
  }
  return { pos: Array.isArray(pos) ? pos : [], closed };
}
// Atualiza o histórico de posições encerradas "do site" da carteira e devolve tudo.
async function atualizar(addr) {
  addr = String(addr || "").toLowerCase();
  if (!ENDERECO.test(addr)) throw new Error("endereço inválido");
  const { pos, closed } = await carteira(addr);
  const assets = [...new Set(pos.concat(closed).map((p) => p && p.asset).filter(Boolean))];
  const noSite = new Set();
  for (let i = 0; i < assets.length; i += 300) {
    const parte = assets.slice(i, i + 300), vals = await redis(["HMGET", K_SITE, ...parte]);
    parte.forEach((a, j) => { if (vals[j]) noSite.add(a); });
  }
  const novos = [];
  closed.forEach((p) => {
    if (!p || !noSite.has(p.asset)) return;
    const x = Number(p.realizedPnl);
    novos.push(p.asset, JSON.stringify({ t: tsMs(p), pnl: isFinite(x) ? x : 0, tv: tradedVal(p), title: String(p.title || "").slice(0, 80), out: String(p.outcome || "") }));
  });
  const chave = "bonding:fech:" + addr;
  if (novos.length) await redis(["HSET", chave, ...novos]);
  const h = lerHash(await redis(["HGETALL", chave])), itens = [];
  Object.keys(h).forEach((a) => { try { itens.push(Object.assign({ a, pend: false }, JSON.parse(h[a]))); } catch (e) {} });
  pos.forEach((p) => {
    if (p && p.redeemable === true && noSite.has(p.asset) && !h[p.asset]) { const x = Number(p.cashPnl); itens.push({ a: p.asset, pend: true, t: tsMs(p), pnl: isFinite(x) ? x : 0, tv: tradedVal(p), title: String(p.title || "").slice(0, 80), out: String(p.outcome || "") }); }
  });
  itens.sort((a, b) => a.t - b.t);
  return { itens, siteAssets: [...noSite] };
}
async function salvarCarteira(addr) { await redis(["SET", K_CARTEIRA, String(addr).toLowerCase()]); }
async function atualizarCarteiraSalva() {
  const addr = await redis(["GET", K_CARTEIRA]);
  if (addr && ENDERECO.test(addr)) await atualizar(addr);
  await podarVistos();
}
module.exports = { registrarVistos, atualizar, salvarCarteira, atualizarCarteiraSalva, ENDERECO };
