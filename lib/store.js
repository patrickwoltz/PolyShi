"use strict";
// Acesso ao Redis (Upstash / Vercel KV) pela API REST, sem dependências.
function cfg() {
  return { url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "", token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "" };
}
function temRedis() { const c = cfg(); return Boolean(c.url && c.token); }
async function redis(cmd) {
  const c = cfg();
  if (!c.url || !c.token) throw new Error("Redis não configurado");
  const r = await fetch(c.url, { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || "Redis HTTP " + r.status);
  return d.result;
}
module.exports = { redis, temRedis };
