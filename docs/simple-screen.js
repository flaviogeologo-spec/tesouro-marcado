/* Single-purpose screen. All financial results come from the existing workspace API. */
(function (root, factory) {
  const api = factory(root.MTMWorkspace || (typeof module === 'object' ? require('./mtm-workspace.js') : null), root.MTMPresentation, root.TesouroChartWorkbench || (typeof module === 'object' ? require('./chart-workbench.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root.document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (workspace, presentation, chartWorkbench) {
  'use strict';
  const DAY = 86400000;
  const COLORS = ['#23654c', '#438477', '#537b9d', '#817aa4', '#b48351', '#a45b55', '#42633a', '#3b6e83', '#9b695e', '#674f7c'];
  const METRICS = ['net_redemption', 'nominal_profit', 'nominal_return', 'real_return'];
  const METRIC_LABELS = { net_redemption: 'Valor a receber (R$)', nominal_profit: 'Lucro estimado (R$)', nominal_return: 'Rendimento total (%)', real_return: 'Ganho acima da inflação (%)' };
  const DEFAULT_BUDGET = '100000.00';
  const clone = value => JSON.parse(JSON.stringify(value));
  class Superseded extends Error {}

  function friendlyMessage(message) {
    const text = String(message || 'Não foi possível concluir. Tente novamente.').replace(/^(?:[A-Z][A-Z0-9_-]*:\s*)+/, '');
    if (/failed to fetch|networkerror|load failed/i.test(text)) return 'Não foi possível acessar o programa. Confira se a janela de execução continua aberta e tente novamente.';
    return text;
  }
  function suggestedRates(raw) {
    const value = workspace.parsePtDecimal(raw, 'Taxa da compra');
    if (value == null) throw new Error('Informe a taxa da compra para sugerir a janela.');
    const rounded = roundPercent(value);
    const minimum = workspace.exactDecimalDifference(rounded, '1'), maximum = workspace.exactDecimalDifference(rounded, '-1');
    ratesForWindow(minimum.replace('.', ','), maximum.replace('.', ','));
    return { minimum, maximum };
  }
  function selectedPeriod(range, outer) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    if (range.some(value => typeof value === 'number' && !Number.isFinite(value))) return null;
    const values = range.map(value => typeof value === 'number' ? new Date(value).toISOString().slice(0, 10) : String(value).slice(0, 10)).sort();
    if (!values.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value))) return null;
    const start = values[0] < outer.start ? outer.start : values[0], end = values[1] > outer.end ? outer.end : values[1];
    return start <= end ? { start, end } : null;
  }

  // This only hit-tests the drawn curves. Financial coordinates remain the exact
  // rate strings of those curves; the workspace API calculates the new points.
  function selectedGraphWindow(range, traces, outer, limits) {
    const period = selectedPeriod(range?.x, outer);
    if (!period || !Array.isArray(range?.y) || range.y.length !== 2 || !range.y.every(Number.isFinite)) return null;
    const [bottom, top] = [...range.y].sort((a, b) => a - b);
    const left = Date.parse(period.start), right = Date.parse(period.end);
    const rates = [];
    for (const trace of traces) {
      if (trace.meta?.kind !== 'simulation' || trace.visible === false || trace.visible === 'legendonly') continue;
      let previous = null, intersects = false;
      for (let i = 0; i < trace.x.length; i++) {
        const x = typeof trace.x[i] === 'number' ? trace.x[i] : Date.parse(trace.x[i]), y = trace.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) { previous = null; continue; }
        if (x >= left && x <= right && y >= bottom && y <= top) intersects = true;
        if (previous && x >= previous.x) {
          const from = Math.max(left, previous.x), to = Math.min(right, x);
          if (from <= to) {
            const at = value => x === previous.x ? y : previous.y + (y - previous.y) * (value - previous.x) / (x - previous.x);
            if (Math.max(at(from), at(to)) >= bottom && Math.min(at(from), at(to)) <= top) intersects = true;
          }
        }
        previous = { x, y };
      }
      if (intersects && workspace.compareSurfaceDecimal(trace.meta.rate, limits[0]) >= 0 && workspace.compareSurfaceDecimal(trace.meta.rate, limits.at(-1)) <= 0) rates.push(trace.meta.rate);
    }
    rates.sort(workspace.compareSurfaceDecimal);
    return rates.length ? { ...period, minimum: rates[0], maximum: rates.at(-1) } : null;
  }

  // Percent points are rounded as decimal strings, half away from zero.
  // A two-place percentage corresponds to four places in the engine's ratio.
  function roundPercent(value) {
    return workspace.shiftDecimal(workspace.parsePtDecimal(workspace.formatPtNumber(value, 2)), 0);
  }
  function roundRate(value) {
    return workspace.shiftDecimal(roundPercent(workspace.shiftDecimal(value, 2)), -2);
  }
  function ratesForWindow(minimum, maximum, entryRate = null, intervals = 4) {
    if (!Number.isInteger(intervals) || intervals < 1 || intervals > 20) throw new Error('Informe de 1 a 20 divisões entre as taxas.');
    const rawMin = workspace.parsePtDecimal(minimum, 'Taxa mínima'), rawMax = workspace.parsePtDecimal(maximum, 'Taxa máxima');
    if (rawMin == null || rawMax == null) throw new Error('Informe as taxas mínima e máxima.');
    const min = roundPercent(rawMin), max = roundPercent(rawMax);
    if (workspace.compareSurfaceDecimal(min, '-100') <= 0) throw new Error('A taxa mínima precisa ser maior que −100% ao ano.');
    if (workspace.compareSurfaceDecimal(min, max) > 0) throw new Error('A taxa mínima não pode superar a máxima.');
    const low = BigInt(workspace.shiftDecimal(min, 2)), high = BigInt(workspace.shiftDecimal(max, 2)), denominator = BigInt(intervals);
    const values = Array.from({ length: low === high ? 1 : intervals + 1 }, (_, i) => {
      const numerator = low * denominator + (high - low) * BigInt(i), magnitude = numerator < 0n ? -numerator : numerator;
      const ticks = (numerator < 0n ? -1n : 1n) * (magnitude / denominator + (2n * (magnitude % denominator) >= denominator ? 1n : 0n));
      return workspace.shiftDecimal(ticks.toString(), -4);
    });
    if (entryRate != null) {
      const entry = roundRate(entryRate);
      if (workspace.compareSurfaceDecimal(entry, values[0]) >= 0 && workspace.compareSurfaceDecimal(entry, values.at(-1)) <= 0) values.push(entry);
    }
    return values.sort(workspace.compareSurfaceDecimal).filter((v, i, a) => i === 0 || workspace.compareSurfaceDecimal(v, a[i - 1]) !== 0);
  }
  function effectiveRateDivisions(minimum, maximum, intervals) {
    return Math.max(1, ratesForWindow(minimum, maximum, null, intervals).length - 1);
  }
  function requiresRateRecalculation(input, view, referenceInput = null) {
    const changed = value => value != null && workspace.compareSurfaceDecimal(value, roundRate(value)) !== 0;
    const inputChanged = value => value && (value.entry_price?.mode === 'MANUAL_RATE' && changed(value.entry_price.annual_real_rate)
      || changed(value.assumptions?.inflation_projection?.annual_rate));
    const viewChanged = value => ['surface', 'overview_surface'].some(key => value?.[key]?.values?.some(changed));
    return Boolean(inputChanged(input) || inputChanged(referenceInput) || viewChanged(view) || viewChanged(view?.comparison?.view));
  }

  function dateSamples(start, end, limit = 15) {
    if (![15, 31, 61].includes(limit)) throw new Error('Resolução temporal inválida.');
    const first = Date.parse(start + 'T12:00:00Z'), last = Date.parse(end + 'T12:00:00Z');
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new Error('Informe um período válido, com início até o fim.');
    const days = Math.round((last - first) / DAY), count = Math.min(limit, days + 1);
    return Array.from({ length: count }, (_, i) => new Date(first + Math.round(days * i / Math.max(1, count - 1)) * DAY).toISOString().slice(0, 10));
  }

  async function commonDateSamples(bounds, limit, eligible) {
    const start = bounds.map(item => item.firstDate).sort().at(-1), end = bounds.map(item => item.lastDate).sort()[0];
    if (start > end) throw new Error('A e B não têm período comum para venda. Ajuste as compras ou o período de saída.');
    const dates = [];
    for (const requested of dateSamples(start, end, limit)) {
      let date = requested;
      // Advance together until every product accepts the very same order date.
      for (let attempt = 0; attempt < 14 && date <= end; attempt++) {
        const found = await Promise.all(bounds.map((_, i) => eligible(i, date, end)));
        if (found.some(value => value == null)) break;
        const next = [...found].sort().at(-1);
        if (found.every(value => value === date)) { dates.push(date); break; }
        date = next;
      }
    }
    const unique = [...new Set(dates)].sort();
    if (!unique.length) throw new Error('Não há datas de venda elegíveis em comum para A e B nesse período.');
    return unique;
  }

  function intervalDateSamples(start, end, step = 15) {
    const first = Date.parse(start + 'T12:00:00Z'), last = Date.parse(end + 'T12:00:00Z');
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last || !Number.isInteger(step) || step < 1 || step > 15) throw new Error('Intervalo temporal inválido.');
    const dates = [];
    for (let value = first; value <= last; value += step * DAY) {
      dates.push(new Date(value).toISOString().slice(0, 10));
      if (dates.length > 2048) throw new Error('O trecho excede o limite de datas calculadas. Selecione um período menor.');
    }
    if (dates.at(-1) !== end) dates.push(end);
    if (dates.length > 2048) throw new Error('O trecho excede o limite de datas calculadas. Selecione um período menor.');
    return dates;
  }

  async function convergingDateSamples(bounds, step, eligible) {
    const start = bounds.map(item => item.firstDate).sort().at(-1), end = bounds.map(item => item.lastDate).sort()[0];
    const shared = [];
    if (bounds.length > 1 && start <= end) {
      for (const requested of intervalDateSamples(start, end, step)) {
        let date = requested;
        for (let attempt = 0; attempt < 14 && date <= end; attempt++) {
          const found = await Promise.all(bounds.map((_, i) => eligible(i, date, end)));
          if (found.some(value => value == null)) break;
          const next = [...found].sort().at(-1);
          if (found.every(value => value === date)) { shared.push(date); break; }
          date = next;
        }
      }
    }
    const result = [];
    for (let i = 0; i < bounds.length; i++) {
      const own = intervalDateSamples(bounds[i].firstDate, bounds[i].lastDate, step);
      const outside = bounds.length === 1 || start > end ? own : own.filter(date => date < start || date > end);
      const dates = [...shared];
      for (let j = 0; j < outside.length; j += 2) {
        const found = await Promise.all(outside.slice(j, j + 2).map(date => eligible(i, date, date < start && start <= end ? workspace.addIsoDays(start, -1) : bounds[i].lastDate)));
        dates.push(...found.filter(Boolean));
      }
      const unique = [...new Set(dates)].sort();
      if (!unique.length) throw new Error('Não há saída elegível no período desse produto.');
      if (unique.length > 2048) throw new Error('O trecho excede o limite de datas calculadas. Selecione um período menor.');
      result.push(unique);
    }
    return result;
  }

  function metricValue(point, id) {
    const value = point?.metrics?.[id];
    return value && value.status === 'ready' && value.value != null ? value.value : null;
  }

  function comparisonRows(sources, date, metric) {
    const rates = sources.flatMap(item => item.record.surface?.values || item.record.points.map(point => point.coordinate.value))
      .sort(workspace.compareSurfaceDecimal).filter((rate, index, all) => index === 0 || workspace.compareSurfaceDecimal(rate, all[index - 1]) !== 0);
    return rates.map(rate => {
      const entries = sources.map(item => ({ ...item, point: item.record.points.find(point => point.order_date === date && workspace.compareSurfaceDecimal(point.coordinate.value, rate) === 0) || null }));
      const difference = id => {
        if (entries.length !== 2) return null;
        const a = metricValue(entries[0].point, id), b = metricValue(entries[1].point, id);
        return a == null || b == null ? null : workspace.exactDecimalDifference(b, a);
      };
      return { rate, entries, difference: difference(metric), return_difference: difference('nominal_return'), profit_difference: difference('nominal_profit') };
    });
  }

  function seriesFor(points, metric) {
    const dates = [...new Set(points.map(p => p.order_date))].sort();
    const rates = [...new Set(points.map(p => p.coordinate.value))].sort(workspace.compareSurfaceDecimal);
    const index = new Map();
    for (const point of points) {
      const key = point.order_date + '|' + workspace.shiftDecimal(point.coordinate.value, 0);
      if (!index.has(key)) index.set(key, point);
    }
    return rates.map(rate => ({ rate, points: dates.map(date => index.get(date + '|' + workspace.shiftDecimal(rate, 0)) || null), dates, metric }));
  }

  function capitalInput(mode, raw) {
    if (!['BUDGET', 'QUANTITY'].includes(mode)) throw new Error('Escolha valor disponível ou quantidade.');
    const value = mode === 'BUDGET' && !String(raw ?? '').trim() ? DEFAULT_BUDGET : workspace.parsePtDecimal(raw, mode === 'BUDGET' ? 'Valor disponível' : 'Quantidade');
    if (value == null || workspace.compareSurfaceDecimal(value, '0') <= 0) throw new Error('Informe um valor ou quantidade maior que zero.');
    if (mode === 'QUANTITY' && (value.split('.')[1] || '').replace(/0+$/, '').length > 2) throw new Error('A quantidade precisa ser múltipla de 0,01 título.');
    return { mode, value };
  }

  // Product limits remain distinct from the engine's broader mathematical horizon.
  function titleYearRange(family, purchaseDate, rendaYears = Array.from({ length: 66 }, (_, i) => 2000 + i)) {
    const minimum = Math.max(2000, /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate || '') ? Number(purchaseDate.slice(0, 4)) : 2000);
    const maximum = family === 'RENDA_PLUS' ? Math.min(2065, rendaYears.at(-1) ?? 2065) : 2050;
    const years = family === 'RENDA_PLUS' ? rendaYears.filter(year => year >= minimum && year <= maximum) : null;
    return { minimum: years?.[0] ?? minimum, maximum, years,
      suggestion: years ? String(years.find(year => year >= 2030) ?? years[0] ?? '') : minimum <= maximum ? String(Math.max(minimum, 2035)) : '' };
  }

  function titleYearError(value, range) {
    if (range.minimum > range.maximum || range.years?.length === 0) return range.years
      ? `Não há ano de início da renda disponível para essa compra. O limite atual do RendA+ é ${range.maximum}.`
      : `Não há vencimento IPCA+ disponível para esse ano de compra. O limite atual é ${range.maximum}.`;
    if (!String(value).trim()) return '';
    const year = Number(value);
    if (!Number.isInteger(year)) return 'Informe um ano inteiro para o título.';
    if (range.years ? !range.years.includes(year) : year < range.minimum || year > range.maximum) return range.years
      ? `Use um ano de início da renda entre ${range.minimum} e ${range.maximum}.`
      : `Use um ano de vencimento entre ${range.minimum} e ${range.maximum}.`;
    return '';
  }

  function fixedInstrument(family) {
    const years = { IPCA_PRINCIPAL: 2050, RENDA_PLUS: 2065 };
    if (!Object.hasOwn(years, family)) throw new Error('Para uma nova simulação, escolha Tesouro IPCA+ 2050 ou Tesouro RendA+ 2065. O registro aberto mantém seu título original.');
    return { family, series_year: years[family] };
  }

  function productOptions(recorded = null) {
    const options = [
      { value: 'IPCA_PRINCIPAL', label: 'Tesouro IPCA+ 2050' },
      { value: 'RENDA_PLUS', label: 'Tesouro RendA+ 2065' }
    ];
    if (recorded && fixedInstrument(recorded.family).series_year !== recorded.series_year) {
      options.unshift({ value: `saved:${recorded.family}:${recorded.series_year}`,
        label: `${recorded.family === 'RENDA_PLUS' ? 'Tesouro RendA+' : 'Tesouro IPCA+'} ${recorded.series_year} · registro salvo`, disabled: true });
    }
    return options;
  }

  function compactSurface(response) {
    const reasons = [];
    return { ...(response.result?.overlay_support ? { overlay_support: clone(response.result.overlay_support) } : {}), points: (response.result?.points || []).map(source => {
      const point = { ...Object.fromEntries(['identity', 'order_date', 'settlement_date', 'coordinate', 'value', 'status', 'quality', 'reason'].map(key => [key, source[key] ?? null])),
        metrics: Object.fromEntries(METRICS.map(metric => [metric, { value: source.metrics?.[metric]?.value ?? null, status: source.metrics?.[metric]?.status ?? null }])) };
      if (Object.hasOwn(source, 'conversion_basis')) point.conversion_basis = clone(source.conversion_basis);
      if (point.reason != null) { if (!reasons.includes(point.reason)) reasons.push(point.reason); point.reason = reasons.indexOf(point.reason); }
      return point;
    }), reasons,
      coverage: clone(response.coverage || {}), source_versions: clone(response.source_versions || {}), engine_manifest: clone(response.engine_manifest || {}) };
  }

  function packSurface(response) {
    const source = compactSurface(response), packed = { encoding: 'grid-v2', dates: [], settlements: [], rates: [], statuses: [], qualities: [], metric_statuses: [], reasons: source.reasons, rows: [], coverage: source.coverage, source_versions: source.source_versions, engine_manifest: source.engine_manifest };
    if (source.overlay_support) packed.overlay_support = packOverlaySupport(source.overlay_support);
    const withBasis = source.points.some(point => Object.hasOwn(point, 'conversion_basis'));
    if (withBasis) packed.conversion_bases = [];
    const index = (key, value) => { let i = packed[key].findIndex(item => JSON.stringify(item) === JSON.stringify(value)); if (i < 0) { i = packed[key].length; packed[key].push(value); } return i; };
    packed.rows = source.points.map(point => [index('dates', point.order_date), index('settlements', point.settlement_date), index('rates', point.coordinate.value), index('statuses', point.status), index('qualities', point.quality), point.reason,
      ...METRICS.map(metric => point.metrics[metric].value), METRICS.map(metric => index('metric_statuses', point.metrics[metric].status)),
      ...(withBasis ? [index('conversion_bases', point.conversion_basis ?? null)] : [])]);
    return packed;
  }

  function unpackSurface(cache) {
    if (cache == null) return { points: [], reasons: [], coverage: {} };
    if (cache.encoding !== 'grid-v2') return cache;
    return { ...cache, ...(cache.overlay_support ? { overlay_support: unpackOverlaySupport(cache.overlay_support) } : {}), points: cache.rows.map(row => ({ identity: `${cache.dates[row[0]]}|${cache.rates[row[2]]}`, order_date: cache.dates[row[0]], settlement_date: cache.settlements[row[1]], coordinate: { value: cache.rates[row[2]], unit: 'ratio' }, ...(cache.conversion_bases ? { conversion_basis: cache.conversion_bases[row[11]] } : {}), value: row[6], status: cache.statuses[row[3]], quality: cache.qualities[row[4]], reason: row[5],
      metrics: Object.fromEntries(METRICS.map((metric, index) => [metric, { value: row[6 + index], status: cache.metric_statuses[row[10][index]] }])) })) };
  }

  function packOverlaySupport(support) {
    const bases = [], rows = support.map(row => {
      const basis = row.conversion_basis;
      const base = basis ? Object.fromEntries(['initial_outflow', 'purchase_settlement_date', 'quality'].map(key => [key, basis[key]])) : null;
      let i = bases.findIndex(value => JSON.stringify(value) === JSON.stringify(base));
      if (i < 0) { i = bases.length; bases.push(base); }
      return [row.order_date, row.settlement_date, i, basis?.inflation_factor ?? null, basis?.inflation_quality ?? 'MISSING'];
    });
    return { encoding: 'reference-v1', bases, rows };
  }
  function unpackOverlaySupport(support) {
    return support.rows.map(row => ({ order_date: row[0], settlement_date: row[1],
      conversion_basis: support.bases[row[2]] ? { ...support.bases[row[2]], inflation_factor: row[3], inflation_quality: row[4] } : null }));
  }

  function snapshotView(record, metric, readingDate) {
    const overview = record.overview || record;
    return { version: 2, ...(record.dateDensity ? { date_density: record.dateDensity, aligned_dates: record.alignedDates === true } : {}), ...(record.dateStepDays ? { date_step_days: record.dateStepDays, overview_date_step_days: overview.dateStepDays, converged_dates: record.convergedDates === true } : {}), divisions: record.divisions || 4, overview_divisions: overview.divisions || 4, period: { start: record.input.analysis_context.timeline.start, end: record.input.analysis_context.timeline.end },
      surface: clone(record.surface), overview_surface: clone(overview.surface), metric, reading_date: readingDate,
      ...(record.outsidePeriod ? { outside_period: true, outside_reason: record.outsideReason || 'NO_SESSION' } : {}), ...(record.outsideOriginal ? { outside_original: true } : {}), result: record.outsidePeriod ? null : packSurface(record.response), overview_result: record.overview && !overview.outsidePeriod ? packSurface(overview.response) : null };
  }

  function goalSummary(record, goal) {
    return seriesFor(record.points, goal.metric).map(series => {
      const valid = series.points.filter(point => metricValue(point, goal.metric) != null);
      const hit = valid.find(point => workspace.compareSurfaceDecimal(metricValue(point, goal.metric), goal.value) >= 0);
      return { rate: series.rate, first: hit?.order_date || null, partial: valid.length !== series.points.length };
    });
  }

  function overlaySupport(record) { return record.response?.result?.overlay_support || []; }
  function overlayDates(record) {
    const support = overlaySupport(record);
    return [...new Set((support.length ? support : record.points).map(point => point.order_date))].sort();
  }
  // Match the engine's 28-significant-digit Decimal quotient, including ties.
  function indexFactor(final, initial) {
    const value = divideFraction(fraction(final), fraction(initial));
    if (value.n <= 0n) return null;
    let exponent = value.n.toString().length - value.d.toString().length;
    if (exponent >= 0 ? value.n < value.d * 10n ** BigInt(exponent) : value.n * 10n ** BigInt(-exponent) < value.d) exponent--;
    const scale = 27 - exponent, n = scale >= 0 ? value.n * 10n ** BigInt(scale) : value.n;
    const d = scale >= 0 ? value.d : value.d * 10n ** BigInt(-scale);
    let q = n / d;
    const remainder = n % d;
    if (remainder * 2n > d || (remainder * 2n === d && q % 2n)) q++;
    return workspace.shiftDecimal(q.toString(), -scale);
  }
  function basisFromResolution(resolved, input) {
    if (input.data?.intermediate_paid_costs?.length) return null;
    const sizing = resolved?.purchase_sizing, purchase = resolved?.dates?.purchase?.settlement_date;
    const sale = resolved?.dates?.sale?.settlement_date;
    if (sizing?.status !== 'available' || !(Number(sizing.initial_outflow?.value) > 0) || !purchase || !sale) return null;
    // Explicit dated levels take precedence, just as in the financial engine.
    const levels = new Map((resolved.resolved_price_index_levels || []).filter(row => row.status === 'available' && Number(row.value) > 0).map(row => [row.reference_date, row.value]));
    for (const row of input.data?.price_index_levels || []) if (Number(row.value) > 0) levels.set(row.date, row.value);
    return { initial_outflow: sizing.initial_outflow.value, purchase_settlement_date: purchase,
      inflation_factor: levels.has(purchase) && levels.has(sale) ? indexFactor(levels.get(sale), levels.get(purchase)) : null };
  }
  function needsOverlayRecovery(record) {
    return overlayDates(record).some(date => !conversionBases(record, date).some(basis => Number(basis.initial_outflow) > 0 && Number(basis.inflation_factor) > 0));
  }
  async function recoverOverlayBases(record, resolve) {
    if (record.overlayRecoveryPromise) return record.overlayRecoveryPromise;
    if (!needsOverlayRecovery(record) || !record.input?.capital || !record.input?.entry_price) return;
    if (record.stored && record.compatibility?.state !== 'EXACT_SNAPSHOT_AVAILABLE') return;
    record.overlayRecoveryPromise = (async () => {
      record.recoveredBases ||= {};
      const dates = overlayDates(record).filter(date => !conversionBases(record, date).some(basis => Number(basis.initial_outflow) > 0 && Number(basis.inflation_factor) > 0));
      // Resolve dates, purchase sizing and indexes only; never replace sale values.
      for (let i = 0; i < dates.length; i += 2) {
        const completed = await Promise.allSettled(dates.slice(i, i + 2).map(async date => {
        const input = { ...clone(record.input), sale_date: date, exit_price: { mode: 'MANUAL_PU', pu: '1' },
          analysis_context: { kind: 'OPERATION', timeline: { mode: 'POINT' } } };
        const resolved = await resolve(input);
        const basis = basisFromResolution(resolved, input);
        if (basis) record.recoveredBases[date] = basis;
        }));
        const failed = completed.find(item => item.status === 'rejected');
        if (failed) throw failed.reason;
      }
    })().catch(error => { record.overlayRecoveryPromise = null; throw error; });
    return record.overlayRecoveryPromise;
  }
  function conversionBases(record, date) {
    if (record.recoveredBases?.[date]) return [record.recoveredBases[date]];
    const support = overlaySupport(record).find(row => row.order_date === date);
    if (support?.conversion_basis) return [support.conversion_basis];
    return record.points.filter(point => point.order_date === date).flatMap(point => {
      if (point.conversion_basis) return [point.conversion_basis];
      // Old photographs can still convert nominal metrics with the exact
      // two-flow identity. Inflation is never inferred from rounded returns.
      const net = metricValue(point, 'net_redemption'), profit = metricValue(point, 'nominal_profit');
      if (net == null || profit == null || metricValue(point, 'nominal_return') == null) return [];
      return [{ initial_outflow: workspace.exactDecimalDifference(net, profit), inflation_factor: null, legacy: true }];
    });
  }
  function fraction(raw) {
    const text = workspace.shiftDecimal(String(raw), 0), [whole, decimal = ''] = text.split('.');
    return { n: BigInt(whole + decimal), d: 10n ** BigInt(decimal.length) };
  }
  function rational(n, d) {
    if (!d) throw new Error('Base de conversão indisponível.');
    if (d < 0n) { n = -n; d = -d; }
    let a = n < 0n ? -n : n, b = d;
    while (b) [a, b] = [b, a % b];
    return { n: n / a, d: d / a };
  }
  const addFraction = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
  const multiplyFraction = (a, b) => rational(a.n * b.n, a.d * b.d);
  const divideFraction = (a, b) => rational(a.n * b.d, a.d * b.n);
  function goalEquivalent(goal, metric, basis) {
    const value = fraction(goal.value), one = fraction('1');
    if (goal.metric === metric) return value;
    if (!basis || !(Number(basis.initial_outflow) > 0)) return null;
    const capital = fraction(basis.initial_outflow);
    const real = goal.metric === 'real_return' || metric === 'real_return';
    if (real && !(Number(basis.inflation_factor) > 0)) return null;
    const inflation = real ? fraction(basis.inflation_factor) : one;
    const nominal = goal.metric === 'net_redemption' ? value : goal.metric === 'nominal_profit' ? addFraction(capital, value)
      : multiplyFraction(multiplyFraction(capital, goal.metric === 'real_return' ? inflation : one), addFraction(one, value));
    return metric === 'net_redemption' ? nominal : metric === 'nominal_profit' ? addFraction(nominal, { n: -capital.n, d: capital.d })
      : addFraction(divideFraction(nominal, multiplyFraction(capital, metric === 'real_return' ? inflation : one)), fraction('-1'));
  }
  function participatesAt(record, date, metric) {
    const support = overlaySupport(record);
    const dates = (support.length ? support : record.points.filter(point => metricValue(point, metric) != null)).map(point => point.order_date).sort();
    return dates.length > 0 && dates[0] <= date && date <= dates.at(-1);
  }
  function crossGoalValues(sources, goal, metric) {
    const dates = [...new Set(sources.flatMap(source => overlayDates(source.record)))].sort();
    let differing = false;
    const values = dates.map(date => {
      if (goal.metric === metric) return Number(goal.value) * (metric.endsWith('return') ? 100 : 1);
      const candidates = sources.map(source => conversionBases(source.record, date).map(basis => goalEquivalent(goal, metric, basis)));
      const all = candidates.flat().filter(Boolean), first = all[0];
      if (!first) return null;
      if (all.some(value => first.n * value.d !== value.n * first.d)) differing = true;
      if (candidates.some((items, index) => items.some(value => !value) || (!items.length && participatesAt(sources[index].record, date, metric)))) return null;
      const value = Number(first.n) / Number(first.d) * (metric.endsWith('return') ? 100 : 1);
      return Number.isFinite(value) ? value : null;
    });
    return { dates, values, differing };
  }
  function crossGoalPresentation(goal, metric, range, sources) {
    if (!goal) return { state: 'none', visible: false, message: '', dates: [], values: [] };
    const converted = crossGoalValues(sources, goal, metric);
    if (goal.metric === metric) return { ...converted, ...goalPresentation(goal, metric, range) };
    const original = `Meta de ${METRIC_LABELS[goal.metric]}: ${valueText(goal.value, goal.metric)}.`;
    if (converted.differing) return { ...converted, state: 'different_projections', visible: false,
      message: `${original} Meta desativada neste gráfico: a conversão exige valores diferentes para as projeções exibidas. Não há uma meta equivalente única. Exiba somente uma simulação compatível ou consulte a medida original.` };
    if (!range || !sources.length) return { ...converted, state: 'no_data', visible: false, message: `${original} Não há pontos disponíveis nesta exibição. Exiba A/B ou simule novamente.` };
    const valid = converted.values.filter(value => value != null);
    if (!valid.length) return { ...converted, state: 'missing_basis', visible: false,
      message: `${original} Meta desativada nesta exibição: não foi possível recuperar as bases de conversão deste resultado com as entradas e fontes registradas. Os campos preenchidos foram preservados. Consulte a medida original; se as fontes antigas não estiverem disponíveis, simule novamente para atualizar o resultado.` };
    const low = Math.min(...valid), high = Math.max(...valid);
    const rangeText = goalPresentation({ metric, value: String(metric.endsWith('return') ? range[0] / 100 : range[0]) }, metric, range).rangeText;
    const outside = high < range[0] || low > range[1];
    const partial = converted.values.some(value => value == null || value < range[0] || value > range[1]);
    return { ...converted, state: outside ? high < range[0] ? 'below_range' : 'above_range' : partial ? 'partial' : 'visible', visible: !outside, rangeText,
      message: `${original} Equivalente em ${METRIC_LABELS[metric]}. ${outside ? 'A linha não é exibida para preservar a escala.' : partial ? 'Linha equivalente parcialmente exibida: trechos fora da faixa são recortados; dados ausentes ficam como lacunas.' : 'Linha pontilhada equivalente identificada na legenda.'} ${rangeText} A consulta da meta usa sua medida original, somente nos pontos calculados.` };
  }
  function referenceValues(record, reference, metric) {
    const dates = overlayDates(record);
    let base = null;
    const values = dates.map(date => {
      const bases = conversionBases(record, date), basis = bases[0];
      if (!basis || !(Number(basis.initial_outflow) > 0) || bases.some(item => workspace.compareSurfaceDecimal(item.initial_outflow, basis.initial_outflow) !== 0)) return null;
      const capital = Number(basis.initial_outflow); base ??= capital;
      const years = (Date.parse(date + 'T12:00:00Z') - Date.parse(record.input.purchase_date + 'T12:00:00Z')) / DAY / 365;
      const nominal = reference.mode === 'PERCENT' ? capital * Math.pow(1 + Number(reference.value), years) : capital + Number(reference.value) * years;
      if (!Number.isFinite(nominal)) return null;
      if (metric === 'real_return' && (!(Number(basis.inflation_factor) > 0) || bases.some(item => item.inflation_factor == null || workspace.compareSurfaceDecimal(item.inflation_factor, basis.inflation_factor) !== 0))) return null;
      const value = metric === 'net_redemption' ? nominal : metric === 'nominal_profit' ? nominal - capital
        : (nominal / capital / (metric === 'real_return' ? Number(basis.inflation_factor) : 1) - 1) * 100;
      return Number.isFinite(value) ? value : null;
    });
    return base == null ? null : { base, dates, values, partial: values.some(value => value == null) };
  }

  function mergeSurfaces(responses, surface) {
    if (responses.length === 1) return responses[0];
    const unavailable = responses.find(response => !response.result?.points?.length);
    if (unavailable) return unavailable;
    const merged = clone(responses[0]), domain = merged.coverage.domain;
    merged.result.points = responses.flatMap(response => response.result?.points || []).sort((a, b) => a.order_date.localeCompare(b.order_date) || workspace.compareSurfaceDecimal(a.coordinate.value, b.coordinate.value));
    for (const key of ['evaluated_points', 'new_evaluations', 'reused_points', 'requested_points', 'resolved_points']) merged.coverage[key] = responses.reduce((sum, response) => sum + (response.coverage[key] || 0), 0);
    merged.coverage.complete = responses.every(response => response.coverage.complete);
    merged.coverage.status = merged.coverage.complete ? 'complete' : 'partial';
    merged.coverage.method = 'explicit_rate_batches'; merged.coverage.batch_count = responses.length;
    merged.coverage.omitted_values = []; domain.candidate_values = clone(surface.values); domain.sampled_values = clone(surface.values);
    merged.coverage.resolution.values = surface.values.length;
    if (surface.order_dates.length > 15) {
      merged.coverage.method = 'explicit_grid_batches';
      domain.candidate_order_dates = clone(surface.order_dates); domain.sampled_order_dates = clone(surface.order_dates);
      domain.date_range = { start: surface.order_dates[0], end: surface.order_dates.at(-1) };
      merged.coverage.resolution.dates = surface.order_dates.length;
      merged.coverage.omitted_dates = []; merged.coverage.omitted_ranges = [];
    }
    const support = new Map(responses.flatMap(response => response.result?.overlay_support || []).map(row => [row.order_date, row]));
    let selected = surface.order_dates.filter(date => support.has(date));
    if (selected.length > 121) selected = Array.from({ length: 121 }, (_, i) => selected[Math.floor(i * (selected.length - 1) / 120)]);
    const extra = [...support.keys()].filter(date => !selected.includes(date)).sort(), room = 121 - selected.length;
    const sampled = extra.length <= room ? extra : Array.from({ length: room }, (_, i) => extra[Math.floor(i * (extra.length - 1) / Math.max(1, room - 1))]);
    if (support.size) merged.result.overlay_support = [...new Set([...selected, ...sampled])].sort().map(date => support.get(date));
    return merged;
  }

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dateText = value => String(value).split('-').reverse().join('/');
  const rateLabel = rate => `IPCA + ${workspace.formatPtNumber(workspace.shiftDecimal(rate, 2), -1)}%`;
  const valueText = (value, metric) => value == null ? 'Indisponível' : metric.endsWith('return')
    ? workspace.formatPtNumber(workspace.shiftDecimal(value, 2), 2) + '%'
    : 'R$ ' + workspace.formatPtNumber(value, 2);
  function simulationFacts(input, surface, period) {
    const original = input.analysis_context.timeline, assumptions = input.assumptions || {}, entry = input.entry_price;
    const facts = [['Título', `${input.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${input.instrument.series_year}`],
      ['Data da compra', dateText(input.purchase_date)], [input.capital.mode === 'QUANTITY' ? 'Quantidade de títulos' : 'Valor disponível', input.capital.mode === 'QUANTITY' ? workspace.formatPtNumber(input.capital.value, 2) : valueText(input.capital.value, 'net_redemption')]];
    if (entry) facts.push(['Condição da compra', entry.mode === 'MANUAL_PU' ? valueText(entry.pu, 'net_redemption') + ' por título' : rateLabel(entry.annual_real_rate) + ' a.a.']);
    facts.push(['Período original', `${dateText(original.start)} a ${dateText(original.end)}`]);
    if (period && (period.start !== original.start || period.end !== original.end)) facts.push(['Trecho exibido', `${dateText(period.start)} a ${dateText(period.end)}`]);
    if (surface?.values?.length) facts.push(['Taxas de saída', surface.values.map(rateLabel).join(' · ')]);
    facts.push(['Inflação (IPCA) futura', assumptions.inflation_projection ? valueText(assumptions.inflation_projection.annual_rate, 'nominal_return') + ' a.a.' : 'Sem hipótese declarada'],
      ['Custo da instituição na compra', valueText(assumptions.entry_fee?.fixed_brl ?? '0', 'net_redemption')],
      ['Custo da instituição na venda', valueText(assumptions.exit_fee_brl ?? '0', 'net_redemption')]);
    return facts;
  }
  function graphScale(traces) {
    const values = traces.flatMap(trace => trace.y || []).filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!values.length) return null;
    const low = Math.min(...values), high = Math.max(...values), padding = high > low ? (high - low) * .07 : Math.abs(low) * .07 || 1;
    return [low - padding, high + padding];
  }
  function goalPresentation(goal, metric, range) {
    if (!goal) return { state: 'none', message: '', visible: false };
    const label = METRIC_LABELS[goal.metric], value = valueText(goal.value, goal.metric);
    if (goal.metric !== metric) return { state: 'different_metric', visible: false, message: `Meta de ${label}: ${value}. Esta exibição mostra ${METRIC_LABELS[metric]} e não traz a medida da meta. A linha não está exibida; escolha a medida da meta.` };
    if (!range) return { state: 'no_data', visible: false, message: `Meta: ${value}. Esta exibição não traz pontos disponíveis dessa medida. Exiba A/B ou simule para consultar a linha da meta.` };
    const number = Number(goal.value) * (metric.endsWith('return') ? 100 : 1);
    const formatted = range.map(value => (metric.endsWith('return') ? '' : 'R$ ') + value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (metric.endsWith('return') ? '%' : ''));
    const rangeText = `Faixa do gráfico: ${formatted[0]} a ${formatted[1]}.`;
    if (number < range[0] || number > range[1]) return { state: number < range[0] ? 'below_range' : 'above_range', visible: false, rangeText,
      message: `Meta de ${label}: ${value}, ${number < range[0] ? 'abaixo' : 'acima'} da faixa do gráfico. A linha não é exibida para preservar a escala. ${rangeText} A consulta dos pontos que atingem a meta continua disponível.` };
    return { state: 'visible', visible: true, rangeText, message: `Meta de ${label}: ${value}. Linha pontilhada identificada na legenda. ${rangeText}` };
  }
  function overlayGraphScale(traces, goal, metric, sources, fit = true) {
    if (!fit || !goal) return graphScale(traces);
    const converted = crossGoalValues(sources, goal, metric);
    return graphScale(converted.differing ? traces : [...traces, { y: converted.values }]);
  }
  function hatchAreas(traces, range, settings = {}) {
    if (!range) return [];
    const areas = [];
    for (const trace of traces) {
      const kind = trace.meta?.kind;
      if (trace.visible !== true || !(kind === 'goal' ? settings.goal : kind === 'projection' && settings.reference)) continue;
      let segment = [];
      const finish = () => {
        if (segment.length > 1) {
          const color = kind === 'goal' ? '177,124,41' : trace.meta.scenario === 'B' ? '40,118,87' : '85,72,59';
          areas.push({ type: 'scatter', mode: 'lines', x: [...segment.map(p => p[0]), segment.at(-1)[0], segment[0][0]],
            y: [...segment.map(p => p[1]), range[0], range[0]], fill: 'toself',
            fillcolor: `rgba(${color},0.035)`, fillpattern: { shape: trace.meta.scenario === 'B' ? '\\' : '/',
              size: 9, solidity: .12, fgcolor: `rgba(${color},0.24)`, fgopacity: .45, bgcolor: `rgba(${color},0.025)`, fillmode: 'overlay' },
            line: { width: 0 }, hoverinfo: 'skip', showlegend: false, visible: true,
            meta: { kind: 'overlay_fill', owner: kind, scenario: trace.meta.scenario || null }, legendgroup: kind === 'goal' ? 'goal' : 'projection:' + trace.meta.scenario, name: trace.name });
        }
        segment = [];
      };
      (trace.x || []).forEach((date, i) => { if (Number.isFinite(trace.y[i])) segment.push([date, trace.y[i]]); else finish(); });
      finish();
    }
    return areas;
  }
  const legendKey = trace => trace.meta?.kind === 'overlay_fill' ? trace.meta.owner === 'goal' ? 'goal' : `projection:${trace.meta.scenario}` : trace.meta?.kind === 'goal' ? 'goal' : trace.meta?.kind === 'projection' ? `projection:${trace.meta.scenario}`
    : trace.meta?.kind === 'simulation' ? `simulation:${trace.meta.scenario}:${workspace.shiftDecimal(trace.meta.rate, 0)}` : null;
  function outsideMessage(record) {
    return { MATURITY: 'o IPCA+ já venceu ou a venda liquidaria no vencimento ou depois dele', INCOME: 'o RendA+ já atingiu o início da renda ou a venda liquidaria após esse limite',
      LOCKUP: 'a carência do RendA+ ainda não terminou', SETTLEMENT: 'a compra ainda não permite uma venda liquidada neste período',
      NO_SESSION: 'não há sessão de venda elegível neste intervalo' }[record.outsideReason] || 'não há datas de venda elegíveis neste intervalo';
  }
  function viewSources(input, view, recoveredBases = {}) {
    return [['A', input, view], ...(view.comparison ? [['B', view.comparison.input, view.comparison.view]] : [])].map(([id, value, item]) => {
      const result = unpackSurface(item.result);
      return { id, record: { input: value, surface: item.surface, outsidePeriod: item.outside_period === true, outsideOriginal: item.outside_original === true,
        outsideReason: item.outside_reason, response: { result }, points: result.points, recoveredBases: recoveredBases[id] } };
    });
  }
  function restoredView(input, view) {
    const original = input.analysis_context.timeline;
    if (!view.overview_result && !view.comparison?.view.overview_result && view.period.start === original.start && view.period.end === original.end) return null;
    const restore = (value, purchase) => ({ ...clone(value), period: { start: purchase.analysis_context.timeline.start, end: purchase.analysis_context.timeline.end },
      surface: clone(value.overview_surface), result: value.outside_original ? null : clone(overviewCache(value)), overview_result: null,
      divisions: value.overview_divisions, date_step_days: value.overview_date_step_days,
      outside_period: value.outside_original === true, ...(value.outside_original ? {} : { outside_reason: undefined }) });
    const result = restore(view, input);
    if (view.comparison) result.comparison = { input: clone(view.comparison.input), view: restore(view.comparison.view, view.comparison.input) };
    return result;
  }
  function overviewCache(view) {
    return view.overview_result || (!view.outside_period && JSON.stringify(view.surface) === JSON.stringify(view.overview_surface) ? view.result : null);
  }
  // Shared by the live screen and the offline overview. No prices are computed here.
  function chartPresentation(sources, metric, overlays = {}, options = {}) {
    const visible = sources.filter(item => options.visibility?.[item.id.toLowerCase()] !== false), active = visible.filter(item => !item.record.outsidePeriod);
    const ratio = metric.endsWith('return'), compared = sources.length > 1;
    const allRates = [...new Set(sources.flatMap(item => item.record.surface.values))].sort(workspace.compareSurfaceDecimal);
    const color = rate => { const i = allRates.findIndex(value => workspace.compareSurfaceDecimal(value, rate) === 0); return (allRates.length === 3 ? ['#3769aa', '#206c50', '#a65c22'][i] : COLORS[i]) || `hsl(${(i * 43 + 125) % 360},40%,42%)`; };
    const groups = visible.flatMap(item => seriesFor(item.record.points, metric).map(group => ({ ...group, id: item.id })));
    const traces = groups.map((group, index) => ({ type: 'scatter', mode: 'lines+markers', meta: { kind: 'simulation', rate: group.rate, scenario: group.id },
      name: `${compared ? group.id + ' · ' : ''}${rateLabel(group.rate)}`, x: group.dates,
      y: group.points.map(point => { const value = metricValue(point, metric); return value == null ? null : Number(value) * (ratio ? 100 : 1); }),
      connectgaps: false, customdata: group.points.map(point => point ? [point.identity, dateText(point.order_date), valueText(metricValue(point, metric), metric), group.id, `${compared ? group.id + ' · ' : ''}${rateLabel(group.rate)}`] : ['', '', 'Indisponível', group.id, rateLabel(group.rate)]),
      visible: true, line: { color: color(group.rate), width: 2, dash: compared ? (group.id === 'A' ? 'solid' : 'dash') : index < 6 ? 'solid' : 'dash' }, marker: { size: 4, symbol: group.id === 'B' ? 'diamond' : 'circle-open' },
      selected: { marker: { opacity: 1 } }, unselected: { marker: { opacity: 1 } }, hovertemplate: '%{customdata[1]}<br>%{customdata[2]}<extra>%{customdata[4]}</extra>' }));
    let missingReference = false;
    if (overlays.reference) for (const item of active) {
      const ref = referenceValues(item.record, overlays.reference, metric);
      missingReference ||= !ref || ref.partial;
      traces.push({ type: 'scatter', mode: ref?.dates.length === 1 ? 'markers' : 'lines', marker: { size: 8 }, name: `Projeção ${item.id}${!ref || ref.values.every(value => value == null) ? ' · indisponível' : ''}`,
        meta: { kind: 'projection', scenario: item.id }, legendgroup: 'projection:' + item.id, x: ref?.dates || [], y: ref?.values || [], connectgaps: false,
        visible: ref?.values.some(value => value != null) ? true : 'legendonly', line: { color: item.id === 'A' ? '#55483b' : '#88735d', width: 2, dash: 'dot' },
        hovertemplate: `%{x|%d/%m/%Y}<br>%{y:,.2f}${ratio ? '%' : ' R$'}<extra>%{fullData.name} · hipótese líquida${metric === 'real_return' ? ' · inflação da simulação' : ''}</extra>` });
    }
    const range = overlayGraphScale(traces, overlays.goal, metric, active, options.fit_overlays !== false), goalInfo = crossGoalPresentation(overlays.goal, metric, range, active);
    if (overlays.goal) {
      const label = goalInfo.visible ? `Meta${overlays.goal.metric !== metric ? ' · equivalente' : ''} · ${valueText(overlays.goal.value, overlays.goal.metric)}`
        : ['different_projections', 'missing_basis'].includes(goalInfo.state) ? 'Meta · desativada' : goalInfo.state === 'no_data' ? 'Meta · sem dados' : 'Meta · fora da faixa';
      traces.push({ type: 'scatter', mode: goalInfo.dates.length === 1 ? 'markers' : 'lines', marker: { size: 9, symbol: 'diamond' }, name: label, legendgroup: 'goal',
        meta: { kind: 'goal', state: goalInfo.state, original: clone(overlays.goal) }, x: goalInfo.dates, y: goalInfo.visible ? goalInfo.values : goalInfo.dates.map(() => null), connectgaps: false,
        visible: goalInfo.visible ? true : 'legendonly', showlegend: true, line: { color: '#b17c29', width: 2, dash: 'dashdot' },
        hovertemplate: `${METRIC_LABELS[overlays.goal.metric]}: ${valueText(overlays.goal.value, overlays.goal.metric)}<br>%{x|%d/%m/%Y}<br>Equivalente: %{y:,.2f}${ratio ? '%' : ' R$'}<extra>Meta única · ${METRIC_LABELS[metric]}</extra>` });
    }
    traces.unshift(...hatchAreas(traces, range, options.overlay_fill));
    for (const trace of traces) if ((options.legend_hidden || []).includes(legendKey(trace))) trace.visible = 'legendonly';
    goalInfo.baseMessage = goalInfo.message;
    if (goalInfo.visible && (options.legend_hidden || []).includes('goal')) { goalInfo.state = 'legend_hidden'; goalInfo.message = 'Meta ocultada pela legenda. Clique novamente em Meta para exibir a linha.'; }
    return { traces, range, goalInfo, missingReference };
  }
  // This formatter is also serialized into the offline HTML; keep it standalone.
  function chartPointText(point, metric) {
    if (!point || point.data?.meta?.kind === 'overlay_fill' || point.y == null || !Number.isFinite(Number(point.y))) return '';
    const data = point.customdata;
    if (data?.[0]) return `${data[4]} · ${data[1]} · ${data[2]}${data[5] ? ' · ' + data[5] : ''}`;
    const iso = String(point.x || '').slice(0, 10), date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso;
    const value = Number(point.y).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${point.data?.name || point.fullData?.name || 'Referência'} · ${date} · ${metric.endsWith('return') ? value + '%' : 'R$ ' + value}`;
  }
  function chartLayout(period, metric, traces, range, goalInfo, width = 1100, narrow = false, mobile = false, touch = mobile) {
    const history = traces.some(t => t.meta?.history), labelWidth = history ? 280 : 215;
    const ratio = metric.endsWith('return'), columns = Math.max(1, Math.floor((width - (ratio ? 58 : 80) - 12) / labelWidth));
    const rows = mobile || touch ? 0 : Math.ceil(traces.filter(t => t.showlegend !== false).length / columns), bottom = mobile || touch ? 60 : 65 + rows * 21;
    const height = (mobile ? 350 : 460) + Math.max(0, rows - 3) * 20;
    return { paper_bgcolor: '#fcfbf7', plot_bgcolor: '#fcfbf7', font: { family: 'Segoe UI, sans-serif', color: '#627067', size: 11 },
      height, meta: { goal_message: goalInfo.message, goal_base_message: goalInfo.baseMessage || goalInfo.message, goal_state: goalInfo.state }, margin: { t: 20, r: 12, b: bottom, l: ratio ? 58 : 80 }, separators: ',.', hovermode: 'closest', hoverdistance: touch ? 40 : 20, clickmode: 'event', dragmode: touch ? false : 'select', selectdirection: 'd',
      xaxis: { title: { text: 'Data de venda', standoff: 12 }, type: 'date', fixedrange: touch, gridcolor: '#e3e6dc', tickformat: narrow ? '%m/%y' : '%d/%m/%Y', tickangle: 0, nticks: narrow ? 4 : 7, range: [period.start, period.end] },
      yaxis: { title: { text: ratio ? 'Retorno (%)' : 'Valor (R$)', standoff: 8 }, fixedrange: touch, gridcolor: '#e3e6dc', zerolinecolor: '#b8c4b6', tickformat: ',.0f', ...(range ? { range, autorange: false } : {}) },
      legend: { orientation: 'h', entrywidth: history ? 235 : 170, entrywidthmode: 'pixels', x: 0, y: -Math.max(45 / Math.max(1, height - 20 - bottom), .18), yanchor: 'top', font: { size: 11 } }, showlegend: !touch && !mobile };
  }
  function objectiveOverlays({ unit, period, measure, value: raw }) {
    if (!['BRL', 'PERCENT'].includes(unit) || !['TOTAL', 'ANNUAL'].includes(period)) throw new Error('Escolha unidade e período válidos.');
    const value = workspace.parsePtDecimal(raw, 'Valor');
    if (value == null) throw new Error('Informe o valor do objetivo.');
    if (period === 'ANNUAL') {
      if (unit === 'PERCENT' && workspace.compareSurfaceDecimal(value, '-100') <= 0) throw new Error('O percentual anual deve ser maior que −100%.');
      return { goal: null, reference: { mode: unit === 'BRL' ? 'NOMINAL' : 'PERCENT', value: unit === 'BRL' ? value : workspace.shiftDecimal(value, -2) } };
    }
    const allowed = unit === 'BRL' ? ['nominal_profit', 'net_redemption'] : ['nominal_return', 'real_return'];
    if (!allowed.includes(measure)) throw new Error('Escolha uma medida compatível com a unidade.');
    if (workspace.compareSurfaceDecimal(value, '0') < 0) throw new Error('A meta de saída deve ser maior ou igual a zero.');
    return { goal: { metric: measure, value: unit === 'BRL' ? value : workspace.shiftDecimal(value, -2) }, reference: null };
  }
  function numericStepSpec(id, modes = {}) {
    const field = id.replace(/^b-/, '');
    if (field === 'budget') return { step: modes.capital === 'QUANTITY' ? '0.01' : '100', min: '0.01' };
    if (field === 'entry') return { step: '0.01', min: modes.entry === 'PU' ? '0.01' : '-99.99' };
    if (['inflation', 'rate-min', 'rate-max'].includes(field)) return { step: '0.01', min: '-99.99' };
    if (['entry-fee', 'exit-fee'].includes(field)) return { step: '0.01', min: '0' };
    if (field === 'goal-value') return { step: modes.goal?.endsWith('return') ? '0.1' : '100', min: '0' };
    if (field === 'reference-value') return { step: modes.reference === 'NOMINAL' ? '100' : '0.1', min: modes.reference === 'NOMINAL' ? null : '-99.9' };
    return null;
  }
  function incrementDecimal(raw, spec, direction) {
    const value = workspace.parsePtDecimal(raw, 'Valor') ?? '0';
    let next = workspace.exactDecimalDifference(value, direction > 0 ? '-' + spec.step : spec.step);
    if (spec.min != null && workspace.compareSurfaceDecimal(next, spec.min) < 0) next = spec.min;
    if (spec.max != null && workspace.compareSurfaceDecimal(next, spec.max) > 0) next = spec.max;
    return workspace.formatPtNumber(next, -1);
  }
  function legacySaveBody(body) {
    const copy = clone(body);
    const strip = view => {
      delete view.chart_controls; delete view.fit_overlays; delete view.overlay_fill; delete view.legend_hidden; delete view.outside_reason;
      for (const key of ['result', 'overview_result']) {
        const result = view[key]; if (!result) continue;
        delete result.overlay_support;
        if (result.conversion_bases) { delete result.conversion_bases; result.rows.forEach(row => { if (row.length === 12) row.pop(); }); }
        for (const point of result.points || []) delete point.conversion_basis;
      }
      if (view.comparison) strip(view.comparison.view);
    };
    strip(copy.view.single_screen);
    return copy;
  }
  function presentationSupport(view) {
    return { result: clone(view.result?.overlay_support || null), overview_result: clone(view.overview_result?.overlay_support || null), ...(view.outside_reason ? { outside_reason: view.outside_reason } : {}),
      comparison: view.comparison ? presentationSupport(view.comparison.view) : null };
  }
  function applyPresentationSupport(view, support) {
    if (!view || !support) return;
    if (view.outside_period && ['MATURITY', 'INCOME', 'LOCKUP', 'SETTLEMENT', 'NO_SESSION'].includes(support.outside_reason)) view.outside_reason = support.outside_reason;
    for (const key of ['result', 'overview_result']) {
      const cached = support[key];
      if (!view[key] || !cached) continue;
      const rows = unpackOverlaySupport(cached);
      const period = key === 'overview_result' ? { start: view.overview_surface.order_dates[0], end: view.overview_surface.order_dates.at(-1) } : view.period;
      if (!Array.isArray(rows) || rows.length > 121 || rows.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.order_date) || row.order_date < period.start || row.order_date > period.end
        || (row.conversion_basis && (!(Number(row.conversion_basis.initial_outflow) > 0) || (row.conversion_basis.inflation_factor != null && !(Number(row.conversion_basis.inflation_factor) > 0)))))) continue;
      view[key].overlay_support = clone(cached);
    }
    if (view.comparison) applyPresentationSupport(view.comparison.view, support.comparison);
  }
  function isPresentationSchemaError(error) {
    return /Campo inesperado em (?:view\.)?single_screen[\w.\[\]]*: (?:chart_controls|fit_overlays|overlay_fill|legend_hidden|outside_reason|overlay_support|conversion_bases|conversion_basis)(?:, (?:chart_controls|fit_overlays|overlay_fill|legend_hidden|outside_reason|overlay_support|conversion_bases|conversion_basis))*$/.test(String(error.message || '').trim());
  }
  async function saveWithPresentationCompatibility(body, post, preservePreferences) {
    try { return { saved: await post(body), legacy: false }; }
    catch (error) {
      if (!isPresentationSchemaError(error)) throw error;
      preservePreferences();
      return { saved: await post(legacySaveBody(body)), legacy: true };
    }
  }
  function tablePreferences(raw = {}) {
    return { metrics: METRICS.filter(metric => (Array.isArray(raw.metrics) ? raw.metrics : METRICS).includes(metric)), hidden_rates: Array.isArray(raw.hidden_rates) ? raw.hidden_rates : [] };
  }
  function tableModel(sources, preferences = {}) {
    const prefs = tablePreferences(preferences), rates = sources.flatMap(item => item.record.surface?.values || item.record.points.map(point => point.coordinate.value))
      .sort(workspace.compareSurfaceDecimal).filter((rate, i, all) => !i || workspace.compareSurfaceDecimal(rate, all[i - 1]) !== 0);
    const groups = rates.filter(rate => !prefs.hidden_rates.some(hidden => workspace.compareSurfaceDecimal(hidden, rate) === 0)).map(rate => ({ rate,
      columns: sources.flatMap(source => prefs.metrics.map(metric => ({ ...source, metric }))) }));
    const dates = [...new Set(sources.flatMap(source => source.record.points.map(point => point.order_date)))].sort();
    const indexes = sources.map(source => new Map(source.record.points.map(point => [point.order_date + '|' + workspace.shiftDecimal(point.coordinate.value, 0), point])));
    return { groups, metrics: prefs.metrics, rows: dates.map(date => ({ date, cells: groups.flatMap(group => group.columns.map(column => {
      const selected = indexes[sources.findIndex(source => source.id === column.id)].get(date + '|' + workspace.shiftDecimal(group.rate, 0)) || null;
      return { ...column, rate: group.rate, point: selected, value: metricValue(selected, column.metric) };
    })) })) };
  }
  // Serialized as a self-contained offline controller; no server or calculator.
  function installExport(pointText, chartApi) {
    const byId = id => document.getElementById(id);
    let overview = byId('export-overview') ? JSON.parse(byId('export-overview').textContent) : null;
    const hidden = new Set(JSON.parse(byId('simulation-data').textContent).view.legend_hidden || []);
    const key = trace => trace.meta?.kind === 'overlay_fill' ? trace.meta.owner === 'goal' ? 'goal' : 'projection:' + trace.meta.scenario : trace.meta?.kind === 'goal' ? 'goal'
      : trace.meta?.kind === 'projection' ? 'projection:' + trace.meta.scenario : trace.meta?.kind === 'simulation' ? 'simulation:' + trace.meta.scenario + ':' + trace.meta.rate : null;
    let restoring = false, disposeChart = () => {};
    async function restore() {
      if (!overview || restoring) return;
      restoring = true;
      const parsed = new DOMParser().parseFromString(overview, 'text/html');
      parsed.querySelectorAll('script:not([type="application/json"])').forEach(node => node.remove());
      disposeChart();
      Plotly.purge(byId('export-chart'));
      document.body.replaceChildren(...parsed.body.childNodes);
      overview = null;
      try { await boot(); byId('export-chart').focus({ preventScroll: true }); byId('export-chart').scrollIntoView({ block: 'center' }); }
      finally { restoring = false; }
    }
    async function boot() {
      const plot = byId('export-chart'), model = JSON.parse(byId('chart-data').textContent), mobile = innerWidth <= 760;
      const touchMode = () => innerWidth <= 760 || matchMedia('(pointer: coarse)').matches;
      for (const trace of model.data) {
        const id = key(trace);
        if (id && hidden.has(id)) trace.visible = 'legendonly';
        else if (id && trace.y?.some(value => value != null)) trace.visible = true;
      }
      const touch = touchMode();
      const chartWidth = () => Math.round(plot.getBoundingClientRect().width);
      let layout = { ...model.layout, autosize: false, width: chartWidth(), showlegend: !touch,
        dragmode: touch ? false : 'select', clickmode: 'event', hoverdistance: touch ? 40 : 20,
        xaxis: { ...model.layout.xaxis, fixedrange: touch }, yaxis: { ...model.layout.yaxis, fixedrange: touch },
        ...(mobile ? { height: 350, margin: { ...model.layout.margin, b: 60 } } : {}) };
      const snapshot = JSON.parse(byId('simulation-data').textContent);
      const bench = byId('export-workbench') && chartApi?.create({ doc: document, host: byId('export-workbench'), plot,
        state: snapshot.view.chart_controls,
        labels: () => Object.fromEntries([['A', snapshot.input], ...(snapshot.view.comparison ? [['B', snapshot.view.comparison.input]] : [])].map(([id,input]) => [id, `${id} · ${input?.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${input?.instrument.series_year || ''}`])),
        onRender: async () => { for (const trace of model.data) if (key(trace)) trace.visible = hidden.has(key(trace)) ? 'legendonly' : true;
          const next = bench.prepare(model.data, {...model.layout,dragmode:touchMode()?false:'select',xaxis:{...model.layout.xaxis,fixedrange:touchMode()},yaxis:{...model.layout.yaxis,fixedrange:touchMode()}}, snapshot.view.metric);
          await Plotly.react(plot, next.traces, {...next.layout, width:chartWidth(), autosize:false}, {responsive:false,displayModeBar:false,scrollZoom:false,doubleClick:false}); legend(); },
      });
      const enhanced = bench?.prepare(model.data, layout, snapshot.view.metric);
      if (enhanced) layout = {...enhanced.layout, width:chartWidth(),autosize:false};
      // Own resizing here: Plotly's window handler can race a layout update and
      // does not cover container changes (including the restored document).
      await Plotly.newPlot(plot, enhanced?.traces || model.data, layout, { responsive: false, displayModeBar: false, doubleClick: false, scrollZoom: false, showAxisDragHandles: false, showAxisRangeEntry: false });
      byId('chart-fallback')?.remove();
      const metric = JSON.parse(byId('simulation-data').textContent).view.metric;
      function interactionMessage() {
        plot.dataset.interaction = touchMode() ? 'touch' : 'mouse';
        byId('export-chart-hint').textContent = touchMode()
          ? `Toque em uma linha para consultar valores. Deslize para rolar a página.${overview ? ' Use Visão original para voltar.' : ''}`
          : overview ? 'Duplo clique no gráfico, tecla 0 ou o botão retorna à visão geral.' : 'Visão original. Passe o mouse sobre os pontos para consultar os valores.';
      }
      plot.on('plotly_click', event => {
        if (bench && event.points?.[0]?.data?.meta?.kind === 'simulation') { bench.selectPoint(event.points[0]); return; }
        if (!touchMode()) return;
        const text = pointText(event.points?.[0], metric), output = byId('export-touch-value');
        output.textContent = text; output.hidden = !text;
      });
      function goalMessage() {
        const goal = plot.data.find(t => t.meta?.kind === 'goal');
        if (!goal) return;
        const base = model.layout.meta?.goal_base_message || model.layout.meta?.goal_message || '';
        const message = goal.y?.some(value => value != null) && hidden.has('goal') ? 'Meta ocultada pela legenda. Clique novamente em Meta para exibir a linha.' : base;
        byId('export-goal-status').textContent = message;
        plot.layout.meta.goal_message = message;
        plot.layout.meta.goal_state = goal.y?.some(value => value != null) && hidden.has('goal') ? 'legend_hidden' : goal.meta.state;
      }
      function legend() {
        const list = byId('export-legend-list'); list.replaceChildren();
        for (const trace of plot.data.filter(t => t.meta?.kind !== 'overlay_fill')) {
          const label = document.createElement('label'), check = document.createElement('input'), swatch = document.createElement('span');
          check.type = 'checkbox'; check.checked = trace.visible !== 'legendonly' && trace.visible !== false;
          check.disabled = !trace.y?.some(value => value != null); check.addEventListener('change', () => toggle(trace));
          swatch.className = 'legend-swatch'; swatch.style.borderColor = trace.line.color;
          if (trace.line.dash !== 'solid') swatch.style.borderTopStyle = 'dashed';
          label.append(check, swatch, document.createTextNode(trace.name)); list.append(label);
        }
      }
      async function toggle(trace) {
        const id = key(trace);
        if (!id || !trace.y?.some(value => value != null)) return;
        const hiding = !hidden.has(id); hiding ? hidden.add(id) : hidden.delete(id);
        await Plotly.restyle(plot, { visible: hiding ? 'legendonly' : true }, plot.data.flatMap((t, i) => key(t) === id ? [i] : []));
        goalMessage(); legend();
      }
      plot.on('plotly_legendclick', event => { toggle(plot.data[event.curveNumber]); return false; });
      plot.on('plotly_legenddoubleclick', () => false);
      plot.on('plotly_deselect', () => { if (!touchMode()) restore(); });
      plot.onkeydown = event => { if (event.target === plot && (event.key === '0' || !bench && event.key === 'Home')) { event.preventDefault(); restore(); } };
      byId('export-reset')?.addEventListener('click', restore);
      let active = true, frame = 0, resizing = false, pending = false;
      const geometry = () => ({ width: chartWidth(), mobile: innerWidth <= 760, touch: touchMode() });
      let previous = { width: layout.width, mobile, touch };
      async function resizeChart() {
        if (!active || !plot.isConnected) return;
        if (resizing) { pending = true; return; }
        const next = geometry();
        if (next.width <= 0 || JSON.stringify(next) === JSON.stringify(previous)) return;
        resizing = true;
        try {
          await Plotly.relayout(plot, { width: next.width, autosize: false,
            ...(next.mobile ? { height: 350, 'margin.b': 60 }
              : { height: model.layout.height, 'margin.b': model.layout.margin.b }),
            showlegend: bench ? false : !next.touch, hoverdistance: next.touch ? 40 : 20,
            dragmode: next.touch ? false : 'select',
            'xaxis.fixedrange': next.touch, 'yaxis.fixedrange': next.touch });
          if (bench) { const adjusted = bench.prepare(model.data, {...model.layout,width:next.width},snapshot.view.metric);
            await Plotly.relayout(plot, {height:adjusted.layout.height,margin:adjusted.layout.margin,annotations:adjusted.layout.annotations,shapes:adjusted.layout.shapes}); }
          previous = next;
          if (active) interactionMessage();
        } finally {
          resizing = false;
          if (active && pending) { pending = false; resized(); }
        }
      }
      function resized() {
        if (!active || frame) return;
        frame = requestAnimationFrame(() => { frame = 0; resizeChart().catch(() => {}); });
      }
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resized) : null;
      observer?.observe(plot);
      window.addEventListener('resize', resized);
      window.addEventListener('orientationchange', resized);
      window.visualViewport?.addEventListener('resize', resized);
      disposeChart = () => {
        active = false;
        cancelAnimationFrame(frame);
        observer?.disconnect();
        window.removeEventListener('resize', resized);
        window.removeEventListener('orientationchange', resized);
        window.visualViewport?.removeEventListener('resize', resized);
      };
      resized();
      interactionMessage(); goalMessage(); legend();
    }
    boot().catch(() => { byId('export-chart')?.remove(); const help = byId('export-chart-hint'); if (help) help.textContent = 'Não foi possível abrir o gráfico interativo. Consulte a imagem e a tabela.'; });
  }
  function exportDocument(name, input, view, chartImage = '', capturedAt = '', interactive = null, recoveredBases = {}, historyContext = {}) {
    view = clone(view);
    const html = escapeHtml, json = value => JSON.stringify(value).replace(/</g, '\\u003c');
    const sources = viewSources(input, view, recoveredBases);
    const visible = sources.filter(source => view.visibility?.[source.id.toLowerCase()] !== false);
    const active = visible.filter(source => !source.record.outsidePeriod);
    historyContext = historyContext.forRates?.([...new Set(active.flatMap(source => source.record.surface.values))]) || historyContext;
    const originalView = restoredView(input, view);
    const outsideNote = sources.filter(source => source.record.outsidePeriod).map(source => `<p>${source.id} · fora ${originalView ? 'do trecho selecionado' : 'do período'}: ${html(outsideMessage(source.record))}.${originalView ? ' A visão geral permanece preservada.' : ''}</p>`).join('');
    const model = tableModel(visible, view.table), compared = sources.length > 1;
    const columns = model.groups.reduce((n, group) => n + group.columns.length, 0);
    const heads = model.groups.map(group => `<th scope="colgroup" colspan="${group.columns.length}">${html(rateLabel(group.rate))}</th>`).join('');
    const labels = model.groups.flatMap(group => group.columns.map(column => `<th scope="col">${compared ? column.id + ' · ' : ''}${html(METRIC_LABELS[column.metric])}</th>`)).join('');
    const rows = model.rows.map(row => `<tr><th scope="row">${html(dateText(row.date))}</th>${row.cells.map(cell => `<td>${html(valueText(cell.value, cell.metric))}</td>`).join('')}</tr>`).join('');
    const table = columns ? `<div class="table-wrap" tabindex="0"><table><thead><tr><th rowspan="2" scope="col">Data da venda</th>${heads}</tr><tr>${labels}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Nenhuma coluna de valores exibida. As escolhas da tela foram preservadas.</p>';
    const safeImage = /^data:image\/(?:svg\+xml|png)[;,]/.test(chartImage) ? `<img id="chart-fallback" alt="Gráfico das saídas simuladas" src="${html(chartImage)}">` : '';
    let overviewHtml = null;
    if (interactive && originalView) {
      const bases = recoveredBases.overview || recoveredBases;
      const model = chartPresentation(viewSources(input, originalView, bases), originalView.metric, originalView.overlays, originalView);
      historyContext.decorate?.(model.traces);
      const layout = chartLayout(originalView.period, originalView.metric, model.traces, model.range, model.goalInfo);
      overviewHtml = exportDocument(name, input, originalView, '', capturedAt, { source: '', data: model.traces, layout }, bases, historyContext);
    }
    const chart = interactive ? `${view.chart_controls ? '<div id="export-workbench"></div>' : ''}<p id="export-chart-hint">${originalView ? 'Duplo clique no gráfico, tecla 0 ou o botão retorna à visão geral.' : 'Visão original. Passe o mouse sobre os pontos para consultar os valores.'}</p>${originalView ? '<button id="export-reset" type="button">Visão original</button>' : ''}<div id="export-chart" tabindex="0" aria-label="Gráfico interativo das saídas" aria-describedby="export-chart-hint"></div><p id="export-touch-value" role="status" aria-live="polite" hidden></p><details id="export-legend"><summary>Legenda · mostrar ou ocultar linhas</summary><div id="export-legend-list"></div></details>${safeImage}<script type="application/json" id="chart-data">${json({ data: interactive.data, layout: interactive.layout })}</script>${overviewHtml ? `<script type="application/json" id="export-overview">${json(overviewHtml)}</script>` : ''}${view.chart_controls && chartWorkbench ? `<script>window.TesouroChartWorkbench=${chartWorkbench.source()};</script>` : ''}<script>${interactive.source.replace(/<\/script/gi, '<\\/script')}</script><script>document.addEventListener('DOMContentLoaded',()=>(${installExport.toString()})(${chartPointText.toString()},window.TesouroChartWorkbench),{once:true});</script>` : safeImage;
    const meshDates = view.surface?.order_dates?.length ? view.surface.order_dates : model.rows.map(row => row.date);
    const meshNote = meshDates.length ? `<p id="export-mesh-status">${meshDates.length} datas calculadas${view.converged_dates ? " com convergência de A e B no período compartilhado e preservação dos trechos individuais" : view.aligned_dates ? " em comum para A e B, somente no período em que ambos permitem venda" : ""}: ${html(dateText(meshDates[0]))} a ${html(dateText(meshDates.at(-1)))}. Valores entre os pontos não foram calculados.</p>` : "";
    const goal = view.overlays?.goal, reference = view.overlays?.reference;
    const metric = METRICS.includes(view.metric) ? view.metric : 'net_redemption';
    const exportTraces = visible.flatMap(source => seriesFor(source.record.points, metric).map(series => ({ y: series.points.map(point => { const value = metricValue(point, metric); return value == null ? null : Number(value) * (metric.endsWith('return') ? 100 : 1); }) })));
    if (reference) for (const source of active) { const projection = referenceValues(source.record, reference, metric); if (projection) exportTraces.push({ y: projection.values }); }
    const goalInfo = crossGoalPresentation(goal, metric, interactive?.layout?.yaxis?.range || overlayGraphScale(exportTraces, goal, metric, active, view.fit_overlays !== false), active);
    if (interactive?.layout?.meta?.goal_message) goalInfo.message = interactive.layout.meta.goal_message;
    const facts = `<section id="export-simulation-facts"><h2>Dados da simulação</h2>${sources.map(source => `<h3>Simulação ${source.id}</h3><dl class="simulation-facts">${simulationFacts(source.record.input, source.record.surface, view.period).map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join('')}</dl>`).join('')}</section>`;
    const goalTable = goal && !['different_projections', 'missing_basis'].includes(goalInfo.state) ? `<h3>Primeiro ponto que atinge a meta</h3><p>Consulta apenas as datas calculadas; não indica a primeira data entre pontos nem garante resultado futuro.</p><div class="table-wrap"><table><thead><tr><th>Simulação / taxa</th><th>Primeiro ponto que atinge</th></tr></thead><tbody>${visible.flatMap(source => goalSummary(source.record, goal).map(result => `<tr><th>${source.id} · ${html(rateLabel(result.rate))}</th><td>${result.first ? html(dateText(result.first)) : 'Sem ponto disponível que atinja a meta'}${result.partial ? ' · cobertura parcial' : ''}</td></tr>`)).join('')}</tbody></table></div>` : '';
    const goalText = goal ? `${METRIC_LABELS[goal.metric]} mínimo: ${valueText(goal.value, goal.metric)}` : 'Sem meta ativa.';
    const referenceText = reference ? `Ganho projetado: ${workspace.formatPtNumber(reference.mode === 'PERCENT' ? workspace.shiftDecimal(reference.value, 2) : reference.value, 2)} ${reference.mode === 'PERCENT' ? '% ao ano, juros compostos' : 'R$ de ganho ao ano, crescimento linear'}. Custo de compra como base, sem sobra de caixa; ano de 365 dias. Hipótese aproximada, sem tributos ou custos adicionais.` : 'Sem ganho projetado.';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(name)} · Tesouro Marcado</title><style>body{font:14px system-ui,sans-serif;color:#293d32;background:#fcfbf7;max-width:1400px;margin:30px auto;padding:0 20px}h1{font-size:28px;letter-spacing:-.04em}p{line-height:1.6}.brand{font-size:13px;letter-spacing:.06em;color:#287657}img{max-width:100%;height:auto}.table-wrap{overflow:auto;max-height:650px}table{border-collapse:separate;border-spacing:0;width:100%;font-size:12px;font-variant-numeric:tabular-nums}td,th{padding:10px 14px;text-align:right;border-bottom:1px solid #dce1d6;white-space:nowrap}thead{position:sticky;top:0;background:#f1f0e9}thead tr:first-child th{color:#215b44}th:first-child{text-align:left}tbody th{position:sticky;left:0;background:#fcfbf7}pre{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:24px 0}#export-chart{min-height:350px}#export-chart[data-interaction="touch"],#export-chart[data-interaction="touch"] .draglayer{touch-action:pan-y pinch-zoom}#export-touch-value{padding:12px;background:#edf1e6;border-left:2px solid #287657;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.simulation-facts{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,3fr);gap:7px 18px;font-size:12px;line-height:1.6}.simulation-facts dd{margin:0;overflow-wrap:anywhere}.simulation-facts dt{color:#627067}#export-chart:focus{outline:2px solid #287657;outline-offset:3px}button{padding:8px 12px;background:#f1f0e9;color:#215b44;border:1px solid #bdcbbb;border-radius:5px}#export-legend{display:none}#export-legend-list{display:grid;gap:10px;margin-top:12px}#export-legend-list label{display:flex;align-items:center;gap:8px;font-size:12px}.legend-swatch{width:18px;border-top:2px solid;flex:none}@media(max-width:760px){#export-legend{display:block}.simulation-facts{grid-template-columns:1fr;gap:2px}.simulation-facts dd{margin-bottom:8px}body{padding:0 16px}button,summary,#export-legend-list label{min-height:44px}#export-legend-list label{padding:8px 0}#export-legend-list input{width:20px;height:20px}}@media(pointer:coarse){#export-legend{display:block}#export-legend-list label{min-height:44px}} </style></head><body><p class="brand">TESOURO MARCADO</p><h1>${html(name)}</h1>${sources.map(source => `<p>${source.id} · ${source.record.input?.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${html(source.record.input?.instrument.series_year)} · compra em ${html(source.record.input?.purchase_date)} · ${source.record.input?.capital.mode === 'QUANTITY' ? 'Quantidade de títulos' : 'Valor disponível (R$)'}: ${html(source.record.input?.capital.value)}</p>`).join('')}<p>Período original: ${html(input.analysis_context.timeline.start)} a ${html(input.analysis_context.timeline.end)}<br>Período exibido: ${html(view.period.start)} a ${html(view.period.end)}<br>Calculado/registrado em: ${html(capturedAt)}</p>${facts}${historyContext.html || ""}${outsideNote}${meshNote}${chart}<p>${html(METRIC_LABELS[view.metric] || '')}${interactive ? ' · Passe o mouse sobre os pontos para consultar os valores.' : ''}</p><h2>Pontos calculados${originalView ? ' · trecho refinado' : ''}</h2><p>Simulações exibidas: ${visible.map(source => source.id).join(', ') || 'nenhuma'}. Datas nas linhas; valores agrupados pela taxa de saída. Valores monetários em R$ e retornos em %. Cada ponto é uma venda independente. Valores entre pontos não foram calculados; dados ausentes não viram zero. A sobra do orçamento não integra o resgate.</p>${table}<section><h2>Metas e projeções</h2><p>${html(goalText)}</p><p id="export-goal-status">${html(goalInfo.message)}</p>${goalTable}<p>${html(referenceText)}</p></section><details><summary>Entradas, fontes, regras e cobertura registradas</summary><pre>${html(JSON.stringify({ input, view, reference_context: recoveredBases }, null, 2))}</pre></details><script type="application/json" id="simulation-data">${json({ input, view, reference_context: recoveredBases, captured_at: capturedAt })}</script></body></html>`;
  }

  function mount(doc) {
    const $ = id => doc.getElementById(id), p = presentation;
    let chartClickTimer, chartRevision = 0, overlayProcessing = false, chartRendering = false, keyboardSelection = null, openMessageTimer, touchedPoint = null;
    const touchChart = () => window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
    const request = (...args) => (window.TesouroTransport?.fetch || window.fetch)(...args);
    let hiddenLegend = new Set();
    let bootstrap, revision = 0, busy = false, current = null, detailRevision = 0, purchaseProposal = null, savedRecord = null, saveOperation = null, automaticName = '', comparisonInitialized = false, overlayError = false;
    const localPreferencesKey = (id, rev, hash) => `tesouro-marcado:view:${id}:${rev}:${hash}`;
    const manualDates = new Set();
    let noticeTimer, displayedMetric = 'net_redemption', tablePrefs = tablePreferences(), savedFingerprint = null, formEdited = false, pendingOpenId = '', loadingSaved = false, savedListRevision = 0;
    const fingerprint = () => JSON.stringify({ name: $('simulation-name').value.trim(), view: fullView() });
    const unsavedChanges = () => { try { return current ? !isCurrent() || fingerprint() !== savedFingerprint : formEdited; } catch (_) { return true; } };
    function setSaveState(text) { $('save-state').textContent = text; $('document-state').textContent = text; }
    function showRecordInfo(revisionNumber, capturedAt, compatible = true) {
      $('record-info').hidden = false;
      $('record-info').open = !compatible;
      $('record-metadata').textContent = `Revisão ${revisionNumber}${capturedAt ? ` · registrada em ${p.formatDate(capturedAt.slice(0, 10))}` : ''}. Valores e exibição guardados neste computador.${compatible ? ' A abertura preserva os cálculos registrados.' : ' As fontes ou regras atuais diferem. Simule novamente para atualizar.'}`;
    }
    const form = $('simulation-form');
    const bFields = form.querySelector('fieldset').cloneNode(true);
    bFields.querySelector('legend').textContent = 'Compra do título B';
    bFields.querySelector('.costs > summary').textContent = 'Custos da instituição · B';
    for (const node of bFields.querySelectorAll('[id]')) node.id = 'b-' + node.id;
    for (const node of bFields.querySelectorAll('[aria-describedby]')) node.setAttribute('aria-describedby', node.getAttribute('aria-describedby').split(/\s+/).map(id => bFields.querySelector('#b-' + id) ? 'b-' + id : id).join(' '));
    for (const node of bFields.querySelectorAll('[list]')) node.setAttribute('list', 'b-' + node.getAttribute('list'));
    $('b-fixed').append(bFields);
    for (const control of $('comparison-inputs').querySelectorAll('input,select')) control.disabled = true;
    const money = value => p.formatCurrency(value, 'BRL', 2);
    const rateText = (value, brief = false) => {
      const exact = workspace.formatPtNumber(roundPercent(workspace.shiftDecimal(value, 2)), -1);
      const shown = brief && exact.length > 10 ? Number(workspace.shiftDecimal(value, 2)).toPrecision(6).replace('.', ',') + '…' : exact;
      return `IPCA + ${shown}%`;
    };
    const historyUI = window.TesouroHistory?.createPanel(doc, { formatRate: rateText,
      onChange: () => { if (isCurrent()) renderChart().catch(() => {}); } });
    const chartUI = chartWorkbench?.create({ doc, host: $('chart-workbench'), plot: $('chart'),
      historySection: $('rate-history'), overlaysButton: $('open-overlays'), historyHost: $('history-selected'), historyTitle: $('history-selected-title'), coverage: $('history-coverage'), tableHost: $('date-reading'), formatRate: rateText,
      labels: () => Object.fromEntries(records().map(item => [item.id, `${item.id} · ${item.record.input.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${item.record.input.instrument.series_year}`])),
      enabled: () => isCurrent() && !busy, canConsult: () => !keyboardSelection, onTable: () => renderReading(),
      onChange: () => { detailRevision++; $('point-details').hidden = true; viewChanged(); }, onRender: () => renderChart().catch(error => recordMessage(error.message, true)),
      onPoint: (data, id) => { const source = records().find(item => item.id === id), point = source?.record.points.find(p => p.identity === data[0]); if (point) showPoint(point, source.record, id); },
    });
    const showError = message => { $('form-error').hidden = !message; $('form-error').textContent = message ? friendlyMessage(message) : ''; };
    const check = run => { if (run !== revision) throw new Superseded(); };
    const isCurrent = () => current && current.revision === revision;
    const hasPendingComparison = () => current?.pending || current?.comparison?.pending;
    function syncActions() {
      chartUI?.refresh();
      $('edit-inputs').disabled = busy;
      $('chart-reset').disabled = busy || !isCurrent();
      $('chart-touch-details').disabled = busy || !isCurrent();
      for (const metric of METRICS) {
        $('metric-' + metric).disabled = busy || !isCurrent();
        $('metric-' + metric).setAttribute('aria-pressed', String(metric === displayedMetric));
      }
      for (const id of ['save-simulation', 'export-simulation', 'save-copy']) $(id).disabled = busy || chartRendering || overlayProcessing || !isCurrent() || overlayError || hasPendingComparison();
      $('open-saved-shortcut').disabled = busy;
      $('saved-simulation').disabled = busy || loadingSaved;
      $('open-simulation').disabled = busy || loadingSaved || !$('saved-simulation').value;
      $('refresh-saved').disabled = busy || loadingSaved;
      $('save-before-open').disabled = $('save-simulation').disabled;
      $('discard-and-open').disabled = busy;
      $('save-copy').hidden = !savedRecord;
      $('open-overlays').disabled = busy || chartRendering || !isCurrent();
      $('open-overlays').textContent = 'Meta e ganho';
      $('open-overlays').dataset.active = String($('goal-enabled').checked || $('reference-enabled').checked);
      $('goal-fill').disabled = !$('goal-enabled').checked; $('reference-fill').disabled = !$('reference-enabled').checked;
      syncStepperStates();
      $('save-simulation').textContent = savedRecord ? 'Salvar revisão' : 'Salvar';
      try { $('suggest-rates').disabled = $('entry-mode').value !== 'RATE' || !suggestedRates($('entry').value); } catch (_) { $('suggest-rates').disabled = true; }
    }
    function inputSummary() {
      if (!current) return 'Entradas da simulação';
      const original = current.overview || current, period = original.input.analysis_context.timeline;
      return `${original.comparison ? '2 títulos' : '1 título'} · ${p.formatDate(period.start)} a ${p.formatDate(period.end)}`;
    }
    function syncSimulationDetails() {
      $('simulation-details').hidden = !current || !$('entry-panel').hidden;
      if ($('simulation-details').hidden) $('simulation-details').open = false;
    }
    function notifyCalculation(text, state) {
      clearTimeout(noticeTimer);
      const notice = $('calculation-notice'); notice.hidden = false; notice.dataset.state = state; notice.textContent = text;
      if (state !== 'processing') noticeTimer = setTimeout(() => { notice.hidden = true; }, 7000);
    }
    function renderSimulationFacts() {
      $('simulation-facts').replaceChildren();
      for (const item of records(true)) {
        const input = (item.record.overview || item.record).input;
        const heading = element('h4', `Simulação ${item.id}`), list = element('dl'); list.className = 'simulation-facts';
        for (const [label, value] of simulationFacts(input, item.record.surface, item.record.input.analysis_context.timeline)) list.append(element('dt', label), element('dd', value));
        $('simulation-facts').append(heading, list);
      }
      syncSimulationDetails();
    }
    function setInputsCollapsed(collapsed, focus = false) {
      $('entry-panel').hidden = collapsed;
      doc.body.classList.toggle('inputs-collapsed', collapsed);
      $('simulate').hidden = collapsed;
      doc.querySelector('.simulate-dock').hidden = collapsed;
      syncWorkspaceInsets();
      syncSimulationDetails();
      $('edit-inputs').textContent = collapsed ? 'Exibir entradas' : 'Recolher entradas';
      $('edit-inputs').setAttribute('aria-expanded', String(!collapsed));
      $('edit-inputs').hidden = !current;
      $('input-summary').textContent = inputSummary();
      // Folding changes the workspace width without resizing the browser window.
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      if (focus) { $('edit-inputs').focus({ preventScroll: true }); $('input-summary').parentElement.scrollIntoView({ block: 'start', behavior: 'auto' }); }
    }
    function suggestDates() {
      const purchase = $('purchase').value;
      if (!purchase) return;
      if (!manualDates.has('start')) $('start').value = purchase;
      if (!manualDates.has('end')) $('end').value = workspace.addIsoMonthsClamped(purchase, 12);
    }
    function divisionHelp() {
      const count = Number($('divisions').value);
      $('division-help').textContent = Number.isInteger(count) && count >= 1 && count <= 20 ? `${count} divisões = até ${count + 1} taxas entre os limites.` : 'Escolha de 1 a 20 divisões.';
    }
    function ensureName(input) {
      if (!$('simulation-name').value.trim() || $('simulation-name').value === automaticName) {
        automaticName = `${input.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${input.instrument.series_year} · compra ${p.formatDate(input.purchase_date)}`;
        $('simulation-name').value = automaticName;
      }
      return $('simulation-name').value.trim();
    }
    function fieldError(id, message) {
      const control = $(id); control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', [...new Set([...(control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), 'form-error'])].join(' '));
      for (let parent = control.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      control.focus(); return new Error(message);
    }
    function invalidate() {
      chartUI?.invalidate();
      historyUI?.update(null);
      formEdited = true; revision++; detailRevision++; purchaseProposal = null; $('confirm-purchase').hidden = true; showError('');
      if (current) { $('stale').hidden = false; $('results').classList.add('is-stale'); }
      $('point-details').hidden = true;
      for (const control of form.querySelectorAll('[aria-invalid]')) {
        control.removeAttribute('aria-invalid');
        const help = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== 'form-error');
        if (help.length) control.setAttribute('aria-describedby', help.join(' ')); else control.removeAttribute('aria-describedby');
      }
      if (current) { setSaveState('Entradas alteradas'); recordMessage('Simule novamente para salvar ou exportar os novos dados.'); }
      syncActions();
      $('form-status').textContent = busy ? 'Entradas alteradas durante o cálculo.' : 'Preencha e simule.';
    }
    function element(tag, text) { const node = doc.createElement(tag); if (text != null) node.textContent = text; return node; }
    function requiredNumber(id, label, positive = false) {
      let value;
      try { value = workspace.parsePtDecimal($(id).value, label); } catch (e) { throw fieldError(id, e.message); }
      if (value == null || (positive && workspace.compareSurfaceDecimal(value, '0') <= 0)) throw fieldError(id, `Informe ${label.toLowerCase()}${positive ? ' maior que zero' : ''}.`);
      return value;
    }
    async function api(action, input, extra, run) {
      check(run);
      const requestId = crypto.randomUUID(), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await request('/api/simulator/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': bootstrap.csrf_token },
          body: JSON.stringify({ schema_version: 2, action, input, request_id: requestId, revision: run + 1, ...extra }), signal: controller.signal });
        const result = await response.json(); check(run);
        if (!response.ok) throw new Error(friendlyMessage(result.error || 'Não foi possível calcular. Tente novamente.'));
        if (result.request_id !== requestId || result.revision !== run + 1) throw new Error('A resposta não corresponde a esta simulação. Simule novamente.');
        return result;
      } catch (error) {
        check(run);
        if (error.name === 'AbortError') throw new Error('O cálculo excedeu o tempo de espera. Tente um período menor.');
        throw error;
      } finally { clearTimeout(timer); }
    }
    function readInput(prefix = '') {
      const at = id => $(prefix + id), shared = id => $(id);
      let instrument;
      try { instrument = fixedInstrument(at('family').value); }
      catch (error) { throw fieldError(prefix + 'family', error.message); }
      if (titleYearError(instrument.series_year, titleYearRange(instrument.family, at('purchase').value, bootstrap?.instrument_series_options?.RENDA_PLUS))) {
        throw fieldError(prefix + 'purchase', `A data da compra não é compatível com ${productOptions().find(option => option.value === instrument.family).label}. Ajuste a data da compra.`);
      }
      for (const control of form.querySelectorAll('[required]')) {
        if (control.disabled || control.id.startsWith('b-') !== Boolean(prefix)) continue;
        if (!control.value.trim() || !control.checkValidity()) throw fieldError(control.id, `Preencha ${control.closest('label').textContent.trim().toLowerCase()}.`);
      }
      if ($('start').value < at('purchase').value) throw fieldError(prefix + 'purchase', `${prefix ? 'B: ' : ''}a compra precisa ocorrer até o início do período de saída.`);
      if ($('end').value > '2085-12-31') throw fieldError('end', 'Use datas dentro da cobertura do calendário: 2000 a 2085.');
      if (at('purchase').value < '2000-01-01') throw fieldError(prefix + 'purchase', 'Use datas dentro da cobertura do calendário: 2000 a 2085.');
      let value = requiredNumber(prefix + 'entry', at('entry-mode').value === 'RATE' ? 'Taxa da compra' : 'Preço da compra', at('entry-mode').value === 'PU');
      if (at('entry-mode').value === 'RATE') { value = roundPercent(value); at('entry').value = workspace.formatPtNumber(value, 2); }
      const entryPrice = at('entry-mode').value === 'RATE' ? { mode: 'MANUAL_RATE', annual_real_rate: workspace.shiftDecimal(value, -2), quoted_side: 'BUY' } : { mode: 'MANUAL_PU', pu: value };
      const requestedDivisions = Number(shared('divisions').value);
      let rates, divisions;
      const minimum = requiredNumber('rate-min', 'Taxa mínima'), maximum = requiredNumber('rate-max', 'Taxa máxima');
      if (workspace.compareSurfaceDecimal(roundPercent(minimum), roundPercent(maximum)) > 0) throw fieldError('rate-max', 'A taxa máxima precisa ser maior ou igual à mínima.');
      try {
        rates = ratesForWindow($('rate-min').value, $('rate-max').value, entryPrice.annual_real_rate, requestedDivisions);
        divisions = effectiveRateDivisions($('rate-min').value, $('rate-max').value, requestedDivisions);
        for (const id of ['rate-min', 'rate-max']) $(id).value = workspace.formatPtNumber(roundPercent(workspace.parsePtDecimal($(id).value)), 2);
      } catch (error) { throw fieldError('rate-min', error.message); }
      try { dateSamples($('start').value, $('end').value); } catch (error) { throw fieldError('end', error.message); }
      let capital;
      try { capital = capitalInput(at('capital-mode').value, at('budget').value); } catch (error) { throw fieldError(prefix + 'budget', error.message); }
      if (!at('budget').value.trim()) at('budget').value = workspace.formatPtNumber(capital.value, 2);
      const assumptions = { settlement_profile: 'SIMULATED_BUY_D1_SELL_D1', entry_fee: { fixed_brl: requiredNumber(prefix + 'entry-fee', 'Custo de compra'), proportional_rate: '0' }, exit_fee_brl: requiredNumber(prefix + 'exit-fee', 'Custo de venda') };
      if (workspace.compareSurfaceDecimal(assumptions.entry_fee.fixed_brl, '0') < 0) throw fieldError(prefix + 'entry-fee', 'O custo de compra não pode ser negativo.');
      if (workspace.compareSurfaceDecimal(assumptions.exit_fee_brl, '0') < 0) throw fieldError(prefix + 'exit-fee', 'O custo de venda não pode ser negativo.');
      const inflation = at('inflation').value.trim() ? roundPercent(requiredNumber(prefix + 'inflation', 'Inflação hipotética')) : null;
      if (inflation != null) at('inflation').value = workspace.formatPtNumber(inflation, 2);
      if (inflation != null && workspace.compareSurfaceDecimal(inflation, '-100') <= 0) throw fieldError(prefix + 'inflation', 'A inflação precisa ser maior que −100% ao ano.');
      return { input: { instrument, capital,
        purchase_date: at('purchase').value, entry_price: entryPrice, knowledge: { date: bootstrap.studio?.current_date || bootstrap.defaults.asof, mode: 'CAUSAL' }, intent: 'HYPOTHETICAL', assumptions,
        source_versions: { market_sim: bootstrap.market_sim_active?.market_sim || null, market_sim_indexes: bootstrap.market_sim_active?.market_sim_indexes || null },
        analysis_context: { kind: 'OPERATION', timeline: { mode: 'WINDOW', start: $('start').value, end: $('end').value } } }, rates, inflation, divisions };
    }
    function probeInput(input, date) {
      return { instrument: input.instrument, purchase_date: input.purchase_date, ...(date ? { sale_date: date } : { analysis_context: input.analysis_context }), knowledge: input.knowledge, intent: 'HYPOTHETICAL', assumptions: { settlement_profile: input.assumptions.settlement_profile } };
    }
    const dateProbeCache = new Map();
    const dateProbeKey = (input, date) => JSON.stringify(probeInput(input, date));
    async function eligibleDate(input, requested, end, run, initial = null) {
      let date = requested, resolved = initial;
      for (let attempt = 0; attempt < 3; attempt++) {
        resolved = resolved || dateProbeCache.get(dateProbeKey(input, date)) || (await api('RESOLVE', probeInput(input, date), {}, run)).resolved;
        const candidate = workspace.firstEligibleDateFromResolution(resolved, date);
        if (!candidate || candidate.date > end) return null;
        if (candidate.saleStatus === 'available' && candidate.date === date) return date;
        if (candidate.date <= date && !candidate.requiresConfirmationProbe) return null;
        date = candidate.date; resolved = null;
      }
      return null;
    }
    async function lastEligibleDate(input, start, end, run) {
      // Ask the same calendar about the end of the window; never leave a long
      // unsampled tail just because its final day has no trading session.
      for (let i = 0; i < 14; i++) {
        const date = workspace.addIsoDays(end, -i);
        if (date < start) return null;
        const resolved = (await api('RESOLVE', probeInput(input, date), {}, run)).resolved;
        if (resolved?.dates?.sale?.status === 'available') return date;
      }
      return null;
    }
    function pendingMessage(response, prefix = '') {
      const resolved = response?.resolved || {};
      const items = (resolved.pending_items || []).filter(item => !/^(exit_price|sale_date)/.test(item.field_path || ''));
      if (!$(prefix + 'inflation').value.trim() && items.some(item => item.reason_code === 'MISSING_PROJECTION')) {
        $(prefix + 'inflation').setAttribute('aria-invalid', 'true'); $(prefix + 'inflation').focus();
        return 'Informe a inflação hipotética para calcular os meses futuros. Use 0 se essa for sua hipótese.';
      }
      const reasons = items.map(item => item.reason?.message || item.message).filter(Boolean);
      for (const cap of Object.values(resolved.capabilities || {})) if (cap.status !== 'available' && cap.reason?.message) reasons.push(cap.reason.message);
      return [...new Set(reasons)].slice(0, 3).join(' ') || 'Confira o histórico de IPCA e a hipótese de inflação. Meses futuros exigem uma hipótese explícita; dados ausentes ficam sem resultado.';
    }
    async function gridBounds(input, run, prefix = '') {
      const { start, end } = input.analysis_context.timeline;
      const first = (await api('RESOLVE', probeInput(input, null), {}, run)).resolved;
      const purchase = first?.dates?.purchase;
      if (purchase?.status !== 'available' || !purchase.settlement_date) {
        if (!prefix && purchase?.proposed_order_date && purchase.proposed_order_date !== input.purchase_date) {
          purchaseProposal = { date: purchase.proposed_order_date, revision: run };
          $('confirm-purchase').textContent = `Usar compra em ${p.formatDate(purchase.proposed_order_date)} e simular`;
          $('confirm-purchase').hidden = false;
        }
        if (prefix && purchase?.proposed_order_date) { $('b-purchase').focus(); throw new Error(`B: compra sem sessão. Informe ${p.formatDate(purchase.proposed_order_date)} ou outra sessão elegível e simule novamente.`); }
        throw new Error('A compra precisa ocorrer em uma sessão elegível. Confira a data ou aceite a sessão sugerida.');
      }
      const afterPurchase = workspace.addIsoDays(purchase.settlement_date, 1);
      const instrument = first.normalized_input?.instrument || {};
      const horizon = instrument.first_income_date || instrument.maturity_date;
      const requested = start > afterPurchase ? start : afterPurchase;
      const resolved = (await api('RESOLVE', probeInput(input, requested), {}, run)).resolved;
      const sale = resolved?.dates?.sale || {};
      const noDate = () => {
        const reason = horizon && (start >= horizon || sale.reason?.code === 'OUTSIDE_HORIZON') ? (instrument.family === 'RENDA_PLUS' ? 'INCOME' : 'MATURITY')
          : end <= purchase.settlement_date ? 'SETTLEMENT' : sale.minimum_eligible_order_date > end ? 'LOCKUP' : 'NO_SESSION';
        throw Object.assign(new Error('Não há saída elegível nesse período: ' + outsideMessage({ outsideReason: reason }) + '.'), { code: 'NO_ELIGIBLE_DATE', purchase, outsideReason: reason });
      };
      if (requested > end) noDate();
      const firstDate = await eligibleDate(input, requested, end, run, resolved);
      if (!firstDate) {
        const proven = end <= purchase.settlement_date || (horizon && start >= horizon) || sale.reason?.code === 'OUTSIDE_HORIZON'
          || sale.minimum_eligible_order_date > end || sale.proposed_order_date > end;
        if (!proven) throw new Error(`Não foi possível confirmar a primeira saída elegível. ${sale.reason?.message || 'Confira as datas e a cobertura do calendário.'}`);
        noDate();
      }
      if (horizon && firstDate >= horizon) noDate();
      const lastDate = await lastEligibleDate(input, firstDate, horizon && end >= horizon ? workspace.addIsoDays(horizon, -1) : end, run);
      if (!lastDate) throw new Error('Não foi possível confirmar a última saída elegível do período. Confira as datas e o calendário.');
      return { firstDate, lastDate, purchase };
    }
    function applyInflation(input, inflation, purchase) {
      if (inflation != null) input.assumptions.inflation_projection = { mode: 'CONSTANT_ANNUAL', annual_rate: workspace.shiftDecimal(inflation, -2), anchor_date: purchase.settlement_date, anchor_level: '1', source_ref: 'Hipótese de inflação declarada pelo usuário na simulação' };
    }
    function outsideRecord(input, values, run, divisions, error, original, density, step, converged) {
      return { revision: run, outsidePeriod: true, outsideOriginal: !original || original.outsideOriginal === true, outsideReason: error.outsideReason,
        input, points: [], firstDate: null, lastDate: null, divisions,
        surface: { mode: 'RATE_DATE_MAP', metric_id: 'net_redemption', value_unit: 'ratio', order_dates: [], values, selected: null },
        response: { result: { points: [] }, coverage: { status: 'outside_period' } }, capturedAt: new Date().toISOString(), ...(original ? { overview: original } : {}),
        dateDensity: density, alignedDates: false, ...(density === 2048 ? { dateStepDays: step, convergedDates: converged } : {}) };
    }
    async function gridPlan(inputs, run, density, step = 15) {
      dateProbeCache.clear();
      const bounds = [];
      for (let i = 0; i < inputs.length; i++) {
        try { bounds.push(await gridBounds(inputs[i], run, i ? 'b-' : '')); }
        catch (error) { if (error instanceof Superseded || inputs.length === 1) throw error; bounds.push({ error }); }
      }
      if (density === 2048) {
        const indexes = bounds.flatMap((item, i) => item.error ? [] : [i]);
        if (bootstrap.simple_screen?.batch_dates && indexes.length) {
          const valid = indexes.map(i => bounds[i]);
          const sharedStart = valid.map(b => b.firstDate).sort().at(-1), sharedEnd = valid.map(b => b.lastDate).sort()[0];
          const shared = valid.length > 1 && sharedStart <= sharedEnd ? intervalDateSamples(sharedStart, sharedEnd, step) : [];
          for (const index of indexes) {
            const own = intervalDateSamples(bounds[index].firstDate, bounds[index].lastDate, step).filter(day => valid.length === 1 || sharedStart > sharedEnd || day < sharedStart || day > sharedEnd);
            const requested = [...new Set([...own, ...shared])].sort();
            check(run);
            const batch = await jsonRequest('/api/simulator/dates', { input: probeInput(inputs[index], null), order_dates: requested });
            check(run);
            if (batch.version !== 1 || !batch.resolutions) throw new Error('Resposta de calendário inválida. Recarregue a página.');
            for (const [day, resolution] of Object.entries(batch.resolutions)) dateProbeCache.set(dateProbeKey(inputs[index], day), resolution);
          }
        }
        const planned = indexes.length ? await convergingDateSamples(indexes.map(i => bounds[i]), step, (i, date, end) => eligibleDate(inputs[indexes[i]], date, end, run)) : [];
        return { bounds, dateSets: bounds.map((_, i) => indexes.includes(i) ? planned[indexes.indexOf(i)] : null) };
      }
      const dates = inputs.length > 1 && bounds.every(item => !item.error)
        ? await commonDateSamples(bounds, density, (i, date, end) => eligibleDate(inputs[i], date, end, run)) : null;
      return { bounds, dateSets: inputs.map(() => dates) };
    }
    async function calculateGrid(input, rates, inflation, run, sharedDates = null, prefix = '', bounds = null, density = 15, step = 15, converged = false) {
      if (bounds?.error) throw bounds.error;
      const { firstDate, lastDate, purchase } = bounds || await gridBounds(input, run, prefix);
      applyInflation(input, inflation, purchase);
      let dates = sharedDates ? [...sharedDates] : [firstDate];
      if (!sharedDates) {
        const requested = dateSamples(firstDate, lastDate, density).slice(1);
        for (let i = 0; i < requested.length; i += 2) {
          const found = await Promise.all(requested.slice(i, i + 2).map(date => eligibleDate(input, date, lastDate, run)));
          dates.push(...found.filter(Boolean));
        }
      }
      dates = [...new Set(dates)].sort();
      const surface = { mode: 'RATE_DATE_MAP', metric_id: 'net_redemption', value_unit: 'ratio', order_dates: dates, values: rates, selected: { order_date: dates[0], value: rates[0] } };
      const batches = [];
      const total = Math.ceil(dates.length / 15) * Math.ceil(rates.length / 15);
      for (let d = 0; d < dates.length; d += 15) {
        const orderDates = dates.slice(d, d + 15);
        for (let i = 0; i < rates.length; i += 15) {
          const values = rates.slice(i, i + 15);
          $('form-status').textContent = `Processando ${prefix ? 'B' : 'A'} · lote ${batches.length + 1}/${total} · ${dates.length} datas × ${rates.length} taxas…`;
          batches.push(await api('SURFACE', input, { surface: { ...surface, order_dates: orderDates, values, selected: { order_date: orderDates[0], value: values[0] } } }, run));
        }
      }
      const response = mergeSurfaces(batches, surface);
      const points = response.result?.points || [];
      if (!points.length) throw new Error(pendingMessage(response, prefix));
      return { revision: run, input, surface, response, points, firstDate: dates[0], lastDate: dates.at(-1), ...(bootstrap.simple_screen ? { dateDensity: density, alignedDates: density === 2048 ? false : Boolean(sharedDates) } : {}), ...(density === 2048 ? { dateStepDays: step, convergedDates: converged } : {}), capturedAt: new Date().toISOString() };
    }
    async function renderRecord() {
      const run = revision;
      $('stale').hidden = true; $('results').classList.remove('is-stale');
      for (const id of ['chart', 'chart-hint', 'coverage']) $(id).hidden = false;
      $('date-reading').hidden = false;
      $('chart-keyboard-tools').hidden = false;
      $('chart-empty').hidden = true; $('point-details').hidden = true;
      const { input } = current, { start, end } = input.analysis_context.timeline;
      $('comparison-display').hidden = !current.comparison;
      for (const [id, input] of [['a', current.input], ['b', current.comparison?.input]]) {
        const record = id === 'a' ? current : current.comparison;
        if (input) $('show-' + id + '-label').textContent = `${id.toUpperCase()} · ${input.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${input.instrument.series_year}${record.outsidePeriod ? current.overview ? ' · fora do trecho' : ' · fora do período' : ''}`;
      }
      renderSimulationFacts();
      $('refine-selection').textContent = `${current.overview ? 'Trecho selecionado' : 'Visão geral'} · ${p.formatDate(start)} a ${p.formatDate(end)} · ${rateText(current.surface.values[0])} a ${rateText(current.surface.values.at(-1))}.`;
      syncChartInteraction();
      const outside = records(true).filter(item => item.record.outsidePeriod);
      $('outside-period-status').hidden = !outside.length;
      $('outside-period-status').textContent = outside.map(item => `${item.id} · fora ${current.overview ? 'do trecho selecionado' : 'do período'}: ${outsideMessage(item.record)}.${current.overview ? ' A visão geral permanece preservada para o duplo clique.' : ''}`).join(' ');
      $('mesh-status').textContent = current.dateStepDays
        ? `Pontos a cada ${current.dateStepDays} ${current.dateStepDays === 1 ? 'dia' : 'dias'} corridos, ajustados para sessões elegíveis.${current.comparison ? ' A e B convergem nas datas do período compartilhado; os trechos individuais são preservados.' : ''} As extremidades do período também são calculadas.`
        : current.alignedDates
        ? `${current.surface.order_dates.length} datas comuns a A e B · ${p.formatDate(current.firstDate)} a ${p.formatDate(current.lastDate)}. A comparação usa somente o período em que ambos permitem saída; trechos fora dele não são calculados.`
        : `${current.surface.order_dates.length} datas calculadas, respeitando os limites do produto.`;
      renderColumnControls(); renderReading(); await renderChart(); check(run); syncActions();
      $('input-summary').textContent = inputSummary(); $('edit-inputs').hidden = false;
    }
    async function simulate(event) {
      event.preventDefault(); if (busy) return;
      if (!bootstrap) {
        if (!$('simulate').disabled) await loadBootstrap();
        return;
      }
      setInputsCollapsed(false);
      let collapseAfterRun = false;
      showError(''); $('confirm-purchase').hidden = true;
      refineMessage('');
      let draft, other;
      try { draft = readInput(); other = $('compare-enabled').checked ? readInput('b-') : null; } catch (error) { showError(error.message); return; }
      const run = ++revision; detailRevision++; busy = true; $('point-details').hidden = true; $('simulate').disabled = true; $('simulate').textContent = 'Processando…'; $('results').setAttribute('aria-busy', 'true');
      syncActions();
      // A new attempt supersedes the previous displayed result even when inputs did not change.
      if (current) { $('stale').hidden = false; $('results').classList.add('is-stale'); }
      try {
        $('form-status').textContent = 'Processando · conferindo a compra e as datas elegíveis…';
        notifyCalculation('Processando simulação…', 'processing');
        const density = bootstrap.simple_screen?.date_step_days === 15 ? 2048 : bootstrap.simple_screen?.max_dates >= 61 ? 61 : 15;
        const plan = await gridPlan([draft.input, ...(other ? [other.input] : [])], run, density);
        const scenario = async (value, prefix) => {
          try { return { ...await calculateGrid(value.input, value.rates, value.inflation, run, plan.dateSets[prefix ? 1 : 0], prefix, plan.bounds[prefix ? 1 : 0], density, 15, Boolean(other)), divisions: value.divisions }; }
          catch (error) {
            if (error instanceof Superseded || !other) throw error;
            if (error.code === 'NO_ELIGIBLE_DATE') {
              if (!bootstrap.simple_screen?.outside_original) throw new Error('Reinicie o aplicativo para salvar uma janela em que apenas um produto permite saída.');
              applyInflation(value.input, value.inflation, error.purchase);
              return outsideRecord(value.input, value.rates, run, value.divisions, error, null, density, 15, true);
            }
            return { revision: run, pending: true, pendingError: friendlyMessage(error.message), input: value.input, divisions: value.divisions, points: [],
              surface: { values: value.rates, order_dates: [] }, response: { result: { points: [] }, coverage: {} }, firstDate: null, lastDate: null };
          }
        };
        const primary = await scenario(draft, '');
        if (other) {
          primary.comparison = await scenario(other, 'b-');
        }
        if (primary.outsidePeriod && primary.comparison?.outsidePeriod) throw new Error('Nenhum dos produtos tem saída elegível no período informado. Ajuste as datas.');
        current = primary;
        ensureName(current.input); setSaveState('Resultado não salvo');
        await renderRecord(); check(run);
        const ready = records(true).reduce((total, item) => total + item.record.points.filter(point => metricValue(point, 'net_redemption') != null).length, 0);
        $('form-status').textContent = ready ? 'Simulação concluída.' : 'Sem resultados. Confira os dados.';
        if (!ready || current.pending) showError(current.pendingError || pendingMessage(current.response));
        if (ready && current.comparison && !current.comparison.outsidePeriod && !current.comparison.points.some(point => metricValue(point, 'net_redemption') != null)) {
          showError('Simulação B: ' + (current.comparison.pendingError || pendingMessage(current.comparison.response, 'b-')));
          $('form-status').textContent = 'A calculada. B tem pendências.';
        }
        if (current.pending && current.comparison?.points.some(point => metricValue(point, 'net_redemption') != null)) $('form-status').textContent = 'B calculada. A tem pendências; confira a mensagem.';
        if (hasPendingComparison()) setSaveState('Comparação pendente');
        collapseAfterRun = ready > 0 && !hasPendingComparison();
        recordMessage('');
        notifyCalculation(hasPendingComparison() ? 'Processamento concluído com pendências. Confira os avisos.' : ready ? 'Simulação concluída.' : 'Processamento concluído sem pontos disponíveis.', hasPendingComparison() || !ready ? 'warning' : 'success');
      } catch (error) {
        if (!(error instanceof Superseded)) { showError(error.message); $('form-status').textContent = 'A simulação não foi concluída. Confira os dados e tente novamente.'; notifyCalculation('Não foi possível concluir a simulação. Confira o aviso junto ao botão.', 'error'); } else notifyCalculation('Processamento interrompido: entradas alteradas. Simule novamente.', 'warning');
      } finally { busy = false; $('simulate').disabled = false; $('simulate').textContent = 'Simular saídas'; $('results').setAttribute('aria-busy', 'false'); syncActions(); }
      if (collapseAfterRun && isCurrent() && window.matchMedia('(max-width: 1023px)').matches) setInputsCollapsed(true, true);
    }
    const recordMessage = (text, error = false) => { clearTimeout(openMessageTimer); $('record-status').textContent = friendlyMessage(text); $('record-status').hidden = !text; $('record-status').classList.toggle('error', error); if ($('continuity').open) { $('files-status').textContent = text ? friendlyMessage(text) : ''; $('files-status').classList.toggle('error', error); } };
    const refineMessage = (text, error = false) => { $('refine-status').textContent = text ? friendlyMessage(text) : ''; $('refine-status').classList.toggle('error', error); };
    async function refine(selection) {
      if (busy || !isCurrent() || hasPendingComparison()) return;
      const previous = current, overview = current.overview || current;
      let input, rates, minimum, maximum;
      const requestedDivisions = 8; let divisions;
      try {
        const period = selectedPeriod([selection.start, selection.end], overview.input.analysis_context.timeline);
        if (!period) throw new Error('Selecione um trecho dentro do período das entradas.');
        const low = overview.surface.values[0], high = overview.surface.values.at(-1);
        const min = workspace.compareSurfaceDecimal(selection.minimum, low) < 0 ? low : selection.minimum;
        const max = workspace.compareSurfaceDecimal(selection.maximum, high) > 0 ? high : selection.maximum;
        minimum = workspace.formatPtNumber(workspace.shiftDecimal(min, 2), -1);
        maximum = workspace.formatPtNumber(workspace.shiftDecimal(max, 2), -1);
        rates = ratesForWindow(minimum, maximum, overview.input.entry_price.annual_real_rate, requestedDivisions);
        divisions = effectiveRateDivisions(minimum, maximum, requestedDivisions);
        input = clone(overview.input); input.analysis_context.timeline = { mode: 'WINDOW', ...period };
      } catch (error) { refineMessage(error.message, true); return; }
      const run = ++revision; busy = true; detailRevision++; $('simulate').disabled = true; $('results').setAttribute('aria-busy', 'true'); syncActions();
      refineMessage('Processando novos pontos no trecho, com a compra preservada…');
      $('form-status').textContent = 'Processando trecho…';
      notifyCalculation('Processando o trecho selecionado…', 'processing');
      try {
        const density = overview.dateStepDays && bootstrap.simple_screen?.date_step_days === 15 ? 2048 : overview.dateDensity || 15;
        const days = Math.round((Date.parse(input.analysis_context.timeline.end) - Date.parse(input.analysis_context.timeline.start)) / DAY);
        const step = Math.min(15, Math.max(1, Math.ceil(days / 1800)));
        const otherInput = overview.comparison ? clone(overview.comparison.input) : null;
        if (otherInput) otherInput.analysis_context.timeline = clone(input.analysis_context.timeline);
        const plan = await gridPlan([input, ...(otherInput ? [otherInput] : [])], run, density, step);
        const scenario = async (value, values, index, original) => {
          if (plan.bounds[index]?.error?.code === 'NO_ELIGIBLE_DATE') {
            if (!bootstrap.simple_screen?.outside_period) throw new Error('Reinicie o aplicativo para detalhar um produto enquanto o outro está fora do período.');
            return outsideRecord(value, values, run, divisions, plan.bounds[index].error, original, density, step, Boolean(otherInput));
          }
          return { ...await calculateGrid(value, values, null, run, plan.dateSets[index], index ? 'b-' : '', plan.bounds[index], density, step, Boolean(otherInput)), divisions };
        };
        const refined = await scenario(input, rates, 0, overview); check(run);
        if (overview.comparison) {
          const otherRates = ratesForWindow(minimum, maximum, otherInput.entry_price.annual_real_rate, requestedDivisions);
          refined.comparison = { ...await scenario(otherInput, otherRates, 1, overview.comparison), overview: overview.comparison };
        }
        if (refined.outsidePeriod && (!refined.comparison || refined.comparison.outsidePeriod)) throw new Error('Nenhum dos produtos tem saída elegível no trecho selecionado.');
        current = { ...refined, overview }; await renderRecord(); check(run);
        setSaveState('Trecho não salvo');
        refineMessage('Trecho refinado calculado. Dê duplo clique no gráfico para voltar à visão geral.');
        recordMessage('Trecho atualizado. Salve para guardar também a visão geral.');
        $('form-status').textContent = 'Trecho refinado concluído.';
        notifyCalculation('Cálculo do trecho concluído.', 'success');
      } catch (error) {
        if (!(error instanceof Superseded)) { current = { ...previous, revision: run }; refineMessage(error.message, true); $('form-status').textContent = 'Não foi possível concluir o trecho.'; notifyCalculation('Não foi possível concluir o trecho. Confira os dados do intervalo.', 'error'); } else notifyCalculation('Processamento interrompido: entradas alteradas. Simule novamente.', 'warning');
      } finally { busy = false; $('simulate').disabled = false; $('results').setAttribute('aria-busy', 'false'); syncActions(); }
    }
    async function resetRefinement() {
      if (busy || !isCurrent() || !current.overview) return;
      current = { ...current.overview, revision: ++revision }; detailRevision++;
      setSaveState('Visão geral restaurada');
      await renderRecord(); refineMessage('Visão geral restaurada, sem recalcular.');
      $('form-status').textContent = 'Visão geral restaurada.'; notifyCalculation('Visão geral restaurada.', 'success');
    }
    async function jsonRequest(path, body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), path === '/api/simulator/save' ? 900000 : 90000);
      try {
        const response = await request(path, body === undefined ? { signal: controller.signal } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': bootstrap.csrf_token }, body: JSON.stringify(body), signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(friendlyMessage(value.error || 'Não foi possível concluir a operação.'));
        return value;
      } catch (error) { if (error.name === 'AbortError') throw new Error('Tempo de espera excedido. Tente novamente; a gravação anterior será reconhecida.'); throw new Error(friendlyMessage(error.message)); }
      finally { clearTimeout(timer); }
    }
    async function refreshSaved(selectedId = '') {
      const run = ++savedListRevision; loadingSaved = true; syncActions();
      $('files-status').textContent = 'Carregando simulações salvas…';
      try {
        const value = await jsonRequest('/api/simulator/scenarios');
        if (run !== savedListRevision) return;
        const saved = value.scenarios.filter(item => item.single_screen);
        $('saved-simulation').replaceChildren(element('option', 'Escolha uma simulação salva'));
        $('saved-simulation').firstChild.value = '';
        for (const record of saved) { const option = element('option', `${record.name} · revisão ${record.revision}`); option.value = record.id; $('saved-simulation').append(option); }
        $('files-status').textContent = saved.length ? `${saved.length} simulações disponíveis neste computador.` : 'Nenhuma simulação salva. Simule e clique em Salvar para guardar a primeira.';
        $('saved-simulation').value = selectedId;
      } finally { if (run === savedListRevision) { loadingSaved = false; syncActions(); } }
    }
    function readOverlays(partial = false) {
      const errors = [];
      const read = fn => { try { return fn(); } catch (error) { errors.push(error.message); return null; } };
      const goal = read(() => {
        if (!$('goal-enabled').checked) return null;
        let value = workspace.parsePtDecimal($('goal-value').value, 'Valor da meta');
        if (value == null || workspace.compareSurfaceDecimal(value, '0') < 0) throw new Error('Informe uma meta mínima maior ou igual a zero.');
        const metric = $('goal-metric').value;
        return { metric, value: metric.endsWith('return') ? workspace.shiftDecimal(value, -2) : value };
      });
      const reference = read(() => {
        if (!$('reference-enabled').checked) return null;
        let value = workspace.parsePtDecimal($('reference-value').value, 'Ganho por ano');
        if (value == null) throw new Error('Informe o ganho por ano.');
        const mode = $('reference-mode').value;
        if (mode === 'PERCENT') value = workspace.shiftDecimal(value, -2);
        if (mode === 'PERCENT' && workspace.compareSurfaceDecimal(value, '-1') <= 0) throw new Error('O ganho percentual precisa ser maior que −100% ao ano.');
        return { mode, value };
      });
      if (errors.length && !partial) throw new Error(errors.join(' '));
      return { goal, reference, ...(partial ? { errors } : {}) };
    }
    function fullView() {
      const view = snapshotView(current, displayedMetric, null);
      view.overlays = readOverlays();
      view.fit_overlays = $('fit-overlays').checked;
      view.overlay_fill = { goal: $('goal-fill').checked, reference: $('reference-fill').checked };
      view.table = clone(tablePrefs);
      if (chartUI) view.chart_controls = chartUI.snapshot();
      view.visibility = { a: $('show-a').checked, b: $('show-b').checked };
      if (current.comparison) view.comparison = { view: snapshotView(current.comparison, displayedMetric, null) };
      const allowed = new Set(['goal', ...records(true).flatMap(({ id, record }) => [`projection:${id}`, ...[record, record.overview].filter(Boolean).flatMap(item => item.surface.values.map(rate => `simulation:${id}:${workspace.shiftDecimal(rate, 0)}`))])]);
      hiddenLegend = new Set([...hiddenLegend].filter(key => allowed.has(key)));
      view.legend_hidden = [...hiddenLegend].sort();
      return view;
    }
    function restoreOverlays(overlays = {}) {
      const goal = overlays?.goal, reference = overlays?.reference;
      $('goal-enabled').checked = Boolean(goal); $('goal-inputs').hidden = !goal;
      if (goal) { $('goal-metric').value = goal.metric; $('goal-value').value = workspace.formatPtNumber(goal.metric.endsWith('return') ? workspace.shiftDecimal(goal.value, 2) : goal.value, -1); }
      $('reference-enabled').checked = Boolean(reference); $('reference-inputs').hidden = !reference;
      if (reference) { $('reference-mode').value = reference.mode; $('reference-value').value = workspace.formatPtNumber(reference.mode === 'PERCENT' ? workspace.shiftDecimal(reference.value, 2) : reference.value, -1); }
      $('reference-label').textContent = $('reference-mode').value === 'PERCENT' ? 'Ganho ao ano (%)' : 'Ganho ao ano (R$)';
      syncOverlaySuggestions();
      overlayError = false;
    }
    function renderGoals(goal, info) {
      $('goal-results').replaceChildren();
      $('goal-query').hidden = !goal;
      if (!goal) return;
      if (['different_projections', 'missing_basis'].includes(info.state)) { $('goal-results').append(element('p', 'Consulta da meta desativada nesta exibição. Use a medida original para conferir os pontos.')); return; }
      const label = $('goal-metric').selectedOptions[0].textContent;
      $('goal-results').append(element('p', `${label}: ${goal.metric.endsWith('return') ? p.formatPercent(goal.value, 2) : money(goal.value)}. Primeira data calculada que atinge a meta; não indica a primeira data entre pontos nem garante resultado futuro.`));
      const table = element('table'), head = element('thead'), body = element('tbody'), header = element('tr');
      for (const text of ['Simulação / taxa', 'Primeiro ponto que atinge']) header.append(element('th', text));
      head.append(header);
      for (const item of records()) for (const result of goalSummary(item.record, goal)) {
        const row = element('tr'); row.append(element('td', `${item.id} · ${rateText(result.rate)}`), element('td', `${result.first ? p.formatDate(result.first) : 'Não atingida nos pontos disponíveis'}${result.partial ? ' · cobertura parcial' : ''}`)); body.append(row);
      }
      table.append(head, body); const wrap = element('div'); wrap.className = 'table-wrap'; wrap.append(table); $('goal-results').append(wrap);

    }
    async function saveSimulation(asCopy = false) {
      if (busy || chartRendering || !isCurrent() || hasPendingComparison() || overlayError) return false;
      const run = revision, overview = current.overview || current;
      const name = ensureName(overview.input);
      const body = { schema_version: 2, name, consent: true, input: clone(overview.input),
        ...(overview.comparison ? { reference: { label: 'Simulação B', input: clone(overview.comparison.input) } } : {}),
        view: { metric: displayedMetric, single_screen: fullView() },
        ...(!asCopy && savedRecord ? { record_id: savedRecord.id, expected_revision: savedRecord.revision } : {}) };
      saveOperation = workspace.saveOperationForPayload(saveOperation, body, () => crypto.randomUUID().replace(/-/g, ''));
      busy = true; $('simulate').disabled = true; syncActions(); recordMessage('Conferindo os valores com o motor e salvando neste computador…');
      try {
        const preferences = { version: 1, chart_controls: body.view.single_screen.chart_controls, fit_overlays: body.view.single_screen.fit_overlays, overlay_fill: body.view.single_screen.overlay_fill, legend_hidden: body.view.single_screen.legend_hidden, support: presentationSupport(body.view.single_screen) };
        const pendingKey = 'tesouro-marcado:view:pending:' + saveOperation.id;
        const { saved, legacy } = await saveWithPresentationCompatibility({ ...body, operation_id: saveOperation.id },
          request => jsonRequest('/api/simulator/save', request), () => {
            try { window.localStorage.setItem(pendingKey, JSON.stringify(preferences)); }
            catch (_) { throw new Error('O aplicativo aberto usa regras anteriores e este navegador não permitiu guardar as opções visuais. As entradas foram preservadas. Reinicie o aplicativo para salvar com as regras atuais.'); }
          });
        if (legacy) {
          window.localStorage.setItem(localPreferencesKey(saved.id, saved.revision, saved.snapshot_sha256), JSON.stringify(preferences));
          window.localStorage.removeItem(pendingKey);
        }
        savedRecord = { id: saved.id, revision: saved.revision, calculationRevision: run }; saveOperation = null;
        showRecordInfo(saved.revision, saved.created_at);
        let unchanged = false;
        try { unchanged = run === revision && $('simulation-name').value.trim() === name && JSON.stringify(fullView()) === JSON.stringify(body.view.single_screen); } catch (_) {}
        setSaveState(unchanged ? `Salvo · revisão ${saved.revision}` : 'Alterações não salvas');
        savedFingerprint = JSON.stringify({ name, view: body.view.single_screen });
        if (unchanged) formEdited = false;
        recordMessage(unchanged ? `Salva: ${name} · revisão ${saved.revision}.${legacy ? ' Opções de escala e hachuras guardadas neste navegador; o processo aberto usa regras anteriores. Ao reiniciar o aplicativo, novas gravações incluirão essas opções no registro.' : ''}` : `A versão anterior foi salva como ${name}. As alterações atuais ainda não foram salvas.`);
        try { await refreshSaved(saved.id); } catch (_) { recordMessage(`Simulação salva na revisão ${saved.revision}. Não foi possível atualizar a lista; reabra a tela para consultá-la.`); }
        return unchanged;
      } catch (error) { recordMessage(error.message, true); return false; }
      finally { busy = false; $('simulate').disabled = false; syncActions(); }
    }
    function restoreForm(input, surface, prefix = '') {
      const at = id => $(prefix + id);
      const options = productOptions(input.instrument);
      at('family').replaceChildren(...options.map(item => {
        const option = element('option', item.label); option.value = item.value; option.disabled = Boolean(item.disabled); return option;
      }));
      at('family').value = options[0].disabled ? options[0].value : input.instrument.family;
      at('purchase').value = input.purchase_date; at('capital-mode').value = input.capital.mode;
      at('budget').value = workspace.formatPtNumber(input.capital.value, -1); syncCapitalLabel(prefix);
      at('entry-mode').value = input.entry_price.mode === 'MANUAL_PU' ? 'PU' : 'RATE'; syncEntryLabel(prefix);
      at('entry').value = input.entry_price.pu != null ? workspace.formatPtNumber(input.entry_price.pu, -1) : workspace.formatPtNumber(roundPercent(workspace.shiftDecimal(input.entry_price.annual_real_rate, 2)), 2);
      if (!prefix) {
        $('start').value = input.analysis_context.timeline.start; $('end').value = input.analysis_context.timeline.end;
        manualDates.add('start'); manualDates.add('end');
        $('rate-min').value = workspace.formatPtNumber(roundPercent(workspace.shiftDecimal(surface.values[0], 2)), 2);
        $('rate-max').value = workspace.formatPtNumber(roundPercent(workspace.shiftDecimal(surface.values.at(-1), 2)), 2);
      }
      at('inflation').value = input.assumptions.inflation_projection ? workspace.formatPtNumber(roundPercent(workspace.shiftDecimal(input.assumptions.inflation_projection.annual_rate, 2)), 2) : '';
      at('entry-fee').value = workspace.formatPtNumber(input.assumptions.entry_fee.fixed_brl, -1); at('exit-fee').value = workspace.formatPtNumber(input.assumptions.exit_fee_brl, -1);
    }
    async function openSimulation(confirmed = false, selectedId = $('saved-simulation').value) {
      const dialog = $('continuity');
      if (busy || !selectedId || !dialog.open) return;
      if (!confirmed && unsavedChanges()) {
        pendingOpenId = selectedId; $('open-warning').hidden = false; $('open-simulation').hidden = true;
        $('files-status').textContent = 'Salve as alterações ou escolha abrir sem salvar.'; syncActions(); $('cancel-open').focus(); return;
      }
      const previousRevision = revision, previousName = $('simulation-name').value;
      let applied = false;
      const run = ++revision; busy = true; detailRevision++; $('simulate').disabled = true; syncActions(); recordMessage('Abrindo os valores registrados…');
      try {
        const record = await jsonRequest('/api/simulator/scenario?id=' + encodeURIComponent(selectedId));
        if (!dialog.open) return;
        check(run);
        const view = clone(record.snapshot.view?.single_screen || null);
        try {
          const raw = window.localStorage.getItem(localPreferencesKey(record.id, record.revision, record.snapshot.snapshot_sha256));
          const prefs = raw && raw.length < 128 * 1024 ? JSON.parse(raw) : null;
          if (prefs?.version === 1 && typeof prefs.fit_overlays === 'boolean' && typeof prefs.overlay_fill?.goal === 'boolean' && typeof prefs.overlay_fill?.reference === 'boolean') {
            if (prefs.chart_controls) view.chart_controls = chartWorkbench?.normalize(prefs.chart_controls);
            view.fit_overlays = prefs.fit_overlays; view.overlay_fill = prefs.overlay_fill; applyPresentationSupport(view, prefs.support);
            if (Array.isArray(prefs.legend_hidden) && prefs.legend_hidden.length <= 128 && prefs.legend_hidden.every(key => typeof key === 'string' && key.length <= 100)) view.legend_hidden = prefs.legend_hidden;
          }
        } catch (_) {}
        if (!view || (!unpackSurface(view.result).points?.length && !(view.outside_period && unpackSurface(view.comparison?.view.result).points?.length))) throw new Error('Esta fotografia não contém um gráfico da tela única. Consulte as ferramentas anteriores.');
        const restore = (cache, input, surface, divisions, metadata = {}) => {
          const outsidePeriod = cache == null;
          cache = unpackSurface(cache);
          const points = cache.points.map(point => ({ ...point, reason: point.reason == null ? null : cache.reasons[point.reason] }));
          return { revision: run, input, surface, divisions, ...(outsidePeriod ? { outsidePeriod: true, outsideOriginal: metadata.outside_original === true, outsideReason: metadata.outside_reason } : {}), response: { result: { points, ...(cache.overlay_support ? { overlay_support: cache.overlay_support } : {}) }, coverage: cache.coverage, source_versions: cache.source_versions, engine_manifest: cache.engine_manifest },
            points, firstDate: [...new Set(points.map(item => item.order_date))].sort()[0], lastDate: [...new Set(points.map(item => item.order_date))].sort().at(-1),
            capturedAt: record.snapshot.captured_at, stored: true, compatibility: record.compatibility };
        };
        const input = clone(record.snapshot.input), activeInput = clone(input);
        const detailed = Boolean(view.overview_result || view.comparison?.view.overview_result || view.period.start !== input.analysis_context.timeline.start || view.period.end !== input.analysis_context.timeline.end);
        activeInput.analysis_context.timeline = { mode: 'WINDOW', ...view.period };
        const loaded = restore(view.result, activeInput, view.surface, view.divisions || (detailed ? 8 : 4), view);
        if (detailed) loaded.overview = restore(overviewCache(view), input, view.overview_surface, view.overview_divisions || 4, view);
        if (view.comparison) {
          const other = view.comparison.view, otherInput = clone(record.snapshot.reference.input), otherActive = clone(otherInput);
          otherActive.analysis_context.timeline = { mode: 'WINDOW', ...other.period };
          loaded.comparison = restore(other.result, otherActive, other.surface, other.divisions || 4, other);
          if (detailed) { loaded.comparison.overview = restore(overviewCache(other), otherInput, other.overview_surface, other.overview_divisions || 4, other); loaded.overview.comparison = loaded.comparison.overview; }
        }
        for (const item of [loaded, loaded.overview, loaded.comparison, loaded.comparison?.overview].filter(Boolean)) {
          if (view.date_density) { item.dateDensity = view.date_density; item.alignedDates = view.aligned_dates === true; }
          if (view.date_step_days) { item.dateStepDays = item === loaded.overview || item === loaded.comparison?.overview ? view.overview_date_step_days : view.date_step_days; item.convergedDates = view.converged_dates; }
        }
        current = loaded; savedRecord = { id: record.id, revision: record.revision, calculationRevision: run }; saveOperation = null; applied = true;
        setSaveState(`Salvo · revisão ${record.revision}`); automaticName = '';
        $('saved-simulation').value = record.id;
        if ($('saved-simulation').selectedOptions[0]) $('saved-simulation').selectedOptions[0].textContent = `${record.name} · revisão ${record.revision}`;
        restoreForm(input, view.overview_surface); $('simulation-name').value = record.name; displayedMetric = view.metric;
        $('divisions').value = view.overview_divisions || 4;
        divisionHelp();
        $('compare-enabled').checked = Boolean(view.comparison); comparisonInitialized = Boolean(view.comparison); syncComparison(false);
        if (view.comparison) restoreForm(record.snapshot.reference.input, view.comparison.view.overview_surface, 'b-');
        $('show-a').checked = view.visibility?.a !== false; $('show-b').checked = view.visibility?.b !== false;
        tablePrefs = tablePreferences(view.table);
        restoreOverlays(view.overlays); $('fit-overlays').checked = view.fit_overlays !== false;
        hiddenLegend = new Set(view.legend_hidden || []);
        chartUI?.restore(view.chart_controls);
        $('goal-fill').checked = view.overlay_fill?.goal === true; $('reference-fill').checked = view.overlay_fill?.reference === true; syncStepperStates();
        $('confirm-purchase').hidden = true; showError('');
        if (requiresRateRecalculation(input, view, record.snapshot.reference?.input)) {
          $('continuity').close(); chartUI?.clear(); current = null;
          for (const id of ['chart', 'rate-history', 'point-details']) $(id).hidden = true;
          $('chart-empty').hidden = false; busy = false; formEdited = true;
          await simulate({ preventDefault() {} });
          recordMessage(isCurrent() ? 'Taxas arredondadas a duas casas. Resultado recalculado; salve uma revisão para guardar.' : 'Taxas arredondadas. Simule novamente para atualizar os resultados.');
          return;
        }
        await renderRecord(); check(run);
        savedFingerprint = fingerprint(); formEdited = false; $('continuity').close();
        showRecordInfo(record.revision, record.snapshot.captured_at, record.compatibility.state === 'EXACT_SNAPSHOT_AVAILABLE');
        recordMessage(`Aberta: ${record.name}.`);
        openMessageTimer = setTimeout(() => { $('record-status').hidden = true; $('record-status').textContent = ''; }, 8000);
        $('form-status').textContent = 'Pronta para usar.';
      } catch (error) {
        if (!(error instanceof Superseded) && (dialog.open || applied)) recordMessage(error.message, true);
      } finally {
        if (!applied && revision === run) {
          revision = previousRevision;
          if (!dialog.open) {
            if ($('simulation-name').value !== previousName && isCurrent()) markNameEdited();
            else recordMessage('');
          }
        }
        busy = false; $('simulate').disabled = false; syncActions();
      }
    }
    async function exportSimulation() {
      if (busy || chartRendering || !isCurrent() || hasPendingComparison() || overlayError) return;
      const run = revision, overview = current.overview || current, view = fullView(), name = $('simulation-name').value.trim() || 'Simulação Tesouro Marcado';
      const historyContext = historyUI?.capture() || {};
      if (view.comparison) view.comparison.input = clone((overview.comparison || current.comparison).input);
      busy = true; $('simulate').disabled = true; syncActions();
      try {
        if (current.overview) for (const item of [{ id: 'A', record: overview }, ...(overview.comparison ? [{ id: 'B', record: overview.comparison }] : [])]) {
          if (view.overlays.reference || (view.overlays.goal && view.overlays.goal.metric !== view.metric)) await recoverOverlayBases(item.record, async value => (await api('RESOLVE', value, {}, run)).resolved);
        }
        let chart = '', interactive = null;
        if (window.Plotly && !$('chart').hidden) {
          // Bundle the installed renderer so the exported document works offline.
          try {
            const response = await fetch('/tesouro-marcado/plotly.min.js');
            if (!response.ok) throw new Error('Gráfico indisponível');
            const source = await response.text(), graph = $('chart');
            interactive = { source, ...(chartUI?.exportModel() || { data: clone(graph.data), layout: clone(graph.layout) }) };
          } catch (_) {}
          try {
            const graph = $('chart'), bottom = 65 + Math.ceil(graph.data.length / 5) * 21, height = Math.max(460, 350 + bottom);
            const layout = { ...clone(graph.layout), width: 1100, height, margin: { ...graph.layout.margin, b: bottom },
              legend: { ...graph.layout.legend, y: -45 / (height - 20 - bottom) }, xaxis: { ...graph.layout.xaxis, tickformat: '%d/%m/%Y', nticks: 7 } };
            chart = await window.Plotly.toImage({ data: clone(graph.data), layout }, { format: 'svg', width: 1100, height });
          } catch (_) {}
        }
        check(run);
        const exportView = fullView();
        if (JSON.stringify({ ...view, comparison: view.comparison ? { view: view.comparison.view } : undefined }) !== JSON.stringify({ ...exportView, comparison: exportView.comparison })) throw new Error('A exibição mudou durante a exportação. Exporte novamente para incluir a exibição atual.');
        const recovered = Object.fromEntries(records(true).map(item => [item.id, item.record.recoveredBases]));
        if (current.overview) recovered.overview = { A: overview.recoveredBases, ...(overview.comparison ? { B: overview.comparison.recoveredBases } : {}) };
        const html = exportDocument(name, overview.input, view, chart, current.capturedAt, interactive, recovered,
          historyContext);
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        const link = element('a'); link.href = url; link.download = 'tesouro-marcado-simulacao.html'; doc.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        recordMessage(interactive ? 'HTML exportado com gráfico interativo offline e as colunas escolhidas.' : chart ? 'HTML exportado com as colunas escolhidas e uma imagem do gráfico. A interação não estava disponível.' : 'HTML exportado com as colunas escolhidas. O gráfico não estava disponível.');
      } catch (error) { recordMessage(error instanceof Superseded ? 'As entradas mudaram. Simule novamente antes de exportar.' : error.message, true); }
      finally { busy = false; $('simulate').disabled = false; syncActions(); }
    }
    function pointReason(point) { return point?.reason ? workspace.localizeWarning(typeof point.reason === 'object' ? point.reason.message || point.reason.code : point.reason) : p.label('status', point?.status || 'missing_metric'); }
    function records(includeHidden = false) {
      if (!current) return [];
      const all = [{ id: 'A', record: current }];
      if (current.comparison) all.push({ id: 'B', record: current.comparison });
      return includeHidden ? all : all.filter(item => !current.comparison || $(item.id === 'A' ? 'show-a' : 'show-b').checked);
    }
    function activeRecords() { return records().filter(item => !item.record.outsidePeriod); }
    function toggleLegend(trace) {
      const key = legendKey(trace);
      if (!key || !trace.y?.some(value => value != null) || busy) return;
      hiddenLegend.has(key) ? hiddenLegend.delete(key) : hiddenLegend.add(key);
      viewChanged(); renderChart().catch(error => recordMessage(error.message, true));
    }
    function renderMobileLegend(traces) {
      $('chart-legend').hidden = false;
      const list = $('chart-legend-list'); list.replaceChildren();
      const lines = traces.filter(trace => trace.meta?.kind !== 'overlay_fill');
      $('chart-legend').querySelector('summary').textContent = `Legenda · ${lines.length} linhas`;
      for (const trace of lines) {
        const label = element('label'), control = element('input'), swatch = element('span');
        control.type = 'checkbox'; control.checked = trace.visible !== 'legendonly' && trace.visible !== false;
        control.disabled = !trace.y?.some(value => value != null); control.addEventListener('change', () => toggleLegend(trace));
        swatch.className = 'legend-swatch'; swatch.style.borderColor = trace.line.color;
        if (trace.line.dash !== 'solid') swatch.style.borderTopStyle = 'dashed';
        label.append(control, swatch, doc.createTextNode(trace.name)); list.append(label);
      }
    }
    function syncChartInteraction() {
      const touch = touchChart();
      $('chart').dataset.interaction = touch ? 'touch' : 'mouse';
      $('chart-keyboard-tools').hidden = touch || !current;
      $('chart-touch-panel').hidden = !touch || !current;
      $('chart-reset').hidden = !touch || !current?.overview;
      $('chart-hint').textContent = touch
        ? `Toque em uma linha para ver os valores.${current?.overview ? ' Use Visão original para voltar.' : ''}`
        : current?.overview ? 'Duplo clique para voltar à visão original.' : 'Arraste no gráfico para ampliar.';
    }
    $('chart-reset').addEventListener('click', () => resetRefinement().catch(error => refineMessage(error.message, true)));
    $('chart-touch-details').addEventListener('click', () => {
      if (touchedPoint && isCurrent() && !busy) showPoint(touchedPoint.point, touchedPoint.record, touchedPoint.id);
    });
    function beginKeyboardSelection() {
      if (!isCurrent() || busy || hasPendingComparison() || !$('chart')._fullLayout) return;
      const period = current.input.analysis_context.timeline, y = $('chart').layout.yaxis.range;
      if (!y) return;
      const start = Date.parse(period.start), end = Date.parse(period.end);
      keyboardSelection = { x: [start + Math.floor((end - start) / DAY / 4) * DAY, start + Math.ceil((end - start) / DAY * .75) * DAY],
        y: [y[0] + (y[1] - y[0]) * .25, y[0] + (y[1] - y[0]) * .75] };
      $('chart').focus({ preventScroll: true }); $('chart').scrollIntoView({ block: 'center' }); drawKeyboardSelection();
    }
    function drawKeyboardSelection() {
      const area = keyboardSelection;
      const status = $('chart-keyboard-status'); status.hidden = !area;
      if (!area) { window.Plotly.relayout($('chart'), { shapes: [] }); return; }
      const dates = area.x.map(value => new Date(value).toISOString().slice(0, 10)).sort(), limits = [...area.y].sort((a, b) => a - b);
      window.Plotly.relayout($('chart'), { shapes: [{ type: 'rect', xref: 'x', yref: 'y', x0: dates[0], x1: dates[1], y0: limits[0], y1: limits[1],
        line: { color: '#287657', width: 2 }, fillcolor: 'rgba(40,118,87,0.08)' }] });
      const number = value => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + (displayedMetric.endsWith('return') ? '%' : ' R$');
      status.textContent = `Área: ${p.formatDate(dates[0])} a ${p.formatDate(dates[1])}, ${number(limits[0])} a ${number(limits[1])}. Enter detalha; Esc cancela.`;
    }
    $('start-keyboard-selection').addEventListener('click', beginKeyboardSelection);
    $('chart').addEventListener('keydown', event => {
      if (event.target !== $('chart') || !isCurrent() || busy) return;
      if (event.key === '0') { event.preventDefault(); resetRefinement().catch(error => refineMessage(error.message, true)); return; }
      if ((event.key === ' ' || event.key === 'Enter') && !keyboardSelection) { event.preventDefault(); beginKeyboardSelection(); return; }
      if (!keyboardSelection) return;
      if (event.key === 'Escape') { event.preventDefault(); keyboardSelection = null; drawKeyboardSelection(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const overview = current.overview || current;
        const selection = selectedGraphWindow(keyboardSelection, $('chart').data, overview.input.analysis_context.timeline, overview.surface.values);
        if (selection) refine(selection).catch(error => refineMessage(error.message, true));
        else notifyCalculation('A área não atravessa curvas disponíveis. Ajuste os limites com as setas.', 'warning');
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const index = event.shiftKey ? 0 : 1, period = current.input.analysis_context.timeline, y = $('chart').layout.yaxis.range;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') keyboardSelection.x[index] = Math.max(Date.parse(period.start), Math.min(Date.parse(period.end), keyboardSelection.x[index] + (event.key === 'ArrowLeft' ? -1 : 1) * DAY * (event.ctrlKey ? 15 : 1)));
      else keyboardSelection.y[index] = Math.max(y[0], Math.min(y[1], keyboardSelection.y[index] + (event.key === 'ArrowDown' ? -1 : 1) * (y[1] - y[0]) / 20));
      drawKeyboardSelection();
    });
    function renderAll() { /* All sampled dates are now shown in the main table. */ }
    function renderColumnControls() {
      const checkbox = (text, checked, changed) => {
        const label = element('label'), control = element('input'); label.className = 'check'; control.type = 'checkbox'; control.checked = checked;
        control.addEventListener('change', () => { changed(control.checked); viewChanged(); renderReading(); });
        label.append(control, doc.createTextNode(text)); return label;
      };
      $('metric-columns').replaceChildren(...METRICS.map(metric => checkbox(METRIC_LABELS[metric], tablePrefs.metrics.includes(metric), checked => {
        tablePrefs.metrics = METRICS.filter(id => id === metric ? checked : tablePrefs.metrics.includes(id));
      })));
      const rates = tableModel(records(true)).groups.map(group => group.rate);
      // Rates absent from a detail may return in the overview; retain their visibility choices.
      $('rate-columns').replaceChildren(...rates.map(rate => checkbox(rateLabel(rate), !tablePrefs.hidden_rates.some(hidden => workspace.compareSurfaceDecimal(hidden, rate) === 0), checked => {
        tablePrefs.hidden_rates = tablePrefs.hidden_rates.filter(hidden => workspace.compareSurfaceDecimal(hidden, rate) !== 0);
        if (!checked) tablePrefs.hidden_rates.push(rate);
      })));
    }
    function renderReading() {
      if (!isCurrent() || $('date-reading').hidden) return;
      const model = tableModel(records(), tablePrefs), compared = Boolean(current.comparison);
      const heading = element('tr'), subheading = element('tr'), date = element('th', 'Data da venda');
      date.scope = 'col'; date.rowSpan = 2; heading.append(date);
      let count = 0;
      for (const group of model.groups) {
        if (!group.columns.length) continue;
        const th = element('th', rateLabel(group.rate)); th.scope = 'colgroup'; th.colSpan = group.columns.length; heading.append(th);
        group.columns.forEach((column, index) => {
          const th = element('th', `${compared ? column.id + ' · ' : ''}${METRIC_LABELS[column.metric]}`); th.scope = 'col'; th.dataset.metric = column.metric;
          if (!index) th.className = 'rate-start';
          if (compared) th.title = `${column.id} · ${column.record.input.instrument.family === 'RENDA_PLUS' ? 'RendA+' : 'IPCA+'} ${column.record.input.instrument.series_year}`;
          subheading.append(th); count++;
        });
      }
      $('reading-head').replaceChildren(heading, subheading);
      $('reading-context').textContent = `${model.rows.length} datas · ${model.groups.length} taxas · ${tablePrefs.metrics.length} medidas por simulação. Role para os lados para ver mais taxas.`;
      $('reading-caption').textContent = 'Pontos calculados por data da venda, agrupados por taxa de saída, com as medidas escolhidas.';
      const rows = count ? model.rows.map(row => {
        const tr = element('tr'), th = element('th', p.formatDate(row.date)); th.scope = 'row'; tr.dataset.date = row.date; tr.append(th);
        row.cells.forEach((cell, index) => {
          const td = element('td'); td.className = 'reading-result'; td.dataset.scenario = cell.id; td.dataset.point = cell.point?.identity || '';
          if (index % (tablePrefs.metrics.length * records().length) === 0) td.classList.add('rate-start');
          const value = element(cell.value == null ? 'span' : 'button', valueText(cell.value, cell.metric)); value.className = 'reading-value'; value.dataset.metric = cell.metric;
          if (cell.value != null && workspace.compareSurfaceDecimal(cell.value, '0') < 0) value.classList.add('reading-negative');
          if (cell.value != null) {
            value.type = 'button'; value.setAttribute('aria-label', `Conferir ${cell.id}, ${p.formatDate(row.date)}, ${rateLabel(cell.rate)}, ${METRIC_LABELS[cell.metric]}: ${valueText(cell.value, cell.metric)}`);
            value.addEventListener('click', () => showPoint(cell.point, cell.record, cell.id));
          } else value.title = cell.point ? pointReason(cell.point) : cell.record.pendingError || 'Sem ponto calculado nesta data e taxa.';
          td.append(value); tr.append(td);
        });
        return tr;
      }) : [];
      if (!rows.length) { const tr = element('tr'), td = element('td', 'Nenhuma coluna de valores exibida. Marque taxas e medidas em Colunas exibidas e escolha as simulações A/B.'); td.colSpan = count + 1; tr.append(td); rows.push(tr); }
      $('reading-body').replaceChildren(...rows);
    }
    async function renderChart() {
      if (!isCurrent() || $('overlays').matches(':popover-open')) return;
      const chartRun = ++chartRevision, run = revision;
      chartRendering = true; syncActions();
      try {
      const metric = displayedMetric, groups = records().flatMap(item => seriesFor(item.record.points, metric).map(group => ({ ...group, record: item.record, id: item.id })));
      let overlays;
      try { overlays = readOverlays(true); overlayError = Boolean(overlays.errors.length); $('overlay-status').classList.toggle('error', overlayError); $('overlay-status').textContent = overlays.errors.join(' '); }
      catch (error) { overlays = { goal: null, reference: null }; overlayError = true; $('overlay-status').classList.add('error'); $('overlay-status').textContent = error.message; }
      if (overlays.reference || (overlays.goal && overlays.goal.metric !== metric)) {
        overlayProcessing = records().some(item => needsOverlayRecovery(item.record));
        if (overlayProcessing) { $('overlay-status').textContent = 'Processando referências com as entradas da simulação…'; syncActions(); }
        // Each record already resolves two dates at a time. Share the server's
        // two calculation slots between A/B instead of starting four requests.
        try { for (const item of records()) await recoverOverlayBases(item.record, async input => (await api('RESOLVE', input, {}, run)).resolved); }
        catch (error) { if (error instanceof Superseded) throw error; overlays.errors ||= []; overlays.errors.push(`Não foi possível preparar as referências: ${error.message}`); }
      }
      if (chartRun !== chartRevision || run !== revision) return;
      overlayProcessing = false;
      if ($('overlay-status').textContent.startsWith('Processando referências')) $('overlay-status').textContent = 'Preparação das referências concluída.';
      if (overlays.errors?.length) $('overlay-status').textContent = overlays.errors.join(' ');
      syncActions();
      const ready = current.points.filter(point => metricValue(point, metric) != null).length;
      const exclusions = current.response.coverage?.domain?.timeline_exclusions || [];
      const missing = current.points.length - ready;
      $('coverage-details').textContent = records(true).map(item => item.record.outsidePeriod ? `${item.id} · fora do período: ${outsideMessage(item.record)}.` : `${item.id} · sessões elegíveis de ${p.formatDate(item.record.firstDate)} a ${p.formatDate(item.record.lastDate)}.`).join(' ') + ' Os valores entre os pontos não foram calculados.';
      $('coverage').textContent = records(true).map(item => item.record.outsidePeriod ? `${item.id}: fora ${current.overview ? 'do trecho' : 'do período'}` : `${current.comparison ? item.id + ': ' : ''}${item.record.surface.values.length} taxas · ${item.record.surface.order_dates.length} datas · ${item.record.points.filter(point => metricValue(point, metric) != null).length}/${item.record.points.length} pontos`).join('  |  ') + (exclusions.length ? ' · ' + exclusions.map(item => item.reason).join(' ') : '');
      $('coverage').classList.toggle('partial', missing > 0 || exclusions.length > 0);
      const options = { visibility: { a: $('show-a').checked, b: $('show-b').checked }, fit_overlays: $('fit-overlays').checked,
        overlay_fill: { goal: $('goal-fill').checked, reference: $('reference-fill').checked }, legend_hidden: [...hiddenLegend] };
      const { traces, range, goalInfo, missingReference } = chartPresentation(records(true), metric, overlays, options);
      historyUI?.update({ scenarios: records().map(item => ({ id: item.id, family: item.record.input.instrument.family, year: item.record.input.instrument.series_year })),
        rates: [...new Set(traces.filter(trace => trace.meta?.kind === 'simulation').map(trace => trace.meta.rate))] });
      historyUI?.decorate(traces);
      if (overlays.reference && !overlayError) $('overlay-status').textContent = `${metric === 'real_return' ? 'Ganho projetado descontado pela inflação original de cada simulação, entre as liquidações.' : 'Ganho estimado desde a compra; não altera os resultados dos títulos.'}${missingReference ? ' Há projeções indisponíveis ou com lacunas por falta das bases originais. Simule novamente para atualizá-las.' : ''}`;
      if (overlays.errors?.length) $('overlay-status').textContent = overlays.errors.join(' ');
      if (!activeRecords().length) $('coverage').textContent = 'Nenhuma simulação com saídas neste trecho está exibida. Marque um produto com datas elegíveis para ver as curvas e tabelas.';
      renderGoals(overlays.goal, goalInfo);
      $('goal-notice').hidden = !overlays.goal;
      $('goal-notice').dataset.state = goalInfo.state;
      $('goal-status').textContent = goalInfo.message;
      $('goal-range').textContent = goalInfo.rangeText ? `${goalInfo.rangeText} ${$('fit-overlays').checked ? 'Escala ajustada para incluir as referências válidas.' : 'Trechos fora dessa faixa ficam recortados; marque Expandir escala para exibi-los.'}` : 'A meta só é exibida quando existe um equivalente único para as projeções e bases suficientes nesta medida.';
      $('show-goal-metric').hidden = !['different_projections', 'missing_basis'].includes(goalInfo.state);
      if (!window.Plotly) { $('chart').hidden = true; $('chart-hint').hidden = true; $('chart-workbench').hidden = true; $('date-reading').hidden = false; $('date-reading').open = true; renderReading(); $('coverage').textContent += ' Gráfico indisponível; os valores calculados estão nas tabelas abaixo.'; if (overlays.goal) $('goal-status').textContent = 'Gráfico indisponível. Consulte os pontos que atingem a meta em Metas e projeções.'; return; }
      keyboardSelection = null; $('chart-keyboard-status').hidden = true;
      touchedPoint = null; $('chart-touch-value').hidden = true; $('chart-touch-details').hidden = true;
      syncChartInteraction();
      const touch = touchChart();
      let layout = chartLayout(current.input.analysis_context.timeline, metric, traces, range, goalInfo, $('chart').clientWidth, window.innerWidth < 1050, window.innerWidth <= 760, touch);
      const enhanced = chartUI?.prepare(traces, layout, metric);
      const plotTraces = enhanced?.traces || traces; layout = enhanced?.layout || layout;
      $('chart').style.height = `${layout.height}px`;
      for (const event of ['plotly_click', 'plotly_hover', 'plotly_selected', 'plotly_legendclick', 'plotly_legenddoubleclick', 'plotly_deselect']) $('chart').removeAllListeners?.(event);
      clearTimeout(chartClickTimer);
      try {
        await window.Plotly.react($('chart'), plotTraces, layout, { responsive: true, displayModeBar: false, scrollZoom: false, doubleClick: false, showAxisDragHandles: false, showAxisRangeEntry: false });
      } catch (_) {
        $('chart').hidden = true; $('chart-hint').hidden = true; $('chart-workbench').hidden = true;
        $('date-reading').hidden = false; $('date-reading').open = true; renderReading();
        $('coverage').textContent += ' Não foi possível exibir o gráfico. Os cálculos estão disponíveis na tabela.';
        return;
      }
      renderMobileLegend(traces);
      $('chart').on('plotly_legendclick', event => { toggleLegend($('chart').data[event.curveNumber]); return false; });
      $('chart').on('plotly_legenddoubleclick', () => false);
      $('chart').on('plotly_hover', event => { const date = String(event.points?.[0]?.x || '').slice(0, 10); for (const row of $('reading-body').rows) row.classList.toggle('hover-date', row.dataset.date === date); });
      $('chart').on('plotly_click', event => {
        clearTimeout(chartClickTimer);
        const data = event.points?.[0]?.customdata, run = revision;
        if (chartUI && event.points?.[0]?.data?.meta?.kind === 'simulation') { chartUI.selectPoint(event.points[0]); return; }
        if (touchChart()) {
          if (!isCurrent() || busy) return;
          const text = chartPointText(event.points?.[0], displayedMetric);
          $('chart-touch-value').textContent = text; $('chart-touch-value').hidden = !text;
          const source = records().find(item => item.id === data?.[3]);
          const point = source?.record.points.find(item => item.identity === data?.[0]);
          touchedPoint = point ? { point, record: source.record, id: source.id } : null;
          $('chart-touch-details').hidden = !touchedPoint;
          return;
        }
        chartClickTimer = setTimeout(() => {
          if (!isCurrent() || busy || run !== revision || !data?.[0]) return;
          const source = records().find(item => item.id === data[3]);
          const point = source?.record.points.find(item => item.identity === data[0]);
          if (point) showPoint(point, source.record, source.id);
        }, 350);
      });
      // In selection mode Plotly reports the double click as deselect.
      $('chart').on('plotly_deselect', () => {
        clearTimeout(chartClickTimer);
        if (touchChart()) return;
        resetRefinement().catch(error => refineMessage(error.message, true));
      });
      $('chart').on('plotly_selected', event => {
        clearTimeout(chartClickTimer);
        if (touchChart() || !isCurrent() || busy || !event?.range) return;
        const overview = current.overview || current;
        const selection = selectedGraphWindow({ ...event.range, y: event.range.y || event.range.y2 }, $('chart').data, overview.input.analysis_context.timeline, overview.surface.values);
        if (!selection) { refineMessage('O retângulo não atravessa curvas de títulos com valores disponíveis. Arraste sobre as curvas para selecionar datas e taxas IPCA+.'); notifyCalculation('Selecione uma área que atravesse as curvas do gráfico.', 'warning'); return; }
        refine(selection).catch(error => refineMessage(error.message, true));
      });
      } finally { if (chartRun === chartRevision) { chartRendering = false; syncActions(); } }
    }
    async function showPoint(point, record = current, label = '') {
      if (!isCurrent()) return;
      const run = revision, detail = ++detailRevision;
      renderReading();
      for (const cell of $('reading-body').querySelectorAll('.reading-result')) cell.classList.toggle('selected', cell.dataset.point === point.identity && (!current.comparison || cell.dataset.scenario === label));
      $('point-details').hidden = false; $('point-details').open = true; $('point-values').replaceChildren(); $('point-status').textContent = 'Conferindo a operação…';
      if (current.stored && current.compatibility?.state !== 'EXACT_SNAPSHOT_AVAILABLE') { $('point-status').textContent = 'Os valores desta fotografia foram preservados. As fontes ou regras atuais diferem; clique em Simular saídas para recalcular antes de conferir a operação.'; return; }
      try {
        const selection = { sale_date: point.order_date, annual_real_rate: point.coordinate.value };
        const input = workspace.surfaceEvaluationInput(record.input, selection, true);
        const response = await api('EVALUATE', input, { selection }, run);
        if (detail !== detailRevision) return;
        const operation = response.result?.operation;
        if (!operation) { $('point-status').textContent = pendingMessage(response); return; }
        $('point-status').textContent = `${label ? label + ' · ' : ''}${p.formatDate(point.order_date)} · ${rateText(point.coordinate.value)} · liquidação em ${p.formatDate(point.settlement_date)}. Valores estimados sob as premissas informadas.`;
        const fields = [['Resgate bruto', operation.gross_redemption], ['Imposto de renda', operation.income_tax], ['IOF', operation.iof], ['Custódia', operation.custody], ['Resgate líquido', operation.net_redemption], ['Lucro líquido', operation.nominal_profit]];
        $('point-values').replaceChildren(...fields.map(([label, value]) => { const box = element('div'); box.append(element('dt', label), element('dd', money(value))); return box; }));
      } catch (error) { if (!(error instanceof Superseded) && detail === detailRevision) $('point-status').textContent = friendlyMessage(error.message); }
    }
    form.addEventListener('input', event => {
      if (event.target.id === 'compare-enabled') syncComparison(true);
      if (event.target.id === 'divisions') divisionHelp();
      if (['start', 'end'].includes(event.target.id)) manualDates.add(event.target.id);
      if (event.target.id === 'purchase') suggestDates();
      invalidate();
    });
    form.addEventListener('change', event => {
      const control = event.target, field = control.id.replace(/^b-/, ''), prefix = control.id.startsWith('b-') ? 'b-' : '';
      if (control.tagName === 'SELECT') invalidate();
      else if (['rate-min', 'rate-max', 'inflation'].includes(field) || field === 'entry' && $(prefix + 'entry-mode').value === 'RATE') {
        try { const value = workspace.parsePtDecimal(control.value); if (value != null) control.value = workspace.formatPtNumber(roundPercent(value), 2); syncStepperStates(); } catch (_) {}
      }
    });
    function clearRecordedProduct(prefix = '') {
      for (const option of $(prefix + 'family').querySelectorAll('option:disabled')) option.remove();
    }
    function syncCapitalLabel(prefix = '') {
      const quantity = $(prefix + 'capital-mode').value === 'QUANTITY', input = $(prefix + 'budget');
      $(prefix + 'capital-label').textContent = quantity ? 'Quantidade de títulos' : 'Valor disponível (R$)';
      input.required = quantity; input.placeholder = quantity ? '2,37' : '100.000,00'; input.dataset.suggestion = input.placeholder;
      $(prefix + 'capital-help').textContent = quantity ? 'Quantidade em múltiplos de 0,01.' : 'Em branco: R$ 100.000,00.';
    }
    function syncEntryLabel(prefix = '') {
      $(prefix + 'entry-label').textContent = $(prefix + 'entry-mode').value === 'RATE' ? 'Taxa da compra (% a.a.)' : 'Preço por título (R$)';
      const input = $(prefix + 'entry'); input.placeholder = $(prefix + 'entry-mode').value === 'RATE' ? '6,25' : '1.234,56'; input.dataset.suggestion = input.placeholder;
    }
    function stepSpec(input) {
      const prefix = input.id.startsWith('b-') ? 'b-' : '';
      const spec = numericStepSpec(input.id, { capital: $(prefix + 'capital-mode').value, entry: $(prefix + 'entry-mode').value,
        goal: $('goal-metric').value, reference: $('reference-mode').value });
      if (input.id === 'rate-min' || input.id === 'rate-max') {
        try {
          const other = workspace.parsePtDecimal($(input.id === 'rate-min' ? 'rate-max' : 'rate-min').value);
          if (other != null) spec[input.id === 'rate-min' ? 'max' : 'min'] = other;
        } catch (_) {}
      }
      return spec;
    }
    function syncStepperStates() {
      for (const input of doc.querySelectorAll('input[role="spinbutton"]')) {
        const spec = stepSpec(input);
        input.dataset.step = spec.step;
        for (const [key, value] of [['min', spec.min], ['max', spec.max]]) {
          if (value == null) input.removeAttribute('aria-value' + key); else input.setAttribute('aria-value' + key, value);
        }
        let value = null;
        input.setAttribute('aria-valuetext', input.value);
        try {
          value = workspace.parsePtDecimal(input.value);
          if (value == null) input.removeAttribute('aria-valuenow'); else input.setAttribute('aria-valuenow', value);
          if (value == null) value = workspace.parsePtDecimal(input.dataset.suggestion || '0');
        } catch (_) { input.removeAttribute('aria-valuenow'); }
        const spinner = input.parentElement.querySelector('.decimal-native-stepper');
        spinner.disabled = input.disabled || input.readOnly;
        for (const [bound, direction] of [['min', -1], ['max', 1]]) {
          const reached = value != null && spec[bound] != null && workspace.compareSurfaceDecimal(value, spec[bound]) * direction >= 0;
          if (reached) spinner.setAttribute(bound, '0'); else spinner.removeAttribute(bound);
        }
      }
    }
    function mountSteppers() {
      const labels = { budget: 'capital', entry: 'entrada', inflation: 'inflação', 'entry-fee': 'custo da compra', 'exit-fee': 'custo da venda',
        'rate-min': 'taxa mínima', 'rate-max': 'taxa máxima', 'goal-value': 'meta', 'reference-value': 'ganho' };
      for (const input of doc.querySelectorAll('input[inputmode="decimal"]')) {
        if (!numericStepSpec(input.id)) continue;
        const wrapper = element('span'), spinner = element('input'); wrapper.className = 'decimal-field';
        // Use the browser's own arrows and held-press repeat, as in the year field.
        // This counter supplies only direction; exact, localized arithmetic stays in the text field.
        spinner.type = 'number'; spinner.step = '1'; spinner.value = '0'; spinner.tabIndex = -1;
        spinner.className = 'decimal-native-stepper'; spinner.setAttribute('aria-hidden', 'true');
        spinner.title = `Ajustar ${labels[input.id.replace(/^b-/, '')]}${input.id.startsWith('b-') ? ' B' : ''}`;
        input.before(wrapper); wrapper.append(input, spinner); input.setAttribute('role', 'spinbutton');
        const adjust = direction => {
          try {
            const raw = input.value.trim() || input.dataset.suggestion || '0';
            input.value = incrementDecimal(raw, stepSpec(input), direction);
            input.dispatchEvent(new Event('input', { bubbles: true })); syncStepperStates();
          } catch (error) { input.focus(); showError(error.message); }
        };
        spinner.addEventListener('input', event => {
          event.stopPropagation();
          const direction = Math.sign(spinner.valueAsNumber); spinner.value = '0';
          if (direction && !input.disabled && !input.readOnly) adjust(direction);
        });
        spinner.addEventListener('change', event => event.stopPropagation());
        doc.addEventListener('pointerup', () => {
          if (doc.activeElement === spinner && !input.disabled) input.focus({ preventScroll: true });
        });
        input.addEventListener('keydown', event => {
          if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); adjust(event.key === 'ArrowUp' ? 1 : -1); }
        });
      }
      syncStepperStates();
    }
    function syncOverlaySuggestions() {
      const goal = $('goal-metric').value, percent = $('reference-mode').value === 'PERCENT';
      $('goal-value-label').textContent = `Valor mínimo (${goal.endsWith('return') ? '%' : 'R$'})`;
      $('goal-value').dataset.suggestion = goal.endsWith('return') ? '10' : goal === 'nominal_profit' ? '1.000,00' : '12.000,00';
      $('reference-value').dataset.suggestion = percent ? '10' : '1.000,00';
      for (const id of ['goal-value', 'reference-value']) $(id).placeholder = 'Ex.: ' + $(id).dataset.suggestion;
    }
    syncOverlaySuggestions();
    for (const input of doc.querySelectorAll('input[data-suggestion]')) input.setAttribute('aria-describedby', [...new Set([...(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), 'suggestion-help'])].join(' '));
    doc.addEventListener('keydown', event => {
      const input = event.target;
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented || input.tagName !== 'INPUT' || input.disabled || input.readOnly || input.value.trim() || !input.dataset.suggestion) return;
      input.value = input.dataset.suggestion;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    function syncComparison(copyFirst) {
      const enabled = $('compare-enabled').checked;
      if (enabled && !comparisonInitialized && copyFirst) {
        $('b-family').replaceChildren(...[...$('family').options].map(option => option.cloneNode(true)));
        for (const id of ['family', 'purchase', 'capital-mode', 'budget', 'entry-mode', 'entry', 'inflation', 'entry-fee', 'exit-fee']) $('b-' + id).value = $(id).value;
        comparisonInitialized = true; syncCapitalLabel('b-'); syncEntryLabel('b-');
      }
      $('comparison-inputs').hidden = !enabled;
      for (const control of $('comparison-inputs').querySelectorAll('input,select')) control.disabled = !enabled;
      if (!enabled) { $('show-a').checked = true; $('show-b').checked = true; }
    }
    $('capital-mode').addEventListener('change', () => { syncCapitalLabel(); $('budget').value = ''; });
    $('entry-mode').addEventListener('change', () => { syncEntryLabel(); $('entry').value = ''; syncActions(); });
    $('family').addEventListener('change', () => clearRecordedProduct());
    $('b-capital-mode').addEventListener('change', () => { syncCapitalLabel('b-'); $('b-budget').value = ''; });
    $('b-entry-mode').addEventListener('change', () => { syncEntryLabel('b-'); $('b-entry').value = ''; });
    $('b-family').addEventListener('change', () => clearRecordedProduct('b-'));
    for (const button of doc.querySelectorAll('[data-period-months]')) button.addEventListener('click', () => {
      if (!$('purchase').value) { showError('Informe a data da compra para escolher o prazo.'); $('purchase').focus(); return; }
      $('start').value = $('purchase').value; $('end').value = workspace.addIsoMonthsClamped($('purchase').value, Number(button.dataset.periodMonths));
      manualDates.add('start'); manualDates.add('end'); invalidate();
    });
    $('suggest-rates').addEventListener('click', () => {
      try { const rates = suggestedRates($('entry').value); $('rate-min').value = workspace.formatPtNumber(rates.minimum, -1); $('rate-max').value = workspace.formatPtNumber(rates.maximum, -1); invalidate(); }
      catch (error) { showError(error.message); $('entry').focus(); }
    });
    form.addEventListener('submit', simulate);
    $('confirm-purchase').addEventListener('click', () => { if (!purchaseProposal || purchaseProposal.revision !== revision || busy) return; $('purchase').value = purchaseProposal.date; suggestDates(); invalidate(); form.requestSubmit(); });
    function viewChanged() { if (isCurrent() && savedRecord?.calculationRevision === revision) setSaveState('Exibição não salva'); }

    for (const metric of METRICS) $('metric-' + metric).addEventListener('click', () => {
      if ($('metric-' + metric).disabled || displayedMetric === metric) return;
      displayedMetric = metric; syncActions(); viewChanged(); renderReading();
      renderChart().catch(() => { $('coverage').textContent += ' Use a tabela para conferir os valores.'; });
    });
    $('show-goal-metric').addEventListener('click', () => $('metric-' + $('goal-metric').value).click());
    for (const id of ['show-a', 'show-b']) $(id).addEventListener('change', () => { detailRevision++; $('point-details').hidden = true; viewChanged(); renderAll(); renderReading(); renderChart().catch(error => recordMessage(error.message, true)); });
    const overlayFields = ['goal-enabled', 'goal-metric', 'goal-value', 'reference-enabled', 'reference-mode', 'reference-value', 'fit-overlays', 'goal-fill', 'reference-fill'];
    let overlayDraft = null;
    const captureOverlayFields = () => Object.fromEntries(overlayFields.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
    function syncObjectiveEditor() {
      const percent = $('objective-unit').value === 'PERCENT', annual = $('objective-period').value === 'ANNUAL';
      const choices = percent ? [['nominal_return', 'Rendimento total'], ['real_return', 'Acima da inflação']] : [['nominal_profit', 'Lucro'], ['net_redemption', 'Valor a receber']];
      const selected = $('objective-measure').value;
      $('objective-measure').replaceChildren(...choices.map(([value, label]) => { const option = element('option', label); option.value = value; return option; }));
      $('objective-measure').value = !annual && choices.some(([value]) => value === selected) ? selected : choices[0][0];
      $('objective-measure').disabled = annual;
      $('objective-value').placeholder = percent ? 'Ex.: 10' : 'Ex.: 1.000';
      $('objective-value').removeAttribute('aria-invalid');
      $('overlay-form-error').classList.remove('error');
      $('overlay-form-error').textContent = annual ? 'Ganho líquido por ano, desde a compra.' : 'Valor mínimo na saída, para todo o período.';
    }
    function positionObjectiveEditor() {
      const popup = $('overlays'), anchor = $('open-overlays').getBoundingClientRect(), rect = popup.getBoundingClientRect();
      const width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
      popup.style.left = Math.max(12, Math.min(anchor.right - rect.width, width - rect.width - 12)) + 'px';
      const above = anchor.top - rect.height - 8;
      popup.style.top = Math.max(12, Math.min(anchor.bottom + 8 > height - rect.height - 12 && above >= 12 ? above : anchor.bottom + 8, height - rect.height - 12)) + 'px';
    }
    new ResizeObserver(() => { if ($('overlays').matches(':popover-open')) positionObjectiveEditor(); }).observe($('overlays'));
    $('open-overlays').addEventListener('click', () => {
      if ($('open-overlays').disabled) return;
      if ($('overlays').matches(':popover-open')) { $('overlays').hidePopover(); return; }
      overlayDraft = captureOverlayFields();
      const goal = $('goal-enabled').checked, reference = !goal && $('reference-enabled').checked;
      const metric = $('goal-metric').value;
      $('objective-period').value = reference ? 'ANNUAL' : 'TOTAL';
      $('objective-unit').value = reference ? ($('reference-mode').value === 'PERCENT' ? 'PERCENT' : 'BRL') : goal && metric.endsWith('return') ? 'PERCENT' : 'BRL';
      syncObjectiveEditor();
      if (goal) $('objective-measure').value = metric;
      $('objective-value').value = goal ? $('goal-value').value : reference ? $('reference-value').value : '';
      $('objective-fill').checked = goal ? $('goal-fill').checked : reference ? $('reference-fill').checked : false;
      if (goal && $('reference-enabled').checked) $('overlay-form-error').textContent = 'Ao aplicar, este objetivo substitui as referências anteriores.';
      $('overlays').showPopover(); positionObjectiveEditor(); $('open-overlays').setAttribute('aria-expanded', 'true');
      $('objective-value').focus({ preventScroll: true });
    });
    for (const id of ['close-overlays', 'cancel-overlays']) $(id).addEventListener('click', () => { $('overlays').hidePopover(); $('open-overlays').focus({ preventScroll: true }); });
    $('overlays').addEventListener('input', event => {
      if (['objective-unit', 'objective-period'].includes(event.target.id)) syncObjectiveEditor();
      else { $('objective-value').removeAttribute('aria-invalid'); $('overlay-form-error').classList.remove('error'); $('overlay-form-error').textContent = $('objective-period').value === 'ANNUAL' ? 'Ganho líquido por ano, desde a compra.' : 'Valor mínimo na saída, para todo o período.'; }
    });
    $('overlays').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.id === 'objective-value') { event.preventDefault(); $('apply-overlays').click(); } });
    $('overlays').addEventListener('beforetoggle', event => {
      if (event.newState !== 'closed') return;
      if (overlayDraft) for (const [id, value] of Object.entries(overlayDraft)) { if ($(id).type === 'checkbox') $(id).checked = value; else $(id).value = value; }
      overlayDraft = null; $('open-overlays').setAttribute('aria-expanded', 'false'); syncActions();
    });
    $('overlays').addEventListener('toggle', event => { if (event.newState === 'closed' && isCurrent()) renderChart().catch(error => recordMessage(error.message, true)); });
    window.addEventListener('resize', () => { if ($('overlays').matches(':popover-open')) positionObjectiveEditor(); });
    doc.addEventListener('scroll', () => { if ($('overlays').matches(':popover-open')) positionObjectiveEditor(); }, true);
    $('clear-overlays').addEventListener('click', () => {
      for (const id of ['goal-enabled', 'reference-enabled', 'goal-fill', 'reference-fill']) $(id).checked = false;
      overlayDraft = null; overlayError = false; viewChanged(); $('overlays').hidePopover();
    });
    $('apply-overlays').addEventListener('click', () => {
      let parsed;
      try { parsed = objectiveOverlays({ unit: $('objective-unit').value, period: $('objective-period').value, measure: $('objective-measure').value, value: $('objective-value').value }); }
      catch (error) { $('overlay-form-error').textContent = error.message; $('overlay-form-error').classList.add('error'); $('objective-value').setAttribute('aria-invalid', 'true'); $('objective-value').focus({ preventScroll: true }); return; }
      restoreOverlays(parsed);
      $('goal-fill').checked = Boolean(parsed.goal && $('objective-fill').checked); $('reference-fill').checked = Boolean(parsed.reference && $('objective-fill').checked);
      overlayDraft = null; overlayError = false; viewChanged(); $('overlays').hidePopover();
    });
    const resetOpenWarning = () => { pendingOpenId = ''; $('open-warning').hidden = true; $('open-simulation').hidden = false; };
    $('saved-simulation').addEventListener('change', () => { resetOpenWarning(); syncActions(); });
    function markNameEdited() {
      if (isCurrent()) { setSaveState('Nome não salvo'); recordMessage('Clique em Salvar para guardar este nome.'); }
    }
    $('simulation-name').addEventListener('input', markNameEdited);
    $('simulation-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveSimulation(); } });
    $('save-simulation').addEventListener('click', () => saveSimulation());
    $('save-copy').addEventListener('click', () => saveSimulation(true));
    $('open-simulation').addEventListener('click', () => openSimulation());
    $('open-saved-shortcut').addEventListener('click', async () => {
      if (busy) return;
      resetOpenWarning(); $('continuity').showModal();
      const initialFocus = doc.activeElement;
      try {
        await refreshSaved(savedRecord?.id || '');
        if ($('continuity').open && doc.activeElement === initialFocus) $('saved-simulation').focus();
      } catch (error) { $('files-status').textContent = friendlyMessage(error.message); }
    });
    $('close-files').addEventListener('click', () => $('continuity').close());
    $('refresh-saved').addEventListener('click', () => refreshSaved($('saved-simulation').value).catch(error => { $('files-status').textContent = friendlyMessage(error.message); }));
    $('cancel-open').addEventListener('click', () => { resetOpenWarning(); ($('open-simulation').disabled ? $('saved-simulation') : $('open-simulation')).focus(); });
    $('discard-and-open').addEventListener('click', () => openSimulation(true, pendingOpenId));
    $('save-before-open').addEventListener('click', async () => { const target = pendingOpenId; if (await saveSimulation()) await openSimulation(true, target); });
    $('edit-inputs').addEventListener('click', () => setInputsCollapsed(!$('entry-panel').hidden));
    doc.querySelector('.skip').addEventListener('click', () => setInputsCollapsed(false));
    $('export-simulation').addEventListener('click', exportSimulation);
    function syncWorkspaceInsets() {
      const root = doc.documentElement;
      for (const [selector, variable] of [['.app-header', '--header-height'], ['.simulate-dock', '--simulate-dock-height']]) {
        root.style.setProperty(variable, `${Math.ceil(doc.querySelector(selector).getBoundingClientRect().height)}px`);
      }
    }
    const workspaceObserver = new ResizeObserver(syncWorkspaceInsets);
    for (const selector of ['.app-header', '.simulate-dock']) workspaceObserver.observe(doc.querySelector(selector));
    syncWorkspaceInsets();
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderChart().catch(() => {}); }, 120); });
    async function loadBootstrap() {
      const button = $('simulate'), status = $('form-status');
      button.disabled = true;
      status.textContent = 'Carregando os dados locais…';
      showError('');
      let value;
      try {
        const response = await request('/api/bootstrap');
        if (!response.ok) throw new Error('Não foi possível abrir os dados locais.');
        value = await response.json();
        if (!value || (!value.recovery_error && !(value.studio?.current_date || value.defaults?.asof))) {
          throw new Error('O serviço retornou dados de inicialização inválidos.');
        }
      } catch (error) {
        showError(error.message);
        status.textContent = 'Não foi possível preparar a simulação.';
        button.textContent = 'Tentar carregar novamente';
        button.disabled = false;
        return;
      }
      if (value.recovery_error) {
        showError('Os dados locais precisam de recuperação. Consulte as ferramentas de dados no rodapé.');
        status.textContent = 'Não foi possível preparar a simulação.';
        return;
      }
      bootstrap = value;
      if (!$('purchase').value) $('purchase').value = value.studio?.current_date || value.defaults.asof;
      if (value.simple_screen?.date_step_days !== 15) $('mesh-help').textContent = 'Reinicie o aplicativo para habilitar os pontos a cada 15 dias e a convergência de datas. Esta sessão usa a amostragem anterior.';
      suggestDates(); syncActions();
      $('data-status').textContent = value.public_ipca
        ? `IPCA ${value.public_ipca.mode === 'live' ? 'atualizado automaticamente' : 'da fotografia pública; atualização automática não confirmada'}${value.public_ipca.as_of ? ' · último mês ' + value.public_ipca.as_of.slice(0, 7).split('-').reverse().join('/') : ''}. Cálculo neste navegador.`
        : `Dados disponíveis neste computador${value.history?.last ? ` · histórico de cotações até ${p.formatDate(value.history.last)}` : ''}. A simulação não baixa dados nem salva operações.`;
      button.textContent = 'Simular saídas'; button.disabled = false; status.textContent = 'Preencha e simule.';
      refreshSaved().catch(error => recordMessage(error.message, true));
    }
    mountSteppers();
    loadBootstrap();
  }
  return Object.freeze({ roundPercent, roundRate, effectiveRateDivisions, requiresRateRecalculation, objectiveOverlays, ratesForWindow, dateSamples, commonDateSamples, intervalDateSamples, convergingDateSamples, mergeSurfaces, metricValue, goalPresentation, crossGoalPresentation, crossGoalValues, goalEquivalent, hatchAreas, legendKey, chartPresentation, chartLayout, chartPointText, restoredView, outsideMessage, numericStepSpec, incrementDecimal, legacySaveBody, presentationSupport, applyPresentationSupport, isPresentationSchemaError, saveWithPresentationCompatibility, basisFromResolution, recoverOverlayBases, overlayGraphScale, graphScale, simulationFacts, comparisonRows, tableModel, seriesFor, capitalInput, titleYearRange, titleYearError, fixedInstrument, productOptions, compactSurface, packSurface, unpackSurface, snapshotView, exportDocument, goalSummary, referenceValues, friendlyMessage, suggestedRates, selectedPeriod, selectedGraphWindow, mount });
});
