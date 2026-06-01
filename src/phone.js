function digitsOnly(input) {
  if (!input) return "";
  return String(input).replace(/\D/g, "").replace(/^0+/, "");
}

function normalizeBRPhoneToE164DigitsStrict(input) {
  let d = digitsOnly(input);
  if (!d) return null;

  // BR com DDI: 55 + DDD(2) + número com 8 ou 9 dígitos.
  if (d.startsWith("55")) {
    return /^55\d{10,11}$/.test(d) ? d : null;
  }

  // BR sem DDI: DDD + número com 8 ou 9 dígitos.
  if (d.length === 10 || d.length === 11) {
    d = "55" + d;
    return /^55\d{10,11}$/.test(d) ? d : null;
  }

  return null;
}

function normalizePTPhoneToE164Digits(input) {
  let d = digitsOnly(input);
  if (!d) return null;

  // Portugal com DDI: 351 + número nacional de 9 dígitos.
  // Aceita formatos como +351 912 345 678, 351912345678 e 00351912345678.
  if (d.startsWith("351")) {
    return /^351[2-9]\d{8}$/.test(d) ? d : null;
  }

  // Portugal sem DDI: número nacional de 9 dígitos.
  // Aceita móveis e fixos: 912345678, 211234567, etc.
  if (/^[2-9]\d{8}$/.test(d)) {
    return "351" + d;
  }

  return null;
}

function normalizePhoneToE164Digits(input) {
  // Mantém a prioridade do Brasil para não mudar o comportamento dos leads atuais.
  return normalizeBRPhoneToE164DigitsStrict(input) || normalizePTPhoneToE164Digits(input);
}

function phoneSearchVariants(input) {
  const raw = digitsOnly(input);
  const normalized = normalizePhoneToE164Digits(input) || raw;
  const variants = new Set([raw, normalized].filter(Boolean));

  for (const d of Array.from(variants)) {
    if (d.startsWith("55")) variants.add(d.slice(2));
    if (d.startsWith("351")) variants.add(d.slice(3));
  }

  return Array.from(variants).filter(Boolean);
}

function extractPhoneRegion(input) {
  const d = normalizePhoneToE164Digits(input) || digitsOnly(input);
  if (!d) return "";

  // Brasil: DDD.
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d.slice(2, 4);

  // Portugal: prefixo/área após o DDI 351.
  // Ex.: 351912345678 => 91, 351211234567 => 21.
  if (d.startsWith("351") && d.length === 12) return d.slice(3, 5);

  // Compatibilidade com números BR antigos sem 55.
  if (d.length === 10 || d.length === 11) return d.slice(0, 2);

  // Portugal antigo sem 351.
  if (d.length === 9 && /^[2-9]/.test(d)) return d.slice(0, 2);

  return "";
}

// Nome antigo mantido por compatibilidade com o restante do sistema.
// Agora ele normaliza Brasil e Portugal para aceitar os leads da imersão internacional.
function normalizeBRPhoneToE164Digits(input) {
  return normalizePhoneToE164Digits(input);
}

module.exports = {
  normalizeBRPhoneToE164Digits,
  normalizePhoneToE164Digits,
  normalizePTPhoneToE164Digits,
  phoneSearchVariants,
  extractPhoneRegion,
};
