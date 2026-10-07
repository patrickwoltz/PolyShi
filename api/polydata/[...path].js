"use strict";
// Proxy somente-leitura da Data API da Polymarket: /api/polydata/positions?user=0x... -> https://data-api.polymarket.com/positions?user=0x...
module.exports = async (req, res) => {
  if (req.method !== "GET") { res.statusCode = 405; return res.end("método não permitido"); }
  const resto = String(req.url || "").replace(/^\/api\/polydata/, "");
  if (!/^\/(positions|closed-positions|value)(\?|$)/.test(resto) || !/[?&]user=0x[a-fA-F0-9]{40}(&|$)/.test(resto)) { res.statusCode = 400; return res.end("rota não permitida"); }
  try {
    const r = await fetch("https://data-api.polymarket.com" + resto, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
    res.statusCode = r.status;
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(await r.text());
  } catch (e) { res.statusCode = 502; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: String(e.message || e) })); }
};
