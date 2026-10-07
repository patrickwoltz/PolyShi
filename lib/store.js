"use strict";
// Acesso ao Redis (Upstash / Vercel KV) pela API REST, sem dependências.
// Aceita qualquer prefixo de variável criado pela Vercel (ex.: KV_REST_API_URL, STORAGE_KV_REST_API_URL, UPSTASH_REDIS_REST_URL).
function achar(regexes, excluir) {
  const env = process.env, nomes = Object.keys(env);
  for (const re of regexes) {
    const n = nomes.find((k) => re.test(k) && env[k] && !(excluir && excluir.test(k)));
    if (n) return env[n];
  }
  return "";
}
function cfg() {
  return {
    url: achar([/^KV_REST_API_URL$/, /^UPSTASH_REDIS_REST_URL$/, /KV_REST_API_URL$/, /UPSTASH_REDIS_REST_URL$/, /REDIS_REST_URL$/]),
    token: achar([/^KV_REST_API_TOKEN$/, /^UPSTASH_REDIS_REST_TOKEN$/, /KV_REST_API_TOKEN$/, /UPSTASH_REDIS_REST_TOKEN$/, /REDIS_REST_TOKEN$/], /READ_ONLY/i)
  };
}
function temRedis() { const c = cfg(); return Boolean(c.url && c.token); }
function variaveisParecidas() {
  return Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH|STORAGE/i.test(k)).sort();
}
async function redis(cmd) {
  const c = cfg();
  if (!c.url || !c.token) {
    const v = variaveisParecidas();
    throw new Error("Redis não configurado. Variáveis parecidas encontradas neste deploy: " + (v.length ? v.join(", ") : "nenhuma"));
  }
  const r = await fetch(c.url, { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || "Redis HTTP " + r.status);
  return d.result;
}
module.exports = { redis, temRedis, variaveisParecidas };
