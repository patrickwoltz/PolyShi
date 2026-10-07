"use strict";
// Roda UM ciclo de monitoramento (Polymarket + Kalshi) e envia os alertas ao Telegram.
// Chame a cada hora cheia com:  GET /api/alerts/run?key=SEU_CRON_SECRET   (ou cabeçalho Authorization: Bearer SEU_CRON_SECRET)
const monitor = require("../../lib/monitor.js");
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const segredo = process.env.CRON_SECRET || "";
  const url = new URL(req.url, "http://x");
  const dado = url.searchParams.get("key") || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!segredo || dado !== segredo) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "não autorizado" })); }
  try {
    const persistente = await monitor.carregarEstado();
    const r = await monitor.ciclo(true);
    res.statusCode = r.ok ? 200 : 500;
    res.end(JSON.stringify(Object.assign({ persistente }, r)));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
};
