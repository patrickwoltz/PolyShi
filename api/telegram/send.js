"use strict";
// Envio manual (botão "Enviar teste" e alertas feitos pela página).
// Aceita só chamadas do próprio site e limita o volume. Para alertas automáticos use /api/alerts/run.
const recentes = [];
function json(res, status, obj) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); }
const hx = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "método não permitido" });
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return json(res, 400, { ok: false, error: "token ou chat ID não configurado" });
  let origemOk = false;
  try { origemOk = new URL(req.headers.origin || "").host === req.headers.host; } catch (e) {}
  if (!origemOk) return json(res, 403, { ok: false, error: "origem não permitida" });
  const agora = Date.now();
  while (recentes.length && agora - recentes[0] > 60000) recentes.shift();
  if (recentes.length >= 5) return json(res, 429, { ok: false, error: "limite de 5 mensagens por minuto" });
  try {
    const corpo = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const texto = String(corpo.text || "").trim().slice(0, 1500);
    if (!texto) return json(res, 400, { ok: false, error: "texto vazio" });
    recentes.push(agora);
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: hx(texto), parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return json(res, 502, { ok: false, error: String(d.description || "Telegram respondeu HTTP " + r.status).split(token).join("***") });
    json(res, 200, { ok: true });
  } catch (e) { json(res, 502, { ok: false, error: String(e.message || e).split(token).join("***") }); }
};
