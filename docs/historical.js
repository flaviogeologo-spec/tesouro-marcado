(function (root, factory) {
  const api = factory(root.MTMWorkspace || (typeof module === 'object' ? require('./mtm-workspace.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TesouroEvolution = api; document.addEventListener('DOMContentLoaded', () => api.mount(document)); }
})(typeof globalThis === 'object' ? globalThis : this, function (workspace) {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = value => value ? value.split('-').reverse().join('/') : '—';
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const signedBrl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', signDisplay: 'exceptZero' });
  const decimalPt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = value => value == null ? '—' : brl.format(Number(value));
  const percent = value => value == null ? '—' : decimalPt.format(Number(value)) + '%';
  function decimal(value, optional = false, label = 'Valor') {
    const text = workspace.parsePtDecimal(value, label);
    if (text == null && optional) return null;
    if (text == null || text.length > 30 || !Number.isFinite(Number(text))) throw Error('Informe números válidos; use vírgula para os centavos.');
    return text;
  }
  // Shift the decimal point instead of converting a user rate through a float.
  function ratio(percentText) {
    const negative = percentText.startsWith('-'), [whole, fraction = ''] = percentText.replace(/^-/, '').split('.');
    const digits = (whole.padStart(3, '0') + fraction), split = digits.length - fraction.length - 2;
    return (negative ? '-' : '') + digits.slice(0, split) + '.' + digits.slice(split);
  }
  function purchaseRate(text) {
    const raw = decimal(text);
    const rounded = workspace.parsePtDecimal(workspace.formatPtNumber(raw, 2));
    return { display: workspace.formatPtNumber(rounded, 2), ratio: ratio(rounded) };
  }
  function fieldError(id, message) { return Object.assign(Error(message), { fieldId: id }); }
  function readField(id, read) { try { return read(); } catch (cause) { if (cause.fieldId) throw cause; throw fieldError(id, cause.message); } }
  function dateInput(id, value, minimum, maximum) {
    if (!value) throw fieldError(id, id === 'history-purchase' ? 'Informe a data da compra.' : id === 'history-settlement' ? 'Informe a liquidação do comprovante.' : id === 'history-reconcile-date' ? 'Informe a data da cotação da instituição.' : 'Informe a data final da projeção.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T12:00:00Z'))
      || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value) throw fieldError(id, 'Informe uma data válida.');
    if (minimum && value < minimum || maximum && value > maximum) throw fieldError(id, `Escolha uma data entre ${day(minimum)} e ${day(maximum)}.`);
    return value;
  }
  function purchaseQuote(series, date) {
    const quotes = series?.observations || [];
    const dates = (series?.prices || []).filter(row => row[1] != null).map(row => row[0]);
    const available = dates.includes(date), quote = available ? quotes.find(row => row[0] === date && row[1] != null) : null;
    return { available, quote, first: dates[0], last: dates.at(-1),
      previous: dates.findLast(value => value < date), next: dates.find(value => value > date) };
  }
  function purchaseInput({ titleId, date, rate, budget, pu, minDate, maxDate, series, actual = false, quantity, settlementDate }) {
    date = dateInput('history-purchase', date, minDate, maxDate);
    if (!actual && series && !purchaseQuote(series, date).available) throw fieldError('history-purchase', 'Não há cotação de compra nessa data. Escolha uma das datas disponíveis indicadas abaixo do campo.');
    if (!String(rate || '').trim()) throw fieldError('history-rate', 'Informe a taxa da compra.');
    const parsedRate = readField('history-rate', () => purchaseRate(rate));
    if (!(Number(parsedRate.ratio) > -1 && Number(parsedRate.ratio) <= 1)) throw fieldError('history-rate', 'A taxa da compra deve ser maior que −100% e de até 100% ao ano.');
    const parsedBudget = actual ? null : readField('history-budget', () => decimal(budget, true, 'Valor investido'));
    const parsedPU = readField('history-pu', () => decimal(pu, true, 'Preço da compra'));
    if (parsedBudget !== null && (Number(parsedBudget) < .01 || Number(parsedBudget) > 1e12 || (parsedBudget.split('.')[1] || '').replace(/0+$/, '').length > 2)) throw fieldError('history-budget', 'Informe um valor de R$ 0,01 a R$ 1 trilhão, com até duas casas decimais.');
    if (parsedPU !== null && (Number(parsedPU) < .01 || Number(parsedPU) > 1e12)) throw fieldError('history-pu', 'O preço por título deve ser de pelo menos R$ 0,01 e de até R$ 1 trilhão.');
    const purchase = { title_id: titleId, date, yield: parsedRate.ratio, budget: parsedBudget, pu: parsedPU };
    if (actual) {
      const q = readField('history-quantity', () => decimal(quantity));
      if (Number(q) < .01 || Number(q) > 1e12 || (q.split('.')[1] || '').replace(/0+$/, '').length > 2) throw fieldError('history-quantity', 'Informe uma quantidade positiva, em múltiplos de 0,01 título.');
      if (parsedPU === null) throw fieldError('history-pu', 'Informe o preço por título do comprovante.');
      purchase.quantity = q;
      purchase.settlement_date = dateInput('history-settlement', settlementDate, workspace.addIsoDays(date, 1), maxDate);
    }
    return purchase;
  }
  function moneyInput(id, raw, optional = false) {
    const value = readField(id, () => decimal(raw, true));
    if (value === null) return optional ? null : '0';
    if (Number(value) < 0 || Number(value) > 1e12 || (value.split('.')[1] || '').replace(/0+$/, '').length > 2) throw fieldError(id, 'Informe um valor não negativo, com até duas casas decimais.');
    return value;
  }
  function cashHTML(point) {
    const cash = point.cash || {};
    const coverage = custodyCoverageText(cash.custody_coverage);
    return `<dl class="position-deductions">${[['Venda bruta',cash.gross_redemption],['IOF',cash.iof],['IR',cash.income_tax],['Custódia estimada',cash.custody],['Despesa de venda',cash.exit_expense],['Líquido estimado',cash.net_redemption]].map(([label,value]) => `<dt>${label}</dt><dd>${escape(money(value))}</dd>`).join('')}</dl>`
      + (coverage ? `<p class="note">${escape(coverage)}</p>` : '');
  }
  function custodyCoverageText(coverage) {
    if (!coverage) return '';
    const {observed_days, carried_days, missing_days, future_days, first_gap, last_gap, fallback_value} = coverage;
    let text = `A custódia usa ${observed_days} dias com PU Base publicado e ${carried_days} dias sem pregão com o último PU Base.`;
    if (missing_days) {
      const interval = first_gap === last_gap ? `em ${day(first_gap)}` : `entre ${day(first_gap)} e ${day(last_gap)}`;
      text += ` Há ${missing_days} dias sem cobertura de PU Base ${interval}.`;
    }
    if (future_days) text += ` Há ${future_days} dias futuros.`;
    if (fallback_value != null) text += ` Esses dias usam ${money(fallback_value)} como valor estimado da posição.`;
    if (coverage.pre_netting_settlement) text += ' O período inclui o regime de cobrança anterior a 31/12/2024. Confira pagamentos anteriores no extrato.';
    return text;
  }
  function reconciliationText(reconciliation, selectedDate) {
    if (!reconciliation) return 'Informe uma cotação líquida da instituição em Custos e conferência para comparar a mesma data.';
    const {date, informed_net, estimated_net, difference, status, custody_coverage} = reconciliation;
    const text = `Conferência em ${day(date)} · líquido informado ${money(informed_net)} · estimado ${money(estimated_net)} · diferença (estimado − informado) ${money(difference)}.`;
    if (status === 'UNAVAILABLE') return text + ' Sem venda comparável nessa data.';
    return date === selectedDate || !custody_coverage ? text : text + ' ' + custodyCoverageText(custody_coverage);
  }
  function hasSale(point) {
    return point?.market != null && Number(point.market) > 0;
  }
  function observedSale(point) {
    return hasSale(point) && point.market_kind !== 'HYPOTHETICAL';
  }
  function comparisonIssue(point) {
    if (point.market_yield == null) return 'sem taxa de venda';
    if (Number(point.market_yield) < -.95 || Number(point.market_yield) > 1) return 'taxa fora do modelo';
    if (!point.observed_index_available) return 'sem IPCA realizado';
    return '';
  }
  function changeHTML(change) {
    const dates = `${day(change.start_date)} a ${day(change.end_date)}`;
    const observed = change.observed_change == null ? '—' : signedBrl.format(Number(change.observed_change));
    const total = `<div class="change-total"><div><p>Variação da venda bruta</p><small>${dates}</small></div><strong>${observed}</strong></div>`;
    if (change.status !== 'AVAILABLE') return total + `<p>${escape(change.reason)}</p>`;
    const rate = value => 'IPCA + ' + percent(Number(value) * 100);
    const rows = [['Passagem do tempo', change.effects.time], ['IPCA realizado', change.effects.ipca],
      ['Mudança da taxa real', change.effects.rate], ['Residual', change.residual]];
    const max = Math.max(...rows.map(([, value]) => Math.abs(Number(value)))) || 1;
    const effects = rows.map(([label, value]) => {
      const amount = Number(value), width = 50 * Math.abs(amount) / max;
      const bar = `<svg class="change-bar" width="100%" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="8" fill="#e5ebe2"/><rect x="${amount < 0 ? 50 - width : 50}" width="${width}" height="8" fill="${amount < 0 ? '#974e36' : '#216947'}"/><path d="M50 0v8" stroke="#53695b" vector-effect="non-scaling-stroke"/></svg>`;
      return `<div><dt>${label}</dt><dd>${bar}<span>${signedBrl.format(amount)}</span></dd></div>`;
    }).join('');
    return total + `<dl class="change-prices"><div><dt>${day(change.start_date)}</dt><dd>${money(change.start_gross)} <small>${rate(change.start_rate)}</small></dd></div><div><dt>${day(change.end_date)}</dt><dd>${money(change.end_gross)} <small>${rate(change.end_rate)}</small></dd></div></dl>`
      + `<p class="note">${change.business_days} dias úteis · correção do índice ${percent(change.index_change_percent)}.</p>`
      + `<dl class="change-effects">${effects}</dl>`
      + `<p class="note">${escape(change.note)}</p>`;
  }
  function positionHTML(point, deferred = false) {
    const pending = deferred && !point.cash;
    return [['Valor indicativo de extrato',point.marked_value,'Quantidade × PU Base oficial'],['Líquido estimado',point.cash?.net_redemption,pending ? 'Abra Líquido, impostos e custos' : 'Após tributos e custos estimados'],['Lucro líquido estimado',point.cash?.nominal_profit,pending ? 'Disponível junto ao líquido' : 'Líquido menos desembolso da compra']].map(([label,value,note]) => `<dl><dt>${label}</dt><dd>${escape(money(value))}<small>${note}</small></dd></dl>`).join('');
  }
  function riskHTML(risk) {
    if (!risk || risk.status !== 'AVAILABLE') return `<p>${escape(risk?.reason || 'Risco indisponível nesta data.')}</p>`;
    return `<p>Base sem choque: ${money(risk.base_gross)} · IPCA + ${percent(Number(risk.base_rate)*100)} · ${day(risk.date)}${risk.base_market_kind === 'HYPOTHETICAL' ? ' · projeção' : ' · cotação histórica'}.</p><div class="historical-table-scroll scroll" tabindex="0" role="region" aria-label="Choques de taxa para a mesma posição"><table><caption class="sr-only">Risco em reais, mantendo data e quantidade</caption><thead><tr>${['Choque (p.p.)','Taxa · IPCA +','Valor bruto','Variação bruta (R$)','Variação bruta (%)','Líquido estimado','Variação líquida (R$)','Limite de queda bruta'].map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${risk.rows.map(row=>`<tr${row.shock_bps === 0 ? ' class="risk-base"' : ''}><th scope="row">${row.shock_bps > 0 ? '+' : ''}${workspace.formatPtNumber(String(row.shock_bps / 100),2)}${row.shock_bps === 0 ? ' · base' : ''}</th><td>${percent(Number(row.rate)*100)}</td><td>${money(row.gross)}</td><td>${money(row.gross_change)}</td><td>${percent(row.gross_change_percent)}</td><td>${money(row.net)}</td><td>${money(row.net_change)}</td><td>${row.status !== 'AVAILABLE' ? 'Fora do domínio' : row.limit_exceeded === null ? 'Não definido' : row.limit_exceeded ? 'Excede o limite' : 'Dentro do limite'}</td></tr>`).join('')}</tbody></table></div><p class="note">${escape(risk.note)}</p>`;
  }
  function projectionInput({ enabled, endDate, inflation, marketYield, minDate, maxDate }) {
    if (!enabled) return null;
    const date = dateInput('history-end', endDate, minDate, maxDate);
    if (!String(inflation || '').trim()) throw fieldError('history-inflation', 'Informe a inflação anual estimada para este cenário.');
    if (!String(marketYield || '').trim()) throw fieldError('history-exit-rate', 'Informe a taxa de mercado ao final do cenário.');
    const annual = readField('history-inflation', () => purchaseRate(inflation).ratio);
    const target = readField('history-exit-rate', () => purchaseRate(marketYield).ratio);
    if (!(Number(annual) > -1 && Number(annual) <= 1)) throw fieldError('history-inflation', 'A inflação deve ser maior que −100% e de até 100% ao ano.');
    if (!(Number(target) >= -.95 && Number(target) <= 1)) throw fieldError('history-exit-rate', 'A taxa de mercado deve estar entre −95% e 100% ao ano.');
    return { end_date: date, annual_inflation: annual, market_yield: target };
  }
  const priceBasis = purchase => purchase.price_basis === 'INFORMED' ? 'informado'
    : purchase.price_basis === 'MODELED_WITH_ESTIMATED_IPCA' ? 'estimado com inflação informada' : 'estimado com IPCA realizado';
  function purchaseContextHTML(result) {
    const { purchase, display } = result;
    const quantity = display === 'BRL'
      ? `${purchase.quantity} títulos ${purchase.quantity_basis === 'INFORMED' ? 'informados' : 'estimados pelo orçamento'} · desembolso ${money(purchase.initial_outflow)}${purchase.unspent_cash == null ? '' : ' · sobra ' + money(purchase.unspent_cash)}`
      : 'Rendimento desde a compra em percentual';
    return `<p><strong>${escape(result.label)}</strong> · IPCA + ${escape(percent(Number(purchase.yield) * 100))} a.a.</p>
      <p>Compra em ${day(purchase.date)} · liquidação em ${day(purchase.settlement_date)} ${purchase.settlement_basis === 'INFORMED' ? 'pelo comprovante' : 'pelo calendário'}</p>
      <p>PU ${money(purchase.pu)} (${priceBasis(purchase)}) · ${escape(quantity)}</p>`;
  }
  function valueAt(result, point, kind) {
    const value = point[result.display === 'BRL' ? kind : kind + '_return'];
    return value == null ? null : Number(value);
  }
  function formatValue(result, point, kind) { return result.display === 'BRL' ? money(point[kind]) : percent(point[kind + '_return']); }
  function pointText(result, point) {
    return `${day(point.date)}${point.period === 'FUTURE' ? ' · Projeção' : ''} · Referência: ${formatValue(result, point, 'reference')} · Venda: ${formatValue(result, point, 'market')}\n`
      + `Delta: ${result.display === 'BRL' ? money(point.delta) + ' · ' : ''}${percent(point.delta_percent)} da referência · Taxa de venda: ${point.market_yield == null ? '—' : 'IPCA + ' + percent(Number(point.market_yield) * 100)}\n${point.status}`;
  }
  function readingHTML(result, point) {
    const delta = result.display === 'BRL' ? money(point.delta) : percent(point.delta_percent);
    const positive = point.delta_percent != null && Number(point.delta_percent) > 0;
    const negative = point.delta_percent != null && Number(point.delta_percent) < 0;
    const rate = point.market_yield == null ? 'Sem taxa nesta data' : 'IPCA + ' + percent(Number(point.market_yield) * 100);
    return `<dl><dt>Referência contratada</dt><dd>${escape(formatValue(result, point, 'reference'))}<small>${point.reference == null ? 'IPCA indisponível' : point.reference_kind === 'HYPOTHETICAL' ? 'Com inflação estimada' : 'Com IPCA realizado'}</small></dd></dl>`
      + `<dl><dt>${point.market_kind === 'HYPOTHETICAL' ? 'Venda projetada' : 'Venda a mercado'}</dt><dd>${escape(formatValue(result, point, 'market'))}<small>${escape(rate)}</small></dd></dl>`
      + `<dl><dt>Delta da referência</dt><dd class="${positive ? 'delta-positive' : negative ? 'delta-negative' : ''}">${positive ? '+ ' : ''}${escape(delta)}<small>${point.delta_percent == null ? 'Comparação indisponível nesta data' : result.display === 'BRL' ? escape(percent(point.delta_percent)) + ' da referência' : 'Em relação à referência contratada'}</small></dd></dl>`;
  }
  function traces(result, view = 'values') {
    const x = result.points.map(p => p.date), customdata = result.points.map((p, index) => [formatValue(result, p, 'reference'), formatValue(result, p, 'market'),
      result.display === 'BRL' ? money(p.delta) : '—', percent(p.delta_percent), p.market_yield == null ? '—' : percent(Number(p.market_yield) * 100), p.status, index]);
    const template = '%{x|%d/%m/%Y}<br>Referência: %{customdata[0]}<br>Venda: %{customdata[1]}<br>'
      + (result.display === 'BRL' ? 'Delta: %{customdata[2]} · ' : 'Delta: ') + '%{customdata[3]} da referência<br>Taxa de venda: IPCA + %{customdata[4]}<br>%{customdata[5]}<extra></extra>';
    // Lines alone hide isolated valid points on either side of a data gap.
    const markers = y => ({ size: y.map((value, i) => value !== null && (i === 0 || y[i - 1] === null) && (i === y.length - 1 || y[i + 1] === null) ? 7 : 0) });
    if (view === 'delta') {
      const hypothetical = p => p.reference_kind === 'HYPOTHETICAL' || p.market_kind === 'HYPOTHETICAL';
      return [false, true].map(projected => {
        const y = result.points.map((p, i) => {
          const bridge = projected && !hypothetical(p) && i + 1 < result.points.length && hypothetical(result.points[i + 1]);
          const value = p[result.display === 'BRL' ? 'delta' : 'delta_percent'];
          return (hypothetical(p) === projected || bridge) && value != null ? Number(value) : null;
        });
        return { type: 'scatter', mode: 'lines+markers', x, y, customdata, connectgaps: false,
          name: projected ? 'Delta com estimativas' : 'Delta histórico', meta: { kind: 'evolution', measure: 'delta', projected },
          showlegend: y.some(value => value !== null), hovertemplate: template,
          marker: markers(y), line: { color: '#287657', width: 2.5, dash: projected ? 'dash' : 'solid' } };
      });
    }
    const areas = []; let run = [];
    function flush() {
      if (run.length > 1) areas.push({ type: 'scatter', mode: 'lines', x: [...run.map(p => p.date), ...run.map(p => p.date).reverse()],
        y: [...run.map(p => valueAt(result, p, 'reference')), ...run.map(p => valueAt(result, p, 'market')).reverse()],
        line: { width: 0 }, fill: 'toself', fillcolor: 'rgba(99,140,118,0.12)', hoverinfo: 'skip', showlegend: false });
      run = [];
    }
    for (const point of result.points) { if (point.reference == null || point.market == null) flush(); else run.push(point); }
    flush();
    function line(kind, projected) {
      const quality = p => p[kind + '_kind'] === 'HYPOTHETICAL';
      const y = result.points.map((p, i) => {
        // Reuse the last real point only to join the dashed segment at its anchor.
        const bridge = projected && !quality(p) && i + 1 < result.points.length && quality(result.points[i + 1]);
        return quality(p) === projected || bridge ? valueAt(result, p, kind) : null;
      });
      const reference = kind === 'reference';
      const name = projected ? reference ? 'Referência projetada' : `Venda projetada · taxa final ${percent(Number(result.projection.selected_yield) * 100)}`
        : reference ? 'Referência contratada · IPCA realizado' : 'Venda histórica · bruto';
      return { type: 'scatter', mode: 'lines+markers', name, x, y, customdata, connectgaps: false, hovertemplate: template, marker: markers(y),
        meta: { kind: 'evolution', measure: kind, projected }, showlegend: y.some(v => v !== null),
        line: { color: reference ? '#9a734c' : '#287657', width: reference ? 2 : 2.5, dash: projected ? 'dash' : 'solid' } };
    }
    return [...areas, line('reference', false), line('market', false), ...(result.projection ? [line('reference', true), line('market', true)] : [])];
  }
  function layout(result, width = 1000, view = 'values', reset = 0) {
    const delta = view === 'delta';
    return { height: result.projection && !delta ? width <= 760 ? 460 : 490 : width <= 760 ? 380 : 440, paper_bgcolor: '#fcfbf7', plot_bgcolor: '#fcfbf7',
      font: { family: 'Segoe UI, sans-serif', color: '#293d32', size: 11 }, margin: { l: 65, r: 18, t: 28, b: result.projection && !delta ? 125 : 85 },
      xaxis: { type: 'date', tickformat: '%d/%m/%y', nticks: width <= 760 ? 4 : 7, gridcolor: '#e6e9df', fixedrange: width <= 760 },
      yaxis: { title: { text: delta ? result.display === 'BRL' ? 'Venda − referência (R$)' : 'Delta em relação à referência (%)' : result.display === 'BRL' ? 'Valor bruto (R$)' : 'Rendimento desde a compra (%)' }, ticksuffix: result.display === 'BRL' ? '' : '%', gridcolor: '#e6e9df', fixedrange: width <= 760,
        ...(delta ? { rangemode: 'tozero', zeroline: true, zerolinecolor: '#819287', zerolinewidth: 1.5 } : {}) },
      legend: { orientation: 'h', x: 0, y: -0.18, font: { size: 11 } }, hovermode: 'closest', dragmode: 'zoom',
      shapes: [
        ...(result.projection ? [{ type: 'line', xref: 'x', yref: 'paper', x0: result.projection.today, x1: result.projection.today, y0: 0, y1: 1, line: { color: '#819287', width: 1, dash: 'dot' } }] : []),
        ...(result.selected_date ? [{ type: 'line', name: 'Data consultada', xref: 'x', yref: 'paper', x0: result.selected_date, x1: result.selected_date, y0: 0, y1: 1, line: { color: '#354b40', width: 1.5, dash: 'dashdot' } }] : []),
      ],
      annotations: result.projection ? [{ xref: 'x', yref: 'paper', x: result.projection.today, y: 1, text: 'Hoje', showarrow: false, xanchor: 'left', yanchor: 'bottom' }] : [],
      separators: ',.', showlegend: true, uirevision: [result.purchase.date, result.title_id, result.display, view, result.coverage.last, reset].join('|') };
  }
  function readingIndex(result, previous, wasLast) {
    if (previous && !wasLast) {
      const found = result.points.findLastIndex(point => point.date <= previous.date);
      return Math.max(0, found);
    }
    if (previous || result.projection) return result.points.length - 1;
    const comparable = result.points.findLastIndex(point => point.delta != null);
    return comparable < 0 ? result.points.length - 1 : comparable;
  }
  function viewHelp(result, view) {
    return view === 'delta' ? 'Acima de zero: venda acima da referência contratada. Abaixo de zero: venda abaixo da referência.' + (result.display === 'BRL' ? ' Diferença em reais.' : ' Percentual calculado sobre a referência; não é a diferença em pontos percentuais entre os rendimentos.')
      : 'Referência contratada e valor de venda para a mesma posição.';
  }
  function projectionSummary(result) {
    if (!result.projection) return '';
    const scenario = result.projection, point = scenario.final_point;
    return `Em ${day(scenario.end_date)} · taxa selecionada: IPCA + ${percent(Number(scenario.selected_yield) * 100)} · Delta: `
      + (result.display === 'BRL' ? money(point.delta) + ' · ' : '') + `${percent(point.delta_percent)} da referência. `
      + (point.delta == null ? 'Venda indisponível nessa data; confira a carência e as condições.' : '');
  }
  function coverageText(result) {
    const c = result.coverage;
    return `${day(c.first)} a ${day(c.last)} · ${c.dates} datas. IPCA divulgado até ${c.ipca_last_month.split('-').reverse().join('/')}. `
      + (c.missing_ipca ? `${c.missing_ipca} datas sem IPCA suficiente para a referência; esses pontos ficam vazios. ` : '')
      + (c.missing_prices ? `${c.missing_prices} datas sem preço de venda; sem interpolação. ` : '')
      + (c.unavailable_sales ? `${c.unavailable_sales} datas sem venda elegível (liquidação, carência ou sessão). ` : '')
      + (result.projection ? `Preços oficiais até ${day(c.historical_last)}. Tracejado: estimativas com inflação de ${percent(Number(result.projection.annual_inflation) * 100)} a.a. após o último IPCA divulgado. ` : '')
      + (result.projection?.requested_end_date !== result.projection?.end_date ? `Data final solicitada: ${day(result.projection.requested_end_date)}; última sessão calculada: ${day(result.projection.end_date)}. ` : '')
      + (result.sources?.market_mode && result.sources.market_mode !== 'live' ? 'Preços da fotografia pública; atualização automática não confirmada. ' : '')
      + (result.sources?.ipca_mode && result.sources.ipca_mode !== 'live' ? 'IPCA da fotografia pública; atualização automática não confirmada. ' : '')
      + 'Valores brutos, antes de impostos e custos. Cada venda é independente.';
  }
  function tableHeaderHTML(result) {
    const cash = result.display === 'BRL', unit = cash ? 'R$' : '%';
    return `<tr><th scope="col">Data</th><th scope="col">Referência (${unit})</th><th scope="col">Venda (${unit})</th>${cash ? '<th scope="col">Delta (R$)</th>' : ''}<th scope="col">Delta (%)</th><th scope="col">Taxa de venda</th>${cash && result.cash_method ? '<th scope="col">Extrato indicativo (R$)</th><th scope="col">Líquido estimado (R$)</th>' : ''}<th scope="col">Situação</th></tr>`;
  }
  function tableHTML(result, interactive = false) {
    return result.points.map((point, index) => {
      const selected = point.date === result.selected_date;
      const date = interactive ? `<button type="button" class="history-table-date" data-history-index="${index}" tabindex="${selected ? '0' : '-1'}"${selected ? ' aria-current="date"' : ''}>${day(point.date)}</button>` : day(point.date);
      return `<tr${selected && !interactive ? ' class="history-current-row"' : ''}><th scope="row">${date}</th><td>${escape(formatValue(result, point, 'reference'))}</td><td>${escape(formatValue(result, point, 'market'))}</td>${result.display === 'BRL' ? '<td>' + escape(money(point.delta)) + '</td>' : ''}<td>${escape(percent(point.delta_percent))}</td><td>${escape(point.market_yield == null ? '—' : percent(Number(point.market_yield) * 100))}</td>${result.display === 'BRL' && result.cash_method ? `<td>${money(point.marked_value)}</td><td>${money(point.cash?.net_redemption)}</td>` : ''}<td>${escape(point.status)}</td></tr>`;
    }).join('');
  }
  function exportHTML(result, plotlySource, view = 'values') {
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
    const purchase = result.purchase, title = result.projection ? 'Histórico e projeção' : 'Evolução histórica';
    const selected = result.points.find(p => p.date === result.selected_date) || result.points.at(-1);
    const reading = `<section aria-labelledby="export-reading"><h2 id="export-reading">Consulta de ${day(selected.date)}</h2><div class="history-reading-values">${readingHTML(result, selected)}</div><p class="note">${escape(selected.status)}</p></section>`;
    const reconciliation = result.reconciliation ? `<p>${escape(reconciliationText(result.reconciliation, selected.date))}</p>` : '';
    const position = result.display === 'BRL' && result.cash_method ? `<details open><summary>Minha posição em ${day(selected.date)}</summary><div class="history-reading-values">${positionHTML(selected)}</div>${cashHTML(selected)}<p>Base fiscal: ${money(purchase.tax_cost_basis)} · despesa da compra: ${money(purchase.entry_fee)}. ${escape(result.cash_method.marked_value_note)}</p><p>${escape(result.cash_method.note)}</p>${reconciliation}</details>` : '';
    const risk = result.risk ? `<details open><summary>Meu risco em reais · ${day(result.risk.date)}</summary>${riskHTML(result.risk)}</details>` : '';
    const change = result.position_change ? `<details open><summary>Explicar a oscilação</summary>${changeHTML(result.position_change)}</details>` : '';
    const summary = result.projection ? `<p class="scenario-summary">Cenário · ${escape(projectionSummary(result))}</p>` : '';
    const chart = plotlySource ? '<div id="chart" role="group" aria-label="Referência contratada e venda a mercado"></div>' : '<p class="note">Gráfico indisponível nesta exportação. Todos os valores estão na tabela.</p>';
    const renderer = plotlySource ? `<script>${plotlySource.replace(/<\/script/gi, '<\\/script')}</script><script>
(async()=>{try{const result=${json({...result, selected_date: selected.date})};await Plotly.newPlot('chart',${json(traces(result, view))},(${layout.toString()})(result,window.innerWidth,${json(view)}),{responsive:true,displayModeBar:false,scrollZoom:false});}
catch(_){document.getElementById('export-values').open=true;document.getElementById('chart').textContent='Não foi possível exibir o gráfico. Consulte a tabela.';}})();</script>` : '';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${escape(result.label)}</title>
<style>body{max-width:1200px;margin:auto;padding:30px 24px;color:#253e32;background:#fcfbf7;font:14px 'Segoe UI',system-ui,sans-serif}h1{font:32px Georgia,serif;letter-spacing:-.5px}p{line-height:1.75}.brand{font-size:12px;color:#216947;letter-spacing:.08em}.context,.note{color:#53695b;font-size:13px}.scenario-summary{padding:14px 16px;border-left:3px solid #216947;background:#e5efe6;line-height:1.75}#chart{width:100%;min-height:380px}table{border-collapse:separate;border-spacing:0;font-size:12px;white-space:nowrap;width:100%;font-variant-numeric:tabular-nums}td,th{padding:12px 14px;border-bottom:1px solid #d8e2d7;text-align:right}td:first-child,th:first-child{text-align:left}thead th{position:sticky;top:0;background:#f0f4ee;z-index:1}tbody th{position:sticky;left:0;background:#fcfbf7}tbody tr:hover{background:#edf4e9}.scroll{overflow:auto;max-height:65vh;border:1px solid #d8e2d7;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;padding:14px 0;font-weight:600;color:#216947;min-height:30px}details{margin-top:14px}@media(max-width:760px){body{padding:24px 16px}h1{font-size:28px}.scenario-summary{font-size:13px}.scroll{max-height:60vh}}</style></head><body>
<p class="brand">TESOURO MARCADO</p><h1>${title} · ${escape(result.label)}</h1>
<p class="context">Compra: ${day(purchase.date)} · Liquidação: ${day(purchase.settlement_date)} · IPCA + ${percent(Number(purchase.yield) * 100)}<br>PU: ${money(purchase.pu)} (${priceBasis(purchase)}) · Quantidade: ${escape(purchase.quantity)} · Desembolso: ${money(purchase.initial_outflow)}${purchase.unspent_cash == null ? '' : ' · Sobra: ' + money(purchase.unspent_cash)}</p>
<style>.history-reading-values{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px}.history-reading-values dl{margin:12px 0}.history-reading-values dt,.history-reading-values small{font-size:12px;color:#53695b}.history-reading-values dd{margin:6px 0;font-size:22px;font-weight:600}.history-reading-values small{display:block;font-weight:400}.position-deductions{display:grid;grid-template-columns:1fr auto;max-width:520px;gap:10px}.position-deductions dd{margin:0;text-align:right}.risk-base,.risk-base th{background:#e5efe6}</style>
<style>.history-current-row,.history-current-row th{background:#e5efe6}.change-total{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 18px;border-top:1px solid #d8e2d7;padding:12px 0}.change-total p{margin:0}.change-total strong{font-size:24px}.change-prices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.change-prices small{display:block;color:#53695b}.change-prices dd{margin:4px 0 0;font-weight:600}.change-effects{max-width:680px;font-size:13px}.change-effects>div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:8px;border-top:1px solid #d8e2d7;padding:8px 0}.change-effects dd{display:grid;grid-template-columns:minmax(0,1fr) minmax(7rem,auto);gap:8px;align-items:center;margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}@media(max-width:530px){.change-effects dd{grid-template-columns:minmax(0,1fr)}.change-bar{grid-row:2}}</style>
${summary}${reading}<p class="note">${escape(viewHelp(result, view))}</p>${chart}<p class="note">${escape(coverageText(result))}</p>${position}${risk}${change}
<details id="export-values"${plotlySource ? '' : ' open'}><summary>Tabela de valores por data</summary><div class="scroll" tabindex="0" role="region" aria-label="Valores por data"><table><thead>${tableHeaderHTML(result)}</thead><tbody>${tableHTML(result)}</tbody></table></div></details>
<details><summary>Como ler a comparação</summary><p>Delta = venda − referência; o percentual é relativo à referência. A referência usa a taxa da compra, com IPCA realizado no histórico e inflação informada no trecho estimado. A projeção parte do último PU oficial, com transição da taxa observada até a selecionada. Não é garantia de resgate.</p><p>Valores brutos, antes de impostos e custos. Preços históricos ausentes permanecem como lacunas. Compra D+1 e venda matinal D+0. RendA+ somente durante a acumulação, respeitando carência. O IPCA reconstruído pode diferir da projeção usada no preço oficial da época.</p></details>
<details><summary>Dados, método e fontes</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre></details>${renderer}</body></html>`;
  }
  function mount(doc) {
    const $ = id => doc.getElementById(id), data = globalThis.TesouroPublicData, history = globalThis.TesouroHistory;
    let market, ipca, bootstrap, current = null, sequence = 0, busy = false, ready = false, hasCalculated = false, pendingProjection = false, stale = false;
    let bootstrapTask, plotlyTask, sourceRun = 0, positionListLoading = false, positionsLoaded = false;
    let chartView = 'values', viewReset = 0, chartRun = 0, renderedChart = null, chartPaint = Promise.resolve(), resizeTimer;
    let currentRequest = null, positionIO = false, analysisBusy = false, riskRevision = 0, changeRevision = 0;
    let changePoints = [], changeByDate = new Map(), tableResult = null, tableDateButton = null;
    let cashRequests = new Map(), positionCashBusy = false, tableCashLoading = null, exporting = false;
    let savedPosition = null, saveAttempt = null, positionDirty = false, pendingPosition = '', positionListRun = 0;
    let positionReceipt = null;
    const request = (...args) => (globalThis.TesouroTransport?.fetch || globalThis.fetch)(...args);
    const localDay = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'});
    const asOf = () => bootstrap?.defaults.asof || localDay.format(new Date());
    function ensureBootstrap() {
      if (bootstrap) return Promise.resolve(bootstrap);
      return bootstrapTask ??= request('/api/bootstrap?scope=historical').then(async response => {
        if (!response.ok) throw Error('Não foi possível preparar o cálculo. Tente novamente.');
        const value = await response.json();
        if (!data.dateOK(value.defaults?.asof) || typeof value.csrf_token !== 'string') throw Error('O motor retornou dados de inicialização inválidos.');
        bootstrap = value;
        availability();
        return value;
      }).finally(() => { bootstrapTask = null; });
    }
    async function jsonRequest(path, body) {
      const response = body === undefined ? await request(path) : await request(path, {
        method:'POST', headers:{'Content-Type':'application/json','X-App-Token':(await ensureBootstrap()).csrf_token}, body:JSON.stringify(body)
      });
      let value;
      try { value = await response.json(); }
      catch (_) {
        throw Error(response.ok ? 'O serviço retornou dados inválidos. Tente novamente.' : 'Serviço temporariamente indisponível. Tente novamente.');
      }
      if (!response.ok) throw Error(value?.error || 'Não foi possível concluir. Tente novamente.');
      return value;
    }
    function syncPositionActions() {
      const blocked = busy || positionIO || analysisBusy;
      $('history-submit').disabled = blocked || !ready;
      $('history-reload').disabled = blocked;
      $('history-export').disabled = blocked || exporting || !current || stale;
      for (const id of ['position-save','position-copy']) $(id).disabled = blocked || !ready || !$('history-actual').checked;
      $('position-save').textContent = savedPosition ? 'Salvar revisão' : 'Salvar compra'; $('position-copy').hidden = !savedPosition;
      $('position-open').disabled = blocked || positionListLoading || !positionsLoaded || !ready || !$('position-list').value;
      $('position-list').disabled = blocked || positionListLoading || !positionsLoaded;
      const point = current?.points[Number($('history-date').value)];
      const canAnalyze = !blocked && !stale && currentRequest && current?.display === 'BRL';
      $('position-risk-run').disabled = !canAnalyze || !hasSale(point) || point?.market_yield == null;
      const start = $('position-change-start').value, end = $('position-change-end').value;
      $('position-change-run').disabled = !canAnalyze || !changeByDate.has(start) || !changeByDate.has(end) || start >= end;
      $('history-compare').hidden = changePoints.length < 2;
      $('history-compare').disabled = !canAnalyze;
      const canUsePoint = point && changePoints[0]?.date < point.date && changeByDate.has(point.date) && point.date !== end;
      $('position-change-use-date').hidden = !canUsePoint;
      $('position-change-use-date').disabled = blocked || stale;
    }
    function clearRisk(message = 'Ajuste os choques e calcule o risco para esta data.') {
      riskRevision++; if (current) delete current.risk;
      $('position-risk-values').hidden = true; $('position-risk-values').innerHTML = '';
      $('position-risk-status').textContent = message; syncPositionActions();
    }
    function clearChange(message = '') {
      changeRevision++;
      if (current) delete current.position_change;
      $('position-change-values').hidden = true;
      $('position-change-values').innerHTML = '';
      $('position-change-status').textContent = message;
    }
    function dateOptions(select, points, chosen) {
      select.replaceChildren();
      for (const point of points) {
        const issue = comparisonIssue(point);
        const option = doc.createElement('option');
        option.value = point.date;
        option.textContent = day(point.date) + (issue ? ' · ' + issue : '');
        select.append(option);
      }
      select.value = chosen || '';
      select.disabled = !points.length;
    }
    function changeCoverage() {
      const selected = ['position-change-start', 'position-change-end'].map(id => changeByDate.get($(id).value));
      const issues = selected.filter(Boolean).flatMap(point => {
        const issue = comparisonIssue(point);
        return issue ? [`${day(point.date)} ${issue}`] : [];
      });
      $('position-change-coverage').textContent = selected.some(point => !point)
        ? 'São necessárias duas datas com venda histórica disponível.'
        : issues.length ? `${issues.join(' · ')}. É possível consultar a variação observada em reais.`
          : 'As duas datas têm preço, taxa e IPCA realizado.';
    }
    function updateChangeStart(preferred) {
      const end = $('position-change-end').value;
      const earlier = changePoints.filter(point => point.date < end);
      const complete = earlier.filter(point => !comparisonIssue(point));
      const candidates = complete.length ? complete : earlier;
      const cutoff = end ? workspace.addIsoDays(end, -30) : '';
      const start = earlier.some(point => point.date === preferred) ? preferred
        : (candidates.findLast(point => point.date <= cutoff) || candidates[0])?.date;
      dateOptions($('position-change-start'), earlier, start);
      changeCoverage();
    }
    function setupChangeDates(keepSelection) {
      const start = $('position-change-start'), end = $('position-change-end');
      const previousEnd = keepSelection ? end.value : '';
      changePoints = current.display === 'BRL' ? current.points.filter(observedSale) : [];
      changeByDate = new Map(changePoints.map(point => [point.date, point]));
      const candidates = changePoints.slice(1);
      const complete = changePoints.filter(point => !comparisonIssue(point));
      const chosen = candidates.some(point => point.date === previousEnd) ? previousEnd
        : (complete.length >= 2 ? complete.at(-1) : candidates.at(-1))?.date;
      dateOptions(end, candidates, chosen);
      updateChangeStart(keepSelection ? start.value : '');
      clearChange();
    }
    function readPurchase() {
      return purchaseInput({titleId:$('history-title').value,date:$('history-purchase').value,rate:$('history-rate').value,
        budget:$('history-budget').value,pu:$('history-pu').value,minDate:$('history-purchase').min,maxDate:$('history-purchase').max,
        series:market?.data.series.find(s=>s.id===$('history-title').value),actual:$('history-actual').checked,
        quantity:$('history-quantity').value,settlementDate:$('history-settlement').value});
    }
    function readCosts() { return {entry_fee:moneyInput('history-entry-fee',$('history-entry-fee').value),exit_fee:moneyInput('history-exit-fee',$('history-exit-fee').value),tax_cost_basis:moneyInput('history-tax-basis',$('history-tax-basis').value,true)}; }
    function actualMode() {
      const actual = $('history-actual').checked;
      for (const id of ['history-actual-fields','position-save-fields']) { $(id).hidden=!actual; $(id).disabled=!actual; }
      $('history-budget-field').hidden=actual; $('history-budget-help').hidden=actual; $('history-budget').disabled=actual;
      $('history-pu-label').textContent = 'Preço pago por título (R$)' + (actual ? ' · obrigatório' : ' · opcional');
      $('history-price-help').textContent = actual ? 'Use o PU efetivamente pago. A taxa informada define a referência contratada.' : 'Sem esse preço, usamos o cálculo pela taxa informada e pelo IPCA histórico.';
      if (actual) $('history-price-details').open=true;
      availability(); syncPositionActions();
    }
    function error(message, messageId = 'history-error') { $(messageId).textContent = message; $(messageId).hidden = !message; }
    function clearFieldErrors(sectionId = 'history-form', messageId = 'history-error') {
      error('', messageId);
      for (const control of $(sectionId).querySelectorAll?.('[aria-invalid]') || []) {
        control.removeAttribute('aria-invalid');
        const help = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== messageId);
        if (help.length) control.setAttribute('aria-describedby', help.join(' ')); else control.removeAttribute('aria-describedby');
      }
    }
    function showFieldError(cause, messageId = 'history-error') {
      error(cause.message, messageId);
      const control = cause.fieldId && $(cause.fieldId);
      if (!control) return;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', [...new Set([...(control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), messageId])].join(' '));
      for (let parent = control.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      control.focus({ preventScroll: true }); control.scrollIntoView?.({ block: 'nearest' });
    }
    function invalidate(scenario = false, purchaseChanged = !scenario) {
      sequence++; stale = Boolean(current); $('history-export').disabled = true;
      if (purchaseChanged) markPositionDirty();
      clearRisk('Entradas alteradas. Atualize a evolução antes de consultar o risco.');
      clearChange('Entradas alteradas. Atualize a evolução antes de comparar as datas.');
      const cashMessage = current?.cash_deferred ? 'Atualize a evolução para consultar o líquido.' : '';
      cashStatus('position-cash', cashMessage);
      cashStatus('history-table', cashMessage);
      $('history-stale').hidden = !current;
      $('history-stale').textContent = scenario ? 'Cenário em edição. A consulta anterior permanece visível até atualizar.' : 'Entradas alteradas. A consulta anterior permanece visível até recalcular.';
      $('form-status').textContent = scenario ? 'Complete o cenário para atualizar a projeção.' : 'Entradas alteradas. Clique em Ver evolução.';
      clearFieldErrors();
    }
    function availability() {
      if (!market) return;
      const series = market.data.series.find(s => s.id === $('history-title').value);
      const { first, last } = purchaseQuote(series, $('history-purchase').value);
      $('history-purchase').min = $('history-actual').checked ? '2000-01-01' : first || ''; $('history-purchase').max = $('history-actual').checked ? asOf() : last || '';
      $('history-settlement').max = asOf();
      $('history-end').min = workspace.addIsoDays(asOf(), 1);
      $('history-availability').textContent = first ? `Histórico disponível: ${day(first)} a ${day(last)}.` : 'Sem cotações de compra para este título na fonte carregada.';
      $('history-end').max = $('history-title').value === 'IPCA_PRINCIPAL_2050' ? '2050-08-14' : '2065-01-14';
      quoteHelp();
    }
    function quoteHelp() {
      if (!market) return;
      const date = $('history-purchase').value, series = market.data.series.find(s => s.id === $('history-title').value);
      const { available, quote, previous, next } = purchaseQuote(series, date);
      const nearby = $('history-nearby-dates'); nearby.replaceChildren(); nearby.hidden = true;
      $('history-use-quote').hidden = !quote;
      if (!date) { $('history-quote-help').textContent = 'Escolha a data do comprovante da compra.'; return; }
      if (quote) {
        const rate = workspace.formatPtNumber(workspace.shiftDecimal(String(quote[1]), -2), 2);
        $('history-quote-help').textContent = `Taxa pública de compra: IPCA + ${rate}% a.a. Use a taxa do seu comprovante se ela for diferente.`;
        $('history-use-quote').textContent = `Usar taxa pública · ${rate}%`;
      } else if (available) {
        $('history-quote-help').textContent = 'Há preço de compra nesta data, mas a taxa pública não está disponível. Informe a taxa do comprovante.';
      } else if ($('history-actual').checked) {
        $('history-quote-help').textContent = 'Sem cotação pública de compra nesta data. Os dados informados do comprovante serão preservados; o gráfico usa a cobertura disponível.';
      } else {
        $('history-quote-help').textContent = 'Sem cotação de compra nesta data. Consulte uma data disponível:';
        for (const [label, value] of [['Anterior', previous], ['Próxima', next]]) {
          if (!value) continue;
          const button = doc.createElement('button'); button.type = 'button'; button.textContent = `${label} · ${day(value)}`;
          button.addEventListener('click', () => { $('history-purchase').value = value; hasCalculated = false; invalidate(); quoteHelp(); $('history-purchase').focus(); });
          nearby.append(button);
        }
        nearby.hidden = !nearby.children.length;
      }
    }
    function applySources(nextMarket, nextIpca) {
      const identity = source => [source.data.as_of, source.data.retrieved_at, source.data.source?.sha256].join('|');
      const keepLatest = (prior, next) => prior && (!data.newer(prior.data, next.data)
        || (identity(prior) === identity(next) && prior.mode === 'live')) ? prior : next;
      const acceptedMarket = keepLatest(market, nextMarket), acceptedIpca = keepLatest(ipca, nextIpca);
      const changed = Boolean(market && ipca && (identity(market) !== identity(acceptedMarket) || identity(ipca) !== identity(acceptedIpca)));
      [market, ipca] = [acceptedMarket, acceptedIpca];
      if (!$('history-end').value) $('history-end').value = workspace.addIsoMonthsClamped(asOf(), 12);
      $('history-data-status').textContent = `${market.mode === 'live' ? 'Base automática de preços' : 'Fotografia de preços; atualização automática não confirmada'} · corte ${day(market.data.as_of)} · coleta ${day(market.data.retrieved_at.slice(0, 10))}.`;
      $('history-ipca-status').textContent = `${ipca.mode === 'live' ? 'IPCA automático' : 'Fotografia de IPCA; atualização automática não confirmada'} · último mês ${ipca.data.as_of.slice(0, 7).split('-').reverse().join('/')} · coleta ${day(ipca.data.retrieved_at.slice(0, 10))}.`;
      availability();
      return changed;
    }
    async function loadSources(initial = false) {
      if (busy || positionIO || analysisBusy) return;
      const previousSources = Boolean(market && ipca), run = ++sourceRun;
      busy = true; ready = false; $('history-submit').disabled = true; $('history-reload').disabled = true; error('');
      syncPositionActions();
      $('form-status').textContent = 'Consultando preços e IPCA…';
      try {
        const sources = [['market-history', value => data.validatePrices(history.validate(value))], ['ipca-history', data.validateIPCA]];
        let values, updates;
        if (initial) {
          const requests = sources.map(args => data.progressive(...args));
          updates = requests.map(item => item.latest.catch(() => null));
          values = await Promise.all(requests.map(item => item.first));
        } else {
          values = await Promise.all(sources.map(args => data.load(...args)));
          bootstrap = null;
        }
        const changed = applySources(...values);
        ready = true;
        if (changed) { hasCalculated = false; invalidate(false, false); }
        $('form-status').textContent = !previousSources ? 'Fontes carregadas. Informe a compra.'
          : changed ? 'Fontes atualizadas. Clique em Ver evolução para recalcular.' : 'Consulta de fontes concluída. A cobertura e a coleta são as mesmas.';
        updates?.forEach((update, index) => update.then(source => {
          if (!source || run !== sourceRun) return;
          const updated = index === 0 ? applySources(source, ipca) : applySources(market, source);
          if (updated && (current || busy)) {
            $('history-source-notice').textContent = 'Há fontes mais recentes para o próximo cálculo. A consulta atual mantém a base usada no início.';
            $('history-source-notice').hidden = false;
          }
        }));
      } catch (cause) { ready = previousSources; error(cause.message); $('form-status').textContent = previousSources ? 'Atualização indisponível. As fontes anteriores foram mantidas.' : 'Não foi possível preparar o histórico.'; }
      finally { busy = false; $('history-submit').disabled = !ready; $('history-reload').disabled = false; syncPositionActions(); }
    }
    function readPoint(index, previousDate = null) {
      if (!current) return;
      const point = current.points[index]; if (!point) return;
      const changed = current.selected_date !== point.date;
      if (changed) clearRisk();
      current.selected_date = point.date;
      $('history-date').value = String(index); $('history-point').textContent = pointText(current, point);
      if (changed) {
        syncChartDate();
        syncTableDate();
      }
      $('history-date-kind').textContent = point.market_kind === 'HYPOTHETICAL' || point.period === 'FUTURE' ? 'Projeção de mercado' : 'Data histórica';
      $('history-reading-values').innerHTML = readingHTML(current, point);
      $('history-reading-note').textContent = point.status === 'Comparável' ? '' : point.status;
      $('history-reading-note').hidden = !($('history-reading-note').textContent);
      $('history-date-prev').disabled = index <= 0;
      $('history-date-next').disabled = index >= current.points.length - 1;
      const latest = current.points.at(-1);
      const lastComparable = current.points.findLast(p => p.delta != null);
      $('history-reading-context').textContent = point.date < latest.date
        ? `${!current.projection && latest.delta == null && point.date === lastComparable?.date ? 'Última comparação disponível' : 'Consultando'}: ${day(point.date)}. O gráfico vai até ${day(latest.date)}.${!current.projection && latest.delta == null ? ' Nas datas mais recentes a comparação está indisponível; consulte o motivo ao selecioná-las.' : ''}` : '';
      if (previousDate && point.date !== previousDate) $('history-reading-context').textContent = `A data consultada (${day(previousDate)}) não faz parte da nova malha. Exibindo ${day(point.date)}. ` + $('history-reading-context').textContent;
      $('history-reading-context').hidden = !$('history-reading-context').textContent;
      $('position-summary').hidden = current.display !== 'BRL' || !current.cash_method;
      if (!$('position-summary').hidden) renderPositionCash(point);
      loadPositionCash();
      $('position-change').hidden = current.display !== 'BRL';
      $('position-risk').hidden = false;
      $('position-risk-context').textContent = `Choques para ${day(point.date)}, mantendo quantidade e inflação. A queda é relativa ao valor bruto sem choque desta data.`;
      if (current.display !== 'BRL') $('position-risk-status').textContent='Informe o valor investido ou os dados do comprovante para consultar o risco em reais.';
      else if (point.market == null) $('position-risk-status').textContent = point.status;
      else if (!hasSale(point)) $('position-risk-status').textContent = 'Valor bruto inferior ao centavo. Risco indisponível.';
      else if (point.market_yield == null) $('position-risk-status').textContent = 'Falta a taxa de venda correspondente nesta data.';
      syncPositionActions();
    }
    function cashStatus(prefix, message = '', retry = false) {
      const status = $(prefix + '-status');
      status.textContent = message;
      status.hidden = !message;
      $(prefix + '-retry').hidden = !retry;
    }
    function renderPositionCash(point) {
      const pending = current.cash_deferred && !point.cash;
      $('position-values').innerHTML = positionHTML(point, current.cash_deferred);
      $('position-cash-details').innerHTML = pending ? '' : cashHTML(point) + `<p>${escape(point.cash?.net_redemption == null ? point.cash?.reason || point.status : current.cash_method.note)}</p>`;
      $('position-reconciliation').textContent = pending ? '' : reconciliationText(current.reconciliation, point.date);
      cashStatus('position-cash');
    }
    function renderFullCash() {
      if (current.display !== 'BRL') return;
      tableResult = null;
      if ($('history-table-details').open) renderTable();
      renderPositionCash(current.points[Number($('history-date').value)]);
      cashStatus('history-table');
    }
    function requestCash(snapshot, dates = null) {
      const tasks = cashRequests, key = dates ? dates.join('|') : 'all';
      if (tasks.has('all')) return tasks.get('all');
      if (tasks.has(key)) return tasks.get(key);
      const body = dates ? {...currentRequest, cash_dates: dates} : currentRequest;
      const pending = jsonRequest('/api/simulator/historical', body).then(result => {
        if (current !== snapshot || stale) return false;
        const byDate = new Map(result.points.map(point => [point.date, point]));
        const targets = dates ? snapshot.points.filter(point => dates.includes(point.date)) : snapshot.points;
        if (JSON.stringify(result.purchase) !== JSON.stringify(snapshot.purchase)
            || (!dates && result.points.length !== targets.length)
            || targets.some(point => {
              const other = byDate.get(point.date);
              return !other?.cash || other.market !== point.market || other.market_yield !== point.market_yield;
            }) || (result.projection && result.projection.today !== snapshot.projection?.today)) {
          throw Error('Os dados da consulta mudaram. Clique em Ver evolução para recalcular.');
        }
        for (const point of targets) point.cash = byDate.get(point.date).cash;
        if (snapshot.projection) snapshot.projection.final_point = snapshot.points.at(-1);
        if (!dates || dates.includes(snapshot.reconciliation?.date)) snapshot.reconciliation = result.reconciliation;
        if (!dates) delete snapshot.cash_deferred;
        return true;
      }).finally(() => tasks.delete(key));
      tasks.set(key, pending);
      return pending;
    }
    async function loadPositionCash() {
      if (!current?.cash_deferred || current.display !== 'BRL' || busy || stale || positionCashBusy || !$('position-cash-panel').open) return;
      const snapshot = current, date = snapshot.selected_date;
      const selected = snapshot.points[Number($('history-date').value)];
      const reconcile = snapshot.points.find(point => point.date === snapshot.reconciliation?.date);
      const dates = [...new Set([selected, reconcile].filter(point => point && !point.cash).map(point => point.date))];
      if (!dates.length) return;
      positionCashBusy = true;
      cashStatus('position-cash', 'Calculando líquido e custos…');
      try {
        if (await requestCash(snapshot, dates) && current.selected_date === date) renderPositionCash(selected);
      } catch (cause) {
        if (current === snapshot && !stale && current.selected_date === date && snapshot.cash_deferred) cashStatus('position-cash', cause.message, true);
      } finally {
        positionCashBusy = false;
        if (current !== snapshot || current.selected_date !== date) loadPositionCash();
      }
    }
    async function loadTableCash() {
      const snapshot = current;
      if (!snapshot?.cash_deferred || snapshot.display !== 'BRL' || busy || stale || tableCashLoading === snapshot || !$('history-table-details').open) return;
      tableCashLoading = snapshot;
      cashStatus('history-table', 'Calculando a coluna de líquido estimado…');
      try {
        if (await requestCash(snapshot)) renderFullCash();
      } catch (cause) {
        if (current === snapshot && !stale) cashStatus('history-table', cause.message, true);
      } finally {
        if (tableCashLoading === snapshot) tableCashLoading = null;
      }
    }
    async function syncChartDate() {
      const plot = globalThis.Plotly;
      if (!current || renderedChart !== current || !plot?.relayout) return;
      const shape = current.projection ? 1 : 0, date = current.selected_date;
      try { await plot.relayout($('history-chart'), { [`shapes[${shape}].x0`]: date, [`shapes[${shape}].x1`]: date }); }
      catch (_) { /* Keep the date controls usable when the chart is unavailable. */ }
    }
    function syncTableDate() {
      if (!current || tableResult !== current) return;
      const button = $('history-table').querySelector(`button[data-history-index="${Number($('history-date').value)}"]`);
      if (!button || button === tableDateButton) return;
      const hadFocus = tableDateButton === doc.activeElement;
      tableDateButton?.setAttribute('tabindex', '-1');
      tableDateButton?.removeAttribute('aria-current');
      button.setAttribute('tabindex', '0');
      button.setAttribute('aria-current', 'date');
      tableDateButton = button;
      if (hadFocus) button.focus();
    }
    function renderTable() {
      if (!current || tableResult === current) return;
      $('history-table-head').innerHTML = tableHeaderHTML(current);
      $('history-table-caption').textContent = current.display === 'BRL' ? 'Posição bruta e delta em reais por data' : 'Rendimento desde a compra e delta da referência em percentual';
      const hadFocus = tableDateButton && tableDateButton === doc.activeElement;
      $('history-table').innerHTML = tableHTML(current, true);
      tableResult = current;
      tableDateButton = null;
      syncTableDate();
      if (hadFocus) tableDateButton?.focus();
    }
    function preparePlotly() {
      if (globalThis.Plotly?.react) return Promise.resolve(globalThis.Plotly);
      return plotlyTask ??= new Promise(resolve => {
        const script = doc.createElement('script');
        let done = false;
        const finish = plot => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!plot) script.remove();
          resolve(plot);
        };
        const timer = setTimeout(() => finish(null), 10000);
        script.src = '/tesouro-marcado/plotly.min.js';
        script.async = true;
        script.addEventListener('load', () => finish(globalThis.Plotly?.react ? globalThis.Plotly : null));
        script.addEventListener('error', () => finish(null));
        doc.head.append(script);
      }).then(plot => { if (!plot) plotlyTask = null; return plot; });
    }
    async function renderChart(pendingPlot = preparePlotly()) {
      if (!current) return;
      const run = ++chartRun, snapshot = current, plottedDate = current.selected_date;
      renderedChart = null;
      $('history-chart-retry').hidden = true;
      $('history-chart-status').textContent = 'Preparando o gráfico…';
      $('history-chart-status').hidden = false;
      for (const view of ['values', 'delta']) $('history-view-' + view).setAttribute('aria-pressed', String(view === chartView));
      $('history-view-help').textContent = viewHelp(snapshot, chartView); $('history-view-help').hidden = false;
      $('history-chart-tools').hidden = false;
      $('history-chart').setAttribute('aria-label', chartView === 'delta' ? 'Diferença entre venda e referência contratada ao longo do tempo' : 'Referência contratada e venda a mercado ao longo do tempo');
      const plot = await pendingPlot;
      if (run !== chartRun) return false;
      let chartFailed = !plot;
      if (!chartFailed) {
        chartPaint = chartPaint.then(async () => {
          if (run !== chartRun) return;
          try {
            $('history-chart').hidden = false;
            $('history-chart').removeAllListeners?.('plotly_click');
            const chartLayout = layout(snapshot, window.innerWidth, chartView, viewReset);
            $('history-chart').style.height = chartLayout.height + 'px';
            await plot.react($('history-chart'), traces(snapshot, chartView), chartLayout, { responsive: true, displayModeBar: false, scrollZoom: false });
          } catch (_) { chartFailed = true; }
        });
        await chartPaint;
        if (run !== chartRun) return false;
      }
      $('history-chart').hidden = chartFailed;
      $('history-chart-status').hidden = !chartFailed;
      $('history-chart-status').textContent = chartFailed ? 'Gráfico indisponível. Os valores estão na tabela.' : '';
      $('history-chart-retry').hidden = !chartFailed;
      $('history-chart-navigation').hidden = chartFailed;
      $('history-coverage').textContent = coverageText(snapshot) + (chartFailed ? ' Gráfico indisponível; os valores estão na tabela.' : '');
      $('history-reset-view').disabled = chartFailed;
      if (chartFailed) {
        renderTable();
        $('history-table-details').open = true;
        loadTableCash();
      }
      else {
        renderedChart = snapshot;
        if (plottedDate !== snapshot.selected_date) syncChartDate();
        $('history-chart').on('plotly_click', event => { const point = event.points?.[0]; if (point?.data?.meta?.kind === 'evolution') readPoint(point.customdata?.[6]); });
      }
      return chartFailed;
    }
    function navigateDates(event, index, previous, next) {
      if (!current || busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const last = current.points.length - 1;
      const target = event.key === previous ? index - 1 : event.key === next ? index + 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
      if (target === null) return;
      event.preventDefault();
      readPoint(Math.max(0, Math.min(target, last)));
    }
    async function calculate(event) {
      event.preventDefault(); if (busy || positionIO || analysisBusy || !ready) return;
      const run = ++sequence; busy = true; $('history-submit').disabled = true; $('history-export').disabled = true;
      const results = doc.querySelector('.historical-results');
      results.setAttribute('aria-busy', 'true'); results.classList.add('is-updating'); clearFieldErrors();
      $('history-reload').disabled = true; $('history-submit').textContent = 'Calculando…';
      for (const id of ['history-view-values', 'history-view-delta', 'history-reset-view']) $(id).disabled = true;
      $('form-status').textContent = current ? 'Atualizando a consulta…' : 'Calculando a evolução…';
      syncPositionActions();
      try {
        const purchaseRequest = readPurchase(), costs = readCosts();
        const projection = projectionInput({ enabled: $('history-project').checked, endDate: $('history-end').value,
          inflation: $('history-inflation').value, marketYield: $('history-exit-rate').value,
          minDate: $('history-end').min, maxDate: $('history-end').max });
        $('history-rate').value = purchaseRate($('history-rate').value).display;
        if (projection) {
          $('history-inflation').value = purchaseRate($('history-inflation').value).display;
          $('history-exit-rate').value = purchaseRate($('history-exit-rate').value).display;
        }
        const net=moneyInput('history-institution-net',$('history-institution-net').value,true);
        const reconciliation = net === null ? null : {date:dateInput('history-reconcile-date',$('history-reconcile-date').value,purchaseRequest.date,asOf()),net_redemption:net};
        const submittedMarket = market, submittedIpca = ipca;
        const submitted = {schema_version:1,purchase:purchaseRequest,projection,market:submittedMarket.data,ipca:submittedIpca.data,position:true,costs,reconciliation};
        const pendingPlot = preparePlotly();
        await ensureBootstrap();
        if (run !== sequence) return;
        const result = await jsonRequest('/api/simulator/historical',{...submitted,cash_dates:[]});
        if (run !== sequence) return;
        result.sources.market_mode = submittedMarket.mode; result.sources.ipca_mode = submittedIpca.mode;
        if (submittedMarket === market && submittedIpca === ipca) $('history-source-notice').hidden = true;
        const samePurchase = current?.title_id === result.title_id && JSON.stringify(current.purchase) === JSON.stringify(result.purchase);
        const previous = samePurchase ? current.points[Number($('history-date').value)] : null;
        const wasLast = previous?.date === current?.points.at(-1)?.date;
        current = result; currentRequest = submitted; cashRequests = new Map(); cashStatus('history-table');
        stale = false; hasCalculated = true; $('history-empty').hidden = true; $('history-stale').hidden = true;
        const purchase = result.purchase;
        $('historical-result-title').textContent=purchase.quantity_basis==='INFORMED' ? 'Minha posição real' : 'Evolução da compra';
        $('history-context').innerHTML = purchaseContextHTML(result);
        $('history-projection-summary').textContent = projectionSummary(result);
        $('history-projection-summary').hidden = !result.projection;
        $('history-coverage').textContent = coverageText(result);
        const select = $('history-date'); select.replaceChildren();
        result.points.forEach((point, index) => { const option = doc.createElement('option'); option.value = String(index); option.textContent = day(point.date) + (point.period === 'FUTURE' ? ' · projeção' : ''); select.append(option); });
        $('history-reading').hidden = false;
        setupChangeDates(samePurchase);
        readPoint(readingIndex(result, previous, wasLast), previous && !wasLast ? previous.date : null);
        $('history-table-details').hidden = false;
        if ($('history-table-details').open) renderTable();
        else { $('history-table').replaceChildren(); tableResult = null; }
        $('form-status').textContent = 'Valores calculados.';
        renderChart(pendingPlot).then(chartFailed => {
          if (run === sequence && chartFailed) $('form-status').textContent = 'Valores calculados. Consulte a tabela.';
        });
        if (event.type === 'submit' && globalThis.innerWidth <= 760) results.scrollIntoView?.({ block: 'start', behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
      } catch (cause) { if (run === sequence) { showFieldError(cause); $('form-status').textContent = current ? 'Não foi possível atualizar. A consulta anterior foi preservada.' : cause.fieldId ? 'Confira o campo indicado para continuar.' : 'Não foi possível calcular a evolução.'; } }
      finally {
        busy = false; $('history-submit').disabled = !ready; $('history-submit').textContent = 'Ver evolução'; $('history-reload').disabled = false;
        for (const id of ['history-view-values', 'history-view-delta']) $(id).disabled = false;
        $('history-reset-view').disabled = !current || $('history-chart').hidden;
        $('history-export').disabled = !current || stale;
        results.setAttribute('aria-busy', 'false'); results.classList.remove('is-updating');
        syncPositionActions();
        if (pendingProjection) { pendingProjection = false; refreshProjection(); }
        loadTableCash();
        loadPositionCash();
      }
    }
    function refreshProjection() {
      if (!hasCalculated || !ready || $('history-project').checked && ['history-end', 'history-inflation', 'history-exit-rate'].some(id => !$(id).value.trim())) return;
      if (busy || analysisBusy || positionIO) { pendingProjection = true; return; }
      calculate({ preventDefault() {} });
    }
    function resumeProjection() { if(pendingProjection && !busy && !analysisBusy && !positionIO){pendingProjection=false;refreshProjection();} }
    async function refreshPositions(selected = $('position-list').value || savedPosition?.id, force = false) {
      if (!force && positionListLoading) return;
      const run=++positionListRun;
      positionListLoading = true;
      $('position-files-status').textContent = 'Consultando compras salvas…';
      $('position-files-retry').hidden = true;
      syncPositionActions();
      try {
        const {positions} = await jsonRequest('/api/simulator/positions');if(run!==positionListRun)return;
        const select=$('position-list');
        select.replaceChildren(); const empty=doc.createElement('option'); empty.value=''; empty.textContent=positions.length ? 'Escolha uma compra' : 'Nenhuma compra salva'; select.append(empty);
        for(const item of positions){const option=doc.createElement('option');option.value=item.id;option.textContent=`${item.name} · revisão ${item.revision}`;select.append(option);}
        select.value=positions.some(item => item.id === selected) ? selected : '';
        $('position-files-status').textContent=`${positions.length} compra(s) salvas localmente.`;
        positionsLoaded = true;
      } catch(cause){
        if (run === positionListRun) {
          positionsLoaded = false;
          $('position-files-status').textContent = cause.message;
          $('position-files-retry').hidden = false;
        }
      } finally {
        if (run === positionListRun) { positionListLoading = false; syncPositionActions(); }
      }
    }
    function purchaseSignature() {
      return JSON.stringify(['history-actual','history-title','history-purchase','history-rate','history-pu','history-quantity','history-settlement','history-entry-fee','history-exit-fee','history-tax-basis','position-name'].map(id=>[id,$(id).value,$(id).checked]));
    }
    function showPositionReceipt() {
      if (!positionReceipt) return;
      const edited = positionReceipt.signature !== purchaseSignature();
      const message = positionReceipt.message + (edited ? ' Há alterações ainda não salvas.' : '');
      if ($('position-save-status').textContent !== message) $('position-save-status').textContent = message;
    }
    function markPositionDirty() {
      positionDirty = true;
      showPositionReceipt();
    }
    function clearOpenConfirmation() {
      $('position-open-warning').hidden = true;
      pendingPosition = '';
    }
    async function savePosition(copy = false) {
      if(busy || positionIO || analysisBusy || !ready || !$('history-actual').checked) return;
      clearFieldErrors();
      positionReceipt = null;
      try {
        const purchase=readPurchase(),costs=readCosts();
        let name=$('position-name').value.trim();
        if(!name){name=`${$('history-title').value.startsWith('IPCA') ? 'IPCA+2050' : 'RendA+2065'} · ${day(purchase.date)} · ${purchase.quantity} títulos`;$('position-name').value=name;}
        const payload={schema_version:1,name,purchase,costs,consent:true,id:copy ? null : savedPosition?.id || null,expected_revision:copy ? null : savedPosition?.revision || null};
        const identity=JSON.stringify(payload);
        const editingSignature=purchaseSignature();
        if(saveAttempt?.identity!==identity)saveAttempt={identity,body:{...payload,operation_id:crypto.randomUUID().replace(/-/g,'')}};
        positionIO=true;syncPositionActions();$('position-save-status').textContent='Gravando a compra…';
        const saved=await jsonRequest('/api/simulator/positions',saveAttempt.body);
        savedPosition=saved;saveAttempt=null;
        positionDirty=editingSignature!==purchaseSignature();
        positionReceipt = {message:`Compra salva · revisão ${saved.revision}.`, signature:editingSignature};
        showPositionReceipt();
        clearOpenConfirmation();
        positionsLoaded = false;
        if ($('position-files').open) await refreshPositions(saved.id, true);
        else { positionListRun++; positionListLoading = false; }
      }catch(cause){showFieldError(cause);$('position-save-status').textContent='A gravação não foi confirmada. Os dados digitados foram preservados.';}
      finally{positionIO=false;syncPositionActions();resumeProjection();}
    }
    async function openPosition(confirmed = false) {
      if(busy || positionIO || analysisBusy || !ready || positionListLoading || !positionsLoaded)return;
      const id=$('position-list').value;
      if(!id || (confirmed && id !== pendingPosition))return;
      if(positionDirty && !confirmed){pendingPosition=id;$('position-open-warning').hidden=false;$('position-cancel-open').focus();return;}
      clearOpenConfirmation();
      positionIO=true;syncPositionActions();$('position-files-status').textContent='Abrindo os dados da compra…';
      try{
        const openingSignature=()=>purchaseSignature()+JSON.stringify(['history-budget','history-project','history-end','history-inflation','history-exit-rate','history-institution-net','history-reconcile-date'].map(id=>[$(id).value,$(id).checked]));
        const editingSignature=openingSignature();
        const record=await jsonRequest('/api/simulator/positions?id='+encodeURIComponent(id)),p=record.payload.purchase,c=record.payload.costs;
        if(editingSignature!==openingSignature()){$('position-files-status').textContent='A edição mudou durante a abertura e foi preservada. Abra a compra novamente quando estiver pronto.';return;}
        $('history-actual').checked=true;$('history-title').value=p.title_id;$('history-purchase').value=p.date;
        $('history-rate').value=workspace.formatPtNumber(workspace.shiftDecimal(p.yield,2),-1);
        $('history-pu').value=workspace.formatPtNumber(p.pu,-1);$('history-quantity').value=workspace.formatPtNumber(p.quantity,-1);$('history-settlement').value=p.settlement_date;
        for(const [control,key]of[['history-entry-fee','entry_fee'],['history-exit-fee','exit_fee'],['history-tax-basis','tax_cost_basis']])$(control).value=c[key]===null ? '' : workspace.formatPtNumber(c[key],-1);
        $('history-institution-net').value='';$('history-reconcile-date').value='';$('position-name').value=record.name;
        $('history-project').checked=false;$('history-projection-fields').hidden=true;$('history-projection-fields').disabled=true;
        actualMode();hasCalculated=false;invalidate(false,false);positionDirty=false;savedPosition={id:record.id,revision:record.revision};saveAttempt=null;
        $('position-files-status').textContent='Compra aberta, sem recalcular. Clique em Ver evolução para consultar as fontes carregadas.';
        positionReceipt = {message:`Dados salvos · revisão ${record.revision}.`, signature:purchaseSignature()};
        showPositionReceipt();$('history-purchase').focus();
      }catch(cause){$('position-files-status').textContent=cause.message;}
      finally{positionIO=false;syncPositionActions();resumeProjection();}
    }
    async function calculateRisk() {
      if($('position-risk-run').disabled)return;
      clearFieldErrors('position-risk', 'position-risk-error');
      let limit;
      try{limit=moneyInput('position-risk-limit',$('position-risk-limit').value,true);}catch(cause){showFieldError(cause, 'position-risk-error');return;}
      const range=Number($('position-risk-range').value);
      if(![50,100,200].includes(range)){showFieldError(fieldError('position-risk-range','Escolha uma faixa de choques válida.'), 'position-risk-error');return;}
      const selected=current.points[Number($('history-date').value)], run=++riskRevision, revision=sequence;
      const body={...currentRequest,risk:{date:selected.date,shocks_bps:[-range,-range/2,0,range/2,range],loss_limit:limit}};
      analysisBusy=true;syncPositionActions();$('position-risk-status').textContent='Reprecificando os choques para a mesma posição…';
      try{
        const result=await jsonRequest('/api/simulator/position-risk',body);
        if(run!==riskRevision || revision!==sequence)return;
        current.risk=result;$('position-risk-values').innerHTML=riskHTML(result);$('position-risk-values').hidden=false;
        $('position-risk-status').textContent=result.status==='AVAILABLE' ? 'Choques calculados. Valores hipotéticos para a mesma data e quantidade.' : 'Risco indisponível nesta data.';
      }catch(cause){if(run===riskRevision)$('position-risk-status').textContent=cause.message;}
      finally{analysisBusy=false;syncPositionActions();resumeProjection();}
    }
    async function explainChange() {
      if ($('position-change-run').disabled) return;
      const comparison = {start_date:$('position-change-start').value, end_date:$('position-change-end').value};
      const run = ++changeRevision, revision = sequence;
      analysisBusy = true;
      syncPositionActions();
      $('position-change-status').textContent = 'Separando os efeitos para a mesma posição…';
      try {
        const result = await jsonRequest('/api/simulator/position-change', {...currentRequest, comparison});
        if (run !== changeRevision || revision !== sequence) return;
        current.position_change = result;
        $('position-change-values').innerHTML = changeHTML(result);
        $('position-change-values').hidden = false;
        $('position-change-status').textContent = result.status === 'AVAILABLE' ? 'Variação explicada.' : 'Decomposição indisponível para essas datas.';
      } catch (cause) {
        if (run === changeRevision) $('position-change-status').textContent = cause.message;
      } finally {
        analysisBusy = false;
        syncPositionActions();
        resumeProjection();
      }
    }
    $('history-form').addEventListener('submit', calculate);
    $('history-form').addEventListener('input', event => { if(event.target.id==='position-name'){markPositionDirty();return;} const scenario = Boolean(event.target.closest('.historical-projection')); if (!scenario) hasCalculated = false; invalidate(scenario); });
    $('history-title').addEventListener('change', availability);
    $('history-actual').addEventListener('change',actualMode);
    $('position-list').addEventListener('change',()=>{clearOpenConfirmation();syncPositionActions();});
    $('position-files').addEventListener('toggle', () => {
      clearOpenConfirmation();
      if ($('position-files').open) return refreshPositions();
    });
    $('position-files-retry').addEventListener('click', () => refreshPositions());
    $('position-open').addEventListener('click',()=>openPosition());
    $('position-confirm-open').addEventListener('click',()=>openPosition(true));
    $('position-cancel-open').addEventListener('click',()=>{clearOpenConfirmation();$('position-open').focus();});
    $('position-save').addEventListener('click',()=>savePosition());
    $('position-copy').addEventListener('click',()=>savePosition(true));
    $('position-risk-run').addEventListener('click',calculateRisk);
    $('position-change-start').addEventListener('change', () => { clearChange(); changeCoverage(); syncPositionActions(); });
    $('position-change-end').addEventListener('change', () => { updateChangeStart($('position-change-start').value); clearChange(); syncPositionActions(); });
    $('position-change-use-date').addEventListener('click', () => {
      if ($('position-change-use-date').hidden || $('position-change-use-date').disabled) return;
      $('position-change-end').value = current.selected_date;
      updateChangeStart($('position-change-start').value); clearChange(); syncPositionActions();
      $('position-change-end').focus();
    });
    $('position-change-run').addEventListener('click', explainChange);
    for(const id of ['position-risk-range','position-risk-limit'])$(id).addEventListener('input',()=>{
      clearFieldErrors('position-risk', 'position-risk-error');
      clearRisk('Choques alterados. Calcule novamente o risco.');
    });
    $('history-purchase').addEventListener('input', quoteHelp);
    $('history-use-quote').addEventListener('click', () => {
      const series = market?.data.series.find(s => s.id === $('history-title').value), quote = purchaseQuote(series, $('history-purchase').value).quote;
      if (!quote) return;
      $('history-rate').value = workspace.formatPtNumber(workspace.shiftDecimal(String(quote[1]), -2), 2);
      hasCalculated = false; invalidate(); $('history-rate').focus();
    });
    for (const view of ['values', 'delta']) $('history-view-' + view).addEventListener('click', () => {
      if (chartView === view || busy || !current) return;
      chartView = view; renderChart();
    });
    $('history-reset-view').addEventListener('click', () => { if (current && !busy) { viewReset++; renderChart(); } });
    $('history-chart-retry').addEventListener('click', () => { if (current && !busy) return renderChart(); });
    $('history-compare').addEventListener('click', () => {
      if ($('history-compare').disabled || $('history-compare').hidden) return;
      $('position-change').open = true;
      $('position-change-end').focus();
    });
    for (const id of ['history-rate', 'history-inflation', 'history-exit-rate']) $(id).addEventListener('blur', () => { if ($(id).value.trim()) { try { $(id).value = purchaseRate($(id).value).display; } catch (_) {} } });
    $('history-project').addEventListener('change', () => {
      const enabled = $('history-project').checked;
      $('history-projection-fields').hidden = !enabled; $('history-projection-fields').disabled = !enabled;
      refreshProjection();
    });
    $('history-projection-fields').addEventListener('change', refreshProjection);
    $('history-date').addEventListener('change', () => readPoint(Number($('history-date').value)));
    $('history-date-prev').addEventListener('click', () => readPoint(Number($('history-date').value) - 1));
    $('history-date-next').addEventListener('click', () => readPoint(Number($('history-date').value) + 1));
    $('history-chart').addEventListener('keydown', event => {
      if (event.target === $('history-chart')) navigateDates(event, Number($('history-date').value), 'ArrowLeft', 'ArrowRight');
    });
    $('history-table').addEventListener('click', event => {
      const button = event.target.closest('button[data-history-index]');
      if (button && !busy) readPoint(Number(button.dataset.historyIndex));
    });
    $('history-table').addEventListener('keydown', event => {
      const button = event.target.closest('button[data-history-index]');
      if (button) navigateDates(event, Number(button.dataset.historyIndex), 'ArrowUp', 'ArrowDown');
    });
    $('history-reload').addEventListener('click', () => loadSources());
    $('position-cash-panel').addEventListener('toggle', loadPositionCash);
    $('position-cash-retry').addEventListener('click', loadPositionCash);
    $('history-table-details').addEventListener('toggle', () => {
      if ($('history-table-details').open) { renderTable(); loadTableCash(); }
    });
    $('history-table-retry').addEventListener('click', loadTableCash);
    $('history-export').addEventListener('click', async () => {
      if (!current || busy || stale || exporting) return;
      const accepted = current, exportedView = chartView, selectedDate = current.selected_date;
      const risk = current.risk, change = current.position_change;
      exporting = true;
      syncPositionActions();
      try {
        const needsCash = accepted.cash_deferred;
        if (needsCash && !await requestCash(accepted)) return;
        if (current !== accepted || stale) return;
        const snapshot = {...accepted, selected_date: selectedDate, risk, position_change: change};
        if (needsCash) renderFullCash();
        let source = '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          const response = await fetch('/tesouro-marcado/plotly.min.js', {signal:controller.signal});
          if (response.ok) source = await response.text();
        } catch (_) {
          // The report's numeric tables remain available offline.
        } finally { clearTimeout(timer); }
        const content = exportHTML(snapshot, source, exportedView), link = doc.createElement('a'), url = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
        link.href = url; link.download = 'evolucao-historica-' + snapshot.title_id.toLowerCase() + '.html'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (cause) { error(cause.message); }
      finally { exporting = false; syncPositionActions(); }
    });
    if (typeof globalThis.ResizeObserver === 'function') {
      const header = doc.querySelector('.app-header');
      const syncHeader = () => doc.documentElement.style.setProperty('--shell-header-height', Math.ceil(header.getBoundingClientRect().height) + 'px');
      new ResizeObserver(syncHeader).observe(header); syncHeader();
    }
    globalThis.addEventListener?.('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (current && !busy && !$('history-chart').hidden) renderChart(); }, 120);
    });
    loadSources(true);
  }
  return { decimal, ratio, purchaseRate, purchaseQuote, purchaseInput, moneyInput, cashHTML, positionHTML, riskHTML, projectionInput, projectionSummary, readingIndex, traces, layout, pointText, readingHTML, coverageText, tableHeaderHTML, tableHTML, exportHTML, mount };
});
