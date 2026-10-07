"use strict";
const crypto = require("crypto");
// Compara o cabeçalho x-site-key (ou ?key=) com a variável SITE_KEY.
function autorizado(req) {
  const esperado = process.env.SITE_KEY || "";
  if (!esperado) return false;
  let dado = String(req.headers["x-site-key"] || "");
  if (!dado) { try { dado = new URL(req.url, "http://x").searchParams.get("key") || ""; } catch (e) {} }
  const a = Buffer.from(dado), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { autorizado };
