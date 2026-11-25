(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TesouroHistory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const IDS = ['IPCA_PRINCIPAL_2050', 'RENDA_PLUS_2065'];
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const sourceURL = 'https://www.tesourotransparente.gov.br/ckan/dataset/taxas-dos-titulos-ofertados-pelo-tesouro-direto';
  const day = value => value.split('-').reverse().join('/');
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const percent = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value) + '%';

  const TITLES = {
    IPCA_PRINCIPAL_2050: { label: 'IPCA+ 2050', type: 'Tesouro IPCA+', maturity: '2050-08-15' },
    RENDA_PLUS_2065: { label: 'RendA+ 2065', type: 'Tesouro Renda+ Aposentadoria Extra', maturity: '2084-12-15' },
  };
  const DAY = 86400000;
  function validDate(value) {
    if (typeof value !== 'string' || !DATE.test(value)) return false;
    const parsed = new Date(value + 'T12:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function validate(data) {
    if (data?.schema_version !== 1 || data.rate_unit !== 'basis_points' || data.observation !== 'morning'
      || !validDate(data.as_of) || !Number.isFinite(Date.parse(data.retrieved_at)) || !/^[a-f0-9]{64}$/.test(data.source?.sha256 || '')
      || !Array.isArray(data.series) || data.series.length !== 2) throw new Error('Histórico inválido.');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(data.retrieved_at));
    for (const id of IDS) {
      const series = data.series.find(item => item.id === id), expected = TITLES[id];
      if (!series || series.type !== expected.type || series.maturity !== expected.maturity
        || !Array.isArray(series.observations) || !series.observations.length || series.observations.length > 30000) throw new Error('Título sem histórico válido.');
      let previous = '';
      for (const row of series.observations) {
        if (!Array.isArray(row) || row.length !== 3 || !validDate(row[0]) || row[0] <= previous
          || row[0] > today || !row.slice(1).every(v => v === null || Number.isSafeInteger(v) && v > -10000)
          || row[1] === null && row[2] === null) throw new Error('Cotações inválidas.');
        previous = row[0];
      }
    }
    if (data.market_dates !== undefined) {
      if (!Array.isArray(data.market_dates) || data.market_dates.length > 30000) throw new Error('Calendário inválido.');
      let previous = '';
      for (const date of data.market_dates) {
        if (!validDate(date) || date <= previous || date > today) throw new Error('Calendário inválido.');
        previous = date;
      }
      const dates = new Set(data.market_dates);
      if (data.series.some(s => s.observations.some(row => !dates.has(row[0])))) throw new Error('Calendário incompleto.');
    }
    const asOf = data.series.map(s => s.observations.at(-1)[0]).sort()[0];
    if (data.as_of !== asOf) throw new Error('Cobertura inconsistente.');
    return data;
  }

  // Exact decimal ratio versus integer basis points; equality belongs to <=.
  function rateThreshold(ratio) {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(ratio));
    if (!match || String(ratio).length > 200) throw new Error('Taxa simulada inválida.');
    const fraction = match[3] || '';
    return { scale: 10n ** BigInt(fraction.length), target: BigInt((match[1] || '') + match[2] + fraction) * 10000n };
  }
  function atOrBelow(bps, ratio) {
    const { scale, target } = rateThreshold(ratio);
    return bps !== null && BigInt(bps) * scale <= target;
  }
  function twoYearsBefore(value) {
    const [year, month, date] = value.split('-').map(Number), limit = new Date(Date.UTC(year - 2, month, 0)).getUTCDate();
    return `${year - 2}-${String(month).padStart(2, '0')}-${String(Math.min(date, limit)).padStart(2, '0')}`;
  }

  function aboveRun(rows, calendar, threshold, start, end) {
    const byDate = new Map(rows.map(row => [row[0], row[2]]));
    const sessions = calendar.filter(date => date >= start && date <= end);
    let run = null, best = null;
    function finish(right) {
      if (!run) return;
      const value = { ...run, span_days: Math.round((Date.parse(run.end) - Date.parse(run.start)) / DAY) + 1, right };
      // Largest calendar span; break ties by observation count, then earliest start.
      if (!best || value.span_days > best.span_days || value.span_days === best.span_days && value.observations > best.observations) best = value;
      run = null;
    }
    for (let i = 0; i < sessions.length; i++) {
      const date = sessions[i], rate = byDate.get(date);
      if (rate === null || rate === undefined) { finish('missing'); continue; }
      if (BigInt(rate) * threshold.scale <= threshold.target) { finish('at_or_below'); continue; }
      if (!run) run = { start: date, end: date, observations: 0,
        left: i === 0 ? 'window' : byDate.get(sessions[i - 1]) == null ? 'missing' : 'at_or_below' };
      run.end = date; run.observations++;
    }
    finish('window');
    return best;
  }

  function summarize(data, scenarios, rates) {
    validate(data);
    const start = twoYearsBefore(data.as_of), end = data.as_of;
    // New collections carry every observed market date from the official CSV.
    // Older snapshots remain readable using the union of both selected series.
    const calendar = data.market_dates || [...new Set(data.series.flatMap(s => s.observations.map(row => row[0])))].sort();
    const thresholds = rates.map(rateThreshold);
    const columns = scenarios.map(scenario => {
      const id = scenario.family + '_' + scenario.year, title = data.series.find(item => item.id === id);
      if (!title) return { ...scenario, supported: false, count: 0 };
      const from = title.observations[0][0] > start ? title.observations[0][0] : start;
      const rows = title.observations.filter(row => row[0] >= from && row[0] <= end);
      const valid = rows.filter(row => row[2] !== null), dates = new Set(valid.map(row => row[0]));
      const expected = calendar.filter(date => date >= from && date <= end);
      return { ...scenario, label: TITLES[id].label, supported: true, start: valid[0]?.[0] || from,
        end: valid.at(-1)?.[0] || end, count: valid.length, missing: expected.filter(date => !dates.has(date)).length,
        values: thresholds.map(threshold => {
          const count = valid.filter(row => BigInt(row[2]) * threshold.scale <= threshold.target).length;
          return { count, total: valid.length, percentage: valid.length ? 100 * count / valid.length : null,
            longest_above: aboveRun(rows, calendar, threshold, from, end) };
        }) };
    });
    return { rates, columns, as_of: data.as_of, retrieved_at: data.retrieved_at, source_sha256: data.source.sha256,
      calendar_basis: data.market_dates ? 'official_csv' : 'selected_series' };
  }

  function preferCandidate(current, candidate, currentMode, mode) {
    if (!current) return true;
    if (candidate.as_of !== current.as_of) return candidate.as_of > current.as_of;
    const difference = Date.parse(candidate.retrieved_at) - Date.parse(current.retrieved_at);
    return difference > 0 || difference === 0 && mode === 'live' && currentMode !== 'live';
  }

  function boundaryNote(run) {
    if (!run) return '';
    if (run.left === 'missing' || run.right === 'missing') return 'limitado por lacuna';
    if (run.left === 'window' || run.right === 'window') return 'limite da amostra';
    return '';
  }
  function runDescription(run) {
    if (!run) return 'Máx. acima: 0 dias';
    return `Máx. acima: ${run.span_days} ${run.span_days === 1 ? 'dia' : 'dias'} · ${run.observations} ${run.observations === 1 ? 'cotação' : 'cotações'}`;
  }
  function runPeriod(run) {
    return run ? `${day(run.start)}–${day(run.end)}${boundaryNote(run) ? ' · ' + boundaryNote(run) : ''}` : '';
  }
  function decorateTraces(traces, summary) {
    for (const trace of traces) {
      if (trace.meta?.kind !== 'simulation') continue;
      const column = summary.columns.find(c => c.id === trace.meta.scenario);
      const value = column?.values?.[summary.rates.indexOf(trace.meta.rate)];
      if (value?.percentage == null) continue;
      const frequency = `≤ taxa: ${percent(value.percentage)} (${value.count}/${value.total})`;
      const longest = runDescription(value.longest_above), period = runPeriod(value.longest_above);
      trace.meta.history = { ...value, start: column.start, end: column.end, as_of: summary.as_of };
      // Preserve stable trace identity, color, rate and the financial point data.
      trace.meta.history_base_name ||= trace.name;
      trace.name = trace.meta.history_base_name + ` · ≤ ${percent(value.percentage)}`;
      trace.customdata = trace.customdata.map(row => [...row.slice(0, 5), [frequency, longest, period].filter(Boolean).join(' · '), frequency, longest, period]);
      trace.hovertemplate = '%{customdata[1]}<br>%{customdata[2]}<br>%{customdata[6]}<br>%{customdata[7]}'
        + (period ? '<br>%{customdata[8]}' : '') + '<extra>%{customdata[4]}</extra>';
    }
    return traces;
  }

  function tableHTML(summary, formatRate) {
    return `<div class="table-wrap"><table class="history-table"><caption class="sr-only">Histórico de taxas: frequência igual ou abaixo e maior trecho observado acima</caption><thead><tr><th scope="col">Taxa</th>${summary.columns.map(c => `<th scope="col">${escape(c.id)} · % ≤</th><th scope="col">${escape(c.id)} · Máx. acima</th>`).join('')}</tr></thead><tbody>${summary.rates.map((rate, i) => `<tr><th scope="row">${escape(formatRate(rate))}</th>${summary.columns.map(c => {
      const value = c.values?.[i], run = value?.longest_above;
      if (value?.percentage == null) return '<td>Sem dados</td><td>Sem dados</td>';
      return `<td><strong>${percent(value.percentage)}</strong><small>${value.count}/${value.total} cotações</small></td><td>${run ? `<strong>${run.span_days} ${run.span_days === 1 ? 'dia' : 'dias'}</strong><small>${run.observations} ${run.observations === 1 ? 'cotação' : 'cotações'} · ${escape(runPeriod(run))}</small>` : '0 dias'}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function coverageText(model) {
    return model.columns.map(c => c.supported && c.count
      ? `${c.id}: ${day(c.start)}–${day(c.end)} · ${c.count} cotações${c.missing ? ' · ' + c.missing + ' ausentes' : ''}`
      : `${c.id}: sem histórico válido`).join(' | ');
  }
  function methodHTML() {
    return `<p><b>% ≤</b>: parcela das cotações com taxa de resgate da manhã menor ou igual à taxa simulada. Igualdade entra na contagem.</p><p><b>Máx. acima</b>: maior trecho de cotações consecutivas estritamente acima. A duração conta os dias corridos entre a primeira e a última cotação, incluindo os extremos. Não comprova permanência intradia. Uma cotação ausente interrompe a sequência; “limite da amostra” indica que ela toca o início ou o fim da janela.</p><p>Janela de até dois anos, sem preencher datas ou taxas. Frequência passada não representa probabilidade futura. <a href="${sourceURL}" target="_blank" rel="noopener">Tesouro Transparente · ODbL</a>.</p>`;
  }
  function exportSummary(model, formatRate, statusText) {
    return `<section><style>.history-table small{display:block;font-size:11px;font-weight:400;white-space:normal}.history-table td{vertical-align:top}</style><h2>Histórico das taxas · até 2 anos</h2><p>${escape(coverageText(model))}</p><details><summary>Dados e critérios</summary>${tableHTML(model, formatRate)}<p>${escape(statusText)}</p>${methodHTML()}</details></section>`;
  }

  function createPanel(doc, { formatRate, onChange = () => {}, request = (...args) => fetch(...args) }) {
    const panel = doc.getElementById('rate-history');
    if (!panel) return { update() {}, decorate: traces => traces, capture: () => ({}) };
    const status = doc.getElementById('history-status'), coverage = doc.getElementById('history-coverage');
    const alert = doc.getElementById('history-alert'), numbers = doc.getElementById('history-numbers');
    let dataset = null, context = null, mode = 'loading', model = null, displayed = null;
    function render() {
      panel.hidden = !context; model = null;
      if (!context) return;
      if (!dataset) {
        status.textContent = ''; coverage.textContent = mode === 'loading' ? 'Consultando histórico…' : 'Histórico indisponível.';
        numbers.replaceChildren(); alert.hidden = true; return;
      }
      model = summarize(dataset, context.scenarios, context.rates);
      status.textContent = `${mode === 'live' ? 'Atualização automática' : 'Fotografia de referência'} · coleta ${day(dataset.retrieved_at.slice(0, 10))} · cotações até ${day(dataset.as_of)}.`;
      const old = (Date.now() - Date.parse(dataset.as_of + 'T12:00:00Z')) / DAY > 7;
      alert.textContent = old ? 'Cotações sem atualização há mais de 7 dias.' : mode === 'live' ? '' : 'Atualização indisponível; usando a base de referência.';
      alert.hidden = !alert.textContent;
      coverage.textContent = coverageText(model);
      numbers.innerHTML = tableHTML(model, formatRate);
    }
    async function read(url) {
      const response = await request(url, { signal: AbortSignal.timeout(15000), cache: 'no-cache' });
      if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Fonte indisponível.');
      return validate(await response.json());
    }
    const accept = (data, source) => {
      if (!preferCandidate(dataset, data, mode, source)) return;
      dataset = data; mode = source; render(); onChange();
    };
    const jobs = [read('/tesouro-marcado/market-history.json').then(data => accept(data, 'snapshot')),
      read('https://raw.githubusercontent.com/flaviogeologo-spec/tesouro-marcado/dados/market-history.json').then(data => accept(data, 'live'))];
    Promise.allSettled(jobs).then(() => { if (!dataset) { mode = 'unavailable'; render(); } });
    return {
      update(value) { context = value?.rates?.length && value.scenarios?.length ? value : null; render(); },
      decorate(traces) {
        displayed = model ? { dataset, scenarios: context.scenarios, model, statusText: status.textContent } : null;
        return model ? decorateTraces(traces, model) : traces;
      },
      capture() {
        // Freeze the history used by the drawn curves while an offline export is built.
        const snapshot = displayed;
        if (!snapshot) return {};
        function forRates(rates) {
          const summary = summarize(snapshot.dataset, snapshot.scenarios, rates);
          return { html: exportSummary(summary, formatRate, snapshot.statusText), forRates, decorate(traces) {
            const values = [...new Set(traces.filter(t => t.meta?.kind === 'simulation').map(t => t.meta.rate))];
            return decorateTraces(traces, summarize(snapshot.dataset, snapshot.scenarios, values));
          } };
        }
        return forRates(snapshot.model.rates);
      },
    };
  }
  return { validate, atOrBelow, twoYearsBefore, summarize, decorateTraces, preferCandidate, createPanel };
});
