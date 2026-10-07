"use strict";
// POST /api/site/seen  { seen: [{ k: "<tokenId>", s: score, pr: preço, q: "pergunta" }] }   cabeçalho x-site-key
const { autorizado } = require("../../lib/auth.js");
const { temRedis } = require("../../lib/store.js");
const perf = require("../../lib/perf.js");
function json(res, st, o) { res.statusCode = st; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(o)); }
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "método não permitido" });
  if (!autorizado(req)) return json(res, 401, { ok: false, error: "chave inválida" });
  if (!temRedis()) return json(res, 503, { ok: false, error: "Redis não configurado" });
  try {
    const corpo = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const n = await perf.registrarVistos(corpo.seen, "pagina");
    json(res, 200, { ok: true, registrados: n });
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
};
