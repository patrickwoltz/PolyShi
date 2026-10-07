"use strict";
// Proxy da Kalshi: /api/kalshi/markets?... -> https://api.elections.kalshi.com/trade-api/v2/markets?...
const HOSTS = ["https://api.elections.kalshi.com", "https://external-api.kalshi.com"];
module.exports = async (req, res) => {
  if (req.method !== "GET") { res.statusCode = 405; return res.end("método não permitido"); }
  const resto = String(req.url || "").replace(/^\/api\/kalshi/, "");
  if (!/^\/(markets|series)(\/|\?|$)/.test(resto)) { res.statusCode = 400; return res.end("rota não permitida"); }
  let ultimo = "erro desconhecido";
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + "/trade-api/v2" + resto, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
      const corpo = await r.text();
      res.statusCode = r.status;
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
      res.setHeader("Cache-Control", r.ok ? "public, s-maxage=15, stale-while-revalidate=30" : "no-store");
      return res.end(corpo);
    } catch (e) { ultimo = String(e.message || e); }
  }
  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: ultimo }));
};
