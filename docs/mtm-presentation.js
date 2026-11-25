/* Pure formatting and vocabulary for the unified MTM workspace. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MTMPresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MISSING = 'Não disponível';
  const LABELS = Object.freeze({
    quality: Object.freeze({
      HYPOTHETICAL: 'Hipótese explícita', INFORMED: 'Informado', ESTIMATED: 'Estimado',
      OBSERVED: 'Observado', REVISED: 'Revisado', RECONSTRUCTED: 'Reconstruído',
      MISSING: MISSING, UNKNOWN: 'Não declarada',
    }),
    status: Object.freeze({
      ready: 'Disponível', needs_input: 'Dados necessários', non_session: 'Sem sessão', outside_horizon: 'Fora do horizonte',
      event_coverage_uncertified: 'Cobertura do evento sem certificação',
      ESTIMATED_NET: 'Líquido estimado',
      missing_index: 'Índice exato indisponível', missing_price: 'PU indisponível',
      missing_metric: 'Métrica indisponível', blocked_policy: 'Bloqueado por política',
      missing_calendar: 'Calendário indisponível', metric_unavailable: 'Métrica indisponível',
      unit_mismatch: 'Unidade incompatível', cancelled: 'Cálculo cancelado', no_target: 'Sem meta',
      unattainable: 'Não atingível no domínio', no_root: 'Sem raiz', all_domain: 'Domínio inteiro atende',
      ambiguous_root: 'Mais de uma raiz', verification_failed: 'Verificação falhou',
      MET: 'Todas as metas atendidas', NOT_MET: 'Uma ou mais metas não atendidas',
      UNKNOWN: 'Sem dado suficiente para confirmar', NO_CONSTRAINTS: 'Sem metas ativas',
      SOLVED: 'Limite verificado', INFEASIBLE: 'Intervalo sem solução no domínio declarado',
      AMBIGUOUS: 'Monotonicidade insuficiente no domínio examinado', BLOCKED_POLICY: 'Bloqueado por política',
      VERIFICATION_FAILED: 'Verificação do limite falhou', NO_FINANCIAL_BOUND: 'As metas não definem um limite financeiro',
      BASE_NOT_MET: 'A meta já falha sem choque', FAILURE_FOUND: 'Falha verificada na grade',
      NO_FAILURE_IN_DOMAIN: 'Nenhuma falha na grade declarada', INCOMPLETE: 'Busca incompleta',
      FOUND: 'Primeira data verificada', NO_SOLUTION: 'Nenhuma data atende no domínio coberto',
      OUTSIDE_DOMAIN: 'Nenhuma sessão elegível no domínio', UNSUPPORTED: 'Busca não suportada para estas premissas',
      EXCLUDED: 'Excluída por regra', partial: 'Parcial', unavailable: 'Indisponível', ineligible: 'Não elegível',
    }),
    goal: Object.freeze({
      MET: 'Atende todas', NOT_MET: 'Não atende todas', UNKNOWN: 'Sem dado', NO_CONSTRAINTS: 'Sem metas',
    }),
    criterion: Object.freeze({ MET: 'Atendida', NOT_MET: 'Não atendida', UNKNOWN: MISSING }),
    profile: Object.freeze({
      SIMULATED_BUY_D1_SELL_D1: 'Compra D+1 · venda D+1',
      SIMULATED_BUY_D1_SELL_D0: 'Compra D+1 · venda D+0',
      EXPLICIT: 'Liquidações informadas',
    }),
    scenario: Object.freeze({
      BASE: 'Cenário-base', EXPLORANDO: 'Exploração', REFERENCIA: 'Referência',
    }),
  });

  function missing(value) {
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  }

  function formatMissing() {
    return MISSING;
  }

  function expandDecimal(value) {
    if (missing(value)) return null;
    let text = String(value).trim();
    if (text.length > 4096) return null;
    const sign = text.startsWith('-') ? '-' : '';
    if (/^[+-]/.test(text)) text = text.slice(1);
    if (!text) return null;

    const scientific = /^(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
    if (scientific) {
      let exponent;
      try { exponent = BigInt(scientific[3]); } catch (_) { return null; }
      if (exponent < -100n || exponent > 100n) return null;
      const places = Number(exponent);
      const digits = scientific[1] + (scientific[2] || '');
      const point = scientific[1].length + places;
      if (point <= 0) text = `0.${'0'.repeat(-point)}${digits}`;
      else if (point >= digits.length) text = `${digits}${'0'.repeat(point - digits.length)}`;
      else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    if (!/^(?:\d+)(?:\.\d*)?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
    const isZero = !/[1-9]/.test(normalizedWhole + fraction);
    return { negative: sign === '-' && !isZero, whole: normalizedWhole, fraction, isZero };
  }

  function formatNumber(value, decimals = 2) {
    if (missing(value)) return MISSING;
    if (!Number.isInteger(decimals) || decimals < -1 || decimals > 12) {
      throw new RangeError('Precisão decimal fora do limite.');
    }
    const parsed = expandDecimal(value);
    if (!parsed) return MISSING;
    let { whole, fraction } = parsed;
    if (decimals >= 0) {
      const scale = 10n ** BigInt(decimals);
      const retained = fraction.slice(0, decimals).padEnd(decimals, '0');
      let scaled = BigInt(whole) * scale + BigInt(retained || '0');
      if ((fraction[decimals] || '0') >= '5') scaled += 1n;
      whole = (scaled / scale).toString();
      fraction = decimals ? (scaled % scale).toString().padStart(decimals, '0') : '';
    } else fraction = fraction.replace(/0+$/, '');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const roundedZero = whole === '0' && !/[1-9]/.test(fraction);
    return `${parsed.negative && !roundedZero ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
  }

  function shiftDecimal(value, places) {
    if (!Number.isInteger(places) || Math.abs(places) > 100) throw new RangeError('Escala decimal fora do limite.');
    const parsed = expandDecimal(value);
    if (!parsed) return null;
    const digits = parsed.whole + parsed.fraction;
    const point = parsed.whole.length + places;
    let shifted;
    if (point <= 0) shifted = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) shifted = `${digits}${'0'.repeat(point - digits.length)}`;
    else shifted = `${digits.slice(0, point)}.${digits.slice(point)}`;
    const [whole, fraction = ''] = shifted.split('.');
    const cleanWhole = whole.replace(/^0+(?=\d)/, '') || '0';
    const cleanFraction = fraction.replace(/0+$/, '');
    const sign = parsed.negative ? '-' : '';
    return `${sign}${cleanWhole}${cleanFraction ? `.${cleanFraction}` : ''}`;
  }

  function formatCurrency(value, currency = 'BRL', decimals = 2) {
    let number = formatNumber(value, decimals);
    if (number === MISSING) return MISSING;
    const symbols = { BRL: 'R$', USD: 'US$', EUR: '€' };
    const code = String(currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('Código de moeda inválido.');
    const sign = number.startsWith('-') ? '-' : '';
    if (sign) number = number.slice(1);
    return `${sign}${symbols[code] || code} ${number}`;
  }

  function formatPercent(value, decimals = 2, suffix = '%') {
    const shifted = shiftDecimal(value, 2);
    return shifted === null ? MISSING : `${formatNumber(shifted, decimals)}${suffix}`;
  }

  function formatRate(value, decimals = 4) {
    const formatted = formatPercent(value, decimals, '%');
    return formatted === MISSING ? MISSING : `${formatted} a.a.`;
  }

  function formatPercentagePoints(value, decimals = 2) {
    const formatted = formatNumber(value, decimals);
    return formatted === MISSING ? MISSING : `${formatted} p.p.`;
  }

  function formatRatioDeltaAsPercentagePoints(value, decimals = 2) {
    const shifted = shiftDecimal(value, 2);
    return shifted === null ? MISSING : formatPercentagePoints(shifted, decimals);
  }

  function formatDate(value) {
    if (missing(value)) return MISSING;
    const text = String(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return MISSING;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12) return MISSING;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day < 1 || day > monthDays[month - 1]) return MISSING;
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  function formatDurationDays(value) {
    if (missing(value)) return MISSING;
    const text = String(value).trim();
    if (!/^-?(?:0|[1-9]\d*)$/.test(text)) return MISSING;
    const normalized = text === '-0' ? '0' : text;
    const singular = normalized === '1' || normalized === '-1';
    return `${normalized} ${singular ? 'dia' : 'dias'}`;
  }

  function labelEntry(kind, code) {
    if (missing(code)) return MISSING;
    const dictionary = LABELS[kind];
    if (!dictionary) return null;
    const key = String(code).trim();
    const normalized = ['quality', 'status', 'goal', 'criterion', 'scenario'].includes(kind) ? key.toUpperCase() : key;
    return Object.prototype.hasOwnProperty.call(dictionary, normalized)
      ? dictionary[normalized]
      : Object.prototype.hasOwnProperty.call(dictionary, key.toLowerCase()) ? dictionary[key.toLowerCase()] : null;
  }

  function label(kind, code) {
    const resolved = labelEntry(kind, code);
    if (resolved !== null) return resolved;
    return ({ quality: 'Qualidade não declarada', status: 'Estado sem descrição', profile: 'Perfil sem descrição', scenario: 'Estado do cenário indisponível', goal: 'Metas sem dado', criterion: MISSING })[kind] || 'Termo sem categoria';
  }

  function labelWithCode(kind, code) {
    const human = label(kind, code);
    if (human === MISSING) return human;
    return `${human} · código ${String(code)}`;
  }

  function decimalInfo(value) {
    const parsed = expandDecimal(value);
    if (!parsed) return null;
    const absolute = `${parsed.whole}${parsed.fraction ? `.${parsed.fraction}` : ''}`;
    return { negative: parsed.negative, zero: parsed.isZero, absolute };
  }

  function warningText(message) {
    const qualityNames = {
      informed: 'informada', observed: 'observada', reconstructed: 'reconstruída',
      hypothetical: 'hipotética', estimated: 'estimada', revised: 'revisada',
    };
    return String(message ?? MISSING)
      .replace(/Valor (informed|observed|reconstructed|hypothetical|estimated|revised) informado/gi,
        (_match, quality) => `Cotação ${qualityNames[quality.toLowerCase()] || quality}`)
      .replace(/hypothetical/gi, 'hipotético');
  }

  function grossDv01ViewModel(result) {
    if (!result || result.metric !== 'GROSS_DV01') return null;
    const available = String(result.status || '').toLowerCase() === 'available';
    const deltaInfo = decimalInfo(result.signed_unit_delta);
    return {
      title: 'DV01 bruto por reprecificação',
      status: available ? 'Disponível' : label('status', result.status || 'unavailable'),
      reasonCode: result.reason_code || null,
      instrument: result.instrument
        ? `${result.instrument.family} · ${result.instrument.instrument_id}` : MISSING,
      financialDate: formatDate(result.financial_date),
      nominal: result.nominal
        ? `${result.nominal.kind} ${formatNumber(result.nominal.value, 8)} (${label('quality', result.nominal.quality)})` : MISSING,
      shock: 'Taxa real +1 bp',
      baseRate: formatRate(result.base_rate, 4),
      shockedRate: formatRate(result.shocked_rate, 4),
      basePu: formatCurrency(result.pu_base, 'BRL', 2),
      shockedPu: formatCurrency(result.pu_shocked, 'BRL', 2),
      signedUnitDelta: formatCurrency(result.signed_unit_delta, 'BRL', 2),
      reductionIfYieldUp: formatCurrency(result.reduction_if_yield_up, 'BRL', 2),
      quantity: result.quantity == null ? MISSING : `${formatNumber(result.quantity, 2)} títulos`,
      grossPositionDelta: formatCurrency(result.gross_position_delta, 'BRL', 2),
      unit: result.pu_unit || 'BRL_PER_TITLE',
      isGross: result.is_gross === true,
      isAnalyticApproximation: result.is_analytic_approximation === true,
      isNetOfCostsOrTaxes: result.is_net_of_costs_or_taxes === true,
      zeroIsAvailable: available && deltaInfo?.zero === true,
      explanation: 'Variação bruta dos PUs publicados; não inclui custos, custódia ou impostos e não é aproximação de duration.',
    };
  }

  return Object.freeze({
    MISSING, formatMissing, formatNumber, formatCurrency, formatPercent, formatRate,
    formatPercentagePoints, formatRatioDeltaAsPercentagePoints, formatDate,
    formatDurationDays, shiftDecimal, label, labelWithCode, decimalInfo, warningText,
    grossDv01ViewModel,
  });
});
