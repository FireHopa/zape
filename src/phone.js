function normalizeBRPhoneToE164Digits(input) {
  if (!input) return null;

  // só dígitos
  let d = String(input).replace(/\D/g, "");

  // tira zeros à esquerda
  d = d.replace(/^0+/, "");

  // se não tiver 55, tenta prefixar
  if (!d.startsWith("55")) {
    // se veio DDD+numero (10/11), prefixa 55
    if (d.length === 10 || d.length === 11) d = "55" + d;
  }

  // BR: 55 + DDD(2) + 8/9
  if (!/^55\d{10,11}$/.test(d)) return null;

  return d; // <-- IMPORTANTE: retorna só dígitos (sem +)
}

module.exports = { normalizeBRPhoneToE164Digits };
