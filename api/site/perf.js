"use strict";
// GET /api/site/perf?addr=0x...   cabeçalho x-site-key
// Atualiza e devolve o histórico das posições encerradas "do site" (guardado no Redis) e a lista de posições da carteira que vieram do site.
const { autorizado } = require("../../lib/auth.js");
const { temRedis } = require("../../lib/store.js");
const perf = require("../../lib/perf.js");
function json(res, st, o) { res.statusCode = st; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(o)); }
module.exports = async (req, res) => {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "método não permitido" });
  if (!autorizado(req)) return json(res, 401, { ok: false, error: "chave inválida" });
  if (!temRedis()) return json(res, 503, { ok: false, error: "Redis não configurado" });
  try {
    const addr = String(new URL(req.url, "http://x").searchParams.get("addr") || "").toLowerCase();
    if (!perf.ENDERECO.test(addr)) return json(res, 400, { ok: false, error: "endereço inválido" });
    await perf.salvarCarteira(addr);
    const r = await perf.atualizar(addr);
    json(res, 200, Object.assign({ ok: true }, r));
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
};
