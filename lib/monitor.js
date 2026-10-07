"use strict";
// Monitor de alertas para a Vercel: um ciclo por chamada, estado e histórico no Redis (Upstash/Vercel KV).
// Credenciais: variáveis TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID, ou telegram.json ({"token":"...","chatId":"..."}).
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const ARQ_CONFIG = path.join(__dirname, "alerts-config.json");
const ARQ_ESTADO = path.join(__dirname, "alerts-state.json");
const KALSHI_HOSTS = ["https://api.elections.kalshi.com", "https://external-api.kalshi.com"];
const DIA = 86400000;

let TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
let TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
try {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, "telegram.json"), "utf8"));
  TG_TOKEN = TG_TOKEN || String(c.token || "");
  TG_CHAT = TG_CHAT || String(c.chatId || "");
} catch (e) {}

const PADRAO = {
  enabled: false,
  fontes: { polymarket: true, kalshi: true },
  scoreMin: 8, retornoMin: 0, prazoMax: 7, saltoScore: 1.5,
  avisarSaida: true, avisarErros: true,
  silencio: { ativo: false, inicio: "23:00", fim: "07:00" },
  resumo: { ativo: false, hora: "20:00" },
  intervaloMin: 5,
  filtros: { probMin: 90, probMax: 99, orcamento: 100 },
  ocultas: []
};

function lerJson(arq, padrao) { try { return JSON.parse(fs.readFileSync(arq, "utf8")); } catch (e) { return padrao; } }
function gravarJson(arq, obj) { const tmp = arq + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, arq); }
function num(v, min, max, pad) { const n = Number(v); if (!isFinite(n)) return pad; return Math.min(max, Math.max(min, n)); }
function hhmm(v, pad) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : pad; }
const CATS_VALIDAS = ["Politics","Sports","Crypto","Esports","Iran","Finance","Geopolitics","Tech","Culture","Economy","Weather","Mentions","Elections","Art"];

function sanear(inp, atual) {
  const c = JSON.parse(JSON.stringify(atual));
  if (!inp || typeof inp !== "object") return c;
  if (typeof inp.enabled === "boolean") c.enabled = inp.enabled;
  if (inp.fontes) {
    if (typeof inp.fontes.polymarket === "boolean") c.fontes.polymarket = inp.fontes.polymarket;
    if (typeof inp.fontes.kalshi === "boolean") c.fontes.kalshi = inp.fontes.kalshi;
  }
  if ("scoreMin" in inp) c.scoreMin = num(inp.scoreMin, 0, 10, c.scoreMin);
  if ("retornoMin" in inp) c.retornoMin = num(inp.retornoMin, 0, 100, c.retornoMin);
  if ("prazoMax" in inp) c.prazoMax = num(inp.prazoMax, 1, 30, c.prazoMax);
  if ("saltoScore" in inp) c.saltoScore = num(inp.saltoScore, 0.1, 10, c.saltoScore);
  if (typeof inp.avisarSaida === "boolean") c.avisarSaida = inp.avisarSaida;
  if (typeof inp.avisarErros === "boolean") c.avisarErros = inp.avisarErros;
  if (inp.silencio) {
    if (typeof inp.silencio.ativo === "boolean") c.silencio.ativo = inp.silencio.ativo;
    c.silencio.inicio = hhmm(inp.silencio.inicio, c.silencio.inicio);
    c.silencio.fim = hhmm(inp.silencio.fim, c.silencio.fim);
  }
  if (inp.resumo) {
    if (typeof inp.resumo.ativo === "boolean") c.resumo.ativo = inp.resumo.ativo;
    c.resumo.hora = hhmm(inp.resumo.hora, c.resumo.hora);
  }
  if ("intervaloMin" in inp) c.intervaloMin = Math.round(num(inp.intervaloMin, 2, 60, c.intervaloMin));
  if (inp.filtros) {
    let a = num(inp.filtros.probMin, 1, 99, c.filtros.probMin), b = num(inp.filtros.probMax, 1, 99, c.filtros.probMax);
    if (a > b) { const t = a; a = b; b = t; }
    c.filtros.probMin = a; c.filtros.probMax = b;
    c.filtros.orcamento = num(inp.filtros.orcamento, 0.01, 1e9, c.filtros.orcamento);
  }
  if (Array.isArray(inp.ocultas)) c.ocultas = inp.ocultas.filter((x) => CATS_VALIDAS.includes(x));
  return c;
}

const TZ = process.env.ALERTS_TZ || "America/Sao_Paulo";
let config = sanear((() => { try { return JSON.parse(process.env.ALERTS_CONFIG || "{}"); } catch (e) { return {}; } })(), PADRAO);
if (!/"enabled"\s*:/.test(process.env.ALERTS_CONFIG || "")) config.enabled = true;
function parteLocal(d) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d || new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { h: Number(p.hour) % 24, m: Number(p.minute), dia: p.year + "-" + p.month + "-" + p.day };
}
const ESTADO_BASE = () => ({ enviados: {}, ativos: {}, falhas: {}, ultimoResumo: "" });
let estado = ESTADO_BASE();
const CHAVE_ESTADO = "bonding:estado";
const ARQ_TMP = "/tmp/bonding-estado.json";
const store = require("./store.js"), perf = require("./perf.js");
async function redis(cmd) { return store.temRedis() ? store.redis(cmd) : undefined; }
async function carregarEstado() {
  const raw = await redis(["GET", CHAVE_ESTADO]);
  if (raw === undefined) estado = Object.assign(ESTADO_BASE(), lerJson(ARQ_TMP, {}));
  else estado = Object.assign(ESTADO_BASE(), raw ? JSON.parse(raw) : {});
  return raw !== undefined;
}
async function salvarEstado() {
  const s = JSON.stringify(estado);
  if ((await redis(["SET", CHAVE_ESTADO, s])) === undefined) fs.writeFileSync(ARQ_TMP, s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- utilidades de rede ----------
async function getJson(url) {
  let ultimo;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status >= 500) { ultimo = new Error("HTTP " + r.status); await sleep(1000 * (t + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      ultimo = e;
      if (String(e.message).startsWith("HTTP 4")) throw e;
      await sleep(500 * (t + 1));
    }
  }
  throw ultimo;
}
let kalshiHostIdx = 0;
async function kalshiGet(p) {
  let ultimo;
  for (let i = 0; i < KALSHI_HOSTS.length; i++) {
    const idx = (kalshiHostIdx + i) % KALSHI_HOSTS.length;
    try { const d = await getJson(KALSHI_HOSTS[idx] + "/trade-api/v2" + p); kalshiHostIdx = idx; return d; } catch (e) { ultimo = e; }
  }
  throw ultimo;
}
async function emLotes(arr, n, fn) { for (let i = 0; i < arr.length; i += n) await Promise.all(arr.slice(i, i + n).map(fn)); }

// ---------- Telegram ----------
let fila = Promise.resolve();
function hx(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
async function enviarComRetry(texto, opts, tent) {
  const corpo = { chat_id: TG_CHAT, text: texto.slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true, disable_notification: !!opts.silencioso };
  if (opts.botoes && opts.botoes.length) corpo.reply_markup = { inline_keyboard: opts.botoes };
  const resp = await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(25000) });
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 429 && tent < 2) {
    const espera = Math.min(Number(dados.parameters && dados.parameters.retry_after) || 5, 60);
    await sleep(espera * 1000 + 300);
    return enviarComRetry(texto, opts, tent + 1);
  }
  if (!resp.ok || !dados.ok) throw new Error(dados.description || "Telegram respondeu HTTP " + resp.status);
}
function enviarTelegram(texto, opts) {
  if (!TG_TOKEN || !TG_CHAT) return Promise.reject(new Error("token ou chat ID não configurado"));
  const job = fila.then(() => enviarComRetry(texto, opts || {}, 0));
  fila = job.catch(() => {}).then(() => sleep(1100));
  return job.catch((e) => { throw new Error(String(e.message || e).split(TG_TOKEN).join("***")); });
}

// ---------- classificação por categoria ----------
const CATEGORIAS = CATS_VALIDAS;
const PADROES = {Politics:/\b(president|presidential|senate|senator|congress|house of representatives|trump|biden|harris|vance|democrat|republican|gop|governor|parliament|prime minister|white house|supreme court|cabinet|impeach|speaker of the house|executive order|shutdown|veto)\b/i,Sports:/\b(nba|nfl|mlb|nhl|wnba|ncaa|soccer|football|fifa|premier league|uefa|champions league|europa league|la liga|serie a|bundesliga|ligue 1|tennis|atp|wta|wimbledon|us open|french open|ufc|mma|boxing|f1|formula 1|grand prix|olympic|olympics|world cup|golf|pga|masters|cricket|ipl|rugby|super bowl|stanley cup|world series|playoffs?|touchdown|vs\.?)\b/i,Crypto:/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|cryptocurrency|xrp|ripple|dogecoin|doge|token|coinbase|binance|stablecoin|altcoin|memecoin|defi|nft|airdrop|fdv)\b/i,Esports:/\b(esports?|league of legends|lol|dota|dota 2|counter-strike|cs2|csgo|valorant|overwatch|call of duty|rocket league|starcraft|t1|blast|iem|pgl|lck|lpl)\b/i,Iran:/\b(iran|iranian|tehran|khamenei|irgc|persian gulf|strait of hormuz)\b/i,Finance:/\b(stocks?|s&p|s&p 500|spx|nasdaq|dow jones|equities|earnings|ipo|market cap|treasury|bond yield|yield|forex|usd|eur|gold|silver|oil|crude|brent|wti|nvidia|nvda|tesla|tsla|apple|aapl|microsoft|msft|amazon|amzn|close (above|below|at)|shares|etf|vix)\b/i,Geopolitics:/\b(war|ukraine|russia|russian|israel|gaza|hamas|hezbollah|china|taiwan|nato|ceasefire|sanctions?|putin|zelensky|north korea|kim jong|missile|invasion|nuclear|syria|yemen|houthi|venezuela|border|annex|treaty|un security council)\b/i,Tech:/\b(ai|a\.i\.|openai|gpt|chatgpt|gemini|claude|anthropic|google|meta|spacex|starship|elon musk|musk|iphone|android|software|robot|robotaxi|chip|semiconductor|tiktok|x\.com|twitter|launch|model|llm|quantum|satellite)\b/i,Culture:/\b(movie|film|oscars?|academy awards|grammys?|emmys?|golden globes?|box office|album|song|billboard|spotify|taylor swift|beyonce|netflix|celebrity|tv show|series|season|streaming|actor|actress|singer|rapper|concert|tour|podcast|youtube|mrbeast|kardashian|reality)\b/i,Economy:/\b(inflation|cpi|pce|gdp|unemployment|jobs report|nonfarm|payrolls?|recession|fomc|fed|federal reserve|interest rates?|rate cuts?|rate hike|tariffs?|economy|economic|mortgage|housing|retail sales|consumer sentiment|debt ceiling|deficit)\b/i,Weather:/\b(weather|temperature|temp|degrees|high temp|low temp|hurricane|tropical storm|typhoon|tornado|snow|snowfall|rain|rainfall|precipitation|heat wave|storm|blizzard|wildfire|earthquake|climate|el nino|la nina)\b/i,Mentions:/\b(say|says|said|mention|mentions|mentioned|word|words|phrase|tweets?|posts?)\b/i,Elections:/\b(election|elections|primary|primaries|nominee|nomination|ballot|runoff|mayor|mayoral|midterms?|electoral|polls?|vote share|turnout|winner of the .* (race|election)|governor race|senate race|presidential race)\b/i,Art:/\b(art|artist|painting|paintings|museum|sculpture|gallery|auction|christie'?s|sotheby'?s|banksy|picasso|exhibit|exhibition|nft art)\b/i};
const MAPA_ROTULOS = [[/politic/,"Politics"],[/sport/,"Sports"],[/crypto/,"Crypto"],[/esport|gaming/,"Esports"],[/iran/,"Iran"],[/financ|compan|stock|business/,"Finance"],[/geopolit|world|global/,"Geopolitics"],[/tech|science|\bai\b/,"Tech"],[/cultur|entertain|pop|music|movie|celebr/,"Culture"],[/econom|inflation|fed/,"Economy"],[/weather|climate|temperature/,"Weather"],[/mention/,"Mentions"],[/election/,"Elections"],[/\bart\b|arts/,"Art"]];
function rotulosDe(vals) { const out = []; (function add(v) { if (v == null) return; if (typeof v === "string") out.push(v.toLowerCase()); else if (Array.isArray(v)) v.forEach(add); else if (typeof v === "object") { add(v.label); add(v.slug); add(v.name); add(v.category); add(v.tags); } })(vals); return out; }
function categoriasDe(texto, rotulos) {
  const set = {};
  for (const r of rotulos) for (const [re, c] of MAPA_ROTULOS) if (re.test(r)) set[c] = true;
  for (const c of CATEGORIAS) if (PADROES[c].test(texto)) set[c] = true;
  return Object.keys(set);
}

// ---------- pontuação ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function pontuar(ret, h, liq, vol, dias) {
  const lg = (x, ref) => clamp(Math.log(1 + Math.max(0, Number(x) || 0)) / Math.log(1 + ref), 0, 1);
  return 4 * clamp((Number(ret) || 0) / 10, 0, 1) + 3 * (1 - clamp((h === null || !isFinite(h) ? 0 : Math.max(0, h)) / (dias * 24), 0, 1)) + 2 * lg(liq, 100000) + 1 * lg(vol, 100000);
}
function tempoTexto(h) { if (!isFinite(h)) return "n/d"; if (h <= 0) return "agora"; const d = Math.floor(h / 24), r = Math.floor(h % 24); return d > 0 ? d + "d " + r + "h" : r + "h"; }

// ---------- Polymarket ----------
function arr(v) { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; } } return []; }
function pEnd(m) { for (const x of [m.endDateIso, m.endDate, m.umaEndDateIso, m.umaEndDate]) { if (x) { const d = new Date(x); if (!isNaN(d.getTime())) return d; } } return null; }
function pHours(m) { const d = pEnd(m); return d ? (d.getTime() - Date.now()) / 3600000 : null; }
function firstNumber(xs) { for (const x of xs) { const n = Number(x); if (isFinite(n) && n >= 0) return n; } return null; }
function pLiq(m) { const n = firstNumber([m.liquidityClob, m.liquidityNum, m.liquidity, m.liquidityAmm]); return n === null ? 0 : n; }
function pVol(m) { return firstNumber([m.volume24hrClob, m.volume24hr, m.volume24Hour, m.volume24h]); }
function pPositions(m) { const ns = arr(m.outcomes), ps = arr(m.outcomePrices), ts = arr(m.clobTokenIds), out = []; for (let i = 0; i < ns.length; i++) { const p = Number(ps[i]); if (isFinite(p)) out.push({ name: String(ns[i]), price: p, tokenId: ts[i] ? String(ts[i]) : null }); } return out; }
function pLive(m) { if (!m) return false; if (m.live === true) return true; const ev = Array.isArray(m.events) ? m.events : []; for (const e of ev) if (e && e.live === true) return true; const g = m.gameStartTime || (ev[0] && ev[0].gameStartTime); if (g) { const d = new Date(String(g).replace(" ", "T")); if (!isNaN(d.getTime()) && d.getTime() <= Date.now()) return true; } return false; }
function taxaMercado(m) { let fs = m && m.feeSchedule; if (typeof fs === "string") { try { fs = JSON.parse(fs); } catch (e) { fs = null; } } if (m && m.feesEnabled === false) return { rate: 0, exp: 1 }; if (fs && fs.rate !== undefined && fs.rate !== null) { const r = Number(fs.rate), x = Number(fs.exponent); return { rate: isFinite(r) ? r : 0.05, exp: isFinite(x) && x > 0 ? x : 1 }; } return { rate: 0.05, exp: 1 }; }
const feeShare = (p, t) => t.rate * Math.pow(p * (1 - p), t.exp);
function pSimular(asks, budget, t) {
  let left = budget, cost = 0, shares = 0;
  for (let i = 0; i < asks.length && left > 0; i++) {
    const l = asks[i], unit = l.price + feeShare(l.price, t), spend = Math.min(left, unit * l.size);
    if (spend > 0) { cost += spend; shares += spend / unit; left -= spend; }
  }
  return { cost, shares, returnPct: cost > 0 ? ((shares - cost) / cost) * 100 : null };
}
function pBook(book, f, m) {
  const bids = Array.isArray(book.bids) ? book.bids : [], asksRaw = Array.isArray(book.asks) ? book.asks : [];
  const px = (xs, cmp) => { let x = null; for (const l of xs) { const p = Number(l.price); if (isFinite(p) && (x === null || cmp(p, x))) x = p; } return x; };
  const bid = px(bids, (a, b) => a > b), ask = px(asksRaw, (a, b) => a < b);
  const asks = asksRaw.map((l) => ({ price: Number(l.price), size: Number(l.size) })).filter((l) => isFinite(l.price) && l.price > 0 && isFinite(l.size) && l.size > 0).sort((a, b) => a.price - b.price);
  if (bid === null || ask === null) return { available: false };
  return { available: true, spread: ask - bid, sim: pSimular(asks, f.orcamento, taxaMercado(m)) };
}
async function polyMercados(dias) {
  const agora = new Date(), dmin = agora.toISOString(), dmax = new Date(agora.getTime() + dias * DIA).toISOString();
  try {
    const todos = []; let cur = null;
    for (let n = 0; n < 40; n++) {
      const d = await getJson("https://gamma-api.polymarket.com/markets/keyset?closed=false&limit=100&end_date_min=" + encodeURIComponent(dmin) + "&end_date_max=" + encodeURIComponent(dmax) + (cur ? "&after_cursor=" + encodeURIComponent(cur) : ""));
      const ms = Array.isArray(d) ? d : ((d && d.markets) || []);
      todos.push(...ms);
      if (d && d.next_cursor && ms.length) cur = d.next_cursor; else break;
    }
    return todos;
  } catch (e) {
    const pages = await Promise.all(Array.from({ length: 10 }, (_, p) => getJson("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=" + (p * 100) + "&end_date_min=" + encodeURIComponent(dmin) + "&end_date_max=" + encodeURIComponent(dmax))));
    return pages.flatMap((p) => (Array.isArray(p) ? p : []));
  }
}
async function avaliarPoly(f) {
  const ms = (await polyMercados(f.dias)).filter((m) => m && m.active !== false && m.closed !== true && !pLive(m));
  const base = [];
  for (const m of ms) {
    const h = pHours(m);
    if (h === null || h <= 0 || h > f.dias * 24 || pLiq(m) <= 10000) continue;
    const p = pPositions(m).find((x) => x.price >= f.pmin && x.price <= f.pmax);
    if (!p || !p.tokenId) continue;
    base.push({ m, p });
  }
  base.sort((a, b) => pLiq(b.m) - pLiq(a.m));
  const cand = base.slice(0, 100);
  await emLotes(cand, 20, async (c) => { try { c.book = pBook(await getJson("https://clob.polymarket.com/book?token_id=" + encodeURIComponent(c.p.tokenId)), f, c.m); } catch (e) { c.book = { available: false }; } });
  return cand.filter((c) => c.book && c.book.available && c.book.spread <= 0.05 && c.book.sim.cost > 0).map((c) => {
    const m = c.m, h = pHours(m), ev = Array.isArray(m.events) ? m.events : [];
    const texto = [m.question, m.slug, m.groupItemTitle].concat(ev.map((e) => e && e.title)).join(" ");
    return {
      key: "poly:" + (m.id || m.conditionId || m.slug || m.question), asset: c.p.tokenId, fonte: "Polymarket", titulo: m.question || "Mercado sem título",
      url: m.slug ? "https://polymarket.com/market/" + encodeURIComponent(m.slug) : "https://polymarket.com",
      score: pontuar(Math.max(0, Number(c.book.sim.returnPct) || 0), h, pLiq(m), pVol(m), f.dias),
      lado: c.p.name, preco: c.p.price, retorno: c.book.sim.returnPct, horas: h, resolve: tempoTexto(h),
      cats: categoriasDe(texto, rotulosDe([m.category, m.categories, m.tags, ev.map((e) => e && [e.category, e.categories, e.tags])]))
    };
  });
}

// ---------- Kalshi ----------
const kNum = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
function kLiq(m) { const n = firstNumber([m.liquidity_dollars, m.liquidity]); if (n !== null && n > 0) return n; return (kNum(m.yes_bid_dollars) || 0) * (kNum(m.yes_bid_size_fp) || 0) + (kNum(m.yes_ask_dollars) || 0) * (kNum(m.yes_ask_size_fp) || 0); }
function kPrice(m) { const a = kNum(m.yes_ask_dollars), l = kNum(m.last_price_dollars), b = kNum(m.yes_bid_dollars); if (a !== null && a > 0) return a; if (l !== null && l > 0) return l; if (b !== null && b > 0) return b; return null; }
function kLevels(xs) { return (Array.isArray(xs) ? xs : []).map((x) => ({ price: Number(x[0]), size: Number(x[1]) })).filter((x) => isFinite(x.price) && x.price > 0 && isFinite(x.size) && x.size > 0).sort((a, b) => b.price - a.price); }
function kSimular(asks, budget) { let left = budget, cost = 0, shares = 0; for (let i = 0; i < asks.length && left > 0.000001; i++) { const x = asks[i], spend = Math.min(left, x.price * x.size); cost += spend; shares += spend / x.price; left -= spend; } return { cost, returnPct: cost ? ((shares - cost) / cost) * 100 : null }; }
function kTop(m, f) { const bid = kNum(m.yes_bid_dollars), ask = kNum(m.yes_ask_dollars), size = kNum(m.yes_ask_size_fp); if (!(bid > 0) || !(ask > 0) || ask >= 1) return { available: false }; return { available: true, sim: kSimular([{ price: ask, size: size > 0 ? size : 1e9 }], f.orcamento) }; }
async function kBook(m, f) {
  try {
    const raw = await kalshiGet("/markets/" + encodeURIComponent(m.ticker) + "/orderbook?depth=100");
    const ob = raw && raw.orderbook_fp ? raw.orderbook_fp : {};
    const bids = kLevels(ob.yes_dollars), asks = kLevels(ob.no_dollars).map((x) => ({ price: 1 - x.price, size: x.size })).filter((x) => x.price > 0 && x.price < 1).sort((a, b) => a.price - b.price);
    if (!bids.length || !asks.length) return kTop(m, f);
    return { available: true, sim: kSimular(asks, f.orcamento) };
  } catch (e) { return kTop(m, f); }
}
let seriesCache = { t: 0, map: {} };
async function kSeries() {
  if (Date.now() - seriesCache.t < 1800000) return seriesCache.map;
  try { const d = await kalshiGet("/series"); const map = {}; (Array.isArray(d && d.series) ? d.series : []).forEach((s) => { if (s && s.ticker) map[s.ticker] = s; }); seriesCache = { t: Date.now(), map }; } catch (e) {}
  return seriesCache.map;
}
async function avaliarKalshi(f) {
  const min = Math.floor(Date.now() / 1000), max = min + Math.floor(f.dias * 86400), todos = []; let cursor = "";
  for (let p = 0; p < 20; p++) {
    const d = await kalshiGet("/markets?limit=1000&min_close_ts=" + min + "&max_close_ts=" + max + "&mve_filter=exclude" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const ms = Array.isArray(d.markets) ? d.markets : [];
    todos.push(...ms);
    if (d.cursor && ms.length) cursor = d.cursor; else break;
  }
  const agora = Date.now(), lim = agora + f.dias * DIA;
  const cand = todos.filter((m) => {
    const s = String(m.status || "").toLowerCase(); if (s !== "active" && s !== "open") return false;
    const t = new Date(m.close_time).getTime(); if (!isFinite(t) || t <= agora || t > lim) return false;
    const p = kPrice(m); return p !== null && p >= f.pmin && p <= f.pmax;
  }).sort((a, b) => kLiq(b) - kLiq(a)).slice(0, 100);
  const series = await kSeries();
  await emLotes(cand, 10, async (m) => { m.book = await kBook(m, f); });
  return cand.filter((m) => m.book && m.book.available && m.book.sim.cost > 0).map((m) => {
    const h = (new Date(m.close_time).getTime() - Date.now()) / 3600000, info = series[String(m.event_ticker || m.ticker || "").split("-")[0]];
    return {
      key: "kal:" + m.ticker, fonte: "Kalshi", titulo: m.title || m.yes_sub_title || m.ticker, url: "https://kalshi.com/markets/" + encodeURIComponent(m.ticker),
      score: pontuar(Math.max(0, m.book.sim.returnPct || 0), h, kLiq(m), kNum(m.volume_24h_fp) || 0, f.dias),
      lado: "YES", preco: kPrice(m), retorno: m.book.sim.returnPct, horas: h, resolve: tempoTexto(h),
      cats: categoriasDe([m.title, m.yes_sub_title, m.no_sub_title, m.subtitle, info && info.title].join(" "), rotulosDe([info && info.category, info && info.tags, m.category]))
    };
  });
}

// ---------- mensagens ----------
function emSilencio(agora) {
  if (!config.silencio.ativo) return false;
  const pl = parteLocal(agora), cur = pl.h * 60 + pl.m;
  const mm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const a = mm(config.silencio.inicio), b = mm(config.silencio.fim);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}
function linhaMercado(n, q) {
  const ret = Number(q.retorno), tag = q.tipo === "subiu" ? " ↑ (de " + q.antes.toFixed(1) + ")" : "";
  return n + ". <b>" + hx(q.titulo) + "</b>\n    " + hx(q.fonte) + " · " + hx(q.lado) + " " + (Number(q.preco) * 100).toFixed(1) + "% · Score " + q.score.toFixed(1) + "/10" + tag + (isFinite(ret) ? " · Retorno " + (ret >= 0 ? "+" : "") + ret.toFixed(1) + "%" : "") + " · Resolve em " + hx(q.resolve);
}
function botoesDe(lista) { return lista.map((q, i) => [{ text: (i + 1) + " · " + (q.titulo.length > 42 ? q.titulo.slice(0, 41) + "…" : q.titulo), url: q.url }]); }

// ---------- ciclo de monitoramento ----------
let rodando = false, proximoCiclo = 0, ultimoCiclo = null, ultimosQualificados = [];
async function registrarFalha(fonte, erro, cfg) {
  const f = estado.falhas[fonte] || { n: 0, avisadoEm: 0, avisou: false };
  f.n++;
  if (erro && f.n >= 3 && cfg.avisarErros && Date.now() - f.avisadoEm > 3600000) {
    f.avisadoEm = Date.now(); f.avisou = true;
    await enviarTelegram("⚠️ <b>Falha na " + hx(fonte) + "</b> há " + f.n + " verificações seguidas.\n" + hx(String(erro).slice(0, 300)), { silencioso: emSilencio() }).catch(() => {});
  }
  estado.falhas[fonte] = f;
}
async function registrarSucesso(fonte, cfg) {
  const f = estado.falhas[fonte];
  if (f && f.avisou && cfg.avisarErros) await enviarTelegram("✅ <b>" + hx(fonte) + "</b> voltou a responder.", { silencioso: emSilencio() }).catch(() => {});
  estado.falhas[fonte] = { n: 0, avisadoEm: 0, avisou: false };
}
async function processarAlertas(qual, fontesOk, cfg) {
  const agora = Date.now(), enviadosAgora = [];
  const novos = [];
  for (const q of qual) {
    const s = estado.enviados[q.key];
    if (!s || agora - s.t > DIA) novos.push(Object.assign({ tipo: "novo" }, q));
    else if (q.score >= s.score + cfg.saltoScore) novos.push(Object.assign({ tipo: "subiu", antes: s.score }, q));
  }
  novos.sort((a, b) => b.score - a.score);
  const lote = novos.slice(0, 5);
  if (lote.length) {
    const texto = "<b>🔔 " + lote.length + (lote.length === 1 ? " mercado" : " mercados") + " com Score ≥ " + cfg.scoreMin + "</b>\n\n" + lote.map((q, i) => linhaMercado(i + 1, q)).join("\n\n");
    await enviarTelegram(texto, { botoes: botoesDe(lote), silencioso: emSilencio() });
    for (const q of lote) { estado.enviados[q.key] = { t: agora, score: q.score }; estado.ativos[q.key] = { titulo: q.titulo, url: q.url, fonte: q.fonte, faltas: 0 }; enviadosAgora.push(q.key); }
  }
  const presentes = new Set(qual.map((q) => q.key)), saidas = [];
  for (const [key, a] of Object.entries(estado.ativos)) {
    if (presentes.has(key)) { a.faltas = 0; continue; }
    if (!fontesOk[a.fonte === "Polymarket" ? "polymarket" : "kalshi"]) continue;
    a.faltas = (a.faltas || 0) + 1;
    if (a.faltas >= 2) { saidas.push(a); delete estado.ativos[key]; }
  }
  if (saidas.length && cfg.avisarSaida) {
    const lista = saidas.slice(0, 8);
    await enviarTelegram("⚪ <b>" + saidas.length + (saidas.length === 1 ? " mercado saiu" : " mercados saíram") + " dos filtros</b>\n\n" + lista.map((a, i) => (i + 1) + ". " + hx(a.fonte) + " · " + hx(a.titulo)).join("\n"), { botoes: botoesDe(lista), silencioso: emSilencio() }).catch(() => {});
  }
  for (const [k, v] of Object.entries(estado.enviados)) if (agora - v.t > 7 * DIA) delete estado.enviados[k];
  return enviadosAgora.length;
}
async function resumoDiario(qual, cfg) {
  if (!cfg.resumo.ativo) return;
  const pl = parteLocal(), hoje = pl.dia;
  const [h, m] = cfg.resumo.hora.split(":").map(Number);
  if (estado.ultimoResumo === hoje || pl.h * 60 + pl.m < h * 60 + m) return;
  const top = qual.slice().sort((a, b) => b.score - a.score).slice(0, 5);
  const texto = top.length ? "📋 <b>Resumo diário — melhores mercados agora</b>\n\n" + top.map((q, i) => linhaMercado(i + 1, q)).join("\n\n") : "📋 <b>Resumo diário</b>\n\nNenhum mercado atende aos filtros neste momento.";
  await enviarTelegram(texto, { botoes: botoesDe(top), silencioso: emSilencio() });
  estado.ultimoResumo = hoje;
}
async function ciclo(manual) {
  if (rodando) return { ok: false, error: "um ciclo já está em andamento" };
  const cfg = config;
  if (!cfg.enabled) return { ok: false, error: "alertas desativados" };
  if (!TG_TOKEN || !TG_CHAT) return { ok: false, error: "Telegram não configurado" };
  rodando = true;
  const ini = Date.now(), erros = {}, fontesOk = {}, todos = [];
  try {
    const f = { dias: cfg.prazoMax, pmin: cfg.filtros.probMin / 100, pmax: cfg.filtros.probMax / 100, orcamento: cfg.filtros.orcamento };
    const tarefas = [];
    if (cfg.fontes.polymarket) tarefas.push(avaliarPoly(f).then((r) => { todos.push(...r); fontesOk.polymarket = true; }).catch((e) => { erros.polymarket = String(e.message || e); }));
    if (cfg.fontes.kalshi) tarefas.push(avaliarKalshi(f).then((r) => { todos.push(...r); fontesOk.kalshi = true; }).catch((e) => { erros.kalshi = String(e.message || e); }));
    await Promise.all(tarefas);
    for (const [fonte, nome] of [["polymarket", "Polymarket"], ["kalshi", "Kalshi"]]) {
      if (!cfg.fontes[fonte]) continue;
      if (erros[fonte]) await registrarFalha(nome, erros[fonte], cfg); else await registrarSucesso(nome, cfg);
    }
    const ocultas = new Set(cfg.ocultas);
    const qual = todos.filter((q) => q.score >= cfg.scoreMin && (Number(q.retorno) || 0) >= cfg.retornoMin && q.horas > 0 && q.horas <= cfg.prazoMax * 24 && !q.cats.some((c) => ocultas.has(c)));
    ultimosQualificados = qual;
    if (store.temRedis()) { try { await perf.registrarVistos(qual.filter((q) => q.asset).map((q) => ({ k: q.asset, s: q.score, pr: q.preco, q: q.titulo })), "alerta"); await perf.atualizarCarteiraSalva(); } catch (e) { console.error("histórico:", e.message); } }
    let enviados = 0, erroEnvio = null;
    try { enviados = await processarAlertas(qual, fontesOk, cfg); await resumoDiario(qual, cfg); } catch (e) { erroEnvio = String(e.message || e); }
    ultimoCiclo = { inicio: ini, fim: Date.now(), analisados: todos.length, qualificados: qual.length, enviados, ativos: Object.keys(estado.ativos).length, erros, erroEnvio };
    await salvarEstado();
    return { ok: true, resultado: ultimoCiclo };
  } catch (e) {
    ultimoCiclo = { inicio: ini, fim: Date.now(), erros: { geral: String(e.message || e) } };
    return { ok: false, error: String(e.message || e) };
  } finally { rodando = false; }
}
module.exports = { ciclo, carregarEstado, config: () => config, estadoAtual: () => estado };
