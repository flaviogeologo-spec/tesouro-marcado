/* Browser bridge between the legacy MTM form and the pure workspace state. */
(function (root, factory) {
  const presentation = root && root.MTMPresentation
    ? root.MTMPresentation
    : (typeof module === 'object' && module.exports ? require('./mtm-presentation.js') : null);
  const api = factory(() => root && root.MTMState, () => presentation, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MTMWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getStateModule, getPresentationModule, root) {
  'use strict';

  let stateModule = null;
  let state = null;
  let http = null;
  let heavyRequestQueue = null;
  let legacyMounted = false;
  let latestDraft = {};
  let workspaceMount = null;

  function saveOperationForPayload(previous, body, createId) {
    const signature = JSON.stringify(body);
    if (previous?.signature === signature) return previous;
    const id = createId();
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new TypeError('Não foi possível identificar esta gravação. Recarregue a página.');
    return Object.freeze({ signature, id });
  }

  function saveAcknowledgementForDraft(dispatchedSignature, currentSignature, name, asCopy) {
    return {
      draftChanged: dispatchedSignature !== currentSignature,
      savedSignature: asCopy
        ? JSON.stringify({ ...JSON.parse(dispatchedSignature), name }) : dispatchedSignature,
    };
  }

  function comparisonSnapshotConfig(value = {}) {
    const config = {
      comparison_mode: value.comparison_mode === 'FIXED_POSITION' ? 'FIXED_POSITION' : 'BUDGET',
      horizon: value.horizon || null,
      cash_growth: value.cash_growth ? { ...value.cash_growth } : null,
      highlight: value.highlight || 'none',
    };
    if (config.comparison_mode === 'FIXED_POSITION' && config.cash_growth) {
      delete config.cash_growth.origin_date;
    }
    return config;
  }

  const G5_BASIS_IDS = Object.freeze({
    reference: 'G3_MANUAL_PU_REFERENCE',
    manual: 'G3_MANUAL_PU',
    repriced: 'G5_REPRICED_RATE_0.069879_INFLATION_0.03',
    semanticsVersion: 'G5_DUAL_BASES_V1',
  });

  const G5_DECISION_MARGINS = Object.freeze({
    nominal_profit_goal_brl: '12000.00',
    cash_rate_domain: Object.freeze({
      minimum_rate: '0.00', maximum_rate: '0.10', step: '0.01',
      unit: 'ratio', kind: 'explicit net hypothetical rate',
    }),
    exit_real_rate_domain: Object.freeze({
      base: '0.069879', minimum_delta: '0.0000', maximum_delta: '0.0020',
      step: '0.0001', unit: 'ratio',
    }),
    annual_inflation_levels: Object.freeze(['0.02', '0.03', '0.04']),
    exit_expense_domain: Object.freeze({
      minimum_brl: '0', maximum_brl: '500', step_brl: '100', unit: 'BRL',
    }),
    decomposition: Object.freeze({rate_a_delta: '0.0010', inflation_b_level: '0.04'}),
    fiscal_pair: Object.freeze({
      sale_dates: Object.freeze(['2027-04-13', '2027-04-14']),
      real_rate: '0.069879',
      inflation_projection: Object.freeze({
        mode: 'CONSTANT_ANNUAL', annual_rate: '0.03', anchor_date: '2026-10-15',
        anchor_level: '1', source_ref: 'G5 independent baseline projection',
      }),
      common_horizon: '2027-04-14', cash_growth_rate: '0.03',
    }),
  });

  function g5StressRequestFromComparison(comparison) {
    if (comparison?.comparison_mode !== 'FIXED_POSITION') {
      throw new TypeError('A sensibilidade G5 exige comparação da mesma posição.');
    }
    if (!comparison.reference?.input || !Array.isArray(comparison.alternatives)
        || comparison.alternatives.length !== 1 || !comparison.alternatives[0]?.input) {
      throw new TypeError('G5 exige uma referência e exatamente uma alternativa da mesma posição.');
    }
    if (comparison.alternatives[0].input.exit_price?.mode !== 'MANUAL_PU'
        || comparison.alternatives[0].input.exit_price.pu == null) {
      throw new TypeError('Margens, caixa e despesas G5 exigem a alternativa G3 explícita em MANUAL_PU.');
    }
    if (!comparison.horizon || !comparison.cash_growth?.annual_net_rate
        || comparison.cash_growth.profile !== 'ACT_365_COMPOUND_v1') {
      throw new TypeError('G5 exige horizonte e taxa líquida de caixa explícitos.');
    }
    return {
      schema_version: 2,
      action: 'STRESS',
      input: JSON.parse(JSON.stringify(comparison.alternatives[0].input)),
      fixed_position: {
        reference: JSON.parse(JSON.stringify(comparison.reference)),
        horizon: comparison.horizon,
        cash_growth: JSON.parse(JSON.stringify(comparison.cash_growth)),
      },
      decision_margins: JSON.parse(JSON.stringify(G5_DECISION_MARGINS)),
      max_evaluations: 64,
      deadline_ms: 10000,
    };
  }

  function g5StressContextIdentity(payload, comparisonIdentity) {
    if (!payload?.fixed_position || !payload?.decision_margins) return null;
    return JSON.stringify({
      input: payload.input,
      fixed_position: payload.fixed_position,
      decision_margins: payload.decision_margins,
      comparison_identity: comparisonIdentity || null,
      basis_semantics: G5_BASIS_IDS,
    });
  }

  async function handleStressResponse({request, isIntentCurrent, isContextCurrent, apply}) {
    const response = await request;
    if (!isIntentCurrent()) return {status: 'superseded', response};
    if (!response?.accepted || !response.response?.result) return {status: 'rejected', response};
    if (!isContextCurrent()) return {status: 'stale', response};
    apply(response);
    return {status: 'applied', response};
  }

  function g5DecisionMarginsViewModel(result) {
    if (result?.comparison_mode !== 'FIXED_POSITION' || !result?.decision_margins) return null;
    const axes = [
      ['cash_rate_sensitivity', 'Caixa líquido anual', 'rate'],
      ['exit_rate_sensitivity', 'Taxa real de saída', 'annual_real_rate'],
      ['inflation_sensitivity', 'Inflação anual', 'annual_inflation_rate'],
      ['exit_expense_sensitivity', 'Despesa de saída', 'exit_expense_brl'],
    ].map(([id, label, coordinate]) => ({
      id, label, coordinate,
      basis_id: result[id]?.basis_id || result[id]?.points?.[0]?.basis_id || null,
      points: Array.isArray(result[id]?.points) ? result[id].points.map(point => ({
        coordinate: point[coordinate] ?? null,
        delta: point.delta ?? null,
        status: point.status || 'UNKNOWN',
        wealth_advantage_brl: point.wealth_advantage_brl ?? null,
        margin: point.margin || null,
        reason: point.reason || null,
      })) : [],
    }));
    const unavailablePoints = [];
    const observedChanges = [];
    for (const axis of axes) {
      if (!axis.points.length) {
        unavailablePoints.push({
          axis_id: axis.id, axis_label: axis.label, coordinate: null,
          reason: {code: 'DOMAIN_POINTS_UNAVAILABLE', message: 'Nenhum ponto declarado foi disponibilizado.'},
        });
      }
      for (let index = 0; index < axis.points.length; index += 1) {
        const point = axis.points[index];
        if (!['MET', 'NOT_MET'].includes(String(point.status).toUpperCase())) {
          unavailablePoints.push({
            axis_id: axis.id, axis_label: axis.label, coordinate: point.coordinate,
            reason: point.reason || {code: 'POINT_UNAVAILABLE', message: 'Este ponto não tem resultado classificável.'},
          });
        }
        if (index === 0) continue;
        const previous = axis.points[index - 1];
        const previousStatus = String(previous.status).toUpperCase();
        const currentStatus = String(point.status).toUpperCase();
        if (['MET', 'NOT_MET'].includes(previousStatus)
            && ['MET', 'NOT_MET'].includes(currentStatus)
            && previousStatus !== currentStatus) {
          observedChanges.push({
            axis_id: axis.id, axis_label: axis.label,
            from_coordinate: previous.coordinate, from_status: previousStatus,
            to_coordinate: point.coordinate, to_status: currentStatus,
            basis_id: axis.basis_id,
          });
        }
      }
    }
    const coverageCounts = [
      ['cash_rate_sensitivity', 'cash_rate_points'],
      ['exit_rate_sensitivity', 'exit_rate_points'],
      ['inflation_sensitivity', 'inflation_points'],
      ['exit_expense_sensitivity', 'exit_expense_points'],
    ];
    const declaredPointsComplete = coverageCounts.every(([axisId, coverageId]) => {
      const axis = axes.find(item => item.id === axisId);
      const counts = result.coverage?.[coverageId];
      if (!axis?.points.length) return false;
      if (!counts) return true;
      return counts.requested === axis.points.length
        && counts.evaluated === counts.requested;
    });
    const complete = result.coverage?.complete === true
      && declaredPointsComplete && unavailablePoints.length === 0;
    const marginReading = {
      kind: !complete ? 'PARTIAL'
        : observedChanges.length ? 'OBSERVED_CHANGE' : 'NO_CHANGE_OBSERVED',
      complete,
      observed_changes: observedChanges,
      unavailable_points: unavailablePoints,
      reasons: [
        ...(result.computation_budget?.incomplete_reason ? [{
          code: result.computation_budget.incomplete_reason,
          message: 'O limite de avaliações ou o prazo deixou cobertura incompleta.',
        }] : []),
        ...(result.rate_inflation_decomposition?.reason ? [result.rate_inflation_decomposition.reason] : []),
        ...(result.fiscal_transition?.reason ? [result.fiscal_transition.reason] : []),
        ...(result.fiscal_transition?.bridge?.reason ? [result.fiscal_transition.bridge.reason] : []),
        ...(Array.isArray(result.warnings) ? result.warnings.filter(item => item?.code || item?.message) : []),
      ],
      message: !complete
        ? 'Cobertura parcial; conclusão limitada aos pontos diretamente avaliados.'
        : observedChanges.length
          ? 'Mudança de estado observada entre pontos diretamente avaliados.'
          : 'Nenhuma mudança de estado foi observada nos pontos diretamente avaliados do domínio declarado.',
    };
    return {
      status: result.status || 'partial',
      complete,
      basis_semantics: result.basis_semantics || null,
      coverage: result.coverage || null,
      computation_budget: result.computation_budget || null,
      margins: {
        nominal_profit_goal: result.decision_margins.nominal_profit_goal || null,
        wealth_at_9_percent: result.decision_margins.wealth_at_9_percent || null,
      },
      axes,
      margin_reading: marginReading,
      decomposition: result.rate_inflation_decomposition || null,
      fiscal_transition: result.fiscal_transition || null,
      limits: result.limits || null,
    };
  }

  function g5MarginStatusLabel(status) {
    return ({
      MET: 'Meta atendida no ponto avaliado',
      NOT_MET: 'Meta não atendida no ponto avaliado',
      UNKNOWN: 'Ponto ainda não verificado',
      READY: 'Calculado',
      PARTIAL: 'Parcial',
    })[String(status || '').toUpperCase()] || 'Estado não informado';
  }

  function g5PointCoordinate(axis, value) {
    if (value == null) return presentation().MISSING;
    return axis.id === 'exit_expense_sensitivity'
      ? formatCurrency(value, 2) : formatRatioPercent(value, 2);
  }

  function renderG5MarginReading(summary, reading, axes, textElement) {
    const changeLabels = reading.observed_changes.map(change => {
      const axis = axes.find(item => item.id === change.axis_id);
      const from = g5PointCoordinate(axis, change.from_coordinate);
      const to = g5PointCoordinate(axis, change.to_coordinate);
      return `${change.axis_label}: ${from} (${g5MarginStatusLabel(change.from_status)}) a ${to} (${g5MarginStatusLabel(change.to_status)})`;
    });
    summary.append(textElement('p', [reading.message, ...changeLabels].join(' '),
      reading.complete ? 'mtm-compare-summary' : 'mtm-surface-stale'));
    for (const item of reading.unavailable_points) {
      const reason = item.reason || {};
      const coordinate = item.coordinate == null ? '' : ` em ${g5PointCoordinate(axes.find(axis => axis.id === item.axis_id), item.coordinate)}`;
      const detail = [reason.code, reason.message].filter(Boolean).join(': ') || 'Motivo não informado.';
      summary.append(textElement('p', `${item.axis_label}${coordinate}: ${detail}`, 'mtm-surface-stale'));
    }
    if (!reading.complete && reading.unavailable_points.length === 0) {
      for (const reason of reading.reasons) {
        const detail = [reason.code, reason.message].filter(Boolean).join(': ');
        if (detail) summary.append(textElement('p', detail, 'mtm-surface-stale'));
      }
    }
    return summary;
  }

  const COMMON_RATE_SHOCKS = Object.freeze([
    { id: 'rate-down-50', rate_shock_ratio: '-0.005' },
    { id: 'rate-unchanged', rate_shock_ratio: '0' },
    { id: 'rate-up-50', rate_shock_ratio: '0.005' },
  ]);

  function commonShockRequests(comparison) {
    return [comparison.reference, ...(comparison.alternatives || [])].map(item => ({
      id: item.id, label: item.label,
      payload: { schema_version: 2, action: 'STRESS',
        input: JSON.parse(JSON.stringify(item.input)),
        shocks: COMMON_RATE_SHOCKS.map(shock => ({ ...shock })),
        margin_searches: [], max_evaluations: 4, deadline_ms: 10000 },
    }));
  }

  function commonShockViewModel(records) {
    return records.map(record => ({
      id: record.id, label: record.label,
      excludedPointOverrides: [...(record.result?.excluded_point_overrides || [])],
      points: COMMON_RATE_SHOCKS.map(shock => {
        const point = record.result?.scenarios?.find(item => item.id === shock.id);
        return { id: shock.id, shock: shock.rate_shock_ratio,
          value: point?.status === 'ready' ? point.operation?.net_redemption ?? null : null,
          status: point?.status || 'unavailable', quality: point?.quality || 'MISSING',
          reason: point?.reason?.message || null, warnings: [...(point?.warnings || [])] };
      }),
    }));
  }

  function fixedPositionComparisonViewModel(result) {
    const alternatives = Array.isArray(result?.alternatives) ? result.alternatives : [];
    const values = (read) => Object.fromEntries(alternatives.map(item => [item.id, read(item) ?? null]));
    const sourceText = item => {
      const sideLabel = (key, label) => {
        const source = item.price_provenance?.[key] || {};
        const provenance = source.provenance || {};
        return `${label}: ${provenance.source_ref || provenance.source_id || `${source.mode || 'PU informado'}; fonte não autenticada`}`;
      };
      const versions = Object.entries(item.source_versions || {})
        .filter(([, value]) => value).map(([key, value]) => {
          const version = String(value);
          return `versão ${key} ${version.length > 32 ? version.slice(0, 12) : version}`;
        });
      return [sideLabel('entry', 'Compra'), sideLabel('exit', 'Venda'), ...versions].join(' · ');
    };
    return {
      rows: [
        { id: 'sale_order', label: 'Venda solicitada', values: values(item => item.dates?.sale_order) },
        { id: 'exit_pu', label: 'PU de saída por título', values: values(item => item.operation?.exit_pu) },
        { id: 'net_redemption', label: 'Resgate líquido na saída', values: values(item => item.operation?.net_redemption) },
        { id: 'profit_since_purchase', label: 'Lucro líquido desde a compra', values: values(item => item.profit_since_purchase?.value) },
        { id: 'wealth_advantage', label: 'Vantagem patrimonial de esperar', values: values(item => item.wealth_advantage_vs_reference?.value) },
        { id: 'total_resources', label: 'Recursos no horizonte comum', values: values(item => item.total_resources_at_horizon?.value) },
        { id: 'availability', label: 'Disponibilidade do resgate', values: values(item => item.dates?.cash_available_at || item.dates?.sale_settlement) },
        { id: 'quality', label: 'Qualidade da estimativa', values: values(item => item.quality) },
        { id: 'sources', label: 'Fontes e versões', values: values(sourceText) },
      ],
      position: result?.position || null,
      cash_assumption: result?.ranking?.assumption || 'Hipótese de caixa não informada.',
    };
  }

  function g4FrontierConditionLabel(status) {
    return ({
      MET: 'Atendida',
      NOT_MET: 'Não atendida',
      TIE: 'Empate na taxa avaliada',
      NO_GOALS: 'Sem metas declaradas',
      UNAVAILABLE: 'Indisponível',
    })[String(status || '').toUpperCase()] || 'Sem estado';
  }

  function g4FrontierViewModel(result) {
    const labels = {
      nominal_equilibrium: 'Equilíbrio nominal',
      personal_goals: 'Metas pessoais',
      sell_wait_indifference: 'Indiferença entre vender e esperar',
    };
    const statusLabels = {
      complete: 'completa', partial: 'parcial', unavailable: 'indisponível',
      not_applicable: 'não aplicável',
    };
    if (!result?.frontiers || typeof result.frontiers !== 'object') return null;
    const reference = result.frontier_reference || {};
    return {
      reference_status: reference.status || 'unavailable',
      common_horizon: reference.common_horizon || null,
      conditions: Object.entries(labels).map(([id, label]) => {
        const frontier = result.frontiers[id] || {};
        const coverage = frontier.coverage || {};
        return {
          id, label,
          coverage_status: coverage.status || 'unavailable',
          coverage_label: statusLabels[coverage.status] || 'indisponível',
          requested_points: Number(coverage.requested_points || 0),
          available_points: Number(coverage.available_points || 0),
          unavailable_points: Number(coverage.unavailable_points || 0),
          not_applicable_points: Number(coverage.not_applicable_points || 0),
          bracket_count: Array.isArray(frontier.brackets) ? frontier.brackets.length : 0,
          tie_count: Array.isArray(frontier.ties) ? frontier.ties.length : 0,
        };
      }),
    };
  }

  function g4FrontierRequestFromComparison(comparison, {
    minimumPercent, maximumPercent, stepPercent, metricId = 'nominal_profit',
  } = {}) {
    if (comparison?.comparison_mode !== 'FIXED_POSITION' || comparison.alternatives?.length !== 1) {
      throw new TypeError('A exploração de fronteiras exige uma referência e uma alternativa da mesma posição.');
    }
    if (!comparison.horizon) throw new TypeError('Informe o horizonte comum para comparar a mesma posição.');
    const reference = comparison.reference;
    const alternative = comparison.alternatives[0];
    const family = alternative.input?.instrument?.family || '';
    const rateDomain = rateCurveDomainFromPercentages(
      minimumPercent, maximumPercent, stepPercent, family, 21,
    );
    const dates = [...new Set([reference.input?.sale_date, alternative.input?.sale_date].filter(Boolean))].sort();
    if (!dates.length || dates.length > 5) {
      throw new TypeError('Informe datas de saída elegíveis nos dois contextos antes de abrir a grade G4.');
    }
    const priorExit = alternative.input.exit_price || {};
    const entry = alternative.input.entry_price || {};
    const knownRate = priorExit.mode === 'MANUAL_RATE' ? priorExit.annual_real_rate
      : priorExit.mode === 'SAME_ENTRY_RATE' ? entry.annual_real_rate : null;
    const selectedRate = knownRate != null && rateDomain.values.some(value => sameDecimalValue(value, knownRate))
      ? rateDomain.values.find(value => sameDecimalValue(value, knownRate))
      : rateDomain.values[Math.floor(rateDomain.values.length / 2)];
    return {
      points: rateDomain.points,
      dates,
      body: {
        schema_version: 2, action: 'SURFACE', input: alternative.input,
        surface: {
          mode: 'RATE_DATE_MAP', metric_id: metricId,
          value_unit: 'ratio', order_dates: dates, values: rateDomain.values,
          selected: { order_date: alternative.input.sale_date || dates.at(-1), value: selectedRate },
        },
        fixed_position: {
          reference, horizon: comparison.horizon,
          ...(comparison.cash_growth ? { cash_growth: comparison.cash_growth } : {}),
        },
      },
    };
  }

  function g4FrontierSelectionContextIsCurrent(expectedContext, currentContext, currentComparisonIdentity) {
    return !expectedContext || (
      currentContext === expectedContext
      && expectedContext.comparison_identity === currentComparisonIdentity
    );
  }

  function presentation() {
    const module = getPresentationModule();
    if (!module) throw new Error('MTM presentation module must load before the workspace bridge.');
    return module;
  }

  function resolutionCapabilityMessages(capabilities, resolved) {
    const required = ['input_resolution', 'date_resolution', 'price_resolution', 'nominal_evaluation', 'purchase_sizing'];
    const messages = [];
    const orderReasons = ['purchase', 'sale'].flatMap(side => {
      const reason = resolved?.dates?.[side]?.reason;
      if (!reason || typeof reason.message !== 'string' || !reason.message.trim()) return [];
      return [{ side, code: reason.code, message: reason.message.trim() }];
    });
    const detailedDateCodes = new Set(orderReasons.map(item => item.code).filter(Boolean));
    for (const key of required) {
      const capability = capabilities?.[key];
      if (!capability || capability.status === 'available') continue;
      if (detailedDateCodes.has(capability.reason?.code)) continue;
      if (capability.reason?.code === 'MISSING_FIELD' && capability.missing_fields?.length) continue;
      const message = typeof capability.reason === 'string'
        ? capability.reason
        : capability.reason?.message;
      if (typeof message === 'string' && message.trim() && !messages.includes(message.trim())) {
        messages.push(message.trim());
      }
    }
    for (const item of orderReasons) {
      const message = `${item.side === 'purchase' ? 'Compra' : 'Venda'}: ${item.message}`;
      if (!messages.includes(message)) messages.push(message);
    }
    return messages;
  }

  function partialResolutionStatusMessage(capabilities, resolved, hasPreviousResult, additionalMessages = []) {
    const pendingItems = Array.isArray(resolved?.pending_items) ? resolved.pending_items : [];
    const blockingCount = pendingItems.filter(item => item?.severity === 'BLOCKING').length;
    const advisoryCount = pendingItems.length - blockingCount;
    if (pendingItems.length) {
      const detail = blockingCount
        ? `${blockingCount} pendência${blockingCount === 1 ? '' : 's'} impede${blockingCount === 1 ? '' : 'm'} esta operação. Use as ações indicadas no início do formulário.`
        : `A operação pode ser avaliada; ${advisoryCount} saída${advisoryCount === 1 ? ' opcional ainda depende' : 's opcionais ainda dependem'} de dados adicionais.`;
      const previous = hasPreviousResult
        ? 'O último resultado válido permanece identificado como anterior.'
        : 'Nenhum resultado está disponível para a revisão atual.';
      return `A revisão atual não foi avaliada. ${detail} ${previous}`;
    }
    const reasons = [...new Set([
      ...resolutionCapabilityMessages(capabilities, resolved),
      ...(Array.isArray(additionalMessages) ? additionalMessages : []),
    ])];
    const detail = reasons.length ? reasons.join(' ') : 'Há dados ou confirmações pendentes.';
    const previous = hasPreviousResult
      ? 'O último resultado válido permanece identificado como anterior.'
      : 'Nenhum resultado está disponível para a revisão atual.';
    return `A revisão atual não foi avaliada. ${detail} ${previous}`;
  }

  function pendingItemPanelModel(item) {
    const pending = item && typeof item === 'object' ? item : {};
    const title = pending.title || 'Dado necessário';
    const relevantDates = Array.isArray(pending.relevant_dates) ? pending.relevant_dates : [];
    const orderDates = Array.isArray(pending.order_dates) ? pending.order_dates : [];
    const settlementDates = Array.isArray(pending.settlement_dates) ? pending.settlement_dates : [];
    const alternatives = (Array.isArray(pending.alternatives) ? pending.alternatives : [])
      .filter(alternative => alternative && typeof alternative.label === 'string');
    const dateDetails = [];
    if (orderDates.length) {
      dateDetails.push(`Data da ordem: ${orderDates.map(value => presentation().formatDate(value)).join(' · ')}`);
    }
    if (settlementDates.length) {
      dateDetails.push(`Data da liquidação: ${settlementDates.map(value => presentation().formatDate(value)).join(' · ')}`);
    }
    return {
      title,
      message: pending.message || 'Confira as informações desta saída.',
      severity_text: pending.severity === 'BLOCKING'
        ? 'Necessária para avaliar esta operação.'
        : 'Não impede o resultado nominal desta operação.',
      relevant_date_text: dateDetails.length
        ? dateDetails.join(' · ')
        : relevantDates.length
          ? `Data financeira: ${relevantDates.map(value => presentation().formatDate(value)).join(' · ')}`
          : null,
      alternatives,
      details_text: [
        `Saída: ${(pending.capability_ids || []).join(', ') || 'não identificada'}`,
        `Campo: ${pending.field_path || 'não identificado'}`,
        `Estado: ${pending.status || 'indisponível'}`,
        `Motivo técnico: ${(pending.reason_codes || [pending.reason_code]).filter(Boolean).join(', ') || 'não informado'}`,
        ...(pending.source_refs || []).map(value => `Fonte informada: ${value}`),
      ].join(' · '),
    };
  }

  function pendingDateSuggestion(item, dates, requested) {
    const side = ({ 'dates.purchase.confirmation': 'purchase', 'dates.sale.confirmation': 'sale' })[item?.field_path];
    const row = dates?.[side];
    if (!side || !row?.confirmation_required || row.status !== 'needs_input' || row.reason?.code !== 'NON_SESSION'
      || row.requested_date !== requested || !row.proposed_order_date || row.proposed_order_date === requested
      || !row.settlement_date) return null;
    return { side, requested, proposed: row.proposed_order_date, settlement: row.settlement_date };
  }

  function priceFormModesFromInput(input) {
    const entry = input?.entry_price || {};
    const exit = input?.exit_price || {};
    return {
      entry: entry.mode === 'MANUAL_PU' ? 'PU' : 'RATE',
      exit: exit.mode === 'MANUAL_RATE' ? 'RATE'
        : exit.mode === 'MANUAL_PU' && exit.provenance?.source_id !== 'SAME_ENTRY_PU_BASELINE' ? 'PU' : 'SAME_ENTRY',
    };
  }

  function analysisFormModesFromInput(input) {
    const context = input?.analysis_context || {};
    const timeline = context.timeline || {};
    return {
      resultMode: context.kind === 'UNIT_PRICE' ? 'UNIT_PRICE' : 'OPERATION',
      timelineMode: timeline.mode === 'WINDOW' ? 'WINDOW' : 'POINT',
      windowStart: timeline.start || '',
      windowEnd: timeline.end || '',
    };
  }

  function analysisFieldVisibility(resultMode = 'OPERATION', timelineMode = 'POINT') {
    const unitPrice = resultMode === 'UNIT_PRICE';
    const point = !unitPrice && timelineMode !== 'WINDOW';
    return {
      timeline: !unitPrice,
      window: !unitPrice && timelineMode === 'WINDOW',
      capital: !unitPrice,
      saleDate: point,
      exitPrice: point,
      operationCosts: !unitPrice,
      operationResults: !unitPrice,
      unitPriceResults: unitPrice,
    };
  }

  function analysisContextForForm(resultMode = 'OPERATION', timelineMode = 'POINT', start = '', end = '') {
    if (resultMode === 'UNIT_PRICE') return { kind: 'UNIT_PRICE', timeline: { mode: 'POINT' } };
    if (timelineMode !== 'WINDOW') return { kind: 'OPERATION', timeline: { mode: 'POINT' } };
    return {
      kind: 'OPERATION',
      timeline: {
        mode: 'WINDOW',
        ...(start ? { start: String(start) } : {}),
        ...(end ? { end: String(end) } : {}),
      },
    };
  }

  function addIsoDays(day, amount) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
    const value = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== day) return null;
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
  }

  function addIsoMonthsClamped(day, months) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
    const value = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== day) return null;
    const dayOfMonth = value.getUTCDate();
    value.setUTCDate(1);
    value.setUTCMonth(value.getUTCMonth() + months);
    const monthEnd = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
    value.setUTCDate(Math.min(dayOfMonth, monthEnd));
    return value.toISOString().slice(0, 10);
  }

  function suggestedWindowEndDate(start, horizonExclusive = null) {
    const twelveMonths = addIsoMonthsClamped(start, 12);
    if (!twelveMonths) return null;
    const limits = [twelveMonths, '2085-12-31'];
    if (horizonExclusive) {
      const lastEligibleDay = addIsoDays(horizonExclusive, -1);
      if (!lastEligibleDay) return null;
      limits.push(lastEligibleDay);
    }
    const end = limits.sort()[0];
    return end > start ? end : null;
  }

  function firstEligibleDateFromResolution(resolved, requestedStart) {
    const sale = resolved?.dates?.sale;
    const proposed = sale?.proposed_order_date;
    const minimum = sale?.minimum_eligible_order_date;
    const date = minimum && (!proposed || minimum > proposed) ? minimum : proposed;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return {
      date: date < requestedStart ? requestedStart : date,
      requiresConfirmationProbe: Boolean(minimum && minimum > proposed),
      saleStatus: sale?.status || null,
    };
  }

  function unitPriceInputFrom(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('A consulta unitária exige as premissas comuns do título.');
    }
    const result = JSON.parse(JSON.stringify(input));
    for (const key of ['capital', 'sale_date', 'exit_price', 'constraints']) delete result[key];
    if (result.assumptions && typeof result.assumptions === 'object') {
      const assumptions = {};
      for (const key of ['settlement_profile', 'explicit_settlements', 'inflation_projection']) {
        if (Object.prototype.hasOwnProperty.call(result.assumptions, key)) assumptions[key] = result.assumptions[key];
      }
      result.assumptions = assumptions;
    }
    result.analysis_context = { kind: 'UNIT_PRICE', timeline: { mode: 'POINT' } };
    return result;
  }

  function grossDv01RequestFromInput(input, quantity = null) {
    const body = {
      schema_version: 2,
      action: 'GROSS_DV01',
      input: unitPriceInputFrom(input),
    };
    if (quantity !== null && quantity !== undefined && String(quantity).trim() !== '') {
      const parsed = parsePtDecimal(quantity, 'Quantidade para DV01');
      if (parsed === null) throw new TypeError('Informe uma quantidade positiva em centésimos de título.');
      const unsigned = parsed.replace(/^\+/, '');
      const negative = unsigned.startsWith('-');
      const [wholeText, fraction = ''] = unsigned.replace(/^-/, '').split('.');
      const cents = BigInt(wholeText) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0') || '0');
      if (negative || cents <= 0n || /[1-9]/.test(fraction.slice(2))) {
        throw new TypeError('Quantidade para DV01 deve ser positiva em múltiplos de 0,01 título.');
      }
      body.quantity = parsed;
    }
    return body;
  }

  function unitPriceBlockedReasonMessage(reasonCode) {
    const messages = {
      CALENDAR_OUTSIDE_DOMAIN: 'A data está fora da cobertura do calendário local. Escolha uma data coberta ou atualize o calendário.',
      HYPOTHETICAL_INTENT_REQUIRED: 'A data escolhida é posterior ao corte de conhecimento. Confirme a hipótese futura para prosseguir.',
      INSTRUMENT_MISMATCH: 'A evidência local pertence a outro título ou vencimento. Confirme a série e a fonte.',
      OBSERVATION_AFTER_AS_OF: 'A observação da cotação é posterior à data de referência do conhecimento. Escolha outra evidência ou ajuste o cenário conscientemente.',
      OUTSIDE_HORIZON: 'A data financeira está fora do horizonte do título.',
      PUBLICATION_DATE_UNKNOWN: 'A cotação local não tem data de publicação identificada. Informe um PU manual (e sua fonte, se disponível), ou use uma taxa real com VNA/VNI compatível.',
      PUBLISHED_AFTER_AS_OF: 'A cotação foi publicada depois da data de referência do conhecimento. Escolha uma evidência conhecida nessa data ou ajuste o cenário conscientemente.',
    };
    const code = String(reasonCode || '').trim();
    return messages[code] || (code
      ? `O motor bloqueou esta referência (${code}). Ajuste a data ou a evidência antes de usar o valor.`
      : 'O motor bloqueou esta referência. Ajuste a data ou a evidência antes de usar o valor.');
  }

  function pendingItemsAfterDateCurve(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(item => !(
      item?.field_path === 'surface.selected'
      && item?.reason_code === 'MISSING_SELECTION'
      && Array.isArray(item?.capability_ids)
      && item.capability_ids.includes('nominal_evaluation')
    ));
  }

  function priceFieldVisibility(entryMode = 'RATE', exitMode = 'SAME_ENTRY') {
    return {
      entryRate: entryMode !== 'RATE', entryPu: entryMode !== 'PU',
      exitRate: exitMode !== 'RATE', exitPu: exitMode !== 'PU',
    };
  }

  function sameEntryPuSelection(pu) {
    return { mode: 'MANUAL_PU', pu: String(pu),
      provenance: { source_id: 'SAME_ENTRY_PU_BASELINE',
        source_ref: 'Hipótese exploratória: PU de venda igual ao PU de compra, sem taxa de venda informada.',
        quality: 'HYPOTHETICAL' } };
  }

  function serializePriceChoice({ side, mode, rate = '', pu = '', sourceRef = '', quality = 'INFORMED', entryMode = 'RATE', entryRate = '', entryPu = '', localQuote = null }) {
    const normalizedSide = side === 'entry' ? 'entry' : side === 'exit' ? 'exit' : null;
    if (!normalizedSide) throw new TypeError('Lado do preço precisa ser entry ou exit.');
    const selectedMode = String(mode || (normalizedSide === 'entry' ? 'RATE' : 'SAME_ENTRY'));
    const rateValue = String(rate ?? ''), puValue = String(pu ?? '');
    const source = String(sourceRef ?? '').trim();
    const manualPu = (value, label) => {
      if (!value.trim()) return { mode: 'MANUAL_PU' };
      if (source.length > 512) throw new TypeError('A referência da fonte do PU excede 512 caracteres.');
      return {
        mode: 'MANUAL_PU', pu: parsePtDecimal(value, label),
        provenance: { source_id: 'USER_INPUT',
          source_ref: source || 'PU informado pelo usuário; fonte externa não verificada', quality },
      };
    };
    if (normalizedSide === 'entry') {
      if (selectedMode === 'PU') return manualPu(puValue, 'PU de compra');
      if (selectedMode !== 'RATE') throw new TypeError('Modo de preço de compra inválido.');
      if (rateValue.trim()) return {
        mode: 'MANUAL_RATE', annual_real_rate: shiftDecimal(parsePtDecimal(rateValue, 'Taxa real de compra'), -2),
        quoted_side: 'BUY',
      };
      return localQuote || { mode: 'MANUAL_RATE' };
    }
    if (selectedMode === 'SAME_ENTRY') {
      if (entryMode === 'RATE' && String(entryRate ?? '').trim()) return { mode: 'SAME_ENTRY_RATE' };
      if (entryMode === 'PU' && String(entryPu ?? '').trim()) {
        return sameEntryPuSelection(parsePtDecimal(entryPu, 'PU de compra'));
      }
      return null;
    }
    if (selectedMode === 'PU') return manualPu(puValue, 'PU de venda');
    if (selectedMode !== 'RATE') throw new TypeError('Modo de preço de saída inválido.');
    if (!rateValue.trim()) return { mode: 'MANUAL_RATE' };
    return {
      mode: 'MANUAL_RATE', annual_real_rate: shiftDecimal(parsePtDecimal(rateValue, 'Taxa real de venda'), -2),
      quoted_side: 'SELL',
    };
  }

  function formatCriterionValue(value, unit) {
    if (value === null || value === undefined) return presentation().MISSING;
    if (unit === 'date') return presentation().formatDate(value);
    if (unit === 'BRL') return presentation().formatCurrency(value, 'BRL', 2);
    if (unit === 'ratio_per_year') return presentation().formatRate(value, 2);
    if (unit === 'ratio') return presentation().formatPercent(value, 2);
    return presentation().MISSING;
  }

  function criterionGoalGapLabel(item, gap) {
    const p = presentation();
    const unavailable = 'Distância à meta: Não disponível.';
    if (!item || !gap || gap.criterion_id !== item.constraint_id
        || gap.operator !== item.operator || gap.unit !== item.unit || gap.status !== item.status) return unavailable;
    if (gap.kind === 'UNAVAILABLE' || item.status === 'UNKNOWN' || gap.amount === null || gap.amount === undefined) return unavailable;
    const amountInfo = p.decimalInfo(gap.amount);
    if (!amountInfo || amountInfo.negative) return unavailable;
    const expectedStatuses = {
      SHORTFALL: item.operator === 'AT_LEAST' && item.status === 'NOT_MET',
      EXCESS: item.operator === 'AT_MOST' && item.status === 'NOT_MET',
      SURPLUS: item.operator === 'AT_LEAST' && item.status === 'MET',
      BELOW_LIMIT: item.operator === 'AT_MOST' && item.status === 'MET',
      AT_LIMIT: item.status === 'MET',
    };
    if (!expectedStatuses[gap.kind]) return unavailable;
    const amountUnit = item.unit === 'date' ? 'calendar_days' : item.unit;
    if (gap.amount_unit !== amountUnit) return unavailable;
    let amount;
    if (amountUnit === 'BRL') amount = p.formatCurrency(gap.amount, 'BRL', 2);
    else if (amountUnit === 'calendar_days') amount = p.formatDurationDays(gap.amount);
    else if (amountUnit === 'ratio' || amountUnit === 'ratio_per_year') amount = p.formatRatioDeltaAsPercentagePoints(gap.amount, 2);
    else return unavailable;

    if (constraintGoalForCriterion(item)?.id === 'LOSS_CAP') {
      if (gap.kind === 'SHORTFALL') return `A perda supera o limite em ${amount}.`;
      if (gap.kind === 'SURPLUS') return `Resultado dentro do limite de perda, com folga de ${amount}.`;
      if (gap.kind === 'AT_LIMIT') return 'Resultado exatamente no limite de perda.';
      return unavailable;
    }
    if (item.unit === 'date') {
      if (gap.kind === 'BELOW_LIMIT') return `Prazo respeitado; faltam ${amount} até a data limite.`;
      if (gap.kind === 'EXCESS') return `Prazo excedido em ${amount}.`;
      if (gap.kind === 'AT_LIMIT') return 'Prazo cumprido na data limite.';
      return unavailable;
    }
    if (gap.kind === 'SHORTFALL') return `Faltam ${amount} para atingir ${formatCriterionValue(item.target_value, item.unit)}.`;
    if (gap.kind === 'EXCESS') return `O resultado ultrapassa o limite em ${amount}.`;
    if (gap.kind === 'SURPLUS') return `Meta atingida, com folga de ${amount}.`;
    if (gap.kind === 'BELOW_LIMIT') return `Meta atingida; resultado ${amount} abaixo do limite.`;
    if (gap.kind === 'AT_LIMIT') return 'Meta atingida no limite.';
    return unavailable;
  }

  function requireState() {
    stateModule = stateModule || getStateModule();
    if (!stateModule) throw new Error('MTM state module must load before the workspace bridge.');
    return stateModule;
  }

  function init({ api, draft = {} } = {}) {
    if (state) throw new Error('MTM workspace has already been initialized.');
    if (typeof api !== 'function') throw new TypeError('The existing HTTP helper is required.');
    http = api;
    state = requireState().createState({ draft });
    heavyRequestQueue = requireState().createLatestRequestQueue();
    latestDraft = { ...draft };
    return snapshot();
  }

  function mountLegacy({ mount, api, readDraft } = {}) {
    if (legacyMounted) throw new Error('The legacy MTM integration can only be mounted once.');
    if (typeof mount !== 'function' || typeof readDraft !== 'function') throw new TypeError('A legacy mount and initial draft reader are required.');
    if (typeof api !== 'function') throw new TypeError('The existing HTTP helper is required.');
    mount();
    init({ api, draft: readDraft() });
    legacyMounted = true;
    mountUnifiedWorkspace();
    return snapshot();
  }

  function parsePtDecimal(raw, label = 'Valor') {
    const value = String(raw == null ? '' : raw).trim().replace(/\s+/g, '').replace(/^R\$/i, '');
    if (!value) return null;
    if (value.length > 48) throw new TypeError(`${label}: valor muito longo.`);
    const sign = value[0] === '-' ? '-' : value[0] === '+' ? '' : '';
    const unsigned = /^[+-]/.test(value) ? value.slice(1) : value;
    if (!unsigned) throw new TypeError(`${label}: informe um número válido.`);
    let integer = unsigned;
    let fraction = '';
    if (unsigned.includes(',')) {
      const pieces = unsigned.split(',');
      if (pieces.length !== 2 || !/^\d{1,12}$/.test(pieces[1])) throw new TypeError(`${label}: use o formato brasileiro, por exemplo 1.234,56.`);
      integer = pieces[0];
      fraction = pieces[1];
      if (!( /^\d+$/.test(integer) || /^\d{1,3}(?:\.\d{3})+$/.test(integer) )) throw new TypeError(`${label}: separadores de milhar inválidos.`);
      integer = integer.replaceAll('.', '');
    } else if (unsigned.includes('.')) {
      if (/^\d{1,3}(?:\.\d{3})+$/.test(unsigned)) integer = unsigned.replaceAll('.', '');
      else {
        const pieces = unsigned.split('.');
        if (pieces.length !== 2 || !/^\d+$/.test(pieces[0]) || !/^\d{1,12}$/.test(pieces[1])) throw new TypeError(`${label}: separadores inválidos.`);
        [integer, fraction] = pieces;
      }
    } else if (!/^\d+$/.test(unsigned)) {
      throw new TypeError(`${label}: use somente dígitos e separadores decimais.`);
    }
    integer = integer.replace(/^0+(?=\d)/, '');
    return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
  }

  function rateCurveDomainFromPercentages(minimumPercent, maximumPercent, stepPercent, family = '', maxPoints = 101) {
    const minimum = parsePtDecimal(minimumPercent, 'Taxa mínima');
    const maximum = parsePtDecimal(maximumPercent, 'Taxa máxima');
    const step = parsePtDecimal(stepPercent, 'Passo da taxa');
    if (minimum === null || maximum === null || step === null) {
      throw new TypeError('Informe os três limites da faixa de taxa.');
    }
    const places = Math.max(...[minimum, maximum, step].map(value => value.split('.')[1]?.length || 0));
    const scaled = value => {
      const negative = value.startsWith('-');
      const unsigned = value.replace(/^[+-]/, '');
      const [whole, fraction = ''] = unsigned.split('.');
      const integer = BigInt(`${whole}${fraction.padEnd(places, '0')}` || '0');
      return negative ? -integer : integer;
    };
    const min = scaled(minimum), max = scaled(maximum), increment = scaled(step);
    if (increment <= 0n || max <= min) throw new TypeError('A taxa máxima deve superar a mínima e o passo precisa ser positivo.');
    if (min <= -100n * (10n ** BigInt(places))) throw new TypeError('A taxa precisa ser maior que −100% a.a.');
    if (family === 'RENDA_PLUS'
        && (min < -95n * (10n ** BigInt(places)) || max > 1000n * (10n ** BigInt(places)))) {
      throw new TypeError('Para RendA+, use taxas entre −95% e 1.000% a.a.');
    }
    const distance = max - min;
    if (distance % increment !== 0n) throw new TypeError('A faixa precisa alinhar os extremos ao passo escolhido.');
    const intervals = distance / increment;
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 101) {
      throw new RangeError('O limite da curva precisa ficar entre 2 e 101 pontos.');
    }
    if (intervals + 1n > BigInt(maxPoints)) {
      throw new RangeError(`A faixa excede ${maxPoints} pontos nesta consulta. Aumente o passo antes de atualizar.`);
    }
    const toDecimal = value => {
      const negative = value < 0n;
      const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
      const whole = places ? digits.slice(0, -places) : digits;
      const fraction = places ? digits.slice(-places).replace(/0+$/, '') : '';
      const percent = `${negative ? '-' : ''}${whole || '0'}${fraction ? `.${fraction}` : ''}`;
      return shiftDecimal(percent, -2);
    };
    const values = Array.from({ length: Number(intervals + 1n) }, (_, index) => toDecimal(min + increment * BigInt(index)));
    return { minimum: values[0], maximum: values.at(-1), step: shiftDecimal(step, -2), values, points: values.length };
  }

  function rateBoundaryQueryFromPercentages(side, minimumPercent, maximumPercent, stepPercent, family = '', entryMode = null) {
    if (side !== 'ENTRY' && side !== 'EXIT') throw new TypeError('Escolha taxa de compra ou taxa de venda.');
    if (side === 'ENTRY' && !['BUDGET', 'QUANTITY'].includes(entryMode)) {
      throw new TypeError('A busca de taxa de compra exige orçamento ou quantidade fixa.');
    }
    const domain = rateCurveDomainFromPercentages(minimumPercent, maximumPercent, stepPercent, family, 101);
    return {
      domain,
      query: {
        kind: 'ENTRY_BOUNDARY', boundary_side: side,
        ...(side === 'ENTRY' ? { entry_mode: entryMode } : {}),
        rate_domain: { minimum: domain.minimum, maximum: domain.maximum, step: domain.step },
      },
    };
  }

  function normalizePriceIndexLevelRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError('Níveis do índice precisam ser uma lista.');
    if (rows.length > 256) throw new RangeError('Informe no máximo 256 níveis do índice por operação.');
    const seenDates = new Set();
    const result = [];
    for (const [index, row] of rows.entries()) {
      const date = String(row?.date || '').trim();
      const rawValue = String(row?.value ?? '').trim();
      const sourceRef = String(row?.source_ref || '').trim();
      if (!date && !rawValue && !sourceRef) continue;
      const label = `Nível do índice ${index + 1}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
          || Number.isNaN(new Date(`${date}T00:00:00Z`).valueOf())
          || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new TypeError(`${label}: informe uma data válida.`);
      }
      if (seenDates.has(date)) throw new TypeError(`${label}: já existe um nível informado para ${date}.`);
      const value = parsePtDecimal(rawValue, label);
      if (value === null) throw new TypeError(`${label}: informe o valor do índice.`);
      if (value.startsWith('-') || !/[1-9]/.test(value)) throw new TypeError(`${label}: o valor precisa ser maior que zero.`);
      if (!sourceRef) throw new TypeError(`${label}: informe a referência da fonte.`);
      if (sourceRef.length > 512) throw new TypeError(`${label}: a referência da fonte excede 512 caracteres.`);
      seenDates.add(date);
      result.push({ date, value, source_ref: sourceRef,
        ...(row?.provenance && typeof row.provenance === 'object' ? { provenance: row.provenance } : {}),
      });
    }
    return result;
  }

  function sameDecimalValue(left, right) {
    const canonical = value => {
      try {
        const parsed = parsePtDecimal(value);
        if (parsed === null) return '';
        const [whole, fraction = ''] = parsed.split('.');
        const trimmedFraction = fraction.replace(/0+$/, '');
        return `${whole}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
      } catch (_) { return ''; }
    };
    return canonical(left) !== '' && canonical(left) === canonical(right);
  }

  function shiftDecimal(value, places) {
    return presentation().shiftDecimal(value, places);
  }

  function formatPtNumber(value, decimals = 2) {
    return presentation().formatNumber(value, decimals);
  }

  function formatCurrency(value, decimals = 2) {
    return presentation().formatCurrency(value, 'BRL', decimals);
  }

  function formatRatioPercent(value, decimals = 2) {
    return presentation().formatPercent(value, decimals);
  }

  function formatAnnualRate(value, decimals = 4) {
    return presentation().formatRate(value, decimals);
  }

  function workspaceAnnualRateText(value, decimals = 4) {
    return formatAnnualRate(value, decimals).replace(/\.$/, '');
  }

  function workspaceResultActionLabel(resultMode, timelineMode, stale = false) {
    if (resultMode === 'UNIT_PRICE') return stale ? 'Atualizar preço' : 'Calcular preço';
    if (stale) return timelineMode === 'WINDOW' ? 'Atualizar período' : 'Atualizar resultado';
    return timelineMode === 'WINDOW' ? 'Explorar período' : 'Analisar investimento';
  }

  const WORKSPACE_ASSUMPTION_LABELS = Object.freeze({
    entry_price: 'PU de compra', entry_rate: 'Taxa real de compra aplicada',
    entry_rate_check: 'Taxa de compra para conferência', entry_price_mode: 'Modo do preço de compra',
    exit_price: 'PU de venda', exit_rate: 'Taxa real de venda aplicada',
    exit_rate_check: 'Taxa de venda para conferência', exit_price_mode: 'Modo do preço de venda',
    purchase_date: 'Data pedida para compra', purchase_financial_date: 'Liquidação da compra',
    sale_date: 'Data pedida para venda', sale_financial_date: 'Liquidação da venda',
    financial_date: 'Data financeira do PU', settlement_profile: 'Perfil de liquidação',
    knowledge_date: 'Data de referência do conhecimento', intent: 'Classificação da execução',
    inflation_projection: 'Trajetória de inflação', inflation_projection_rate: 'IPCA inicial projetado',
    entry_fee: 'Custo de entrada aplicado', entry_fee_fixed: 'Custo fixo de entrada',
    entry_fee_rate: 'Custo proporcional de entrada', exit_fee: 'Custo de saída',
    tax_cost_basis: 'Base tributária considerada', custody_override: 'Custódia informada',
    institution_net_override: 'Líquido institucional informado', hypothesis: 'Natureza da hipótese',
  });

  function workspaceAssumptionLabel(item) {
    const id = String(item?.assumption_id || '');
    if (WORKSPACE_ASSUMPTION_LABELS[id]) return WORKSPACE_ASSUMPTION_LABELS[id];
    const intermediate = /^intermediate_cost_(\d+)$/.exec(id);
    if (intermediate) return `Custo intermediário ${intermediate[1]}`;
    const anchor = /^index_anchor_(VNA|VNI)_(\d{4}-\d{2}-\d{2})_\d+$/.exec(id);
    if (anchor) return `Âncora ${anchor[1]} · ${presentation().formatDate(anchor[2])}`;
    const unitAnchor = /^index_anchor_(VNA|VNI)_\d+$/.exec(id);
    if (unitAnchor) return `Âncora ${unitAnchor[1]}`;
    const priceIndex = /^price_index_(\d{4}-\d{2}-\d{2})$/.exec(id);
    if (priceIndex) return `Índice geral de preços · ${presentation().formatDate(priceIndex[1])}`;
    const version = /^source_version_([a-z0-9_]+)$/i.exec(id);
    if (version) return `Versão da fonte ${version[1].replace(/_/g, ' ')}`;
    return 'Premissa adicional';
  }

  function workspaceAssumptionValue(item) {
    if (item?.value == null || item.value === '') return presentation().MISSING;
    const value = String(item.value);
    if (item.unit === 'BRL') return formatCurrency(value, 2);
    if (item.unit === 'BRL_PER_TITLE') return formatCurrency(value, 4) + ' por título';
    if (item.unit === 'ratio') return formatAnnualRate(value, 4);
    if (item.unit === 'date') return presentation().formatDate(value);
    if (item.unit === 'sha256') return /^[a-f0-9]{64}$/i.test(value) ? `${value.slice(0, 12)}…` : presentation().MISSING;
    if (item.unit === 'enum') {
      if (item.assumption_id === 'settlement_profile') return presentation().label('profile', value);
      return ({
        HYPOTHETICAL: 'Hipótese explícita', HISTORICAL_REVIEW: 'Revisão histórica',
        CONSTANT_ANNUAL: 'Taxa de inflação constante', LINEAR_ANNUAL_RATE: 'Taxa anual interpolada',
        MANUAL_PU: 'PU informado', MANUAL_RATE: 'Taxa informada', SAME_ENTRY_RATE: 'Taxa da compra aplicada na saída',
        AUTO_LOCAL: 'Cotação local exata',
      })[value] || value.replace(/_/g, ' ').toLowerCase();
    }
    return value;
  }

  function workspaceAssumptionState(item) {
    const status = String(item?.status || 'MISSING');
    const quality = item?.quality ? presentation().label('quality', item.quality) : '';
    if (status === 'MISSING') return 'Ausente';
    if (status === 'BLOCKED_POLICY') return 'Bloqueado por política';
    if (status === 'UNAVAILABLE') return 'Indisponível';
    if (status === 'NOT_APPLIED') return 'Não aplicado';
    if (status === 'NOT_EVALUATED') return 'Não avaliado';
    if (status === 'NOT_USED') return 'Não utilizado';
    if (status === 'ESTIMATED') return 'Estimado';
    if (item?.quality === 'RECONSTRUCTED') return 'Calculado · Reconstruído';
    if (item?.quality === 'HYPOTHETICAL' && String(item?.assumption_id || '').startsWith('inflation_projection')) {
      return 'Projetado · Hipótese explícita';
    }
    return quality || 'Disponível';
  }

  function workspaceAssumptionSource(item) {
    const source = item?.source && typeof item.source === 'object' ? item.source : {};
    const provenance = source.provenance && typeof source.provenance === 'object' ? source.provenance : {};
    const sourceKind = source.kind || provenance.source_kind || provenance.source_id;
    const sourceRef = source.source_ref || provenance.source_ref || source.profile_id;
    const kindLabel = ({
      MANUAL_PU: 'PU informado', MANUAL_RATE: 'Taxa informada', SAME_ENTRY_RATE: 'Taxa herdada da compra',
      AUTO_LOCAL: 'Cotação local', USER_INPUT: 'Entrada do usuário', LOCAL_MARKET_CSV: 'Mercado local',
      calendar_resolution: 'Calendário local', USER_REQUEST: 'Data pedida pelo usuário',
    })[sourceKind] || sourceKind;
    const detail = [kindLabel, sourceRef].filter(Boolean).join(' · ');
    const userSupplied = sourceKind === 'USER_INPUT' || provenance.source_id === 'USER_INPUT';
    const sourceText = detail ? `${detail}${userSupplied ? ' · referência declarada, não verificada' : ''}`
      : userSupplied ? 'Referência informada por você; não verificada pelo aplicativo.' : '';
    const evidence = [];
    const add = (label, value) => {
      if (value !== null && value !== undefined && value !== '') evidence.push({ label, value: String(value) });
    };
    for (const [key, label] of [
      ['kind', 'Tipo'], ['profile_id', 'Perfil'], ['source_ref', 'Fonte declarada'], ['mode', 'Modo'],
      ['reference_date', 'Data da referência'], ['date', 'Data'], ['key', 'Identificador da fonte'],
    ]) add(label, source[key]);
    for (const [key, label] of [
      ['source_id', 'Origem'], ['source_kind', 'Tipo de fonte'], ['source_ref', 'Referência'],
      ['source_url', 'Endereço da fonte'], ['observation_date', 'Data da observação'],
      ['observed_on', 'Observado em'], ['published_at', 'Publicado em'], ['quoted_side', 'Ponta'],
      ['evidence_status', 'Estado da evidência'], ['version', 'Versão'], ['sha256', 'SHA-256'],
    ]) add(label, provenance[key]);
    return { text: sourceText, evidence };
  }

  function workspaceAssumptionEditTarget(item, result, resolved) {
    const id = String(item?.assumption_id || ''), source = item?.source || {};
    const priceKind = source.kind || source.provenance?.source_id;
    const fixed = selector => ({ selector });
    if (id === 'instrument') return fixed('#mtm-workspace-instrument');
    if (id === 'series_year') return fixed('#mtm-workspace-series-year');
    if (id === 'entry_price') {
      if (priceKind === 'MANUAL_PU') return fixed('#mtm-workspace-entry-pu');
      if (priceKind === 'MANUAL_RATE') return fixed('input[name="entry-price-mode"][value="RATE"]');
      return fixed('input[name="entry-price-mode"][value="RATE"]');
    }
    if (id === 'entry_rate') return item.status === 'AVAILABLE'
      ? fixed('#mtm-workspace-buy-rate') : fixed('input[name="entry-price-mode"][value="RATE"]');
    if (id === 'entry_rate_check') return null;
    if (id === 'entry_price_mode') return fixed(`input[name="entry-price-mode"][value="${priceKind === 'MANUAL_PU' ? 'PU' : 'RATE'}"]`);
    if (id === 'exit_price') {
      if (priceKind === 'MANUAL_PU' || priceKind === 'USER_INPUT') return fixed('#mtm-workspace-exit-pu');
      if (priceKind === 'MANUAL_RATE') return fixed('select#mtm-workspace-exit-price-mode');
      return fixed('select#mtm-workspace-exit-price-mode');
    }
    if (id === 'exit_rate') return source.kind === 'MANUAL_RATE'
      ? fixed('#mtm-workspace-sell-rate') : fixed('select#mtm-workspace-exit-price-mode');
    if (id === 'exit_rate_check') return null;
    if (id === 'exit_price_mode') return fixed('select#mtm-workspace-exit-price-mode');
    if (id === 'purchase_date') return fixed('#mtm-workspace-purchase-date');
    if (id === 'purchase_financial_date' || id === 'financial_date') return fixed('#mtm-workspace-purchase-date');
    if (id === 'sale_date') return fixed('#mtm-workspace-sale-date');
    if (id === 'sale_financial_date') return fixed('#mtm-workspace-sale-date');
    if (id === 'settlement_profile') return fixed('#mtm-workspace-settlement');
    if (id === 'knowledge_date') return fixed('#mtm-workspace-knowledge-date');
    if (id === 'inflation_projection' || id === 'inflation_projection_rate') {
      return fixed(source.end_annual_rate != null ? '#mtm-workspace-future-inflation-rate' : '#mtm-workspace-inflation-rate');
    }
    if (id === 'entry_fee_fixed') return fixed('#mtm-workspace-entry-fee');
    if (id === 'entry_fee_rate') return fixed('#mtm-workspace-entry-rate');
    if (id === 'exit_fee') return fixed('#mtm-workspace-exit-fee');
    if (id === 'entry_fee') return fixed('#mtm-workspace-entry-fee');
    const anchor = /^index_anchor_(?:VNA|VNI)_(?:\d{4}-\d{2}-\d{2}_)?\d+$/.test(id)
      || /^index_anchor_(?:VNA|VNI)_\d{4}-\d{2}-\d{2}_\d+$/.test(id);
    if (anchor) {
      const referenceDate = source.reference_date;
      const purchaseDate = resolved?.dates?.purchase?.settlement_date || result?.unit_price?.financial_date;
      const saleDate = resolved?.dates?.sale?.settlement_date;
      if (referenceDate && referenceDate === purchaseDate) return fixed('#mtm-workspace-buy-anchor');
      if (referenceDate && referenceDate === saleDate) return fixed('#mtm-workspace-sell-anchor');
      return null;
    }
    const priceIndex = /^price_index_(\d{4}-\d{2}-\d{2})$/.exec(id);
    if (priceIndex) return { kind: 'index-level', date: priceIndex[1] };
    return null;
  }

  function workspaceAssumptionsViewModel(result, resolved, stale = false) {
    const payload = result?.result && typeof result.result === 'object' ? result.result : result;
    const assumptions = Array.isArray(payload?.assumptions_summary) ? payload.assumptions_summary.slice() : [];
    const resolvedOnly = assumptions.length === 0 && Boolean(resolved?.dates)
      && !payload?.operation && !payload?.unit_price;
    if (resolvedOnly) {
      for (const [side, prefix] of [['purchase', 'purchase'], ['sale', 'sale']]) {
        const date = resolved.dates[side];
        if (!date) continue;
        for (const [key, id, financial] of [
          ['requested_date', `${prefix}_date`, false],
          ['settlement_date', `${prefix}_financial_date`, true],
        ]) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date[key] || ''))) continue;
          assumptions.push({ assumption_id: id, value: date[key], unit: 'date', status: 'AVAILABLE',
            quality: financial ? date.quality : 'INFORMED',
            source: financial ? { kind: 'calendar_resolution', source_ref: date.source_ref,
              profile_id: date.profile_id, provenance: { version: date.calendar_id } }
              : { kind: 'USER_REQUEST' },
          });
        }
      }
    }
    const instrument = resolved?.normalized_input?.instrument
      || payload?.normalized_input?.instrument || payload?.instrument || null;
    const family = instrument?.family;
    const yearDate = family === 'RENDA_PLUS' ? instrument?.first_income_date : instrument?.maturity_date;
    const year = /^\d{4}-\d{2}-\d{2}$/.test(String(yearDate || '')) ? String(yearDate).slice(0, 4) : null;
    const instrumentName = family === 'RENDA_PLUS' ? 'Tesouro RendA+'
      : family === 'IPCA_PRINCIPAL' ? 'Tesouro IPCA+ sem cupom' : null;
    const title = instrumentName ? `${instrumentName}${year ? ` · ${year}` : ''}`
      : instrument?.instrument_id ? `Título ${instrument.instrument_id}` : 'Título não disponível';
    const rows = assumptions.map(item => {
      const source = workspaceAssumptionSource(item);
      return {
        id: item.assumption_id, label: workspaceAssumptionLabel(item),
        value: workspaceAssumptionValue(item), state: workspaceAssumptionState(item),
        source: source.text, evidence: source.evidence,
        group: /^entry_|^exit_/.test(item.assumption_id) ? 'Preços e taxas'
          : /^inflation_|^index_|^price_index_/.test(item.assumption_id) ? 'Inflação e índices'
          : /date|settlement_profile/.test(item.assumption_id) ? 'Título e datas'
          : /fee|cost|tax|custody|institution/.test(item.assumption_id) ? 'Custos e caixa'
          : /knowledge|intent|hypothesis|source_version/.test(item.assumption_id) ? 'Evidência e escopo'
          : 'Outras premissas',
        editTarget: workspaceAssumptionEditTarget(item, payload, resolved),
      };
    });
    if (instrumentName) {
      rows.unshift({ id: 'series_year', label: 'Ano do título', value: year || presentation().MISSING,
        state: 'Resolvido na identidade do título', source: 'Identidade normalizada pelo motor', evidence: [],
        group: 'Título e datas', editTarget: { selector: '#mtm-workspace-series-year' } });
      rows.unshift({ id: 'instrument', label: 'Título', value: title,
        state: 'Resolvido na identidade do título', source: 'Identidade normalizada pelo motor', evidence: [],
        group: 'Título e datas', editTarget: { selector: '#mtm-workspace-instrument' } });
    }
    const byId = new Map(rows.map(row => [row.id, row]));
    const requested = id => byId.get(id)?.value || presentation().MISSING;
    const priceRate = side => {
      const price = byId.get(`${side}_price`), rate = byId.get(`${side}_rate`);
      const shown = price && price.value !== presentation().MISSING ? price.value : null;
      const rateShown = rate?.state === 'Não aplicado' ? 'taxa não aplicada'
        : rate?.value && rate.value !== presentation().MISSING ? String(rate.value).replace(/\.$/, '') : null;
      return [shown, rateShown].filter(Boolean).join(' · ');
    };
    const unitPrice = Boolean(payload?.unit_price && !payload?.operation);
    const unevaluatedPrice = resolvedOnly ? 'preço ainda não avaliado' : 'preço/taxa indisponível';
    const summary = unitPrice
      ? `${title}. PU ${requested('entry_price')}; data pedida ${requested('purchase_date')}; data financeira ${requested('financial_date')}; ${priceRate('entry') || 'taxa não declarada'}.`
      : `${title}. Compra ${requested('purchase_date')} · liquidação ${requested('purchase_financial_date')}; ${priceRate('entry') || unevaluatedPrice}. Venda ${requested('sale_date')} · liquidação ${requested('sale_financial_date')}; ${priceRate('exit') || unevaluatedPrice}.`;
    const projection = assumptions.find(item => item.assumption_id === 'inflation_projection');
    const projectionSource = projection?.source || {};
    const endpoint = projectionSource.end_date;
    const analysisEnd = byId.get('sale_financial_date')?.value;
    const interpolationNote = endpoint
      ? `A taxa final da interpolação de inflação é aplicada em ${presentation().formatDate(endpoint)}; o horizonte da análise termina na liquidação da venda em ${analysisEnd || presentation().MISSING}.`
      : null;
    const warnings = [...new Set((Array.isArray(payload?.warnings) ? payload.warnings : [])
      .filter(item => typeof item === 'string').map(localizeWarning).filter(Boolean))];
    const heading = resolvedOnly ? 'Premissas resolvidas; operação não avaliada' : 'Premissas desta avaliação';
    return { title, heading, summary, rows, resolvedOnly, stale: Boolean(stale), unitPrice, interpolationNote, warnings };
  }

  function firstDateSearchViewModel(result, stale = false) {
    const previous = result?.previous_coverage || {};
    const candidate = result?.candidate || result?.best_candidate || null;
    const foundAndVerified = result?.status === 'FOUND' && result?.first_verified === true;
    const candidateDate = result?.found_date || candidate?.order_date || null;
    const labels = {
      FOUND: foundAndVerified ? 'Primeira data verificada' : 'Candidato atendido; primeira data não verificada',
      INCOMPLETE: 'Busca incompleta', UNKNOWN: 'Resultado desconhecido',
      NO_SOLUTION: 'Nenhuma data atende no domínio coberto',
      OUTSIDE_DOMAIN: 'Nenhuma sessão elegível no domínio',
    };
    const canExplore = !stale && Boolean(candidateDate) && candidate?.status === 'MET'
      && Boolean(candidate?.financial_result?.operation)
      && (foundAndVerified || (result?.status === 'INCOMPLETE' && Boolean(result?.found_date)));
    return {
      statusLabel: labels[result?.status] || 'Estado de busca não reconhecido',
      candidateDate,
      settlementDate: result?.settlement_date || candidate?.settlement_date || null,
      candidateLabel: foundAndVerified ? 'Data'
        : candidate?.status === 'MET' ? 'Candidato que atende; ordem de primeira data desconhecida'
          : 'Melhor candidato avaliado',
      fixedExitCondition: result?.fixed_exit_condition || null,
      candidate,
      coveredEarlier: Number(previous.covered_candidates || 0),
      unknownEarlier: Number(previous.unknown_candidates || 0),
      canExplore,
      exploreLabel: foundAndVerified ? 'Explorar essa data' : 'Explorar candidato atendido',
    };
  }

  function firstDateCandidateSelection(candidate, fixedExitCondition) {
    const saleDate = candidate?.order_date;
    const value = fixedExitCondition?.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(saleDate || '')) || value == null) return null;
    if (fixedExitCondition.unit === 'ratio') {
      return { sale_date: saleDate, annual_real_rate: String(value) };
    }
    if (fixedExitCondition.unit === 'BRL_PER_TITLE') {
      return { sale_date: saleDate, exit_pu: String(value) };
    }
    return null;
  }

  function firstDateAssumptionsViewModel(input, dateDomain, fixedExitCondition) {
    const instrument = input?.instrument || {};
    const yearDate = instrument.family === 'RENDA_PLUS'
      ? (instrument.conversion_date || instrument.first_income_date)
      : (instrument.maturity_date || instrument.series_year);
    const year = /^\d{4}/.exec(String(yearDate || ''))?.[0] || '';
    const title = instrument.family === 'RENDA_PLUS'
      ? `Tesouro RendA+${year ? ` ${year}` : ''}`
      : instrument.family === 'IPCA_PRINCIPAL'
        ? `Tesouro IPCA+${year ? ` ${year}` : ''}`
        : instrument.instrument_id || 'Título atual';
    const capital = input?.capital?.mode === 'QUANTITY'
      ? `quantidade fixa de ${input.capital.value ?? 'indisponível'} título(s)`
      : `orçamento de ${input?.capital?.value != null ? formatCurrency(input.capital.value, 2) : 'indisponível'}`;
    const entry = input?.entry_price || {};
    const purchase = entry.mode === 'MANUAL_RATE' && entry.annual_real_rate != null
      ? `taxa real de compra ${formatAnnualRate(entry.annual_real_rate, 4)}`
      : entry.mode === 'MANUAL_PU' && entry.pu != null
        ? `PU de compra ${formatCurrency(entry.pu, 4)} por título`
        : 'condição de compra resolvida no cenário';
    const condition = fixedExitCondition?.unit === 'ratio'
      ? `taxa real de venda fixa em ${formatAnnualRate(fixedExitCondition.value, 4)}`
      : fixedExitCondition?.unit === 'BRL_PER_TITLE'
        ? `PU de venda fixo em ${formatCurrency(fixedExitCondition.value, 4)} por título`
        : 'condição de venda ainda não informada';
    const projection = input?.assumptions?.inflation_projection;
    let inflation;
    if (projection?.annual_rate != null) {
      inflation = `Projeção hipotética de inflação: ${formatAnnualRate(projection.annual_rate, 4)}`;
      if (projection.end_annual_rate != null && projection.end_date) {
        inflation += ` no início, interpolada até ${formatAnnualRate(projection.end_annual_rate, 4)} em ${presentation().formatDate(projection.end_date)}`;
      } else {
        inflation += ' constante ao ano';
      }
      inflation += '.';
    } else {
      inflation = 'VNA/VNI calculado pelo IPCA mensal local. Sem projeção explícita, meses ainda não divulgados permanecem pendentes.';
    }
    const domain = dateDomain?.start && dateDomain?.end
      ? `${presentation().formatDate(dateDomain.start)} a ${presentation().formatDate(dateDomain.end)}`
      : 'preencha o início e o fim da busca';
    return {
      scenario: `${title} · ${capital} · ${purchase} · compra pedida em ${input?.purchase_date ? presentation().formatDate(input.purchase_date) : 'data indisponível'}`,
      exit: `Varia somente a data de venda; ${condition}.`,
      inflation,
      domain: `Domínio declarado: ${domain}.`,
    };
  }

  function workspaceMoneyViewModel(evaluation, resolved, stale = false) {
    const payload = evaluation?.result && typeof evaluation.result === 'object'
      ? evaluation.result : evaluation;
    const metrics = Array.isArray(payload?.presentation_summary?.metrics)
      ? payload.presentation_summary.metrics : [];
    const byId = new Map(metrics.filter(item => item && typeof item.metric_id === 'string')
      .map(item => [item.metric_id, item]));
    const formatMetric = metric => {
      if (metric.value == null) return presentation().MISSING;
      if (metric.unit === 'BRL' || metric.unit === 'BRL_EXIT_DATE') return formatCurrency(metric.value, 2);
      if (metric.unit === 'ratio' || metric.unit === 'ratio_per_year') return formatRatioPercent(metric.value, 2);
      if (metric.unit === 'calendar_days') return presentation().formatDurationDays(metric.value);
      if (metric.unit === 'TITLE') return formatPtNumber(metric.value, 4);
      if (metric.unit === 'BRL_PER_TITLE') return formatCurrency(metric.value, 4);
      return String(metric.value);
    };
    const metricView = (metricId, label) => {
      const metric = byId.get(metricId);
      const available = Boolean(metric && metric.value != null
        && ['AVAILABLE', 'ESTIMATED'].includes(metric.status));
      const declaredExit = metricId === 'exit_pu' && Array.isArray(payload?.assumptions_summary)
        ? payload.assumptions_summary.find(item => item.assumption_id === 'exit_price'
          && ['AVAILABLE', 'ESTIMATED'].includes(item.status)
          && sameDecimalValue(item.value, metric?.value)) : null;
      const qualityCode = metric?.quality || declaredExit?.quality;
      const quality = available && qualityCode
        ? presentation().label('quality', qualityCode) : '';
      const unavailableMessage = metric?.reason?.message
        || ({
          MISSING: 'Não há dado suficiente para calcular esta métrica.',
          UNAVAILABLE: 'Esta métrica não se aplica a esta operação.',
          BLOCKED_POLICY: 'A política do título bloqueia esta métrica na data selecionada.',
        }[metric?.status] || 'Esta métrica não está disponível neste resultado.');
      const shown = available ? formatMetric(metric) : presentation().MISSING;
      const precisionNote = available && metric.unit === 'ratio' && /^-?0[,.]00%$/.test(shown)
        && !/^-?0(?:\.0+)?$/.test(metric.value)
        ? `Precisão ampliada: ${formatRatioPercent(metric.value, 8)}` : null;
      return {
        metricId,
        label,
        value: shown,
        precisionNote,
        note: available
          ? (quality || 'Qualidade não declarada')
          : unavailableMessage,
        status: metric?.status || 'MISSING',
        available,
      };
    };
    const primary = [
      metricView('net_redemption', 'Resgate líquido'),
      metricView('nominal_profit', 'Lucro nominal líquido'),
      metricView('real_return', 'Retorno real no período'),
    ];
    const secondarySpecs = [
      ['nominal_return', 'Retorno nominal no período'],
      ['annualized_nominal_return', 'Retorno nominal ao ano'],
      ['real_profit_in_exit_date_currency', 'Lucro real na moeda da data de saída'],
      ['gross_redemption', 'Resgate bruto'],
      ['initial_outflow', 'Capital efetivamente aplicado'],
      ['quantity', 'Quantidade de títulos'],
      ['entry_pu', 'PU de compra'],
      ['exit_pu', 'PU de venda'],
    ];
    const secondary = secondarySpecs.map(([metricId, label]) => metricView(metricId, label))
      .filter(item => byId.has(item.metricId));
    const sizing = resolved?.purchase_sizing || {};
    const cashRemainder = sizing.cash_remainder?.value ?? sizing.cash_remainder;
    if (cashRemainder !== null && cashRemainder !== undefined) {
      secondary.push({
        metricId: 'cash_remainder', label: 'Sobra do orçamento',
        value: formatCurrency(cashRemainder, 2), note: 'Mantida separada do retorno do título.',
        status: 'AVAILABLE', available: true,
      });
    }
    const duration = byId.get('holding_days');
    const dates = resolved?.dates || {};
    const purchaseDate = dates.purchase?.settlement_date;
    const saleDate = dates.sale?.settlement_date;
    const durationLabel = duration?.value != null
      ? presentation().formatDurationDays(duration.value) : null;
    const horizon = durationLabel !== null && durationLabel !== presentation().MISSING
      ? 'Prazo: ' + durationLabel + (durationLabel.endsWith(' dia') ? ' corrido' : ' corridos')
        + (purchaseDate && saleDate
            ? ' · liquidação da compra em ' + presentation().formatDate(purchaseDate)
              + ' e da venda em ' + presentation().formatDate(saleDate) + '.' : '.')
      : (duration?.reason?.message || 'Prazo de liquidação não disponível para esta avaliação.');
    return { primary, secondary, horizon, stale: Boolean(stale) };
  }

  const WORKSPACE_BRIDGE_LABELS = Object.freeze({
    capital_available: 'Capital disponível', purchase_gross: 'Compra bruta', entry_expense: 'Custo de entrada',
    cash_remainder_after_purchase: 'Sobra após a compra', gross_redemption: 'Resgate bruto',
    net_redemption: 'Resgate líquido', iof: 'IOF', income_tax: 'Imposto de renda', custody: 'Custódia',
    exit_expense: 'Custo de saída', rounding_residual: 'Resíduo de arredondamento',
  });
  const WORKSPACE_BRIDGE_TOTALS = Object.freeze([
    ['capital_available_brl', 'Capital disponível'], ['initial_outflow_brl', 'Desembolso inicial'],
    ['cash_remainder_after_purchase_brl', 'Sobra após a compra'], ['intermediate_net_brl', 'Custos intermediários líquidos'],
    ['final_cash_balance_brl', 'Saldo de caixa no horizonte'], ['final_net_inflow_brl', 'Resgate líquido'],
    ['final_wealth_brl', 'Patrimônio final conforme a ponte'], ['nominal_profit_brl', 'Lucro nominal líquido do motor'],
    ['rounding_residual_brl', 'Resíduo de arredondamento'],
  ]);

  function workspaceBridgeStatus(status) {
    return ({
      AVAILABLE: 'Disponível', ESTIMATED: 'Estimado', MISSING: 'Ausente', UNAVAILABLE: 'Indisponível',
      BLOCKED_POLICY: 'Bloqueado por política', NOT_EVALUATED: 'Não avaliado',
    })[String(status || '').toUpperCase()] || 'Estado não informado';
  }

  function workspaceBridgeSourceLabel(value) {
    const source = String(value || '');
    if (source === 'input.capital.value') return 'Capital informado';
    if (source.startsWith('operation.entry_gross')) return 'Compra calculada pelo motor';
    if (source.startsWith('purchase_sizing.purchase_gross')) return 'Dimensionamento da compra';
    if (source === 'operation.initial_outflow_minus_entry_gross') return 'Diferença do desembolso inicial e da compra bruta';
    if (source === 'purchase_sizing.cash_remainder') return 'Dimensionamento da compra';
    if (source.startsWith('operation.intermediate_paid_costs')) return 'Custo intermediário informado e arredondado pelo motor';
    if (source === 'operation.gross_redemption') return 'Cálculo do motor';
    if (source === 'operation.gross_redemption_reference') return 'Valor bruto de referência do motor';
    if (source === 'operation.net_redemption') return 'Cálculo do motor';
    if (source.startsWith('operation.')) return 'Componente calculado pelo motor';
    if (source === 'cash_bridge.rounding_reconciliation') return 'Reconciliação da ponte';
    return 'Origem detalhada no resultado do motor';
  }

  function workspaceCashBridgeViewModel(evaluation) {
    const payload = evaluation?.result && typeof evaluation.result === 'object' ? evaluation.result : evaluation;
    const bridge = payload?.cash_bridge;
    if (!bridge || !Array.isArray(bridge.lines)) return null;
    const lines = bridge.lines.map(line => {
      const intermediate = /^intermediate_paid_cost_\d+$/.test(String(line.line_id || ''));
      const label = intermediate ? 'Custo intermediário já pago'
        : WORKSPACE_BRIDGE_LABELS[line.line_id] || 'Outro componente do caixa';
      const amount = line.amount_brl == null ? presentation().MISSING : formatCurrency(line.amount_brl, 2);
      const movement = line.sign === 'OUTFLOW' ? 'Saída'
        : line.sign === 'INFLOW' ? 'Entrada'
          : line.line_id === 'net_redemption' ? 'Valor líquido' : 'Sem movimento';
      const signedAmount = line.amount_brl == null ? amount
        : `${line.sign === 'OUTFLOW' ? '−' : line.sign === 'INFLOW' ? '+' : ''}${amount}`;
      return {
        id: String(line.line_id || ''), label, amount: signedAmount, status: workspaceBridgeStatus(line.status),
        movement, source: workspaceBridgeSourceLabel(line.source_component),
      };
    });
    const totals = WORKSPACE_BRIDGE_TOTALS.filter(([key]) =>
      Object.prototype.hasOwnProperty.call(bridge.totals || {}, key)).map(([key, label]) => ({
      id: key, label, value: bridge.totals[key] == null ? presentation().MISSING : formatCurrency(bridge.totals[key], 2),
    }));
    const reconciliation = ({
      RECONCILED: 'A ponte reconcilia com o lucro nominal do motor.',
      RESIDUAL_EXPOSED: 'A ponte expõe separadamente o resíduo de arredondamento.',
      NOT_EVALUATED: 'A reconciliação não pôde ser avaliada com os componentes disponíveis.',
    })[String(bridge.totals?.reconciliation_status || '').toUpperCase()]
      || 'Estado de reconciliação não informado.';
    return {
      status: String(bridge.status || 'partial').toLowerCase(), lines, totals, reconciliation,
      summaryLines: lines.filter(line => [
        'purchase_gross', 'entry_expense', 'cash_remainder_after_purchase', 'gross_redemption',
        'iof', 'income_tax', 'custody', 'exit_expense', 'net_redemption', 'rounding_residual',
      ].includes(line.id)),
      hasCashRemainder: bridge.totals?.cash_remainder_after_purchase_brl != null,
    };
  }

  function snapshotStoredFactsViewModel(evaluation) {
    const bridge = workspaceCashBridgeViewModel(evaluation);
    const assumptions = workspaceAssumptionsViewModel(evaluation, null);
    return { bridge, assumptions, hasStoredFacts: Boolean(bridge || assumptions.rows.length) };
  }

  const WORKSPACE_GOAL_METRICS = Object.freeze({
    NOMINAL_PROFIT: 'lucro nominal líquido', NET_REDEMPTION: 'resgate líquido',
    NOMINAL_RETURN: 'retorno nominal do período', ANNUALIZED_NOMINAL_RETURN: 'retorno nominal anualizado',
    REAL_RETURN: 'retorno real do período', REAL_PROFIT: 'lucro real', REQUESTED_ORDER_DATE: 'data pedida',
  });

  function workspaceConclusionViewModel(evaluation, stale = false, unitPriceMode = false, activeCriteria = []) {
    const payload = evaluation?.result && typeof evaluation.result === 'object' ? evaluation.result : evaluation || {};
    if (unitPriceMode) {
      const quote = payload.unit_price || payload.reference_price || {};
      const amount = quote.value ?? quote.unit_price;
      const date = quote.financial_date || quote.requested_date;
      const rate = quote.annual_real_rate;
      const index = quote.index;
      const indexCalculation = quote.index_calculation;
      const assumptions = Array.isArray(payload.assumptions_summary) ? payload.assumptions_summary : [];
      const manualPu = assumptions.some(item =>
        (item.assumption_id === 'entry_price_mode' && item.value === 'MANUAL_PU')
        || (item.assumption_id === 'entry_price' && item.source?.kind === 'MANUAL_PU'));
      const quality = quote.quality ? presentation().label('quality', quote.quality) : null;
      const nominalReason = indexCalculation?.reason_code || quote.reason_code;
      const nominalMissing = nominalReason === 'MISSING_IPCA_HISTORY'
        ? 'Histórico IPCA ausente (MISSING_IPCA_HISTORY).'
        : nominalReason === 'MISSING_IPCA_MONTH'
          ? `Mês IPCA ausente: ${indexCalculation?.missing_month || 'não identificado'} (MISSING_IPCA_MONTH).`
          : nominalReason === 'MISSING_PROJECTION'
            ? `Falta projeção explícita${indexCalculation?.projection_start_month ? ` a partir de ${indexCalculation.projection_start_month}` : ''} (MISSING_PROJECTION).`
            : null;
      const missing = nominalMissing || quote.reason?.message || payload.capabilities?.unit_price?.reason?.message
        || ((payload.capabilities?.unit_price?.missing_fields || []).length
          ? 'Confira as pendências específicas retornadas pelo motor.' : null);
      const parts = [];
      parts.push(amount == null
        ? `Preço unitário indisponível${missing ? `: ${missing}` : ' com a evidência atual.'}`
        : `PU unitário de ${formatCurrency(amount, 4)} por título${date ? ` na data financeira ${presentation().formatDate(date)}` : ''}${quality ? ` · qualidade ${quality}` : ''}.`);
      if (rate != null) parts.push(`Taxa real aplicada: ${workspaceAnnualRateText(rate, 4)}.`);
      else if (manualPu) parts.push('A entrada foi um PU informado; nenhuma taxa real foi inferida.');
      const indexLabel = index?.kind || index?.index_kind;
      if (index && (index.value != null || index.reference_date)) {
        parts.push(`Índice usado: ${indexLabel || 'nível informado'}${index.value == null ? '' : ` ${formatPtNumber(index.value, 6)}`}${index.reference_date ? ` em ${presentation().formatDate(index.reference_date)}` : ''}.`);
      } else if (!manualPu && rate != null) {
        parts.push('Confira a fonte e a data do índice nas premissas desta avaliação.');
      }
      if (indexCalculation) {
        if (indexCalculation.status === 'available') {
          parts.push(`VNA/VNI calculado automaticamente pelo IPCA mensal local, com dias corridos entre dias 15${indexCalculation.projected_months ? '; inclui inflação hipotética para meses não divulgados' : ''}.`);
        } else {
          parts.push('Cálculo automático de VNA/VNI pendente.');
        }
        if (indexCalculation.evidence_mode === 'EX_POST') {
          parts.push(`Reconstrução ex-post${indexCalculation.knowledge_cutoff ? ` (corte ${indexCalculation.knowledge_cutoff})` : ''}.`);
        } else if (indexCalculation.evidence_mode === 'CAUSAL') {
          parts.push(`Corte causal: ${indexCalculation.knowledge_cutoff || 'não identificado'}.`);
        }
        parts.push(indexCalculation.last_observed_month
          ? `Último mês observado: ${indexCalculation.last_observed_month}.`
          : 'Nenhum mês IPCA observado disponível.');
        if (amount != null && nominalReason === 'MISSING_PROJECTION') {
          parts.push(`Falta projeção explícita${indexCalculation.projection_start_month ? ` a partir de ${indexCalculation.projection_start_month}` : ''} (MISSING_PROJECTION).`);
        } else if (indexCalculation.quality === 'HYPOTHETICAL' && indexCalculation.projection_start_month) {
          parts.push(`Projeção explicitamente declarada desde ${indexCalculation.projection_start_month}.`);
        } else if (amount != null && nominalReason === 'MISSING_IPCA_HISTORY') {
          parts.push('Histórico IPCA ausente (MISSING_IPCA_HISTORY).');
        } else if (amount != null && nominalReason === 'MISSING_IPCA_MONTH') {
          parts.push(`Mês IPCA ausente: ${indexCalculation.missing_month || 'não identificado'} (MISSING_IPCA_MONTH).`);
        }
        if (indexCalculation.quality) {
          parts.push(`Qualidade do nominal: ${presentation().label('quality', indexCalculation.quality)}.`);
        }
        if (indexCalculation.source_ref) {
          parts.push(`Fonte do nominal: ${String(indexCalculation.source_ref).slice(0, 300)}.`);
        }
      }
      parts.push('Este PU unitário não representa resgate, lucro ou patrimônio de uma operação.');
      return { text: `${stale ? 'Resultado da revisão anterior. ' : ''}${parts.join(' ')}`, partial: amount == null, stale, goalLines: [] };
    }

    const summary = payload.presentation_summary || {};
    const metrics = Array.isArray(summary.metrics) ? summary.metrics : [];
    const byMetric = new Map(metrics.map(metric => [metric.metric_id, metric]));
    const metricText = id => {
      const metric = byMetric.get(id);
      if (!metric || metric.value == null) return null;
      if (metric.unit === 'BRL' || metric.unit === 'BRL_EXIT_DATE') return formatCurrency(metric.value, 2);
      if (metric.unit === 'ratio' || metric.unit === 'ratio_per_year') return formatRatioPercent(metric.value, 2);
      if (metric.unit === 'calendar_days') return presentation().formatDurationDays(metric.value);
      if (metric.unit === 'date') return presentation().formatDate(metric.value);
      return String(metric.value);
    };
    const available = id => ['AVAILABLE', 'ESTIMATED'].includes(String(byMetric.get(id)?.status || '').toUpperCase());
    const net = metricText('net_redemption'), profit = metricText('nominal_profit'), days = metricText('holding_days');
    const durationLabel = days ? ` após ${days} ${days === '1 dia' ? 'corrido' : 'corridos'}` : '';
    const realReturn = metricText('real_return'), missingPrimary = ['net_redemption', 'nominal_profit', 'real_return']
      .filter(id => !available(id));
    const assumptions = Array.isArray(payload.assumptions_summary) ? payload.assumptions_summary : [];
    const exitRate = assumptions.find(item => item.assumption_id === 'exit_rate' && item.value != null);
    const exitPrice = assumptions.find(item => item.assumption_id === 'exit_price' && item.value != null);
    let condition = null;
    if (exitRate) condition = `Condição da venda: IPCA + ${workspaceAnnualRateText(exitRate.value, 4)} (${exitRate.quality ? presentation().label('quality', exitRate.quality).toLowerCase() : 'qualidade não declarada'}).`;
    else if (exitPrice) condition = `Condição mensurável: PU de saída ${formatCurrency(exitPrice.value, 4)} (${exitPrice.quality ? presentation().label('quality', exitPrice.quality).toLowerCase() : 'qualidade não declarada'}).`;

    const constraints = payload.constraint_evaluation || {};
    const criteria = Array.isArray(constraints.criteria) ? constraints.criteria : [];
    const gaps = new Map((Array.isArray(payload.goal_gap) ? payload.goal_gap : []).map(item => [item.criterion_id, item]));
    const goalDescriptions = criteria.map(resultCriterion => {
      const localCriterion = (Array.isArray(activeCriteria) ? activeCriteria : [])
        .find(item => item.id === resultCriterion.constraint_id);
      const criterion = { ...resultCriterion, goal_type: localCriterion?.goal_type };
      const gap = gaps.get(criterion.constraint_id);
      const status = String(criterion.status || gap?.status || 'UNKNOWN').toUpperCase();
      const outcome = status === 'MET' ? 'atendida' : status === 'NOT_MET' ? 'não atendida' : 'não avaliada';
      const distance = criterionGoalGapLabel(criterion, gap).replace(/^Distância à meta: /, '');
      return `${criterionGoalTitle(criterion)}: ${outcome}; ${distance}`;
    });
    const goalLines = criteria.map(criterion => {
      const metric = WORKSPACE_GOAL_METRICS[criterion.metric] || 'resultado definido';
      const operator = criterion.operator === 'AT_LEAST' ? 'pelo menos' : 'no máximo';
      const target = formatCriterionValue(criterion.target_value, criterion.unit);
      const gap = gaps.get(criterion.constraint_id);
      const amount = gap?.amount == null ? 'distância não disponível'
        : gap.amount_unit === 'BRL' || gap.amount_unit === 'BRL_EXIT_DATE' ? formatCurrency(gap.amount, 2)
          : gap.amount_unit === 'ratio' || gap.amount_unit === 'ratio_per_year' ? formatRatioPercent(gap.amount, 2)
            : gap.amount_unit === 'calendar_days' ? presentation().formatDurationDays(gap.amount) : String(gap.amount);
      const distance = ({
        SHORTFALL: `faltam ${amount}`, SURPLUS: `${amount} acima do mínimo`, EXCESS: `excede o limite em ${amount}`,
        BELOW_LIMIT: `${amount} abaixo do limite`, AT_LIMIT: 'no limite', UNAVAILABLE: 'distância não disponível',
      })[gap?.kind] || amount;
      const status = String(criterion.status || gap?.status || 'UNKNOWN').toUpperCase();
      const outcome = status === 'MET' ? 'atendida' : status === 'NOT_MET' ? 'não atendida' : 'não avaliada';
      return `Meta de ${metric} ${operator} ${target}: ${outcome}; ${distance}.`;
    });
    const parts = [];
    if (net && profit) parts.push(`Neste cenário, o resgate líquido é ${net}${durationLabel} e o lucro nominal líquido é ${profit}.`);
    else if (profit) parts.push(`Neste cenário, o lucro nominal líquido é ${profit}${durationLabel}.`);
    else if (net) parts.push(`Neste cenário, o resgate líquido é ${net}${durationLabel}.`);
    else parts.push('O resultado patrimonial está indisponível com os dados desta avaliação.');
    if (criteria.length) {
      const status = String(constraints.status || 'UNKNOWN').toUpperCase();
      const aggregate = status === 'MET' ? 'As metas deste cenário são atendidas.'
        : status === 'NOT_MET' ? 'Uma ou mais metas deste cenário não são atendidas.'
          : 'O atendimento de uma ou mais metas não pôde ser avaliado.';
      parts.push(aggregate);
    }
    if (condition) parts.push(condition);
    if (realReturn) parts.push(`Retorno real no período: ${realReturn}.`);
    if (missingPrimary.length || String(summary.status || '').toLowerCase() === 'partial') {
      const missingReasons = missingPrimary.map(id => {
        const metric = byMetric.get(id);
        const label = ({ net_redemption: 'Resgate líquido', nominal_profit: 'Lucro nominal líquido', real_return: 'Retorno real' })[id];
        let reason = String(metric?.reason?.message || 'dado indisponível').replace(/[.?!\s]+$/, '');
        if (id === 'real_return') reason = reason.replace(/^retorno real\s+/i, '');
        return `${label} indisponível: ${reason}`;
      });
      if (missingReasons.length === 1) parts.push(`${missingReasons[0]}.`);
      else if (missingReasons.length > 1) parts.push(`Medidas indisponíveis: ${missingReasons.join('; ')}.`);
      else parts.push('Parte das medidas permanece indisponível nesta avaliação.');
    }
    return {
      text: `${stale ? 'Resultado da revisão anterior. ' : ''}${parts.join(' ')}`,
      partial: Boolean(missingPrimary.length), stale, goalLines, goalDescriptions,
    };
  }


  function entryBoundaryDomainDefaults(currentPU) {
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(String(currentPU ?? ''));
    if (!match || (match[2] || '').slice(2).replace(/0/g, '')) return null;
    const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').slice(0, 2).padEnd(2, '0') || '0');
    if (cents <= 0n) return null;
    const radius = cents / 100n > 100n ? cents / 100n : 100n;
    const minimum = cents > radius ? cents - radius : 1n;
    const maximum = cents + radius;
    const fromCents = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    return { minimum: fromCents(minimum), maximum: fromCents(maximum), tick: '0.01' };
  }

  function exactDecimalDifference(left, right) {
    const parse = value => {
      // Use the bounded presentation parser for the full precision emitted by
      // Decimal, including scientific zero, before doing exact BigInt math.
      const canonical = shiftDecimal(value, 0);
      if (canonical === null) return null;
      const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(canonical);
      if (!match) return null;
      return { negative: match[1] === '-', whole: match[2], fraction: match[3] || '' };
    };
    const a = parse(left), b = parse(right);
    if (!a || !b) return null;
    const scale = Math.max(a.fraction.length, b.fraction.length);
    const factor = 10n ** BigInt(scale);
    const integer = value => {
      const absolute = BigInt(value.whole) * factor + BigInt(value.fraction.padEnd(scale, '0') || '0');
      return value.negative ? -absolute : absolute;
    };
    const difference = integer(a) - integer(b);
    const negative = difference < 0n;
    const absolute = negative ? -difference : difference;
    const whole = (absolute / factor).toString();
    const fraction = scale ? (absolute % factor).toString().padStart(scale, '0').replace(/0+$/, '') : '';
    return `${negative && absolute !== 0n ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  const STRESS_QUICK_PRESETS = Object.freeze([
    { id: 'rate-down-100', group: 'rate', label: 'Taxa de saída −1,00 p.p.', points: '-1,00', delta: '-0.01' },
    { id: 'rate-down-050', group: 'rate', label: 'Taxa de saída −0,50 p.p.', points: '-0,50', delta: '-0.005' },
    { id: 'rate-up-050', group: 'rate', label: 'Taxa de saída +0,50 p.p.', points: '0,50', delta: '0.005' },
    { id: 'rate-up-100', group: 'rate', label: 'Taxa de saída +1,00 p.p.', points: '1,00', delta: '0.01' },
    { id: 'inflation-down-100', group: 'inflation', label: 'Inflação anual −1,00 p.p.', points: '-1,00', delta: '-0.01' },
    { id: 'inflation-up-100', group: 'inflation', label: 'Inflação anual +1,00 p.p.', points: '1,00', delta: '0.01' },
  ]);

  function stressQuickPresetModel(input) {
    const entry = input?.entry_price;
    const exit = input?.exit_price;
    const rate = exit?.mode === 'MANUAL_RATE' ? exit.annual_real_rate
      : exit?.mode === 'SAME_ENTRY_RATE'
        ? entry?.annual_real_rate ?? entry?.rate_check?.annual_real_rate ?? null
        : null;
    const projection = input?.assumptions?.inflation_projection;
    const unitPrice = input?.result_mode === 'UNIT_PRICE' || input?.analysis_context?.kind === 'UNIT_PRICE';
    const unitPriceUnavailable = unitPrice
      ? 'Indisponível: estresses patrimoniais exigem uma operação, e esta base calcula somente preço unitário.'
      : null;
    const rateUnavailable = !rate
      ? 'Indisponível: informe uma taxa real de saída ou use a taxa de compra como hipótese com taxa-base resolvida.'
      : null;
    return STRESS_QUICK_PRESETS.map(preset => {
      let reason = null;
      if (preset.group === 'rate') {
        reason = unitPriceUnavailable || rateUnavailable;
        if (!reason) {
          const negativeDelta = preset.delta.startsWith('-') ? preset.delta.slice(1) : `-${preset.delta}`;
          const shifted = exactDecimalDifference(rate, negativeDelta);
          const aboveMinimum = shifted !== null && exactDecimalDifference(shifted, '-1') !== '0'
            && !exactDecimalDifference(shifted, '-1')?.startsWith('-');
          if (!aboveMinimum) reason = 'Indisponível: a taxa de saída resultante seria −100% a.a. ou menor; o choque não foi truncado.';
        }
      } else if (unitPriceUnavailable) {
        reason = unitPriceUnavailable;
      } else if (!projection || projection.annual_rate == null || !projection.source_ref) {
        reason = 'Indisponível: esta base não tem projeção explícita de inflação.';
      } else if (projection.mode !== 'CONSTANT_ANNUAL' && projection.mode !== 'INTERPOLATED_ANNUAL') {
        reason = 'Indisponível: a trajetória de inflação não tem um perfil reconhecido para deslocamento.';
      } else if (projection.mode === 'INTERPOLATED_ANNUAL'
          && (projection.end_annual_rate == null || !projection.end_date)) {
        reason = 'Indisponível: a trajetória interpolada não tem taxa e data finais resolvidas.';
      } else {
        const negativeDelta = preset.delta.startsWith('-') ? preset.delta.slice(1) : `-${preset.delta}`;
        const initial = exactDecimalDifference(projection.annual_rate, negativeDelta);
        const end = projection.mode === 'INTERPOLATED_ANNUAL'
          ? exactDecimalDifference(projection.end_annual_rate, negativeDelta) : initial;
        const initialAboveMinimum = initial !== null && exactDecimalDifference(initial, '-1') !== '0'
          && !exactDecimalDifference(initial, '-1')?.startsWith('-');
        const endAboveMinimum = end !== null && exactDecimalDifference(end, '-1') !== '0'
          && !exactDecimalDifference(end, '-1')?.startsWith('-');
        if (!initialAboveMinimum || !endAboveMinimum) {
          reason = 'Indisponível: o deslocamento levaria a inflação inicial ou final a −100% a.a. ou menos; a hipótese não foi truncada.';
        }
      }
      return Object.freeze({ ...preset, allowed: reason === null, reason });
    });
  }

  const SURFACE_METRICS = Object.freeze({
    gross_redemption: { label: 'Resgate bruto', unit: 'BRL', color: 'sequential' },
    net_redemption: { label: 'Resgate líquido', unit: 'BRL', color: 'sequential' },
    nominal_profit: { label: 'Lucro líquido nominal', unit: 'BRL', color: 'diverging' },
    nominal_return: { label: 'Retorno nominal', unit: 'ratio', color: 'diverging' },
    annualized_nominal_return: { label: 'Retorno anualizado', unit: 'ratio_per_year', color: 'diverging' },
    real_profit_in_exit_date_currency: { label: 'Lucro real na data de saída', unit: 'BRL', color: 'diverging' },
    real_return: { label: 'Retorno real', unit: 'ratio', color: 'diverging' },
  });
  const CONSTRAINT_METRICS = Object.freeze({
    NET_REDEMPTION: { label: 'Resgate líquido', unit: 'BRL', displayUnit: 'R$' },
    NOMINAL_PROFIT: { label: 'Lucro líquido nominal', unit: 'BRL', displayUnit: 'R$' },
    NOMINAL_RETURN: { label: 'Retorno nominal acumulado', unit: 'ratio', displayUnit: '%' },
    REAL_RETURN: { label: 'Retorno real', unit: 'ratio', displayUnit: '%' },
    ANNUALIZED_NOMINAL_RETURN: { label: 'Retorno nominal anualizado', unit: 'ratio_per_year', displayUnit: '% a.a.' },
    REQUESTED_ORDER_DATE: { label: 'Data solicitada', unit: 'date', displayUnit: 'data' },
  });

  const CONSTRAINT_GOALS = Object.freeze([
    { id: 'PROFIT_MINIMUM', label: 'Ganhar pelo menos', metric: 'NOMINAL_PROFIT', operator: 'AT_LEAST' },
    { id: 'RECEIVE_MINIMUM', label: 'Receber pelo menos', metric: 'NET_REDEMPTION', operator: 'AT_LEAST' },
    { id: 'LOSS_CAP', label: 'Limitar a perda a', metric: 'NOMINAL_PROFIT', operator: 'AT_LEAST' },
    { id: 'PROFIT_MAXIMUM', label: 'Limitar o lucro nominal a', metric: 'NOMINAL_PROFIT', operator: 'AT_MOST' },
    { id: 'REDEMPTION_MAXIMUM', label: 'Limitar o resgate líquido a', metric: 'NET_REDEMPTION', operator: 'AT_MOST' },
    { id: 'NOMINAL_RETURN_MINIMUM', label: 'Obter retorno nominal de pelo menos', metric: 'NOMINAL_RETURN', operator: 'AT_LEAST' },
    { id: 'NOMINAL_RETURN_MAXIMUM', label: 'Limitar o retorno nominal a', metric: 'NOMINAL_RETURN', operator: 'AT_MOST' },
    { id: 'REAL_RETURN_MINIMUM', label: 'Obter retorno real de pelo menos', metric: 'REAL_RETURN', operator: 'AT_LEAST' },
    { id: 'REAL_RETURN_MAXIMUM', label: 'Limitar o retorno real a', metric: 'REAL_RETURN', operator: 'AT_MOST' },
    { id: 'ANNUALIZED_RETURN_MINIMUM', label: 'Obter retorno nominal anualizado de pelo menos', metric: 'ANNUALIZED_NOMINAL_RETURN', operator: 'AT_LEAST' },
    { id: 'ANNUALIZED_RETURN_MAXIMUM', label: 'Limitar o retorno nominal anualizado a', metric: 'ANNUALIZED_NOMINAL_RETURN', operator: 'AT_MOST' },
    { id: 'SALE_REQUEST_DEADLINE', label: 'Solicitar a venda até', metric: 'REQUESTED_ORDER_DATE', operator: 'AT_MOST' },
  ].map(Object.freeze));

  function constraintGoalForCriterion(criterion = {}) {
    const explicit = CONSTRAINT_GOALS.find(goal => goal.id === criterion.goal_type
      && goal.metric === criterion.metric && goal.operator === criterion.operator);
    if (explicit) return explicit;
    const target = criterion.target_value ?? criterion.value;
    if (criterion.metric === 'NOMINAL_PROFIT' && criterion.operator === 'AT_LEAST'
        && String(target ?? '').trim().startsWith('-')) {
      return CONSTRAINT_GOALS.find(goal => goal.id === 'LOSS_CAP');
    }
    return CONSTRAINT_GOALS.find(goal => goal.metric === criterion.metric
      && goal.operator === criterion.operator && goal.id !== 'LOSS_CAP') || null;
  }

  function constraintThresholdForGoal(goalId, rawValue) {
    const goal = CONSTRAINT_GOALS.find(item => item.id === goalId);
    if (!goal) throw new TypeError('Escolha um objetivo compatível.');
    const definition = CONSTRAINT_METRICS[goal.metric];
    const raw = String(rawValue ?? '').trim();
    if (!raw) throw new TypeError(`Informe o limite para “${goal.label.toLowerCase()}”.`);
    if (definition.unit === 'date') {
      const parsedDate = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== raw) {
        throw new TypeError('Informe uma data válida para o prazo.');
      }
      return raw;
    }
    let value = parsePtDecimal(raw, goal.label);
    if (value === null) throw new TypeError(`Informe um limite válido para “${goal.label.toLowerCase()}”.`);
    if (goal.id === 'LOSS_CAP') {
      if (value.startsWith('-')) throw new TypeError('Informe o limite de perda como um valor positivo ou zero.');
      value = exactDecimalDifference('0', value);
    } else if (goal.metric === 'NET_REDEMPTION' && value.startsWith('-')) {
      throw new TypeError('O limite de resgate líquido não pode ser negativo.');
    } else if (goal.id === 'PROFIT_MINIMUM' && value.startsWith('-')) {
      throw new TypeError('Para definir uma perda máxima, escolha “Limitar a perda a”.');
    }
    return definition.unit === 'ratio' || definition.unit === 'ratio_per_year'
      ? shiftDecimal(value, -2) : value;
  }

  function criterionGoalTitle(criterion = {}) {
    const goal = constraintGoalForCriterion(criterion);
    const unit = criterion.unit || CONSTRAINT_METRICS[criterion.metric]?.unit;
    const target = criterion.target_value ?? criterion.value;
    if (!goal) {
      const metric = WORKSPACE_GOAL_METRICS[criterion.metric] || 'resultado definido';
      return `Meta de ${metric} ${criterion.operator === 'AT_MOST' ? 'no máximo' : 'pelo menos'} ${formatCriterionValue(target, unit)}`;
    }
    const displayTarget = goal.id === 'LOSS_CAP' && String(target ?? '').startsWith('-')
      ? String(target).slice(1) : target;
    return `${goal.label} ${formatCriterionValue(displayTarget, unit)}`;
  }

  function unitPriceGoalGuidance(resultMode = 'OPERATION') {
    return resultMode === 'UNIT_PRICE'
      ? 'Preço por unidade calcula o PU sem orçamento ou resultado patrimonial. Metas de lucro, resgate e retorno exigem orçamento ou quantidade; escolha “Resultado do investimento” para avaliá-las.'
      : 'Preço por unidade calcula o PU sem orçamento ou resultado patrimonial.';
  }

  function surfaceChartFallbackMessage(plotly) {
    return !plotly || typeof plotly.react !== 'function'
      ? 'Gráfico interativo indisponível; use a tabela acessível para explorar os pontos.'
      : null;
  }

  function surfaceBaseRateForExploration(input, selection, windowMode = false) {
    if (selection?.annual_real_rate != null) return String(selection.annual_real_rate);
    const exit = input?.exit_price || {};
    if (exit.mode === 'MANUAL_RATE' && exit.annual_real_rate != null) return String(exit.annual_real_rate);
    if (exit.mode !== 'SAME_ENTRY_RATE' && !windowMode) return null;
    const entry = input?.entry_price || {};
    return entry.mode === 'MANUAL_RATE' && entry.annual_real_rate != null
      ? String(entry.annual_real_rate) : null;
  }

  function withoutInstitutionalPointOverrides(input) {
    const copy = JSON.parse(JSON.stringify(input));
    if (copy.assumptions) for (const key of ['custody_override_brl', 'institution_net_brl', 'institution_release_date']) delete copy.assumptions[key];
    return copy;
  }

  function institutionalActualFormValues(raw = {}) {
    return Object.fromEntries(['mtm-workspace-custody-actual', 'mtm-workspace-institution-net']
      .map(id => [id, raw[id] ?? '']));
  }

  function surfaceEvaluationInput(input, selection, windowMode = false) {
    const original = input?.exit_price?.mode === 'SAME_ENTRY_RATE' ? input?.entry_price : input?.exit_price;
    const key = selection?.annual_real_rate !== undefined ? 'annual_real_rate' : 'pu';
    const selected = selection?.annual_real_rate ?? selection?.exit_pu;
    const samePoint = input?.sale_date === selection?.sale_date && original?.[key] != null
      && selected != null && compareSurfaceDecimal(String(original[key]), String(selected)) === 0;
    input = samePoint ? input : withoutInstitutionalPointOverrides(input);
    const exitPrice = selection?.annual_real_rate !== undefined
      ? { mode: 'MANUAL_RATE', annual_real_rate: String(selection.annual_real_rate) }
      : { mode: 'MANUAL_PU', pu: String(selection?.exit_pu) };
    return {
      ...input,
      sale_date: String(selection?.sale_date || ''),
      exit_price: exitPrice,
      ...(windowMode ? {
        analysis_context: {
          ...(input?.analysis_context || {}),
          kind: 'OPERATION',
          timeline: { mode: 'POINT' },
        },
      } : {}),
    };
  }

  function surfaceSelectionForScenario(input, selection = null) {
    const saleDate = selection?.sale_date || input?.sale_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(saleDate || ''))) return null;
    if (selection?.annual_real_rate != null) {
      return { sale_date: String(saleDate), annual_real_rate: String(selection.annual_real_rate) };
    }
    if (selection?.exit_pu != null) return { sale_date: String(saleDate), exit_pu: String(selection.exit_pu) };

    const exit = input?.exit_price || {};
    if (exit.mode === 'MANUAL_RATE' && exit.annual_real_rate != null) {
      return { sale_date: String(saleDate), annual_real_rate: String(exit.annual_real_rate) };
    }
    if (exit.mode === 'SAME_ENTRY_RATE' && input?.entry_price?.annual_real_rate != null) {
      return { sale_date: String(saleDate), annual_real_rate: String(input.entry_price.annual_real_rate) };
    }
    if (exit.mode === 'MANUAL_PU' && exit.pu != null) {
      return { sale_date: String(saleDate), exit_pu: String(exit.pu) };
    }
    if (exit.mode === 'SAME_ENTRY' && input?.entry_price?.pu != null) {
      return { sale_date: String(saleDate), exit_pu: String(input.entry_price.pu) };
    }
    return null;
  }

  function surfaceContextMarkers(points, contexts = {}) {
    const rows = Array.isArray(points) ? points : [];
    const roles = [
      ['base', 'Cenário-base', contexts.base],
      ['selection', 'Seleção avaliada', contexts.selection],
      ['reference', 'Referência salva', contexts.reference],
    ];
    return roles.flatMap(([role, label, selection]) => {
      const normalized = surfaceSelectionForScenario({}, selection);
      if (!normalized) return [];
      const coordinate = normalized.annual_real_rate ?? normalized.exit_pu;
      const point = rows.find(candidate => candidate.order_date === normalized.sale_date
        && sameDecimalValue(candidate.coordinateRaw ?? candidate.coordinate?.value, coordinate));
      return [{ role, label, selection: normalized, point: point || null }];
    });
  }

  function surfaceGoalOverlayModel(points, dates, coordinates) {
    const pointByCell = new Map((Array.isArray(points) ? points : []).map(point => [
      `${point.order_date}\u0000${point.coordinateRaw ?? point.coordinate?.value}`, point,
    ]));
    const met = [], unknown = [];
    const matrix = (Array.isArray(coordinates) ? coordinates : []).map(coordinate => (
      (Array.isArray(dates) ? dates : []).map(orderDate => {
        const point = pointByCell.get(`${orderDate}\u0000${coordinate}`);
        if (point?.constraintStatus === 'MET') { met.push(point); return 1; }
        if (point?.constraintStatus === 'NOT_MET') return 0;
        if (point?.constraintStatus === 'UNKNOWN') unknown.push(point);
        return null;
      })
    ));
    return { matrix, met, unknown };
  }

  function compareSurfaceDecimal(left, right) {
    const difference = exactDecimalDifference(String(left ?? ''), String(right ?? ''));
    if (difference === null) {
      const numericDifference = Number(left) - Number(right);
      return Number.isFinite(numericDifference) ? Math.sign(numericDifference) : String(left ?? '').localeCompare(String(right ?? ''), 'pt-BR', { numeric: true });
    }
    return difference === '0' ? 0 : difference.startsWith('-') ? -1 : 1;
  }

  function surfaceTablePageModel(points, options = {}) {
    const pageSize = [10, 25, 50].includes(Number(options.pageSize)) ? Number(options.pageSize) : 10;
    const sortKey = ['date', 'coordinate', 'metric'].includes(options.sortKey) ? options.sortKey : 'date';
    const sortDirection = options.sortDirection === 'desc' ? 'desc' : 'asc';
    const rows = Array.isArray(points) ? points : [];
    const raw = (point, key) => key === 'date' ? point?.order_date
      : key === 'coordinate' ? point?.coordinateRaw ?? point?.coordinate?.value : point?.valueRaw;
    const missing = (point, key) => raw(point, key) == null || raw(point, key) === ''
      || (key === 'metric' && (point?.valueNumber == null || point?.metricStatus !== 'ready'));
    const sortedPoints = rows.map((point, index) => ({ point, index })).sort((a, b) => {
      const aMissing = missing(a.point, sortKey), bMissing = missing(b.point, sortKey);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      let comparison = 0;
      if (!aMissing) comparison = sortKey === 'date'
        ? String(raw(a.point, sortKey)).localeCompare(String(raw(b.point, sortKey)))
        : compareSurfaceDecimal(raw(a.point, sortKey), raw(b.point, sortKey));
      if (comparison) return comparison * (sortDirection === 'desc' ? -1 : 1);
      comparison = compareSurfaceDecimal(
        a.point?.coordinateRaw ?? a.point?.coordinate?.value,
        b.point?.coordinateRaw ?? b.point?.coordinate?.value,
      );
      if (comparison) return comparison;
      comparison = String(a.point?.order_date || '').localeCompare(String(b.point?.order_date || ''));
      if (comparison) return comparison;
      comparison = String(a.point?.pointId || a.point?.identity || '').localeCompare(String(b.point?.pointId || b.point?.identity || ''));
      return comparison || a.index - b.index;
    }).map(item => item.point);
    const total = sortedPoints.length;
    const pageCount = Math.ceil(total / pageSize);
    const page = total ? Math.max(0, Math.min(pageCount - 1, Math.floor(Number(options.page) || 0))) : 0;
    const start = total ? page * pageSize + 1 : 0;
    const end = Math.min(total, (page + 1) * pageSize);
    return {
      sortedPoints, pagePoints: sortedPoints.slice(page * pageSize, (page + 1) * pageSize),
      total, page, pageSize, pageCount, start, end, sortKey, sortDirection,
    };
  }

  function deduplicateSurfaceMessage(message) {
    const clauses = String(message || '').split(/;\s*/).map(value => value.trim()).filter(Boolean);
    return [...new Set(clauses)].join('; ');
  }

  function surfaceSourceReferenceLabel(sourceRef) {
    return deduplicateSurfaceMessage(sourceRef).split('; ').map(reference => (
      /^HYPOTHETICAL_ACT365_COMPOUND_V\d+$/i.test(reference.replace(/\s+/g, ''))
        ? 'Perfil hipotético ACT/365 com capitalização composta' : reference
    )).join('; ');
  }

  function surfaceViewModel(surface, metricId) {
    const result = surface?.result || surface;
    const unitPriceCurve = result?.mode === 'UNIT_PRICE_RATE_CURVE';
    const metricDefinition = unitPriceCurve
      ? { label: 'Preço unitário', unit: 'BRL_PER_TITLE', color: 'sequential' }
      : SURFACE_METRICS[metricId];
    if (!metricDefinition || !Array.isArray(result?.points)) return null;
    const coordinateUnit = unitPriceCurve ? 'ratio'
      : result.points.find(point => point?.coordinate?.unit)?.coordinate.unit || result.selected?.unit || '';
    const points = result.points.map((point, index) => {
      const metric = unitPriceCurve ? {
        value: point.unit_price, unit: 'BRL_PER_TITLE',
        status: point.status === 'available' ? 'ready' : point.status,
        quality: point.quality, reason: point.reason_code, source_ref: point.source,
      } : (point?.metrics?.[metricId] || {});
      const coordinateRaw = unitPriceCurve ? point.annual_real_rate : point?.coordinate?.value;
      const rawValue = unitPriceCurve ? metric.value : metric.value === undefined ? point.value : metric.value;
      const coordinateNumber = coordinateRaw == null ? null : Number(coordinateRaw);
      const metricNumber = rawValue == null ? null : Number(rawValue);
      const unitMatches = unitPriceCurve
        ? metric.unit === 'BRL_PER_TITLE'
        : metric.unit === undefined || metric.unit === metricDefinition.unit;
      return {
        ...point,
        ...(unitPriceCurve ? {
          order_date: point.requested_date || point.order_date,
          settlement_date: point.financial_date || point.settlement_date,
          coordinate: { value: coordinateRaw, unit: 'ratio' },
          identity: `${point.requested_date || point.order_date}|${coordinateRaw}`,
        } : {}),
        constraintEvaluation: point.constraint_evaluation || null,
        constraintStatus: String(point.constraint_evaluation?.status || '').toUpperCase(),
        pointId: point.identity || `${point.order_date}|${coordinateRaw}|${index}`,
        coordinateRaw,
        coordinateNumber: coordinateNumber === null || !Number.isFinite(coordinateNumber)
          ? null : (coordinateUnit === 'ratio' ? coordinateNumber * 100 : coordinateNumber),
        coordinateUnit: point?.coordinate?.unit || coordinateUnit,
        valueRaw: rawValue == null ? null : String(rawValue),
        valueNumber: !unitMatches || metricNumber === null || !Number.isFinite(metricNumber)
          ? null : (['BRL', 'BRL_PER_TITLE'].includes(metricDefinition.unit) ? metricNumber : metricNumber * 100),
        metricStatus: unitMatches ? String(metric.status || point.status || 'missing_metric').toLowerCase() : 'unit_mismatch',
        metricUnit: metric.unit || metricDefinition.unit,
        quality: metric.quality || point.quality || 'MISSING',
        reason: metric.reason || point.reason || null,
        sourceRef: metric.source_ref || point.source_ref || null,
      };
    });
    const dates = [...new Set(points.map(point => point.order_date))].sort();
    const coordinates = [...new Set(points.map(point => point.coordinateRaw).filter(value => value !== null))]
      .sort((left, right) => Number(left) - Number(right));
    const pointByCell = new Map(points.map(point => [`${point.order_date}\u0000${point.coordinateRaw}`, point]));
    const matrix = coordinates.map(coordinate => dates.map(orderDate => {
      const point = pointByCell.get(`${orderDate}\u0000${coordinate}`);
      return point?.valueNumber ?? null;
    }));
    const availableValues = points.map(point => point.valueNumber).filter(value => value !== null);
    const extent = availableValues.length ? Math.max(...availableValues.map(Math.abs)) : 1;
    const low = availableValues.length ? Math.min(...availableValues) : 0;
    const high = availableValues.length ? Math.max(...availableValues) : 1;
    const range = metricDefinition.color === 'diverging'
      ? { zmin: -Math.max(extent, 1e-9), zmax: Math.max(extent, 1e-9) }
      : { zmin: low, zmax: high === low ? high + Math.max(Math.abs(high) * .01, 1e-9) : high };
    const unitLabel = metricDefinition.unit === 'BRL_PER_TITLE'
      ? 'R$/título' : metricDefinition.unit === 'BRL'
        ? 'R$' : metricDefinition.unit === 'ratio_per_year' ? '% a.a.' : '%';
    return {
      mode: result.mode,
      metricId,
      metricLabel: metricDefinition.label,
      metricUnit: metricDefinition.unit,
      unitLabel,
      coordinateUnit,
      coordinateLabel: coordinateUnit === 'ratio' ? 'Taxa real (% a.a.)' : 'PU de saída (R$)',
      dates,
      coordinates,
      points,
      matrix,
      range,
      colorscale: metricDefinition.color === 'diverging'
        ? [[0, '#b84d43'], [.49, '#eef2f3'], [.5, '#f7f9f9'], [1, '#167b66']]
        : 'Blues',
      coverage: surface?.coverage || null,
      selected: result.selected || null,
      constraintsActive: points.some(point => Boolean(point.constraintEvaluation)),
    };
  }

  function surfaceHoverGoalSummary(point, stale = false) {
    if (stale) return 'Mapa desatualizado';
    const status = presentation().label('goal', point?.constraintEvaluation?.status);
    const unavailableReasons = point?.metricStatus === 'ready'
      ? (point?.constraintEvaluation?.criteria || [])
        .filter(item => item.status === 'UNKNOWN').map(item => item.reason)
      : [point?.reason || point?.sourceRef];
    const text = [...new Set([status, ...unavailableReasons].filter(Boolean))].join(' · ');
    return text.length > 96 ? `${text.slice(0, 93).trimEnd()}…` : text;
  }

  function localizeWarning(message) {
    return presentation().warningText(message);
  }

  function comparisonContextLabel(item, items) {
    if (!item || item.id === 'reference') return item?.label || 'Referência';
    const alternatives = (items || []).filter(candidate => candidate && candidate.id !== 'reference');
    const position = alternatives.findIndex(candidate => candidate.id === item.id);
    if (position < 0 || position > 25) return item.label || item.id || 'Alternativa';
    return `${String.fromCharCode(65 + position)} · ${item.label || item.id || 'Alternativa'}`;
  }

  function localISODate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function mountUnifiedWorkspace() {
    const doc = typeof document === 'undefined' ? null : document;
    const form = doc && doc.getElementById('mtm-workspace-form');
    if (!form || workspaceMount) return;
    const snapshot = () => requireState().viewSnapshot(state);
    const workspaceRoot = form.closest('[data-mtm-workspace]') || form.parentElement;
    const byId = id => doc.getElementById(id);
    const legacySelect = byId('mtm-quick-instrument');
    const visibleSelect = byId('mtm-workspace-instrument');
    const submit = byId('mtm-workspace-submit');
    const confirmResolved = byId('mtm-workspace-confirm-resolved');
    const pending = byId('mtm-workspace-pending');
    const errorBox = byId('mtm-workspace-error');
    const formatErrors = new Map();
    const formatErrorSummary = doc.createElement('div');
    formatErrorSummary.className = 'mtm-field-errors';
    formatErrorSummary.hidden = true;
    formatErrorSummary.setAttribute('role', 'status');
    form.before(formatErrorSummary);
    function clearFormatError(control) {
      const previous = formatErrors.get(control.id);
      if (!previous) return;
      previous.remove();
      formatErrors.delete(control.id);
      const descriptions = (control.getAttribute('aria-describedby') || '').split(/\s+/)
        .filter(id => id && id !== previous.id);
      if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '));
      else control.removeAttribute('aria-describedby');
      if (control !== invalidField) control.removeAttribute('aria-invalid');
    }
    function renderFormatErrors() {
      formatErrorSummary.replaceChildren();
      const orderedErrors = [...formatErrors.keys()].sort((a,b) => {
        const left=byId(a),right=byId(b);
        return left&&right ? (left.compareDocumentPosition(right)&4 ? -1 : 1) : 0;
      });
      for (const id of orderedErrors) {
        const control = byId(id);
        if (!control || control.closest('[hidden]')) { if (control) clearFormatError(control); continue; }
        const link = doc.createElement('a');
        link.href = '#' + id;
        link.textContent = control.labels?.[0]?.querySelector('span')?.textContent
          || control.labels?.[0]?.firstChild?.textContent?.trim() || 'Corrigir valor';
        link.addEventListener('click', event => {
          event.preventDefault();
          doc.dispatchEvent(new CustomEvent('mtm:focus-field', {detail:{id:control.id}}));
          for (let parent = control.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
          }
          control.focus();
        });
        formatErrorSummary.append(link);
      }
      formatErrorSummary.hidden = formatErrors.size === 0;
    }
    form.addEventListener('focusout', event => {
      const control = event.target;
      if (!control.matches('input[inputmode="decimal"]') || !control.id) return;
      clearFormatError(control);
      if (control.value.trim()) {
        try { parsePtDecimal(control.value, 'Valor'); }
        catch (error) {
          const message = doc.createElement('p');
          message.className = 'mtm-field-error';
          message.id = control.id + '-format-error';
          message.textContent = error?.message || 'Informe um número válido.';
          (control.closest('label') || control).after(message);
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), message.id].filter(Boolean).join(' '));
          formatErrors.set(control.id, message);
        }
      }
      renderFormatErrors();
    });
    form.addEventListener('input', event => { clearFormatError(event.target); renderFormatErrors(); });
    const pendingPanel = doc.createElement('section');
    pendingPanel.className = 'mtm-pending-list';
    pendingPanel.hidden = true;
    pendingPanel.setAttribute('aria-labelledby', 'mtm-workspace-pending-title');
    const pendingTitle = doc.createElement('h3');
    pendingTitle.id = 'mtm-workspace-pending-title';
    pendingTitle.textContent = 'Pendências desta avaliação';
    const pendingSummary = doc.createElement('p');
    pendingSummary.className = 'mtm-pending-summary';
    pendingSummary.setAttribute('role', 'status');
    pendingSummary.setAttribute('aria-live', 'polite');
    const pendingBlocking = doc.createElement('ul');
    pendingBlocking.className = 'mtm-pending-items';
    const pendingOptionalDetails = doc.createElement('details');
    pendingOptionalDetails.className = 'mtm-pending-optional';
    const pendingOptionalSummary = doc.createElement('summary');
    pendingOptionalSummary.textContent = 'Outras saídas';
    const pendingOptionalItems = doc.createElement('ul');
    pendingOptionalItems.className = 'mtm-pending-items';
    pendingOptionalDetails.append(pendingOptionalSummary, pendingOptionalItems);
    pendingPanel.append(pendingTitle, pendingSummary, pendingBlocking, pendingOptionalDetails);
    form.insertBefore(pendingPanel, form.firstElementChild);
    const actions = doc.createElement('div');
    actions.className = 'mtm-state-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'Ações do cenário');
    const makeAction = (id, label) => {
      const button = doc.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = 'subtle';
      button.textContent = label;
      actions.append(button);
      return button;
    };
    const undoButton = makeAction('mtm-workspace-undo', 'Desfazer');
    const cancelButton = makeAction('mtm-workspace-cancel', 'Cancelar intenção atual');
    const applyReferenceButton = makeAction('mtm-workspace-apply-reference', 'Fixar original e criar cópia');
    const restoreReferenceButton = makeAction('mtm-workspace-restore-reference', 'Restaurar referência');
    if (submit?.parentElement) submit.parentElement.insertBefore(actions, pending || null);
    const scenarioContext = doc.createElement('div');
    scenarioContext.className = 'mtm-scenario-context';
    scenarioContext.hidden = true;
    const scenarioContextStatus = doc.createElement('p');
    scenarioContextStatus.setAttribute('role', 'status');
    scenarioContextStatus.setAttribute('aria-live', 'polite');
    const restoreBaseButton = doc.createElement('button');
    restoreBaseButton.id = 'mtm-workspace-restore-base';
    restoreBaseButton.type = 'button';
    restoreBaseButton.className = 'subtle';
    restoreBaseButton.textContent = 'Voltar ao cenário-base';
    restoreBaseButton.hidden = true;
    scenarioContext.append(scenarioContextStatus, restoreBaseButton);
    const workspaceSummary = byId('mtm-workspace-summary');
    if (workspaceSummary?.parentElement) workspaceSummary.insertAdjacentElement('afterend', scenarioContext);
    if (errorBox) errorBox.tabIndex = -1;
    let invalidField = null;
    let invalidFieldDescriptionAdded = false;
    let preserveErrorFeedbackDuringDraft = false;
    let decisionController = null;
    let busy = false;
    let activeIntent = null;
    let intentSequence = 0;
    let grossDv01PendingIntent = null;
    let catalog = null;
    let instrumentSeriesOptions = {};
    let instrumentOptionsRequestSequence = 0;
    let lastSelectedFamily = visibleSelect?.value || '';
    let currentResolution = null;
    let currentEvaluation = null;
    let lastValidResult = null;
    let baseContext = null;
    let sourceVersionsOverride = null;
    let resolvedInputJson = null;
    let resolvedExitValue = null;
    let resolvedSaleDate = null;
    let pendingResolution = null;
    let lastDateResolution = null;
    let draftSignature = null;
    let currentSurface = null;
    let currentG4FrontierContext = null;
    let surfaceViewCache = { identity: '', time: null, rate: null, map: null };
    let activeSurfaceView = 'time';
    let unitPriceResult = null;
    let unitPriceResultStale = false;
    let unitPriceInput = null;
    let currentConstraintLimit = null;
    let currentFirstDateSearch = null;
    let currentEntryBoundarySearch = null;
    let currentRateBoundarySearch = { ENTRY: null, EXIT: null };
    let criteriaSequence = 0;
    let pendingSurfacePoint = null;
    const surfaceTableState = { pageSize: 10, page: 0, sortKey: 'date', sortDirection: 'asc', ensureSelectionPage: false };
    let surfaceTableSelectionAction = null;
    let surfaceStale = false;
    let surfaceChartTickCount = 0;
    let surfaceChartNarrowLayout = false;
    const surfaceSelectionActionButton = doc.createElement('button');
    surfaceSelectionActionButton.id = 'mtm-surface-show-selection';
    surfaceSelectionActionButton.type = 'button';
    surfaceSelectionActionButton.className = 'subtle mtm-surface-selection-action';
    surfaceSelectionActionButton.hidden = true;
    byId('mtm-surface-select-row')?.append(surfaceSelectionActionButton);
    surfaceSelectionActionButton.addEventListener('click', () => {
      const dateFilter = byId('mtm-surface-date-filter');
      const coordinateFilter = byId('mtm-surface-coordinate-filter');
      if (surfaceTableSelectionAction?.type === 'clear_filters') {
        if (dateFilter) dateFilter.value = '';
        if (coordinateFilter) coordinateFilter.value = '';
        surfaceTableState.page = 0;
        surfaceTableState.ensureSelectionPage = true;
      } else if (surfaceTableSelectionAction?.type === 'go_to_page') {
        surfaceTableState.page = surfaceTableSelectionAction.page;
      }
      if (currentSurface) renderSurface(currentSurface, surfaceStale);
      const selectedRow = byId('mtm-unified-surface-table')?.querySelector('[data-selected-point-row="true"]');
      if (selectedRow) selectedRow.focus();
      else if (!surfaceSelectionActionButton.hidden) surfaceSelectionActionButton.focus();
      else byId('mtm-surface-apply')?.focus();
    });
    let comparisonIncludedIds = new Set();
    let knownAlternativeIds = new Set();
    let focusedAlternativeId = '';
    let comparisonResult = null;
    let commonShockResult = null;
    let stressResultsByContext = new Map();
    let stressShockDrafts = [{ label: 'Estresse 1', rate: '', inflation: '', entryCost: '', exitCost: '' }];
    let stressMarginDrafts = [];
    let stressSource = 'current';
    let currentStressResult = null;
    let analysisMode = 'compare';
    let comparisonHighlight = 'none';
    let stressSequence = 1;
    let stressShortcutUndo = null;
    let activeStressShortcutId = null;
    let marginSequence = 0;
    let openedRecord = null;
    let openedWorkspaceInput = null;
    let openedFormTouched = false;
    let openedChangedFields = new Set();
    let openedMigrationWarning = '';
    let openingSnapshot = false;
    let snapshotList = [];
    let snapshotBusy = false;
    let pendingSaveOperation = null;
    let pendingSnapshotRecalculation = null;
    let suggestedSnapshotName = '';
    const SNAPSHOT_REOPEN_KEY = 'mtm.unified.reopenScenarioId';

    function cloneJson(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function suggestSnapshotName() {
      const field = byId('mtm-snapshot-name');
      if (!field || snapshot()?.persistence?.id) return;
      const instrument = byId('mtm-workspace-instrument');
      const title = instrument?.selectedOptions?.[0]?.textContent?.trim() || '';
      const year = byId('mtm-workspace-series-year')?.value?.trim() || '';
      const purchaseDate = byId('mtm-workspace-purchase-date')?.value || '';
      const parts = [title, year, purchaseDate ? presentation().formatDate(purchaseDate) : ''].filter(Boolean);
      const suggestion = parts.join(' · ').slice(0, 120);
      const current = field.value.trim();
      if (suggestion && (!current || current === suggestedSnapshotName)) {
        field.value = suggestion;
        suggestedSnapshotName = suggestion;
      }
    }

    function snapshotSavedAt(value) {
      const timestamp = Date.parse(String(value || ''));
      if (!Number.isFinite(timestamp)) return 'horário não informado pelo servidor';
      try {
        return `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp))} (horário local)`;
      } catch (_) { return String(value); }
    }

    function snapshotConflict(error) {
      return /STALE_REVISION|E-CONFLICT|\b409\b/i.test(String(error?.code || error?.message || error));
    }

    function currentSnapshotSignature() {
      const current = snapshot();
      const formState = current?.draft?.ui_form || {};
      return JSON.stringify({
        form: formState,
        criteria: current?.criteria || [],
        selection: current?.selection || null,
        reference: current?.reference || null,
        alternatives: current?.alternatives || [],
        view: current?.view || {},
        decision: decisionController?.capture() || null,
        comparison: {
          included: [...comparisonIncludedIds].sort(),
          comparison_mode: byId('mtm-compare-position-mode')?.value || 'BUDGET',
          horizon: byId('mtm-compare-horizon')?.value || '',
          cash_rate: byId('mtm-compare-cash-rate')?.value || '',
          cash_origin: byId('mtm-compare-cash-origin')?.value || '',
          highlight: byId('mtm-compare-highlight')?.value || comparisonHighlight,
          mode: analysisMode,
          focused_alternative: focusedAlternativeId,
        },
        stress: {
          source: stressSource,
          shocks: stressShockDrafts,
          margins: stressMarginDrafts,
        },
        name: byId('mtm-snapshot-name')?.value || '',
      });
    }

    function invalidateSnapshotRecalculation() {
      pendingSnapshotRecalculation = null;
      const section = byId('mtm-snapshot-recalculation');
      const save = byId('mtm-snapshot-save-revision');
      if (section) section.hidden = true;
      if (save) { save.hidden = true; save.disabled = true; }
    }

    function setSnapshotMessage(message, isError = false) {
      const target = byId('mtm-snapshot-message');
      if (!target) return;
      target.textContent = String(message || '');
      target.classList.toggle('is-error', Boolean(isError));
    }

    function snapshotPointLabel(id) {
      if (id === 'current') return 'Cenário atual';
      if (id === 'reference') return 'Referência';
      const alternative = (snapshot()?.alternatives || []).find(item => item.id === id);
      return alternative?.label || id;
    }

    function renderSnapshotPoints(root, evaluations, legacyEvaluation = null) {
      if (!root) return;
      root.replaceChildren();
      const entries = evaluations && typeof evaluations === 'object' && !Array.isArray(evaluations)
        ? Object.entries(evaluations) : [];
      if (!entries.length && legacyEvaluation) entries.push(['current', { status: legacyEvaluation.status, result: legacyEvaluation }]);
      if (!entries.length) {
        root.append(textElement('p', 'Esta fotografia não contém uma avaliação pontual disponível.', 'muted'));
        return;
      }
      for (const [id, evaluation] of entries) {
        const card = doc.createElement('article'); card.className = 'mtm-snapshot-point';
        const result = evaluation?.result || (id === 'current' ? legacyEvaluation : null) || {};
        const hasUnitPrice = Object.prototype.hasOwnProperty.call(result, 'unit_price');
        const unitPrice = result.unit_price;
        const operation = result.operation || (hasUnitPrice ? {} : result);
        const selection = evaluation?.selection || (id === 'current' ? openedRecord?.snapshot?.selection : null) || {};
        card.append(textElement('h5', `${snapshotPointLabel(id)} · ${presentation().labelWithCode('status', evaluation?.status || result.status)}`));
        const lines = [];
        if (selection.sale_date) lines.push(`Data de saída: ${surfaceDateLabel(selection.sale_date)}`);
        if (unitPrice?.requested_date) lines.push(`Data solicitada: ${surfaceDateLabel(unitPrice.requested_date)}`);
        if (unitPrice?.financial_date) lines.push(`Data financeira: ${surfaceDateLabel(unitPrice.financial_date)}`);
        if (unitPrice?.value != null) lines.push(`PU unitário: ${formatCurrency(unitPrice.value, 4)} por título`);
        else if (hasUnitPrice) lines.push('PU unitário indisponível; a fotografia preserva a pendência informada.');
        if (unitPrice?.annual_real_rate != null) lines.push(`Taxa real de entrada: ${formatAnnualRate(unitPrice.annual_real_rate, 4)}`);
        if (unitPrice?.quality) lines.push(`Qualidade: ${presentation().labelWithCode('quality', unitPrice.quality)}`);
        if (unitPrice?.source) lines.push(`Fonte: ${unitPrice.source}`);
        if (selection.exit_pu != null) lines.push(`PU de saída: ${formatCurrency(selection.exit_pu, 4)}`);
        if (selection.annual_real_rate != null) lines.push(`Taxa real anual: ${formatAnnualRate(selection.annual_real_rate, 4)}`);
        for (const [key, label] of [
          ['gross_redemption', 'Resgate bruto'], ['net_redemption', 'Resgate líquido'],
          ['nominal_profit', 'Lucro nominal líquido'], ['real_profit', 'Lucro real'],
        ]) if (operation[key] != null) lines.push(`${label}: ${formatCurrency(operation[key], 2)}`);
        for (const [key, label, annual] of [
          ['nominal_return', 'Retorno nominal', false], ['annualized_nominal_return', 'Retorno nominal anualizado', true],
          ['real_return', 'Retorno real', false],
        ]) if (operation[key] != null) lines.push(`${label}: ${annual
          ? formatAnnualRate(operation[key], 2) : formatRatioPercent(operation[key], 2)}`);
        if (!lines.length) lines.push(evaluation?.reason === 'NO_POINT_SELECTION' ? 'Sem ponto de saída guardado.' : 'Resultado pontual indisponível; nenhuma medida foi inferida.');
        for (const line of lines) card.append(textElement('p', line));
        const storedFacts = snapshotStoredFactsViewModel(result);
        if (storedFacts.hasStoredFacts) {
          const details = doc.createElement('details');
          details.className = 'mtm-snapshot-facts';
          details.append(textElement('summary', 'Detalhes financeiros da fotografia · sem recálculo'));
          details.append(textElement('p',
            'Valores, datas e evidências guardados nesta revisão; não representam uma avaliação dos campos atuais.', 'muted'));
          if (storedFacts.bridge) {
            const list = doc.createElement('dl');
            for (const item of storedFacts.bridge.lines) {
              const row = doc.createElement('div');
              row.append(textElement('dt', item.label), textElement('dd', item.amount),
                textElement('small', `${item.movement} · ${item.status} · ${item.source}`));
              list.append(row);
            }
            for (const item of storedFacts.bridge.totals) {
              const row = doc.createElement('div');
              row.append(textElement('dt', item.label), textElement('dd', item.value));
              list.append(row);
            }
            details.append(list, textElement('p', storedFacts.bridge.reconciliation));
          }
          if (storedFacts.assumptions.rows.length) {
            const list = doc.createElement('dl');
            for (const item of storedFacts.assumptions.rows) {
              const row = doc.createElement('div');
              row.append(textElement('dt', item.label), textElement('dd', item.value),
                textElement('small', `${item.state}${item.source ? ` · Fonte: ${item.source}` : ''}`));
              for (const evidence of item.evidence) row.append(textElement('p', `${evidence.label}: ${evidence.value}`, 'muted'));
              list.append(row);
            }
            details.append(textElement('h6', 'Premissas guardadas'), list);
          }
          card.append(details);
        }
        if (Array.isArray(evaluation?.warnings)) for (const warning of evaluation.warnings) {
          if (typeof warning === 'string') card.append(textElement('p', warning, 'muted'));
        }
        root.append(card);
      }
    }

    function currentSnapshotInput() {
      if (openedWorkspaceInput && !openedFormTouched) return cloneJson(openedWorkspaceInput);
      const fresh = makeInput();
      if (!openedWorkspaceInput) return fresh;
      const base = cloneJson(openedWorkspaceInput);
      const owned = ['instrument', 'capital', 'purchase_date', 'sale_date', 'entry_price', 'exit_price', 'knowledge', 'intent', 'assumptions', 'source_versions', 'constraints', 'data'];
      for (const key of owned) delete base[key];
      const merged = { ...base, ...fresh };
      if (fresh.instrument) {
        const sameInstrument = base.instrument?.family === fresh.instrument.family
          && base.instrument?.instrument_id === fresh.instrument.instrument_id;
        merged.instrument = sameInstrument ? { ...base.instrument, ...fresh.instrument } : fresh.instrument;
      }
      if (fresh.capital) merged.capital = fresh.capital;
      if (base.assumptions || fresh.assumptions) {
        merged.assumptions = { ...(base.assumptions || {}), ...(fresh.assumptions || {}) };
        if (base.assumptions?.explicit_settlements && !openedChangedFields.has('mtm-workspace-settlement')) {
          merged.assumptions.settlement_profile = 'EXPLICIT';
        }
      }
      if (!fresh.purchase_date) delete merged.purchase_date;
      if (!fresh.sale_date) delete merged.sale_date;
      for (const key of ['entry_price', 'exit_price']) {
        const fieldId = key === 'entry_price' ? 'mtm-workspace-entry-pu' : 'mtm-workspace-exit-pu';
        const modeId = key === 'entry_price' ? 'entry_price_mode' : 'exit_price_mode';
        const originalPrice = openedWorkspaceInput[key];
        if (fresh[key]) merged[key] = fresh[key];
        else if (!openedChangedFields.has(fieldId) && !openedChangedFields.has(modeId)
          && (['MANUAL_RATE', 'SAME_ENTRY_RATE'].includes(originalPrice?.mode)
            || originalPrice?.mode === 'MANUAL_PU' && originalPrice.provenance?.source_id === 'SAME_ENTRY_PU_BASELINE')) {
          merged[key] = cloneJson(originalPrice);
        } else delete merged[key];
      }
      if (fresh.constraints?.length) merged.constraints = fresh.constraints;
      else delete merged.constraints;
      return merged;
    }

    function makeSnapshotBody({ includeConsent = false, revisionSave = false } = {}) {
      const current = snapshot();
      const name = (byId('mtm-snapshot-name')?.value || current?.persistence?.name || '').trim();
      const input = currentSnapshotInput();
      const reference = current.reference ? {
        id: 'reference', label: current.reference.label || 'Referência',
        input: frozenInput(current.reference), selection: current.reference.selection || null,
      } : null;
      const alternatives = (current.alternatives || []).map(item => ({
        id: item.id, label: item.label || instrumentLabel(frozenInput(item)),
        input: frozenInput(item), selection: item.selection || null,
      }));
      const horizon = byId('mtm-compare-horizon')?.value || '';
      const cashRateText = byId('mtm-compare-cash-rate')?.value?.trim() || '';
      const cashOrigin = byId('mtm-compare-cash-origin')?.value || '';
      const comparisonMode = byId('mtm-compare-position-mode')?.value || 'BUDGET';
      let cashGrowth = null;
      if (cashRateText || (comparisonMode === 'BUDGET' && cashOrigin)) {
        if (!cashRateText || !horizon || (comparisonMode === 'BUDGET' && !cashOrigin)) {
          throw new TypeError(comparisonMode === 'FIXED_POSITION'
            ? 'Para salvar crescimento do caixa, preencha taxa líquida e horizonte comum.'
            : 'Para salvar crescimento de caixa, preencha taxa líquida, data de origem e horizonte comum.');
        }
        const parsed = parsePtDecimal(cashRateText, 'Taxa líquida anual');
        if (parsed == null) throw new TypeError('Informe uma taxa líquida anual válida.');
        cashGrowth = { annual_net_rate: shiftDecimal(parsed, -2), profile: 'ACT_365_COMPOUND_v1' };
        if (comparisonMode === 'BUDGET') cashGrowth.origin_date = cashOrigin;
      }
      const shocks = [];
      for (let index = 0; index < stressShockDrafts.length; index += 1) {
        const draft = stressShockDrafts[index];
        const values = [draft.rate, draft.inflation, draft.entryCost, draft.exitCost];
        if (!values.some(value => String(value || '').trim())) continue;
        const id = draft.id || stressScenarioId(draft.label);
        if (!id || id === 'reference' || shocks.some(item => item.id === id)) throw new TypeError(`Estresse ${index + 1}: informe um nome distinto e válido.`);
        const shock = { id, label: String(draft.label || `Estresse ${index + 1}`).trim() };
        const rate = parseShockDelta(draft.rate, 'Choque na taxa', true);
        const inflation = parseShockDelta(draft.inflation, 'Choque na inflação', true);
        const entry = parseShockDelta(draft.entryCost, 'Variação do custo de entrada');
        const exit = parseShockDelta(draft.exitCost, 'Variação do custo de saída');
        if (rate != null) shock.rate_shock_ratio = rate;
        if (inflation != null) shock.annual_inflation_ratio = inflation;
        if (entry != null) shock.entry_expense_delta_brl = entry;
        if (exit != null) shock.exit_expense_delta_brl = exit;
        shocks.push(shock);
      }
      const margins = stressMarginDrafts.map((draft, index) => {
        const ratio = String(draft.dimension || '').endsWith('_ratio');
        const maximum = parseShockDelta(draft.maximum, `Magnitude máxima da busca ${index + 1}`, ratio);
        const resolution = parseShockDelta(draft.resolution, `Resolução da busca ${index + 1}`, ratio);
        if (maximum == null || resolution == null) throw new TypeError(`Busca de folga ${index + 1}: preencha a magnitude e a resolução.`);
        return {
          id: draft.id, criterion_id: draft.criterion_id, dimension: draft.dimension,
          direction: draft.direction, maximum_magnitude: maximum, resolution,
        };
      });
      const stress = { source_id: stressSource, shocks, margin_searches: margins };
      if (shocks.length || margins.length) { stress.max_evaluations = 4096; stress.deadline_ms = 10000; }
      const view = cloneJson(current.view || { tab: 'map' });
      const decision = decisionController?.capture();
      if (decision && (decision.cards.length || decision.result)) view.decision = decision;
      else delete view.decision;
      const body = {
        schema_version: 2, name, input,
        selection: input.analysis_context?.kind === 'UNIT_PRICE' ? null
          : current.selection || (lastValidResult?.identity === resultIdentity() ? selectionForCurrentResult() : null),
        reference, alternatives,
        analysis: {
          mode: analysisMode,
          included_alternative_ids: alternatives.filter(item => comparisonIncludedIds.has(item.id)).map(item => item.id),
          comparison: comparisonSnapshotConfig({
            comparison_mode: comparisonMode, horizon, cash_growth: cashGrowth,
            highlight: byId('mtm-compare-highlight')?.value || comparisonHighlight || 'none',
          }),
          stress,
        },
        view,
      };
      if (includeConsent) body.consent = Boolean(byId('mtm-snapshot-consent')?.checked);
      if (revisionSave) {
        if (current.persistence?.schema_version !== 2 || !current.persistence.id || !current.persistence.revision) {
          throw new TypeError('Somente uma fotografia v2 carregada pode receber uma nova revisão.');
        }
        body.record_id = current.persistence.id;
        body.expected_revision = current.persistence.revision;
      }
      return body;
    }

    function syncSnapshotControls() {
      const current = snapshot();
      const status = byId('mtm-snapshot-dirty');
      const save = byId('mtm-snapshot-save');
      const copy = byId('mtm-snapshot-copy');
      const recalculate = byId('mtm-snapshot-recalculate');
      const consent = byId('mtm-snapshot-consent');
      const open = byId('mtm-snapshot-open');
      const selector = byId('mtm-snapshot-select');
      const nameInput = byId('mtm-snapshot-name');
      const revisionButton = byId('mtm-snapshot-save-revision');
      if (!current || !status) return;
      let signature = '';
      let serializable = true;
      try { signature = currentSnapshotSignature(); makeSnapshotBody(); }
      catch (error) { serializable = false; }
      if (openedMigrationWarning && current.persistence?.duplicate_of) serializable = false;
      const dirty = requireState().snapshotIsDirty(current, signature);
      const loaded = Boolean(current.persistence?.id);
      const legacy = current.persistence?.schema_version === 1;
      const recalcReady = pendingSnapshotRecalculation
        && pendingSnapshotRecalculation.id === current.persistence?.id
        && pendingSnapshotRecalculation.revision === current.persistence?.revision
        && pendingSnapshotRecalculation.signature === signature;
      status.textContent = !loaded ? 'Novo rascunho · não salvo'
        : `${legacy ? 'v1 adaptado' : `v2 · r${current.persistence.revision}`} · ${dirty ? 'alterações não salvas' : 'fotografia original íntegra'}`;
      status.classList.toggle('is-dirty', dirty);
      if (save) {
        save.disabled = snapshotBusy || busy || !serializable || !dirty || legacy || !consent?.checked
          || !nameInput?.value?.trim();
        save.textContent = loaded ? (legacy ? 'Salvar cópia v2' : 'Salvar alterações') : 'Salvar análise';
        save.title = legacy ? 'A fotografia v1 é somente leitura; salve uma cópia v2.' : '';
      }
      if (copy) {
        copy.hidden = !loaded;
        copy.disabled = snapshotBusy || busy || !loaded || !serializable || !consent?.checked
          || (legacy && Boolean(openedMigrationWarning));
        copy.title = openedMigrationWarning
          ? `A conversão em cópia está bloqueada para preservar campos: ${openedMigrationWarning}` : '';
      }
      if (recalculate) recalculate.disabled = snapshotBusy || busy || !loaded;
      if (consent) consent.disabled = snapshotBusy || busy;
      if (nameInput) nameInput.disabled = snapshotBusy || busy;
      if (selector) selector.disabled = snapshotBusy || busy || !snapshotList.length;
      if (open) open.disabled = snapshotBusy || busy || !selector?.value;
      if (revisionButton) revisionButton.disabled = snapshotBusy || busy || !recalcReady || !consent?.checked;
      if (revisionButton && !recalcReady) revisionButton.hidden = true;
    }

    function displaySnapshotReview(record) {
      const section = byId('mtm-snapshot-review');
      const note = byId('mtm-snapshot-review-note');
      const points = byId('mtm-snapshot-review-points');
      const stored = record?.snapshot || {};
      if (section) section.hidden = false;
      if (note) {
        const adapter = record.schema_version === 1
          ? ` · v1 adaptado apenas para exibição; o hash original não foi alterado.${openedMigrationWarning ? ` Conversão bloqueada: ${openedMigrationWarning}` : ''}` : '';
        const compatibility = record.compatibility?.state
          || (record.schema_version === 2 ? 'nova revisão gravada com pontos reavaliados' : 'estado de compatibilidade indisponível');
        const missing = record.compatibility?.missing_source_versions?.length || 0;
        note.textContent = `Fotografia r${record.revision} · SHA-256 ${stored.snapshot_sha256 || 'indisponível'} · ${compatibility}${missing ? ` · ${missing} fonte(s) ausente(s)` : ''}${adapter} · abrir não executou cálculo.`;
      }
      renderSnapshotPoints(points, stored.point_evaluations, stored.evaluation);
    }

    function legacySnapshotInput(record) {
      const request = record?.snapshot?.request || {};
      const scenario = request.scenario || {};
      const instrument = scenario.instrument || {};
      const entry = scenario.entry || {};
      const exit = scenario.exit || {};
      const asOf = scenario.as_of || {};
      const context = request.context || {};
      const migrationWarnings = [];
      const legacyRateOrPu = (row, side) => {
        const modes = Number(row.unit_price != null) + Number(row.real_yield != null);
        if (modes > 1) migrationWarnings.push(`${side}: preço e taxa informados simultaneamente`);
        const selection = row.unit_price != null
          ? { mode: 'MANUAL_PU', pu: String(row.unit_price) }
          : row.real_yield != null ? {
            mode: 'MANUAL_RATE', annual_real_rate: String(row.real_yield),
            quoted_side: row.quoted_side || (side === 'entry' ? 'BUY' : 'SELL'),
            ...(row.spread != null ? { spread: String(row.spread) } : {}),
            ...(row.spread_source ? { spread_source: row.spread_source } : {}),
          } : null;
        if (selection && row.provenance) selection.provenance = cloneJson(row.provenance);
        return selection;
      };
      if ((instrument.pays_coupon || Number(instrument.coupon_rate || 0) !== 0)
          && (instrument.pays_coupon != null || instrument.coupon_rate != null)) {
        migrationWarnings.push('instrumento legado com cupom não representável no formulário unificado');
      }
      for (const row of [entry, exit]) {
        if (row.instrument_id && row.instrument_id !== instrument.instrument_id) migrationWarnings.push('identificador de instrumento divergente entre operação e título');
      }
      if (entry.side && entry.side !== 'BUY') migrationWarnings.push('lado de entrada legado diferente de BUY');
      if (exit.side && exit.side !== 'SELL') migrationWarnings.push('lado de saída legado diferente de SELL');
      const assumptions = { settlement_profile: 'SIMULATED_BUY_D1_SELL_D1' };
      const entryExpense = context.entry_expense_paid;
      if (entryExpense != null) {
        if (Number(entryExpense) < 0) migrationWarnings.push('despesa inicial legada negativa não convertível como custo explícito');
        else assumptions.entry_fee = { fixed_brl: String(entryExpense), proportional_rate: '0' };
      }
      if (context.exit_expense != null) {
        if (Number(context.exit_expense) < 0) migrationWarnings.push('despesa de saída legada negativa não convertível como custo explícito');
        else assumptions.exit_fee_brl = String(context.exit_expense);
      }
      for (const [oldKey, newKey] of [
        ['tax_cost_basis', 'tax_cost_basis_brl'], ['custody_override', 'custody_override_brl'],
        ['institution_net_override', 'institution_net_brl'], ['institution_release_date', 'institution_release_date'],
      ]) if (context[oldKey] != null) assumptions[newKey] = String(context[oldKey]);
      if ((entry.settlement_date || exit.settlement_date)
          && !(entry.settlement_date && exit.settlement_date)) migrationWarnings.push('uma das datas explícitas de liquidação está ausente');
      if (entry.settlement_date && exit.settlement_date) {
        assumptions.settlement_profile = 'EXPLICIT';
        assumptions.explicit_settlements = {
          purchase: { date: entry.settlement_date, quality: 'INFORMED', source_ref: 'Snapshot v1 · liquidação informada da compra' },
          sale: { date: exit.settlement_date, quality: 'INFORMED', source_ref: 'Snapshot v1 · liquidação informada da venda' },
        };
      }
      const data = {};
      if (Array.isArray(context.index_anchors) && context.index_anchors.length) data.index_anchors = cloneJson(context.index_anchors);
      if (Array.isArray(context.index_levels) && context.index_levels.length) data.price_index_levels = context.index_levels.map(item => ({
        date: item.date, value: String(item.value), source_ref: item.source_ref,
        ...(item.provenance ? { provenance: cloneJson(item.provenance) } : {}),
      }));
      if (Array.isArray(context.intermediate_paid_costs) && context.intermediate_paid_costs.length) data.intermediate_paid_costs = context.intermediate_paid_costs.map(item => ({
        date: item.date, amount_brl: String(item.amount), label: item.label,
      }));
      if (context.calendar_id && context.calendar_id !== 'BR_FINANCIAL_RULES_PROJECTED_v1') migrationWarnings.push('calendário legado diferente do calendário v2 instalado');
      if (context.calendar_knowledge_date && context.calendar_knowledge_date !== asOf.date) migrationWarnings.push('data de conhecimento do calendário difere do as_of legado');
      openedMigrationWarning = [...new Set(migrationWarnings)].join('; ');
      const input = {
        instrument: {
          family: instrument.family, instrument_id: instrument.instrument_id,
          maturity_date: instrument.maturity_date,
          ...(instrument.conversion_date ? { conversion_date: instrument.conversion_date } : {}),
          ...(instrument.first_income_date ? { first_income_date: instrument.first_income_date } : {}),
          ...(instrument.pays_coupon ? { pays_coupon: instrument.pays_coupon } : {}),
          ...(instrument.coupon_rate != null ? { coupon_rate: String(instrument.coupon_rate) } : {}),
        },
        capital: { mode: 'QUANTITY', value: String(entry.quantity || '1') },
        purchase_date: entry.order_date, sale_date: exit.order_date,
        knowledge: { date: asOf.date, mode: asOf.mode || 'CAUSAL' },
        intent: 'HISTORICAL_REVIEW',
        assumptions,
      };
      if (Object.keys(data).length) input.data = data;
      const entryPrice = legacyRateOrPu(entry, 'entry');
      const exitPrice = legacyRateOrPu(exit, 'exit');
      if (entryPrice) input.entry_price = entryPrice;
      if (exitPrice) input.exit_price = exitPrice;
      return input;
    }

    async function refreshSnapshots(selectId = null) {
      const selector = byId('mtm-snapshot-select');
      try {
        const result = await http('simulator/scenarios');
        snapshotList = Array.isArray(result?.scenarios) ? result.scenarios : [];
        const previous = selectId || selector?.value || '';
        if (selector) {
          const options = [textElement('option', snapshotList.length ? 'Selecione uma fotografia' : 'Nenhuma fotografia salva')];
          options[0].value = '';
          for (const row of snapshotList) {
            const mode = row.context_kind === 'UNIT_PRICE' ? 'Preço por título' : 'Operação';
            const timeline = row.timeline_mode === 'WINDOW' ? ' · período' : ' · pontual';
            const date = row.as_of ? ` · ${presentation().formatDate(row.as_of)}` : '';
            const quality = row.quality ? ` · ${presentation().label('quality', row.quality)}` : '';
            const sources = (Array.isArray(row.source_labels) ? row.source_labels : []).map(value => String(value).slice(0, 120));
            sources.push(...(Array.isArray(row.source_versions) ? row.source_versions : []).map(source => {
              const label = source.kind === 'market_sim' ? 'preços' : source.kind === 'market_sim_indexes' ? 'índices' : source.kind;
              return `${label} ${String(source.hash || '').slice(0, 12)}`;
            }));
            const source = sources.length ? ` · fonte ${sources.join(', ')}` : '';
            const option = textElement('option', `${row.name} · ${mode}${timeline}${date}${quality}${source} · v${row.snapshot_version} · r${row.revision}${row.instrument_id ? ` · ${row.instrument_id}` : ''}`);
            option.value = row.id; options.push(option);
          }
          selector.replaceChildren(...options);
          selector.value = snapshotList.some(row => row.id === previous) ? previous : '';
        }
        if (snapshotList.length) setSnapshotMessage(`${snapshotList.length} fotografia(s) local(is) disponível(is). Abrir exibe o registro guardado sem avaliar novamente.`);
        else setSnapshotMessage('Nada foi salvo ainda. A simulação continua disponível sem persistência.');
        return true;
      } catch (error) {
        setSnapshotMessage(`Não foi possível listar fotografias locais. ${error?.message || error}`, true);
        return false;
      } finally { syncSnapshotControls(); }
    }

    function inputToFormRaw(input) {
      const instrument = input?.instrument || {};
      const capital = input?.capital || {};
      const entry = input?.entry_price || {};
      const exit = input?.exit_price || {};
      const assumptions = input?.assumptions || {};
      const inputEntryFee = assumptions.entry_fee || {};
      const anchors = Array.isArray(input?.data?.index_anchors) ? input.data.index_anchors : [];
      const priceModes = priceFormModesFromInput(input);
      const analysisModes = analysisFormModesFromInput(input);
      const buyAnchor = anchors.find(item => item.reference_date < (input?.sale_date || '9999-12-31'));
      const sellAnchor = anchors.find(item => item.reference_date >= (input?.sale_date || '9999-12-31'));
      const raw = {
        'mtm-workspace-instrument': instrument.family || 'IPCA_PRINCIPAL',
        'mtm-budget-value': capital.mode === 'BUDGET' && capital.value != null ? formatPtNumber(capital.value, -1) : '',
        'mtm-quantity-value': capital.mode === 'QUANTITY' && capital.value != null ? formatPtNumber(capital.value, -1) : '',
        'mtm-workspace-purchase-date': input?.purchase_date || '',
        'mtm-workspace-sale-date': input?.sale_date || '',
        'mtm-workspace-window-start': analysisModes.windowStart,
        'mtm-workspace-window-end': analysisModes.windowEnd,
        'mtm-workspace-series-year': instrument.series_year || (instrument.family === 'RENDA_PLUS'
          ? instrument.conversion_date?.slice(0, 4) : instrument.maturity_date?.slice(0, 4)) || '',
        'mtm-workspace-buy-rate': entry.mode === 'MANUAL_RATE' ? formatPtNumber(shiftDecimal(entry.annual_real_rate, 2), -1) : '',
        'mtm-workspace-sell-rate': exit.mode === 'MANUAL_RATE' ? formatPtNumber(shiftDecimal(exit.annual_real_rate, 2), -1) : '',
        'mtm-workspace-entry-pu': entry.mode === 'MANUAL_PU' && entry.pu != null ? formatPtNumber(entry.pu, -1) : '',
        'mtm-workspace-exit-pu': exit.mode === 'MANUAL_PU' && exit.provenance?.source_id !== 'SAME_ENTRY_PU_BASELINE'
          && exit.pu != null ? formatPtNumber(exit.pu, -1) : '',
        'mtm-workspace-entry-pu-source': entry.mode === 'MANUAL_PU' ? entry.provenance?.source_ref || '' : '',
        'mtm-workspace-exit-pu-source': exit.mode === 'MANUAL_PU' && exit.provenance?.source_id !== 'SAME_ENTRY_PU_BASELINE'
          ? exit.provenance?.source_ref || '' : '',
        entry_price_mode: priceModes.entry,
        exit_price_mode: priceModes.exit,
        result_mode: analysisModes.resultMode,
        timeline_mode: analysisModes.timelineMode,
        'mtm-workspace-buy-anchor': buyAnchor?.value != null ? formatPtNumber(buyAnchor.value, -1) : '',
        'mtm-workspace-sell-anchor': sellAnchor?.value != null ? formatPtNumber(sellAnchor.value, -1) : '',
        'mtm-workspace-inflation-rate': assumptions.inflation_projection?.annual_rate != null
          ? formatPtNumber(shiftDecimal(assumptions.inflation_projection.annual_rate, 2), -1) : '',
        'mtm-workspace-future-inflation-rate': assumptions.inflation_projection?.end_annual_rate != null
          ? formatPtNumber(shiftDecimal(assumptions.inflation_projection.end_annual_rate, 2), -1) : '',
        'mtm-workspace-anchor-source': buyAnchor?.source_ref || sellAnchor?.source_ref || '',
        'mtm-workspace-settlement': assumptions.settlement_profile || 'SIMULATED_BUY_D1_SELL_D1',
        'mtm-workspace-entry-fee': inputEntryFee.fixed_brl != null ? formatPtNumber(inputEntryFee.fixed_brl, -1) : '0',
        'mtm-workspace-entry-rate': inputEntryFee.proportional_rate != null ? formatPtNumber(shiftDecimal(inputEntryFee.proportional_rate, 2), -1) : '0',
        'mtm-workspace-exit-fee': assumptions.exit_fee_brl != null ? formatPtNumber(assumptions.exit_fee_brl, -1) : '0',
        'mtm-workspace-custody-actual': assumptions.custody_override_brl != null ? formatPtNumber(assumptions.custody_override_brl, -1) : '',
        'mtm-workspace-institution-net': assumptions.institution_net_brl != null ? formatPtNumber(assumptions.institution_net_brl, -1) : '',
        'mtm-workspace-knowledge-date': input?.knowledge?.date || '',
        'mtm-workspace-evidence-mode': input?.knowledge?.mode || 'CAUSAL',
        'mtm-workspace-index-levels': Array.isArray(input?.data?.price_index_levels)
          ? cloneJson(input.data.price_index_levels).map(item => ({
            date: item.date, value: formatPtNumber(String(item.value), -1), source_ref: item.source_ref,
            ...(item.provenance ? { provenance: cloneJson(item.provenance) } : {}),
          })) : [],
        capital_mode: capital.mode === 'QUANTITY' ? 'QUANTITY' : 'BUDGET',
      };
      return raw;
    }

    function hydrateSnapshot(record) {
      openingSnapshot = true;
      try {
        const stored = record.snapshot || {};
        const input = record.schema_version === 2 ? cloneJson(stored.input) : legacySnapshotInput(record);
        openedRecord = record;
        openedWorkspaceInput = cloneJson(input);
        openedFormTouched = false;
        openedChangedFields = new Set();
        if (record.schema_version !== 1) openedMigrationWarning = '';
        sourceVersionsOverride = input?.source_versions || null;
        const rawCriteria = Array.isArray(input?.constraints) ? input.constraints.map(item => {
          const unit = item.unit || CONSTRAINT_METRICS[item.metric]?.unit;
          const value = unit === 'ratio' || unit === 'ratio_per_year'
            ? formatPtNumber(shiftDecimal(item.value, 2), 4)
            : unit === 'BRL' ? formatPtNumber(item.value, 2) : String(item.value);
          return { id: item.id, metric: item.metric, operator: item.operator, value };
        }) : [];
        const reference = record.schema_version === 2 && stored.reference ? {
          id: 'reference', label: stored.reference.label, input: stored.reference.input,
          selection: stored.reference.selection || null,
        } : null;
        const alternatives = record.schema_version === 2 ? (stored.alternatives || []).map(item => ({
          ...item, source_versions: item.input?.source_versions || {}, provenance: {},
        })) : [];
        const analysis = stored.analysis || {};
        const workspace = {
          draft: { ui_form: inputToFormRaw(input) }, reference, alternatives,
          selection: record.schema_version === 2 ? stored.selection : null,
          criteria: rawCriteria, view: record.schema_version === 2 ? (stored.view || { tab: 'map' }) : { tab: 'map' },
        };
        const baselineName = record.name || '';
        byId('mtm-snapshot-name').value = baselineName;
        byId('mtm-snapshot-consent').checked = false;
        dispatch({ type: 'OPEN_SNAPSHOT', workspace, metadata: {
          id: record.id, revision: record.revision, name: baselineName,
          schema_version: record.schema_version, snapshot_sha256: stored.snapshot_sha256,
          saved_signature: '', duplicate_of: null,
        } });
        latestDraft = { ...latestDraft, ui_form: workspace.draft.ui_form };
        syncFormFromRaw(workspace.draft.ui_form);
        dispatch({ type: 'UPDATE_CONSTRAINTS', criteria: rawCriteria });
        renderCriteria();
        comparisonIncludedIds = new Set(analysis.included_alternative_ids || []);
        knownAlternativeIds = new Set(alternatives.map(item => item.id));
        focusedAlternativeId = '';
        const comparison = analysis.comparison || {};
        byId('mtm-compare-position-mode').value = comparison.comparison_mode === 'FIXED_POSITION' ? 'FIXED_POSITION' : 'BUDGET';
        syncComparisonModeControls();
        byId('mtm-compare-horizon').value = comparison.horizon || '';
        byId('mtm-compare-cash-rate').value = comparison.cash_growth?.annual_net_rate != null
          ? formatPtNumber(shiftDecimal(comparison.cash_growth.annual_net_rate, 2), 8) : '';
        byId('mtm-compare-cash-origin').value = comparison.cash_growth?.origin_date || '';
        comparisonHighlight = comparison.highlight || 'none';
        byId('mtm-compare-highlight').value = comparisonHighlight;
        analysisMode = analysis.mode === 'stress' ? 'stress' : 'compare';
        for (const button of doc.querySelectorAll('[data-mtm-analysis-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mtmAnalysisMode === analysisMode));
        byId('mtm-compare-mode').hidden = analysisMode !== 'compare';
        byId('mtm-stress-mode').hidden = analysisMode !== 'stress';
        const stress = analysis.stress || {};
        stressSource = stress.source_id || 'current';
        stressShockDrafts = (stress.shocks || []).map(item => ({
          id: item.id, label: item.label || item.id,
          rate: item.rate_shock_ratio != null ? formatPtNumber(shiftDecimal(item.rate_shock_ratio, 2), 8) : '',
          inflation: item.annual_inflation_ratio != null ? formatPtNumber(shiftDecimal(item.annual_inflation_ratio, 2), 8) : '',
          entryCost: item.entry_expense_delta_brl != null ? formatPtNumber(item.entry_expense_delta_brl, 8) : '',
          exitCost: item.exit_expense_delta_brl != null ? formatPtNumber(item.exit_expense_delta_brl, 8) : '',
        }));
        if (!stressShockDrafts.length) stressShockDrafts = [{ label: 'Estresse 1', rate: '', inflation: '', entryCost: '', exitCost: '' }];
        stressMarginDrafts = (stress.margin_searches || []).map(item => ({
          id: item.id, criterion_id: item.criterion_id, dimension: item.dimension,
          direction: item.direction, maximum: formatPtNumber(item.maximum_magnitude, 8), resolution: formatPtNumber(item.resolution, 8),
        }));
        renderStressShockEditors(); renderStressMarginEditors(); renderCompareContexts();
        if (record.schema_version === 2 && stored.view?.tab) renderTabs(stored.view.tab);
        if (stored.view?.metric && SURFACE_METRICS[stored.view.metric]) byId('mtm-surface-metric').value = stored.view.metric;
        lastValidResult = null; currentEvaluation = null; currentSurface = null;
        currentConstraintLimit = null; currentFirstDateSearch = null; currentEntryBoundarySearch = null;
        currentRateBoundarySearch = { ENTRY: null, EXIT: null };
        comparisonResult = null; currentStressResult = null; stressResultsByContext.clear();
        invalidateSnapshotRecalculation();
        displaySnapshotReview(record);
        byId('mtm-output-title').textContent = 'Fotografia aberta sem novo cálculo';
        byId('mtm-workspace-quality').textContent = 'Resultado guardado';
        byId('mtm-workspace-summary').textContent = 'Os resultados originais estão na fotografia abaixo. Use “Recalcular fotografia salva” para comparar com o motor atual.';
        decisionController?.restore(stored.view?.decision || null);
        const persistence = snapshot().persistence;
        const signature = currentSnapshotSignature();
        dispatch({ type: 'MARK_SNAPSHOT_SAVED', metadata: {
          ...persistence, id: record.id, revision: record.revision, name: baselineName,
          schema_version: record.schema_version, snapshot_sha256: stored.snapshot_sha256,
          saved_signature: signature,
        } });
        setSnapshotMessage(record.schema_version === 1
          ? 'Snapshot v1 aberto em adaptação visual. A fotografia original e seu hash permanecem intactos; duplique para criar uma cópia v2.'
          : `Fotografia v2 aberta sem recalcular · r${record.revision}.`, false);
      } finally { openingSnapshot = false; }
      syncActionState();
    }

    async function openSelectedSnapshot(id = null, force = false) {
      const selectedId = id || byId('mtm-snapshot-select')?.value;
      if (!selectedId) throw new TypeError('Selecione uma fotografia salva.');
      const current = snapshot();
      const dirty = requireState().snapshotIsDirty(current, currentSnapshotSignature());
      const hasWork = current.persistence?.id || lastValidResult || current.revisions.scenario_revision > 0
        || current.revisions.criteria_revision > 0 || current.revisions.reference_revision > 0 || current.revisions.alternatives_revision > 0;
      if (!force && dirty && hasWork && !root.confirm('Há alterações não salvas. Abrir esta análise substituirá o rascunho atual. Cancelar preserva o rascunho; Abrir descarta essas alterações locais.')) return;
      snapshotBusy = true; syncSnapshotControls();
      try {
        const record = await http(`simulator/scenario?id=${encodeURIComponent(selectedId)}`);
        hydrateSnapshot(record);
        if (byId('mtm-snapshot-select')) byId('mtm-snapshot-select').value = selectedId;
        try {
          const preference = byId('mtm-snapshot-reopen')?.checked;
          if (preference) root.localStorage?.setItem(SNAPSHOT_REOPEN_KEY, selectedId);
        } catch (_) { /* Browser storage can be disabled; snapshot remains available in memory. */ }
        setSnapshotMessage(`Fotografia carregada · hash verificado pelo servidor · r${record.revision}. Nenhuma chamada de avaliação foi feita ao abrir.`);
      } catch (error) {
        setSnapshotMessage(`Não foi possível abrir a fotografia. O rascunho atual foi preservado. ${error?.message || error}`, true);
      } finally { snapshotBusy = false; syncSnapshotControls(); }
    }

    async function saveSnapshot({ asCopy = false, requireRecalculation = false } = {}) {
      if (snapshotBusy || busy) return;
      const current = snapshot();
      if (!byId('mtm-snapshot-consent')?.checked) throw new TypeError('Marque o consentimento para salvar neste computador.');
      const originalId = current.persistence?.id || null;
      if (asCopy && !originalId) throw new TypeError('Abra uma análise salva antes de criar uma cópia.');
      const updating = Boolean(originalId && !asCopy);
      if (current.persistence?.schema_version === 1 && !asCopy) throw new TypeError('Fotografias v1 são somente leitura; salve uma cópia v2.');
      if (asCopy && current.persistence?.schema_version === 1 && openedMigrationWarning) {
        throw new TypeError(`A conversão foi bloqueada para preservar campos: ${openedMigrationWarning}`);
      }
      const body = makeSnapshotBody({ includeConsent: true, revisionSave: updating });
      if (asCopy) {
        const currentName = String(body.name || '').trim();
        const originalName = String(current.persistence?.name || 'análise').trim();
        body.name = currentName && currentName !== originalName
          ? currentName : `Cópia de ${originalName}`.slice(0, 120);
      }
      if (!body.name) throw new TypeError('Informe um nome para a fotografia.');
      if (requireRecalculation && (!updating || !pendingSnapshotRecalculation
          || pendingSnapshotRecalculation.signature !== currentSnapshotSignature())) {
        throw new TypeError('Recalcule e confira as diferenças antes de salvar uma nova revisão.');
      }
      snapshotBusy = true; syncSnapshotControls();
      try {
        const dispatchedSignature = currentSnapshotSignature();
        pendingSaveOperation = saveOperationForPayload(pendingSaveOperation, body,
          () => root.crypto.randomUUID().replaceAll('-', ''));
        body.operation_id = pendingSaveOperation.id;
        const result = await http('simulator/save', body);
        pendingSaveOperation = null;
        const acknowledgment = saveAcknowledgementForDraft(
          dispatchedSignature, currentSnapshotSignature(), body.name, asCopy);
        if (asCopy && !acknowledgment.draftChanged) byId('mtm-snapshot-name').value = body.name;
        const signature = acknowledgment.savedSignature;
        dispatch({ type: 'MARK_SNAPSHOT_SAVED', metadata: {
          id: result.id, revision: result.revision, name: body.name, schema_version: 2,
          snapshot_sha256: result.snapshot_sha256, saved_signature: signature,
          duplicate_of: asCopy ? originalId : current.persistence?.duplicate_of || null,
        } });
        openedRecord = { ...result, schema_version: 2, snapshot: {
          ...result, application: 'renda2065.market_sim', snapshot_version: 2,
          schema_version: 2, input: body.input, selection: result.point_evaluations?.current?.selection || body.selection,
          reference: body.reference, alternatives: body.alternatives, analysis: body.analysis,
          view: body.view, point_evaluations: result.point_evaluations,
        } };
        openedWorkspaceInput = cloneJson(body.input); openedFormTouched = acknowledgment.draftChanged;
        pendingSnapshotRecalculation = null; byId('mtm-snapshot-consent').checked = false;
        invalidateSnapshotRecalculation(); displaySnapshotReview(openedRecord);
        const refreshed = await refreshSnapshots(result.id);
        try { if (byId('mtm-snapshot-reopen')?.checked) root.localStorage?.setItem(SNAPSHOT_REOPEN_KEY, result.id); }
        catch (_) { /* Preference is optional and no financial data is stored. */ }
        const savedAt = snapshotSavedAt(result.updated_at || result.created_at);
        setSnapshotMessage(acknowledgment.draftChanged
          ? `Fotografia enviada “${body.name}” salva · r${result.revision}. O rascunho alterado durante a gravação continua com alterações não salvas.${refreshed ? '' : ' A lista não atualizou; use “Atualizar lista”.'}`
          : result.operation_replayed
          ? `Confirmação recuperada: análise “${body.name}” salva · r${result.revision} · ${savedAt}. A gravação foi conferida sem criar outra fotografia.${refreshed ? '' : ' Use “Atualizar lista”.'}`
          : refreshed
          ? `Análise “${body.name}” salva · r${result.revision} · ${savedAt}. O servidor avaliou somente os pontos guardados.`
          : `Análise “${body.name}” salva · r${result.revision} · ${savedAt}. A lista não atualizou; use “Atualizar lista”.`, !refreshed);
      } catch (error) {
        setSnapshotMessage(snapshotConflict(error)
          ? `Conflito de revisão: outra versão foi salva depois que esta análise foi aberta. Seu rascunho e consentimento foram preservados. Próxima ação: use “Salvar como cópia” para guardar esta versão ou atualize a lista e abra a revisão mais recente.`
          : `Não foi possível salvar. O rascunho, a seleção e o consentimento foram preservados. Tente novamente ou use “Salvar como cópia”. ${error?.message || error}`, true);
      } finally { snapshotBusy = false; syncSnapshotControls(); }
    }

    function renderRecalculationDiff(result, record) {
      const section = byId('mtm-snapshot-recalculation');
      const note = byId('mtm-snapshot-recalculation-note');
      const points = byId('mtm-snapshot-recalculation-points');
      if (section) section.hidden = false;
      if (points) points.replaceChildren();
      const compatibility = result.compatibility || record.compatibility || {};
      const changes = Object.keys(compatibility.engine_changes || {});
      if (note) note.textContent = `Recálculo da revisão original r${result.revision} · hash ${result.snapshot_sha256}. ${changes.length ? `Manifesto alterado: ${changes.join(', ')}.` : 'Manifesto do motor compatível.'} A gravação original ainda não foi alterada.`;
      if (result.schema_version === 2) {
        const currentEvaluations = result.current_evaluations || {};
        const savedEvaluations = record.snapshot?.point_evaluations || {};
        for (const [id, evaluation] of Object.entries(currentEvaluations)) {
          const saved = savedEvaluations[id] || {};
          const oldOperation = saved.result?.operation || {};
          const newOperation = evaluation.result?.operation || {};
          const card = doc.createElement('article'); card.className = 'mtm-snapshot-point';
          card.append(textElement('h5', `${snapshotPointLabel(id)} · ${presentation().labelWithCode('status', evaluation.status)}`));
          const oldUnit = saved.result?.unit_price;
          const newUnit = evaluation.result?.unit_price;
          if (oldUnit || newUnit) {
            const showUnit = value => value == null ? presentation().MISSING : formatCurrency(value, 2);
            card.append(textElement('p', `Preço por título: salvo ${showUnit(oldUnit?.value)} → atual ${showUnit(newUnit?.value)}`));
            const nominalCode = newUnit?.reason_code;
            if (nominalCode === 'MISSING_IPCA_HISTORY' || nominalCode === 'MISSING_IPCA_MONTH') {
              card.append(textElement('p', 'IPCA mensal indisponível: importe ou atualize a série em Dados e backups e recalcule. A fotografia salva permanece intacta; VNA/VNI será calculado automaticamente.'));
            } else if (nominalCode === 'MISSING_PROJECTION') {
              card.append(textElement('p', 'Declare a hipótese de inflação para os meses ainda não divulgados.'));
            }
          }
          for (const key of ['net_redemption', 'nominal_profit', 'real_profit', 'nominal_return', 'real_return']) {
            const oldValue = oldOperation[key], newValue = newOperation[key];
            if (oldValue == null && newValue == null) continue;
            const currency = key.includes('profit') || key === 'net_redemption';
            const ratio = key.endsWith('return');
            const show = value => value == null ? presentation().MISSING : currency
              ? formatCurrency(value, 2) : formatRatioPercent(value, 2);
            card.append(textElement('p', `${key}: salvo ${show(oldValue)} → atual ${show(newValue)}${JSON.stringify(oldValue) === JSON.stringify(newValue) ? ' · sem mudança' : ' · mudou'}`));
          }
          points?.append(card);
        }
      } else {
        const fields = { ...(result.comparison?.scenario_fields || {}), ...(result.comparison?.operation_fields || {}) };
        for (const [key, values] of Object.entries(fields)) {
          const card = doc.createElement('article'); card.className = 'mtm-snapshot-point';
          card.append(textElement('h5', key));
          card.append(textElement('p', `Salvo: ${values.saved ?? presentation().MISSING} → Atual: ${values.current ?? presentation().MISSING}${values.changed ? ' · mudou' : ' · sem mudança'}`));
          points?.append(card);
        }
      }
      const revisionButton = byId('mtm-snapshot-save-revision');
      const canCommit = result.schema_version === 2 && record.schema_version === 2 && !compatibility.missing_source_versions?.length;
      if (revisionButton) { revisionButton.hidden = !canCommit; revisionButton.disabled = !canCommit; }
    }

    async function recalculateOpenedSnapshot() {
      const current = snapshot();
      const record = openedRecord;
      if (!record?.id || snapshotBusy) return;
      snapshotBusy = true; syncSnapshotControls(); invalidateSnapshotRecalculation();
      try {
        const result = await http('simulator/recalculate', {
          schema_version: record.schema_version, id: record.id, revision: record.revision,
        });
        renderRecalculationDiff(result, record);
        pendingSnapshotRecalculation = {
          id: record.id, revision: record.revision, signature: currentSnapshotSignature(), result,
        };
        setSnapshotMessage(`Recálculo separado concluído para ${record.id} · r${result.revision}. Compare as diferenças abaixo; o registro original não foi gravado.`);
      } catch (error) {
        setSnapshotMessage(`Recálculo não concluído; fotografia e rascunho permanecem intactos. ${error?.message || error}`, true);
      } finally { snapshotBusy = false; syncSnapshotControls(); }
    }

    async function saveRecalculatedRevision() {
      const current = snapshot();
      if (!pendingSnapshotRecalculation || pendingSnapshotRecalculation.signature !== currentSnapshotSignature()) {
        throw new TypeError('As premissas mudaram; recalcule novamente antes de salvar a revisão.');
      }
      const oldId = current.persistence.id;
      await saveSnapshot({ requireRecalculation: true });
      if (snapshot().persistence.id === oldId && snapshot().persistence.revision > current.persistence.revision) {
        setSnapshotMessage(`Nova revisão v2 salva após comparação explícita · r${snapshot().persistence.revision}.`);
      }
    }

    function syncActionState() {
      decisionController?.update();
      const current = snapshot();
      undoButton.disabled = busy || !current?.undo_depth;
      cancelButton.hidden = !busy;
      cancelButton.disabled = !busy;
      applyReferenceButton.hidden = !lastValidResult;
      const referenceFresh = lastValidResult?.identity === resultIdentity();
      const hasFingerprint = /^(?:sha256:)?[0-9a-f]{64}$/i.test(String(lastValidResult?.response?.input_fingerprint || ''));
      applyReferenceButton.disabled = busy || !referenceFresh || !hasFingerprint;
      applyReferenceButton.textContent = current?.reference ? 'Atualizar referência' : 'Fixar original e criar cópia';
      applyReferenceButton.title = !referenceFresh
        ? 'Avalie a revisão atual antes de congelá-la como referência.'
        : (!hasFingerprint ? 'Fingerprint verificável indisponível nesta resposta.' : '');
      restoreReferenceButton.hidden = !current?.reference;
      restoreReferenceButton.disabled = busy || !current?.reference;
      const scenarioMode = current?.scenario_mode || 'BASE';
      const showScenarioContext = Boolean(lastValidResult) && lastValidResult.identity === resultIdentity()
        && lastValidResult.response?.result?.operation && lastValidResult.input?.result_mode !== 'UNIT_PRICE';
      scenarioContext.hidden = !showScenarioContext;
      restoreBaseButton.hidden = !showScenarioContext || scenarioMode !== 'EXPLORANDO';
      restoreBaseButton.disabled = busy || !baseContext;
      if (showScenarioContext) {
        const selection = current?.selection;
        if (scenarioMode === 'REFERENCIA') scenarioContextStatus.textContent = 'Referência salva · a avaliação atual está vinculada à referência congelada.';
        else if (scenarioMode === 'EXPLORANDO' && selection) {
          const coordinate = selection.annual_real_rate !== undefined
            ? `taxa real ${formatPtNumber(shiftDecimal(selection.annual_real_rate, 2), 4)}% a.a.`
            : `PU de saída R$ ${formatPtNumber(selection.exit_pu, 2)}`;
          scenarioContextStatus.textContent = `Explorando ${selection.sale_date} · ${coordinate}.`;
        } else scenarioContextStatus.textContent = 'Cenário-base · resultado da operação atual.';
      }
      if (submit) submit.disabled = busy;
      for (const button of pendingPanel.querySelectorAll('[data-confirm-date]')) button.disabled = busy;
      if (confirmResolved) confirmResolved.disabled = busy;
      const addCriterion = byId('mtm-criteria-add');
      if (addCriterion) addCriterion.disabled = busy || (current?.criteria || []).length >= 8;
      const applyCriteriaButton = byId('mtm-criteria-apply');
      if (applyCriteriaButton) applyCriteriaButton.disabled = busy;
      const exploreLimit = byId('mtm-constraint-explore');
      if (exploreLimit) exploreLimit.disabled = busy || currentConstraintLimit?.identity !== resultIdentity();
      const firstDateButton = byId('mtm-first-date-run');
      if (firstDateButton) firstDateButton.disabled = busy || !lastValidResult || lastValidResult.identity !== resultIdentity();
      const entryBoundaryButton = byId('mtm-entry-boundary-run');
      if (entryBoundaryButton) entryBoundaryButton.disabled = busy || !lastValidResult || lastValidResult.identity !== resultIdentity();
      const exploreEntryBoundary = byId('mtm-entry-boundary-explore');
      if (exploreEntryBoundary) exploreEntryBoundary.disabled = busy || currentEntryBoundarySearch?.identity !== entryBoundarySearchIdentity();
      for (const button of doc.querySelectorAll('[data-rate-boundary-run]')) {
        button.disabled = busy || !lastValidResult || lastValidResult.identity !== resultIdentity();
      }
      for (const button of doc.querySelectorAll('[data-rate-boundary-explore]')) {
        const side = button.dataset.rateBoundaryExplore;
        button.disabled = busy || currentRateBoundarySearch[side]?.identity !== rateBoundarySearchIdentity(side);
      }
      const pinDisabled = busy || !lastValidResult || lastValidResult.identity !== resultIdentity()
        || !hasFingerprint || (current?.alternatives || []).length >= 2;
      for (const button of doc.querySelectorAll('[data-mtm-pin-alternative]')) button.disabled = pinDisabled;
      const alternativeSaveStatus = byId('mtm-alternative-save-status');
      if (alternativeSaveStatus) {
        const stale = resultStaleness(lastValidResult);
        if (lastValidResult && stale.financial) {
          alternativeSaveStatus.textContent = 'Você alterou as premissas financeiras. Recalcule para atualizar este resultado.';
        } else if (lastValidResult && stale.goals) {
          alternativeSaveStatus.textContent = 'Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.';
        } else if (!lastValidResult && !alternativeSaveStatus.textContent.trim()) {
          alternativeSaveStatus.textContent = 'Avalie um cenário antes de guardá-lo como alternativa.';
        } else if (lastValidResult && ['Avalie um cenário antes de guardá-lo como alternativa.',
          'Avalie a revisão atual antes de guardá-la como alternativa.',
          'Você alterou as premissas financeiras. Recalcule para atualizar este resultado.',
          'Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.'].includes(alternativeSaveStatus.textContent)) {
          alternativeSaveStatus.textContent = '';
        }
      }
      const compareButton = byId('mtm-compare-run');
      const selectedAlternatives = (current?.alternatives || []).filter(item => comparisonIncludedIds.has(item.id));
      const fixedPositionComparison = byId('mtm-compare-position-mode')?.value === 'FIXED_POSITION';
      if (compareButton) compareButton.disabled = busy || !current?.reference
        || (fixedPositionComparison ? selectedAlternatives.length !== 1 : selectedAlternatives.length === 0);
      const stressButton = byId('mtm-stress-run');
      if (stressButton) stressButton.disabled = busy || !stressSourceInput(stressSource);
      const addStress = byId('mtm-stress-add-shock');
      if (addStress) addStress.disabled = busy || stressShockDrafts.length >= 25;
      const addMargin = byId('mtm-stress-add-margin');
      if (addMargin) addMargin.disabled = busy || stressMarginDrafts.length >= 4
        || stressConstraintRows(stressSourceInput(stressSource)?.input).length === 0;
      renderStressQuickControls();
      for (const button of doc.querySelectorAll('[data-stress-shortcut]')) {
        button.disabled = busy || button.dataset.stressBlocked === 'true';
      }
      const stressUndoButton = byId('mtm-stress-shortcut-undo');
      if (stressUndoButton) {
        stressUndoButton.hidden = !stressShortcutUndo;
        stressUndoButton.disabled = busy || !stressShortcutUndo;
      }
      for (const control of doc.querySelectorAll('#mtm-stress-shocks input, #mtm-stress-shocks button, #mtm-stress-margins input, #mtm-stress-margins select, #mtm-stress-margins button')) {
        control.disabled = busy || (control.dataset.stressRemove === 'true' && stressShockDrafts.length <= 1);
      }
      const removeAlternative = byId('mtm-compare-remove-alternative');
      if (removeAlternative) removeAlternative.disabled = busy || !focusedAlternativeId;
      const copyAlternative = byId('mtm-compare-copy-alternative');
      if (copyAlternative) copyAlternative.disabled = busy || !focusedAlternativeId;
      syncSnapshotControls();
      syncSurfaceGenerationAction();
      syncGrossDv01Action();
    }

    function syncSurfaceGenerationAction() {
      const panel = byId('mtm-panel-map');
      const resultDetail = byId('mtm-workspace-result-detail');
      if (!panel || !resultDetail) return;

      let generation = byId('mtm-surface-generation');
      if (!generation) {
        generation = doc.createElement('div');
        generation.id = 'mtm-surface-generation';
        generation.className = 'mtm-surface-generation';

        const status = doc.createElement('p');
        status.id = 'mtm-surface-generation-status';
        status.className = 'muted';
        status.setAttribute('role', 'status');

        const button = doc.createElement('button');
        button.id = 'mtm-surface-generate';
        button.type = 'button';
        button.className = 'primary';
        button.addEventListener('click', () => { void updateRateExploration(); });
        generation.append(status, button);
        panel.insertBefore(generation, resultDetail.nextSibling);
      }

      const modes = selectedAnalysisModes();
      const operationReady = modes.resultMode === 'OPERATION'
        && modes.timelineMode === 'POINT'
        && lastValidResult?.identity === resultIdentity()
        && Boolean(lastValidResult?.response?.result?.operation);
      const unitPriceReady = modes.resultMode === 'UNIT_PRICE'
        && Boolean(unitPriceResult) && !unitPriceResultStale;
      const ready = operationReady || unitPriceReady;
      const hasSurface = Boolean(currentSurface?.result);
      const status = byId('mtm-surface-generation-status');
      const button = byId('mtm-surface-generate');
      generation.hidden = hasSurface || !ready;
      if (status) status.textContent = unitPriceReady
        ? 'Calcule a faixa de preços unitários para explorar o PU por taxa real. Essa consulta adicional só é feita quando solicitada.'
        : 'Calcule uma curva por taxa para explorar o resultado. Essa consulta adicional só é feita quando solicitada.';
      if (button) {
        button.textContent = unitPriceReady ? 'Calcular faixa por taxa' : 'Calcular curva por taxa';
        button.disabled = busy || !ready;
      }
    }

    function financialResultIdentity() {
      const current = snapshot();
      return JSON.stringify({
        draft: draftSignature,
        selection: current?.selection ? {
          sale_date: current.selection.sale_date || null,
          settlement_date: current.selection.settlement_date || null,
          ...(current.selection.exit_pu !== undefined ? { exit_pu: current.selection.exit_pu } : {}),
          ...(current.selection.annual_real_rate !== undefined ? { annual_real_rate: current.selection.annual_real_rate } : {}),
        } : null,
        source_versions: sourceVersionsOverride || {
          market_sim: catalog?.market_sim_active?.market_sim || null,
          market_sim_indexes: catalog?.market_sim_active?.market_sim_indexes || null,
        },
      });
    }

    function goalResultIdentity() {
      return JSON.stringify(snapshot()?.criteria || []);
    }

    function resultIdentity() {
      return JSON.stringify({ financial: financialResultIdentity(), goals: goalResultIdentity() });
    }

    function resultIdentityFields() {
      return {
        identity: resultIdentity(),
        financial_identity: financialResultIdentity(),
        goal_identity: goalResultIdentity(),
      };
    }

    function resultStaleness(result) {
      if (!result) return { financial: true, goals: true };
      const financial = result.financial_identity !== financialResultIdentity();
      return {
        financial,
        goals: financial || result.goals_evaluated === false || result.goal_identity !== goalResultIdentity(),
      };
    }

    function comparisonIdentity() {
      const current = snapshot();
      return JSON.stringify({
        reference_revision: current?.revisions?.reference_revision,
        alternatives_revision: current?.revisions?.alternatives_revision,
        alternatives: (current?.alternatives || []).filter(item => comparisonIncludedIds.has(item.id)).map(item => item.id),
        comparison_mode: byId('mtm-compare-position-mode')?.value || 'BUDGET',
        horizon: byId('mtm-compare-horizon')?.value || '',
        cash_rate: byId('mtm-compare-cash-rate')?.value || '',
        cash_origin: byId('mtm-compare-cash-origin')?.value || '',
      });
    }

    function syncComparisonModeControls() {
      const fixedPosition = byId('mtm-compare-position-mode')?.value === 'FIXED_POSITION';
      const origin = byId('mtm-compare-cash-origin-wrap');
      const help = byId('mtm-compare-cash-help');
      if (origin) origin.hidden = fixedPosition;
      if (help) help.textContent = fixedPosition
        ? 'Mesma quantidade, compra, base fiscal e custos pagos para as duas saídas. O caixa de cada venda só cresce depois da respectiva liquidação; informe horizonte e, se desejar ranking patrimonial, uma taxa nominal líquida explícita.'
        : 'A taxa de caixa é uma hipótese nominal líquida. Informe horizonte, taxa e origem em conjunto. Sem taxa, datas diferentes não podem ser ordenadas por patrimônio.';
    }

    function textElement(tag, text, className = '') {
      const element = doc.createElement(tag);
      element.textContent = text == null ? '' : String(text);
      if (className) element.className = className;
      return element;
    }

    function frozenInput(scenario) {
      return scenario?.input || scenario?.normalized_input || null;
    }

    function instrumentLabel(input) {
      const instrument = input?.instrument || {};
      const id = instrument.instrument_id;
      if (id && !['IPCA_PRINCIPAL', 'RENDA_PLUS'].includes(id)) return id;
      const family = instrument.family === 'RENDA_PLUS' ? 'RendA+' : instrument.family === 'IPCA_PRINCIPAL' ? 'IPCA+ sem cupom' : 'Título';
      const date = instrument.family === 'RENDA_PLUS' ? instrument.conversion_date : instrument.maturity_date;
      return [family, String(date || instrument.series_year || '').slice(0, 4)].filter(Boolean).join(' ');
    }

    function compareScenarioSources() {
      const current = snapshot();
      return [
        ...(current?.reference ? [{ key: 'reference', scenario: current.reference, label: 'Referência' }] : []),
        ...(current?.alternatives || []).map((scenario, index) => ({
          key: scenario.id, scenario, label: scenario.label || `Alternativa ${String.fromCharCode(65 + index)}`,
        })),
      ];
    }

    const comparisonFieldLabels = Object.freeze({
      'mtm-workspace-instrument': 'Título', 'mtm-budget-value': 'Orçamento', 'mtm-quantity-value': 'Quantidade',
      'mtm-workspace-purchase-date': 'Data de compra', 'mtm-workspace-sale-date': 'Data de venda',
      'mtm-workspace-window-start': 'Início do período', 'mtm-workspace-window-end': 'Fim do período',
      'mtm-workspace-series-year': 'Ano da série', 'mtm-workspace-buy-rate': 'Taxa de compra',
      'mtm-workspace-sell-rate': 'Taxa de venda', 'mtm-workspace-entry-pu': 'PU de compra',
      'mtm-workspace-exit-pu': 'PU de venda', 'mtm-workspace-entry-pu-source': 'Fonte do PU de compra',
      'mtm-workspace-exit-pu-source': 'Fonte do PU de venda', 'mtm-workspace-buy-anchor': 'Âncora de compra',
      'mtm-workspace-sell-anchor': 'Âncora de venda', 'mtm-workspace-inflation-rate': 'Inflação inicial',
      'mtm-workspace-future-inflation-rate': 'Inflação final', 'mtm-workspace-anchor-source': 'Fonte do índice',
      'mtm-workspace-settlement': 'Liquidação', 'mtm-workspace-entry-fee': 'Custo fixo de entrada',
      'mtm-workspace-entry-rate': 'Custo proporcional de entrada', 'mtm-workspace-exit-fee': 'Custo de saída',
      'mtm-workspace-custody-actual': 'Custódia efetivamente cobrada',
      'mtm-workspace-institution-net': 'Resgate líquido informado pela instituição',
      'mtm-workspace-knowledge-date': 'Data de referência dos dados', 'mtm-workspace-evidence-mode': 'Modo da evidência',
      'mtm-workspace-index-levels': 'Níveis manuais do índice', capital_mode: 'Forma do capital',
      entry_price_mode: 'Forma do PU de compra', exit_price_mode: 'Forma do PU de venda',
      result_mode: 'Tipo de resultado', timeline_mode: 'Horizonte',
    });

    function comparisonFieldValue(value, key) {
      if (Array.isArray(value)) return `${value.length} nível(is) do índice`;
      if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
      const text = String(value ?? '').trim();
      return text || 'vazio';
    }

    function renderAlternativeDifferences(raw = snapshot()?.draft?.ui_form || {}) {
      const status = byId('mtm-compare-context-status');
      const host = status?.parentElement;
      if (!host) return;
      let panel = byId('mtm-compare-differences');
      if (!panel) {
        panel = doc.createElement('section'); panel.id = 'mtm-compare-differences';
        panel.className = 'mtm-alternative-differences';
        panel.setAttribute('aria-labelledby', 'mtm-compare-differences-title');
        panel.setAttribute('aria-live', 'polite');
        const heading = doc.createElement('h5'); heading.id = 'mtm-compare-differences-title';
        heading.textContent = 'Edições da cópia em relação à referência';
        const list = doc.createElement('ul'); list.id = 'mtm-compare-differences-list';
        panel.append(heading, list);
        host.insertBefore(panel, status);
      }
      const reference = snapshot()?.reference;
      panel.hidden = !reference;
      if (!reference) return;
      const base = reference.draft?.ui_form || {};
      const keys = [...new Set([...Object.keys(base), ...Object.keys(raw || {})])];
      const differences = keys.filter(key => JSON.stringify(base[key]) !== JSON.stringify(raw?.[key]));
      const list = byId('mtm-compare-differences-list');
      if (!list) return;
      list.replaceChildren();
      if (!differences.length) {
        list.append(textElement('li', 'Nenhuma edição em relação à referência.'));
        return;
      }
      for (const key of differences) {
        const label = comparisonFieldLabels[key] || key;
        const item = doc.createElement('li');
        item.textContent = `${label}: ${comparisonFieldValue(base[key], key)} → ${comparisonFieldValue(raw?.[key], key)}`;
        list.append(item);
      }
    }

    function renderAlternativeRenameControls(focused) {
      const actions = byId('mtm-compare-focus-actions');
      if (!actions) return;
      let controls = byId('mtm-compare-rename-controls');
      if (!controls) {
        controls = doc.createElement('div'); controls.id = 'mtm-compare-rename-controls';
        controls.className = 'mtm-compare-rename-controls';
        const label = doc.createElement('label'); label.textContent = 'Nome da alternativa';
        const input = doc.createElement('input'); input.id = 'mtm-compare-rename-input'; input.type = 'text';
        input.maxLength = 120; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Nome da alternativa');
        const button = doc.createElement('button'); button.id = 'mtm-compare-rename-save'; button.type = 'button';
        button.className = 'subtle'; button.textContent = 'Salvar nome';
        label.append(input); controls.append(label, button); actions.append(controls);
        input.addEventListener('input', () => {
          button.disabled = busy || !focusedAlternativeId || !input.value.trim();
        });
        button.addEventListener('click', () => renameFocusedAlternative(input.value));
      }
      const input = byId('mtm-compare-rename-input');
      const button = byId('mtm-compare-rename-save');
      controls.hidden = !focused;
      if (input && doc.activeElement !== input) input.value = focused?.label || '';
      if (button) button.disabled = busy || !focused || !input?.value.trim();
    }

    function renameFocusedAlternative(value) {
      if (busy || !focusedAlternativeId) return;
      const label = String(value ?? '').trim();
      const status = byId('mtm-compare-context-status');
      if (!label || label.length > 120) {
        if (status) status.textContent = 'Informe um nome de 1 a 120 caracteres.';
        return;
      }
      try {
        dispatch({ type: 'RENAME_ALTERNATIVE', alternative_id: focusedAlternativeId, label });
        if (status) status.textContent = 'Nome da alternativa atualizado. Você pode desfazer essa alteração.';
        renderCompareContexts();
      } catch (error) {
        if (status) status.textContent = error?.message || 'Não foi possível renomear a alternativa.';
      }
    }

    function renderCompareContexts() {
      const current = snapshot();
      const reference = current?.reference;
      const refSummary = byId('mtm-compare-reference-summary');
      if (refSummary) {
        const input = frozenInput(reference);
        const fingerprint = String(reference?.input_fingerprint || '').slice(0, 12);
        refSummary.textContent = reference
          ? `Referência congelada · ${instrumentLabel(input)} · ${fingerprint ? `fingerprint ${fingerprint}…` : 'premissas e ponto preservados na fotografia local'}`
          : 'Defina a referência depois de avaliar um cenário. A referência não muda quando você edita o cenário atual.';
      }
      const alternatives = current?.alternatives || [];
      const liveIds = new Set(alternatives.map(item => item.id));
      comparisonIncludedIds = new Set([...comparisonIncludedIds].filter(id => liveIds.has(id)));
      for (const item of alternatives) if (!knownAlternativeIds.has(item.id)) comparisonIncludedIds.add(item.id);
      knownAlternativeIds = liveIds;
      if (!liveIds.has(focusedAlternativeId)) focusedAlternativeId = '';
      const list = byId('mtm-compare-alternatives');
      if (list) {
        list.replaceChildren();
        alternatives.forEach((scenario, index) => {
          const label = doc.createElement('label'); label.className = 'mtm-alternative-option';
          const checkbox = doc.createElement('input'); checkbox.type = 'checkbox';
          checkbox.checked = comparisonIncludedIds.has(scenario.id); checkbox.dataset.alternativeId = scenario.id;
          const description = doc.createElement('span');
          description.textContent = `${String.fromCharCode(65 + index)} · ${scenario.label || instrumentLabel(frozenInput(scenario))}`;
          label.append(checkbox, description); list.append(label);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) comparisonIncludedIds.add(scenario.id);
            else comparisonIncludedIds.delete(scenario.id);
            comparisonResult = null;
            renderComparisonResult();
            const status = byId('mtm-compare-status');
            if (status) status.textContent = 'A seleção de colunas mudou. Execute novamente a comparação.';
            syncActionState();
          });
        });
        if (!alternatives.length) {
          const stale = resultStaleness(lastValidResult);
          const guidance = !lastValidResult
            ? 'Nenhuma alternativa guardada. Avalie um cenário para habilitar a comparação.'
            : stale.financial
              ? 'Nenhuma alternativa guardada. Recalcule o cenário editado para habilitar a comparação.'
              : stale.goals
                ? 'Nenhuma alternativa guardada. Aplique as metas para atualizar o atendimento antes de comparar.'
                : 'Nenhuma alternativa guardada. O cenário atual está pronto para comparação.';
          list.append(textElement('p', guidance, 'muted'));
        }
      }
      const focus = byId('mtm-compare-focus');
      if (focus) {
        const options = [textElement('option', 'Nenhuma alternativa selecionada')];
        options[0].value = '';
        alternatives.forEach((scenario, index) => {
          const option = textElement('option', `${String.fromCharCode(65 + index)} · ${scenario.label || instrumentLabel(frozenInput(scenario))}`);
          option.value = scenario.id; options.push(option);
        });
        focus.replaceChildren(...options); focus.value = focusedAlternativeId;
      }
      const focusActions = byId('mtm-compare-focus-actions');
      const focused = alternatives.find(item => item.id === focusedAlternativeId);
      if (focusActions) focusActions.hidden = !focused;
      const focusDetail = byId('mtm-compare-focus-detail');
      if (focusDetail) {
        const fingerprint = String(focused?.input_fingerprint || '').slice(0, 12);
        focusDetail.textContent = focused
          ? `${instrumentLabel(frozenInput(focused))} · ${fingerprint ? `fingerprint ${fingerprint}…` : 'premissas preservadas na fotografia local'}`
          : '';
      }
      renderAlternativeRenameControls(focused);
      renderAlternativeDifferences();
      const stressSourceControl = byId('mtm-stress-source');
      if (stressSourceControl) {
        const options = [textElement('option', 'Cenário atual')]; options[0].value = 'current';
        compareScenarioSources().forEach(source => {
          const option = textElement('option', source.label); option.value = source.key; options.push(option);
        });
        stressSourceControl.replaceChildren(...options);
        if (stressSource !== 'current' && !compareScenarioSources().some(source => source.key === stressSource)) stressSource = 'current';
        stressSourceControl.value = stressSource;
      }
      renderStressQuickControls();
      renderStressMarginEditors();
      renderStressResults();
      renderComparisonResult();
      syncActionState();
    }

    function pinCurrentAlternative() {
      if (busy || !lastValidResult || lastValidResult.identity !== resultIdentity()) {
        const status = byId('mtm-alternative-save-status');
        const stale = resultStaleness(lastValidResult);
        if (status) status.textContent = !lastValidResult || busy
          ? 'Avalie o cenário atual antes de guardá-lo como alternativa.'
          : stale.financial
            ? 'Você alterou as premissas financeiras. Recalcule para atualizar este resultado.'
            : 'Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.';
        return;
      }
      const current = snapshot();
      const fingerprint = lastValidResult.response?.input_fingerprint;
      if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(fingerprint || ''))) {
        const status = byId('mtm-alternative-save-status');
        if (status) status.textContent = 'Fingerprint verificável indisponível; o cenário não foi guardado.';
        return;
      }
      const alternatives = current?.alternatives || [];
      if (alternatives.length >= 2) {
        const status = byId('mtm-alternative-save-status');
        if (status) status.textContent = 'Já há duas alternativas. Remova uma antes de guardar outra.';
        return;
      }
      if (current?.reference?.input_fingerprint === fingerprint || alternatives.some(item => item.input_fingerprint === fingerprint)) {
        const status = byId('mtm-alternative-save-status');
        if (status) status.textContent = 'Este fingerprint já está guardado como referência ou alternativa.';
        return;
      }
      const input = lastValidResult.input;
      const versions = lastValidResult.input?.source_versions || input?.source_versions || {};
      const provenance = {
        resolved_prices: lastValidResult.resolved?.resolved_prices || {},
        source_resolution: lastValidResult.resolved?.source_resolution || lastValidResult.response?.source_versions || {},
        quality: lastValidResult.response?.result?.quality || lastValidResult.response?.result?.operation?.quality || null,
      };
      const id = `alternative-${++intentSequence}`;
      try {
        dispatch({ type: 'PIN_ALTERNATIVE', alternative: {
          id, label: [instrumentLabel(input), current.selection?.sale_date || input.sale_date,
            current.selection?.annual_real_rate != null ? formatAnnualRate(current.selection.annual_real_rate, 2)
              : input.exit_price?.annual_real_rate != null ? formatAnnualRate(input.exit_price.annual_real_rate, 2) : null,
          ].filter(Boolean).join(' · ').slice(0, 80),
          draft: current.draft, input, source_versions: versions, provenance,
          input_fingerprint: fingerprint, selection: current.selection,
        } });
        comparisonIncludedIds.add(id);
        focusedAlternativeId = id;
        comparisonResult = null;
        const status = byId('mtm-alternative-save-status');
        if (status) status.textContent = 'Alternativa guardada como fotografia. Edições futuras não a alteram.';
        renderCompareContexts();
      } catch (error) {
        const status = byId('mtm-alternative-save-status');
        if (status) status.textContent = error?.message || 'Não foi possível guardar a alternativa.';
      }
    }

    function removeFocusedAlternative() {
      if (busy || !focusedAlternativeId) return;
      const id = focusedAlternativeId;
      try {
        dispatch({ type: 'REMOVE_ALTERNATIVE', alternative_id: id });
        stressResultsByContext.delete(id);
        focusedAlternativeId = '';
        comparisonResult = null;
        const status = byId('mtm-compare-context-status');
        if (status) status.textContent = 'Alternativa removida. Use “Desfazer” para restaurá-la.';
        renderCompareContexts();
      } catch (error) {
        const status = byId('mtm-compare-context-status');
        if (status) status.textContent = error?.message || 'Não foi possível remover a alternativa.';
      }
    }

    function copyFocusedAlternativeToExploration() {
      const scenario = (snapshot()?.alternatives || []).find(item => item.id === focusedAlternativeId);
      const raw = scenario?.draft?.ui_form;
      if (busy || !scenario || !raw || typeof raw !== 'object') {
        const status = byId('mtm-compare-context-status');
        if (status) status.textContent = 'Esta fotografia não contém os campos de edição necessários para uma cópia fiel.';
        return;
      }
      const input = frozenInput(scenario) || {};
      sourceVersionsOverride = scenario.source_versions || input.source_versions || null;
      dispatch({ type: 'EDIT_DRAFT', path: 'ui_form', value: raw });
      syncFormFromRaw(raw);
      if (scenario.selection?.sale_date && (scenario.selection.exit_pu != null || scenario.selection.annual_real_rate != null)) {
        dispatch({ type: 'SELECT_POINT', point: scenario.selection });
      }
      {
        const criteria = (Array.isArray(input.constraints) ? input.constraints : []).map(item => {
          const unit = item.unit || CONSTRAINT_METRICS[item.metric]?.unit;
          const display = unit === 'ratio' || unit === 'ratio_per_year'
            ? formatPtNumber(shiftDecimal(item.value, 2), 4)
            : (unit === 'BRL' ? formatPtNumber(item.value, 2) : item.value);
          return { id: item.id, metric: item.metric, operator: item.operator, value: display };
        });
        dispatch({ type: 'UPDATE_CONSTRAINTS', criteria });
        renderCriteria();
        onCriteriaEdited();
      }
      showError('');
      currentFirstDateSearch = null;
      currentEntryBoundarySearch = null;
      currentRateBoundarySearch = { ENTRY: null, EXIT: null };
      comparisonResult = null;
      const status = byId('mtm-compare-context-status');
      if (status) status.textContent = 'Cópia carregada nos campos. A alternativa guardada continua intacta; avalie novamente para explorar.';
      renderComparisonResult();
      syncActionState();
    }

    function selectedComparisonItems() {
      const current = snapshot();
      if (!current?.reference) return [];
      return [
        { id: 'reference', label: 'Referência', input: frozenInput(current.reference) },
        ...(current.alternatives || []).filter(item => comparisonIncludedIds.has(item.id)).map(item => ({
          id: item.id, label: item.label || instrumentLabel(frozenInput(item)), input: frozenInput(item),
        })),
      ];
    }

    function makeComparisonRequest() {
      const items = selectedComparisonItems();
      if (items.length < 2) throw new TypeError('Defina uma referência e selecione ao menos uma alternativa.');
      const comparisonMode = byId('mtm-compare-position-mode')?.value || 'BUDGET';
      if (comparisonMode === 'FIXED_POSITION' && items.length !== 2) {
        throw new TypeError('A comparação da mesma posição exige uma referência e uma alternativa.');
      }
      let budget = null;
      for (const item of items) {
        const capital = item.input?.capital;
        const requiredMode = comparisonMode === 'FIXED_POSITION' ? 'QUANTITY' : 'BUDGET';
        if (capital?.mode !== requiredMode || capital.value == null) {
          throw new TypeError(comparisonMode === 'FIXED_POSITION'
            ? 'A mesma posição exige quantidade explícita em cada fotografia. Reavalie os cenários com a quantidade original.'
            : 'COMPARE exige orçamento fixo explícito em cada fotografia. Reavalie os cenários nesse modo.');
        }
        if (budget === null) budget = capital.value;
        else if (exactDecimalDifference(budget, capital.value) !== '0') {
          throw new TypeError(comparisonMode === 'FIXED_POSITION'
            ? 'Os cenários guardados não preservam a mesma quantidade. Guarde novas saídas da posição original.'
            : 'Os cenários guardados não usam o mesmo orçamento. Guarde novas alternativas com um valor comum.');
        }
      }
      const horizon = byId('mtm-compare-horizon')?.value || '';
      const rateText = byId('mtm-compare-cash-rate')?.value?.trim() || '';
      const originDate = byId('mtm-compare-cash-origin')?.value || '';
      const payload = {
        schema_version: 2, action: 'COMPARE',
        comparison_mode: comparisonMode,
        reference: { id: 'reference', label: 'Referência', input: items[0].input },
        alternatives: items.slice(1).map(item => ({ id: item.id, label: item.label, input: item.input })),
      };
      if (comparisonMode === 'FIXED_POSITION' && !horizon) {
        throw new TypeError('Informe o horizonte comum para comparar a mesma posição.');
      }
      if (horizon) payload.horizon = horizon;
      if (rateText || (comparisonMode === 'BUDGET' && originDate)) {
        if (!rateText || !horizon || (comparisonMode === 'BUDGET' && !originDate)) {
          throw new TypeError(comparisonMode === 'FIXED_POSITION'
            ? 'Para crescer o caixa, preencha taxa líquida e horizonte comum.'
            : 'Para crescer o caixa, preencha taxa líquida, data de origem e horizonte comum.');
        }
        const rate = parsePtDecimal(rateText, 'Taxa líquida anual');
        if (rate === null) throw new TypeError('Informe uma taxa líquida anual válida.');
        payload.cash_growth = {
          annual_net_rate: shiftDecimal(rate, -2), profile: 'ACT_365_COMPOUND_v1',
        };
        if (comparisonMode === 'BUDGET') payload.cash_growth.origin_date = originDate;
      }
      return payload;
    }

    function compareStatusText(result) {
      if (!result) return 'A resposta de comparação está indisponível.';
      const ranking = result.ranking || {};
      if (ranking.rankable) {
        const names = new Map((result.alternatives || []).map(item => [
          item.id, comparisonContextLabel(item, result.alternatives),
        ]));
        return `Ordenação patrimonial no horizonte comum: ${(ranking.order || []).map(id => names.get(id) || id).join(' → ')}. ${ranking.assumption || ''}`;
      }
      const reasons = (ranking.reasons || []).map(item => item.message).filter(Boolean);
      return `Resultado da operação preservado; total patrimonial não ordenável. ${reasons.join(' ') || ranking.assumption || ''}`;
    }

    function comparisonDeltaText(delta) {
      if (delta?.value == null) return presentation().MISSING;
      const normalized = exactDecimalDifference(delta.value, '0');
      if (normalized === null) return presentation().MISSING;
      const negative = normalized.startsWith('-');
      const magnitude = negative ? normalized.slice(1) : normalized;
      const sign = normalized === '0' ? '' : negative ? '− ' : '+ ';
      if (delta.unit === 'BRL') return `${sign}${formatCurrency(magnitude, 2)}`;
      if (delta.unit === 'PERCENTAGE_POINTS') {
        return `${sign}${formatRatioPercent(shiftDecimal(magnitude, -2), 2).replace('%', ' p.p.')}`;
      }
      if (delta.unit === 'DAYS') return `${sign}${presentation().formatDurationDays(magnitude)}`;
      return `${sign}${formatPtNumber(magnitude, 4)} ${delta.unit || ''}`.trim();
    }

    function comparisonGoalOutcome(status) {
      return ({ MET: 'atendida', NOT_MET: 'não atendida', UNKNOWN: 'não avaliada' })[status] || 'sem resultado';
    }

    function comparisonGoalMargin(delta) {
      if (delta?.value == null) return presentation().MISSING;
      if (delta.unit === 'BRL' || delta.unit === 'BRL_EXIT_DATE') return formatCurrency(delta.value, 2);
      if (delta.unit === 'ratio' || delta.unit === 'ratio_per_year') return formatRatioPercent(delta.value, 2);
      if (delta.unit === 'calendar_days') return presentation().formatDurationDays(delta.value);
      return `${formatPtNumber(delta.value, 4)} ${delta.unit || ''}`.trim();
    }

    function comparisonGoalsText(item) {
      const comparison = item.goal_deltas_from_reference;
      if (!comparison) return presentation().MISSING;
      if (comparison.status === 'NO_GOALS') return 'Nenhuma meta declarada.';
      if (!comparison.criteria?.length) return 'Metas ausentes ou diferentes; sem delta comum.';
      const details = comparison.criteria.map(criterion => {
        const left = comparisonGoalOutcome(criterion.reference_status);
        const right = comparisonGoalOutcome(criterion.alternative_status);
        const delta = criterion.margin_delta == null ? ''
          : ` · Δ folga ${comparisonDeltaText(criterion.margin_delta)}`;
        const basis = criterion.comparable_basis ? '' : ' · critério diferente';
        return `${criterion.id}: ${left} → ${right}${delta}${basis}`;
      });
      const basis = comparison.status === 'COMPARABLE'
        ? 'Mesmo critério e limite' : 'Metas diferentes ou sem base comum';
      return `${basis} · ${details.join('; ')}`;
    }

    function comparisonQualityText(item) {
      const quality = item.quality_comparison;
      if (!quality || quality.reference == null || quality.alternative == null) return presentation().MISSING;
      const reference = presentation().label('quality', quality.reference);
      const alternative = presentation().label('quality', quality.alternative);
      return quality.same ? `Igual à referência · ${alternative}` : `Mudou · ${reference} → ${alternative}`;
    }

    function appendComparisonReading(root, table) {
      const reading = doc.createElement('section');
      reading.className = 'mtm-comparison-reading';
      reading.setAttribute('aria-label', 'Comparação por medida');
      for (const heading of table.querySelectorAll('thead th')) heading.scope = 'col';
      const labels = [...table.querySelectorAll('thead th')].slice(1).map(cell => cell.textContent);
      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = [...row.children];
        const label = cells[0]?.textContent || '';
        if (!/resgate líquido|lucro nominal|recursos no horizonte|patrimônio|prazo de permanência/i.test(label)) continue;
        const section = doc.createElement('section');
        section.append(textElement('h4', label));
        const values = doc.createElement('dl');
        cells.slice(1).forEach((cell, index) => {
          const line = doc.createElement('div');
          line.append(textElement('dt', labels[index] || 'Cenário'), textElement('dd', cell.textContent));
          values.append(line);
        });
        section.append(values); reading.append(section);
      }
      if (reading.childElementCount) root.append(reading);
      const full = doc.createElement('details');
      full.className = 'mtm-comparison-full';
      full.open = !window.matchMedia('(max-width:767px)').matches;
      full.append(textElement('summary', 'Tabela completa e evidências'), table);
      root.append(full);
    }

    function renderComparisonResult() {
      const summary = byId('mtm-compare-result-summary');
      const root = byId('mtm-compare-result-table');
      if (root) root.replaceChildren();
      if (summary) summary.replaceChildren();
      if (!root || !comparisonResult?.result) return;
      const result = comparisonResult.result;
      const items = result.alternatives || [];
      const status = textElement('p', compareStatusText(result), 'mtm-compare-summary');
      const fixedPosition = result.comparison_mode === 'FIXED_POSITION';
      const coverage = textElement('p', result.status === 'ready'
        ? (fixedPosition
          ? `Duas saídas da mesma posição comprada; horizonte comum ${result.ranking?.common_horizon || presentation().MISSING}.`
          : `Avaliação completa · orçamento comum ${formatCurrency(result.common_budget?.value, 2)}.`)
        : 'Cobertura parcial: pelo menos um cenário ou fluxo não foi resolvido completamente.', 'muted');
      summary.append(status, coverage);
      if (fixedPosition) {
        const view = fixedPositionComparisonViewModel(result);
        const position = view.position || {};
        summary.append(textElement('p', view.cash_assumption, 'mtm-compare-premises'));
        summary.append(textElement('p', `Posição preservada: ${formatPtNumber(position.quantity, 2)} título(s); PU de compra ${formatCurrency(position.entry_pu, 4)}; desembolso original ${formatCurrency(position.initial_outflow, 2)}; base fiscal ${formatCurrency(position.tax_cost_basis, 2)} (origem ${position.tax_cost_basis_source || presentation().MISSING}, qualidade ${position.tax_cost_basis_quality || presentation().MISSING}); custo de entrada pago ${formatCurrency(position.entry_expense_paid, 2)}; compra liquidada ${position.purchase_settlement ? surfaceDateLabel(position.purchase_settlement) : presentation().MISSING}.`, 'mtm-compare-premises'));
        summary.append(textElement('p',
          'O lucro líquido mede o resultado desde a compra. A vantagem patrimonial compara os saldos de venda levados ao horizonte comum a partir de cada disponibilidade.', 'muted'));
        if (comparisonResult.identity !== comparisonIdentity()) {
          summary.append(textElement('p', 'Esta tabela pertence a uma configuração anterior. Execute novamente para atualizar.', 'mtm-surface-stale'));
        }
        if (comparisonResult.identity === comparisonIdentity()) {
          summary.append(textElement('p',
            'Explore uma grade direta de taxas e datas para manter separadas as condições de equilíbrio nominal, metas pessoais e vantagem de esperar.', 'muted'));
          const frontierButton = doc.createElement('button');
          frontierButton.type = 'button'; frontierButton.className = 'primary';
          frontierButton.dataset.mtmG4Frontier = 'true';
          frontierButton.textContent = 'Explorar fronteiras por taxa e data';
          summary.append(frontierButton);
        }
        const table = doc.createElement('table');
        table.append(textElement('caption', 'Mesma quantidade e aquisição; lucro e patrimônio no horizonte são medidas distintas.'));
        const head = doc.createElement('thead'), headerRow = doc.createElement('tr');
        headerRow.append(textElement('th', 'Medida'));
        for (const item of items) {
          const th = textElement('th', comparisonContextLabel(item, items)); th.scope = 'col'; headerRow.append(th);
        }
        head.append(headerRow);
        const body = doc.createElement('tbody');
        for (const modelRow of view.rows) {
          const row = doc.createElement('tr'), heading = textElement('th', modelRow.label); heading.scope = 'row'; row.append(heading);
          for (const item of items) {
            const raw = modelRow.values[item.id];
            const value = ['availability', 'sale_order'].includes(modelRow.id)
              ? (raw ? surfaceDateLabel(raw) : presentation().MISSING)
              : modelRow.id === 'quality'
                ? (raw ? surfaceQualityLabel(raw) : presentation().MISSING)
                : modelRow.id === 'sources' ? raw : formatCurrency(raw, 2);
            row.append(textElement('td', value));
          }
          body.append(row);
        }
        table.append(head, body); appendComparisonReading(root, table);
        renderCommonShocks(root);
        return;
      }
      const differentPremises = [...new Set(items.slice(1).flatMap(item => item.differences_from_reference || []))]
        .map(comparisonDifferenceLabel);
      summary.append(textElement('p', differentPremises.length
        ? `Premissas distintas da referência: ${differentPremises.join(' · ')}.`
        : 'Nenhuma dimensão distinta foi identificada nas premissas comparadas.', 'mtm-compare-premises'));
      summary.append(textElement('p',
        'Preço unitário é valor por título e não participa do ranking patrimonial de operações.', 'muted'));
      if (comparisonResult.identity !== comparisonIdentity()) {
        summary.append(textElement('p', 'Esta tabela pertence a uma configuração anterior. Execute novamente para atualizar.', 'mtm-surface-stale'));
      }
      const highlighted = new Set();
      let highlightNote = '';
      if (comparisonHighlight === 'profit' || comparisonHighlight === 'duration') {
        const key = comparisonHighlight === 'profit' ? 'nominal_profit' : 'holding_days';
        const complete = items.length >= 2 && items.every(item => item.status === 'ready'
          && item.operation && item.operation[key] != null);
        const profitDateKeys = ['purchase_order', 'purchase_settlement', 'sale_order', 'sale_settlement'];
        const operationDateBases = items.map(item => profitDateKeys.map(key => item.dates?.[key] || ''));
        const sameProfitDates = comparisonHighlight !== 'profit' || (
          operationDateBases.every(values => values.every(Boolean))
          && new Set(operationDateBases.map(values => values.join('|'))).size === 1
        );
        const usable = complete && sameProfitDates ? items : [];
        if (usable.length) {
          const best = usable.reduce((candidate, item) => {
            const difference = exactDecimalDifference(item.operation[key], candidate.operation[key]);
            if (difference === null || difference === '0') return candidate;
            const better = comparisonHighlight === 'profit' ? !difference.startsWith('-') : difference.startsWith('-');
            return better ? item : candidate;
          });
          const winners = usable.filter(item => comparisonHighlight === 'profit'
            ? exactDecimalDifference(item.operation[key], best.operation[key]) === '0'
            : exactDecimalDifference(item.operation[key], best.operation[key]) === '0');
          winners.forEach(item => highlighted.add(item.id));
          const winnerLabels = winners.map(item => comparisonContextLabel(item, items)).join(', ');
          highlightNote = comparisonHighlight === 'profit'
            ? `Destaque visual escolhido: maior lucro nominal nas mesmas datas e no orçamento comum declarado · ${winnerLabels}. Não é um score nem substitui o ranking patrimonial.`
            : `Destaque visual escolhido: menor prazo · ${winnerLabels}. Não é um score nem substitui o ranking patrimonial.`;
        } else if (comparisonHighlight === 'profit' && !sameProfitDates) {
          highlightNote = 'Destaque indisponível: o lucro nominal só é destacado entre operações completas com as mesmas datas e liquidações de compra e venda.';
        } else highlightNote = 'Destaque indisponível: todos os contextos precisam ter a medida completa para comparar.';
      } else if (comparisonHighlight === 'resilience') {
        const records = items.map(item => [item, stressResultsByContext.get(item.id)
          || [...stressResultsByContext.values()].find(value => value.base_fingerprint && value.base_fingerprint === item.input_fingerprint)]);
        const signatures = new Set(records.map(([, stress]) => stress?.shock_signature).filter(Boolean));
        if (records.length && records.every(([, stress]) => stress?.complete
            && stress.result?.worst_tested_result?.value != null
            && exactDecimalDifference(stress.result.worst_tested_result.value, stress.result.worst_tested_result.value) !== null)
            && signatures.size === 1) {
          const best = records.reduce((winner, pair) => {
            const difference = exactDecimalDifference(
              pair[1].result.worst_tested_result.value, winner[1].result.worst_tested_result.value,
            );
            return difference === null || difference === '0' || difference.startsWith('-') ? winner : pair;
          });
          const winners = records.filter(([, stress]) => exactDecimalDifference(
            stress.result.worst_tested_result.value, best[1].result.worst_tested_result.value,
          ) === '0');
          winners.forEach(([item]) => highlighted.add(item.id));
          highlightNote = `Destaque visual escolhido: maior pior lucro nominal entre testes completos com a mesma lista de choques · ${winners.map(([item]) => comparisonContextLabel(item, items)).join(', ')}. Sem inferir probabilidades.`;
        } else highlightNote = 'Para destacar resistência, teste todos os contextos com a mesma lista de choques e cobertura completa.';
      }
      if (highlightNote) summary.append(textElement('p', highlightNote, 'mtm-compare-highlight-note'));

      const table = doc.createElement('table');
      const caption = textElement('caption', 'Resultados separados por contexto financeiro, sem preencher dados ausentes.');
      const head = doc.createElement('thead'), headerRow = doc.createElement('tr');
      headerRow.append(textElement('th', 'Medida'));
      for (const item of items) {
        const th = textElement('th', comparisonContextLabel(item, items)); th.scope = 'col';
        if (highlighted.has(item.id)) th.classList.add('mtm-compare-highlighted');
        headerRow.append(th);
      }
      head.append(headerRow);
      const body = doc.createElement('tbody');
      const cash = item => item.cash_remainder?.value;
      const total = item => item.total_resources_at_horizon?.value;
      const delta = item => item.comparison_to_reference?.total_resources_delta?.value;
      const realReturn = item => item.operation?.real_return;
      const rows = [
        ['Título / série', item => instrumentLabel({ instrument: item.instrument })],
        ['Estado / qualidade', item => `${stressStatusLabel(item.status)} · ${surfaceQualityLabel(item.quality)}`],
        ['Qualidade vs. referência', comparisonQualityText],
        ['Compra solicitada', item => item.dates?.purchase_order ? surfaceDateLabel(item.dates.purchase_order) : presentation().MISSING],
        ['Venda solicitada', item => item.dates?.sale_order ? surfaceDateLabel(item.dates.sale_order) : presentation().MISSING],
        ['PU de entrada', item => formatCurrency(item.operation?.entry_pu, 4)],
        ['PU de saída', item => formatCurrency(item.operation?.exit_pu, 4)],
        ['Quantidade', item => formatPtNumber(item.operation?.quantity, 4)],
        ['Desembolso inicial', item => formatCurrency(item.operation?.initial_outflow, 2)],
        ['Sobra do orçamento', item => formatCurrency(cash(item), 2)],
        ['Resgate líquido', item => formatCurrency(item.operation?.net_redemption, 2)],
        ['Lucro nominal líquido', item => formatCurrency(item.operation?.nominal_profit, 2)],
        ['Δ lucro nominal vs. referência', item => comparisonDeltaText(item.metric_deltas_from_reference?.nominal_profit)],
        ['Retorno nominal', item => formatRatioPercent(item.operation?.nominal_return, 2)],
        ['Δ retorno nominal vs. referência', item => comparisonDeltaText(item.metric_deltas_from_reference?.nominal_return)],
        ['Retorno real', item => formatRatioPercent(realReturn(item), 2)],
        ['Prazo de permanência', item => presentation().formatDurationDays(item.operation?.holding_days)],
        ['Δ prazo vs. referência', item => comparisonDeltaText(item.metric_deltas_from_reference?.holding_days)],
        ['Metas vs. referência', comparisonGoalsText],
        ['Recursos no horizonte', item => formatCurrency(total(item), 2)],
        ['Diferença patrimonial vs. referência', item => formatCurrency(delta(item), 2)],
        ['Dimensões distintas', item => (item.differences_from_reference || []).map(comparisonDifferenceLabel).join(', ') || 'Nenhuma informada'],
      ];
      for (const [label, value] of rows) {
        const row = doc.createElement('tr'), th = textElement('th', label); th.scope = 'row'; row.append(th);
        for (const item of items) {
          const cell = textElement('td', value(item));
          if (highlighted.has(item.id)) cell.classList.add('mtm-compare-highlighted');
          row.append(cell);
        }
        body.append(row);
      }
      table.append(caption, head, body); appendComparisonReading(root, table);
      renderCommonShocks(root);
    }

    function renderCommonShocks(container) {
      const button = textElement('button', 'Comparar resgates sob choques comuns de taxa', 'subtle');
      button.type = 'button'; button.id = 'mtm-common-shocks-run';
      button.disabled = busy || comparisonResult?.identity !== comparisonIdentity();
      button.addEventListener('click', runCommonShocks);
      container.append(button, textElement('p',
        'Choques de −0,50, 0 e +0,50 p.p. na taxa real de saída de cada cenário. Reprecificações hipotéticas; valores nominais nas próprias datas, sem ranking patrimonial. PU informado sem taxa compatível pode permanecer indisponível.', 'muted'));
      if (!commonShockResult) return;
      if (commonShockResult.identity !== comparisonIdentity()) {
        container.append(textElement('p', 'Curvas de uma comparação anterior; recalcule os choques.', 'mtm-surface-stale'));
        return;
      }
      const models = commonShockViewModel(commonShockResult.records);
      for (const model of models) {
        if (model.excludedPointOverrides.length) {
          const names = { institution_net_brl: 'líquido institucional informado', custody_override_brl: 'custódia pontual informada', institution_release_date: 'data de liberação institucional' };
          container.append(textElement('p', `${model.label}: os choques usam uma nova estimativa. Não reutilizam ${model.excludedPointOverrides.map(key => names[key] || 'ajuste pontual informado').join(', ')}. O choque zero também pode diferir da referência informada.`, 'note'));
        }
      }
      const plot = doc.createElement('div'); plot.className = 'chart'; plot.id = 'mtm-common-shocks-plot';
      plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', 'Resgate líquido de cada cenário sob os mesmos choques');
      container.append(plot);
      const table = doc.createElement('table'); table.id = 'mtm-common-shocks-table';
      table.append(textElement('caption', 'Mesmos pontos do gráfico. Lacunas não são zero; linhas apenas ligam os choques avaliados.'));
      const head = doc.createElement('tr');
      for (const label of ['Cenário', 'Choque na taxa de saída', 'Resgate líquido', 'Estado / qualidade']) head.append(textElement('th', label));
      const thead = doc.createElement('thead'); thead.append(head); table.append(thead);
      const body = doc.createElement('tbody');
      for (const model of models) for (const point of model.points) {
        const row = doc.createElement('tr');
        for (const label of [model.label, `${formatPtNumber(shiftDecimal(point.shock, 2), 2)} p.p.`,
          formatCurrency(point.value, 2), `${stressStatusLabel(point.status)} · ${surfaceQualityLabel(point.quality)}${point.reason ? ` · ${point.reason}` : ''}${point.warnings.length ? ` · ${point.warnings.map(localizeWarning).join(' · ')}` : ''}`]) row.append(textElement('td', label));
        body.append(row);
      }
      table.append(body); container.append(table);
      const plotly = root?.Plotly;
      if (plotly?.react) {
        const traces = models.map(model => ({ type: 'scatter', mode: 'lines+markers', name: model.label,
          x: model.points.map(point => Number(point.shock) * 100),
          y: model.points.map(point => point.value === null ? null : Number(point.value)), connectgaps: false,
          customdata: model.points.map(point => point.value), hovertemplate: '%{x} p.p.<br>R$ %{customdata}<extra>%{fullData.name}</extra>' }));
        try {
          Promise.resolve(plotly.react(plot, traces, { margin: { t: 25, r: 15, b: 65, l: 75 },
            xaxis: { title: 'Choque na taxa real de saída (p.p.)' }, yaxis: { title: 'Resgate líquido nominal (R$)' },
            uirevision: commonShockResult.identity }, { responsive: true, displaylogo: false }))
            .catch(() => { plot.textContent = 'Gráfico indisponível; consulte a tabela dos mesmos pontos.'; });
        } catch (_) { plot.textContent = 'Gráfico indisponível; consulte a tabela dos mesmos pontos.'; }
      } else plot.textContent = 'Gráfico indisponível; consulte a tabela dos mesmos pontos.';
    }

    async function runCommonShocks() {
      if (busy) return;
      const output = byId('mtm-compare-status');
      const identity = comparisonIdentity();
      let requests;
      try { requests = commonShockRequests(makeComparisonRequest()); }
      catch (error) { if (output) output.textContent = error.message; return; }
      const intent = { id: ++intentSequence, action: 'STRESS', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = 'Reprecificando os mesmos choques em cada cenário…';
      try {
        const records = [];
        for (const item of requests) {
          const response = await request('STRESS', 'simulator/workspace', item.payload);
          if (activeIntent !== intent || intent.cancelled || identity !== comparisonIdentity()) return;
          if (!response.accepted || !response.response?.result) throw new Error('Resposta substituída; recalcule os choques.');
          records.push({ id: item.id, label: item.label, result: response.response.result });
        }
        commonShockResult = { identity, records };
        if (output) output.textContent = 'Choques comuns concluídos; a tabela conserva cada estado e ausência.';
      } catch (error) { if (activeIntent === intent && output) output.textContent = `Choques não concluídos. ${error.message}`; }
      finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); renderComparisonResult(); }
      }
    }

    async function runComparison() {
      if (busy) return;
      const output = byId('mtm-compare-status');
      let payload;
      try { payload = makeComparisonRequest(); }
      catch (error) { if (output) output.textContent = error?.message || String(error); return; }
      const identity = comparisonIdentity();
      const intent = { id: ++intentSequence, action: 'COMPARE', cancelled: false };
      activeIntent = intent; setBusy(true); comparisonResult = null; renderComparisonResult();
      if (output) output.textContent = 'Resolvendo e avaliando cada fotografia com as respectivas fontes…';
      try {
        const response = await request('COMPARE', 'simulator/workspace', payload);
        if (activeIntent !== intent) return;
        if (!response.accepted || !response.response?.result) {
          if (output) output.textContent = 'A comparação foi substituída por uma configuração mais recente.';
          return;
        }
        if (identity !== comparisonIdentity()) {
          if (output) output.textContent = 'Os contextos ou o horizonte mudaram durante o cálculo. Execute novamente.';
          return;
        }
        comparisonResult = { result: response.response.result, identity };
        const currentStress = stressResultsByContext.get('current');
        if (currentStress) {
          const matching = (comparisonResult.result.alternatives || []).find(item => item.input_fingerprint === currentStress.base_fingerprint);
          if (matching) stressResultsByContext.set(matching.id, currentStress);
        }
        if (output) output.textContent = response.response.status === 'ready'
          ? 'Comparação concluída.' : 'Comparação parcial; motivos e valores indisponíveis aparecem na tabela.';
        renderComparisonResult();
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `Não foi possível comparar os cenários. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); renderComparisonResult(); }
      }
    }

    async function exploreG4Frontier() {
      if (busy) return;
      const status = byId('mtm-compare-status');
      let comparison;
      let query;
      try {
        comparison = makeComparisonRequest();
        query = g4FrontierRequestFromComparison(comparison, {
          minimumPercent: byId('mtm-surface-rate-min')?.value,
          maximumPercent: byId('mtm-surface-rate-max')?.value,
          stepPercent: byId('mtm-surface-rate-step')?.value,
          metricId: byId('mtm-surface-metric')?.value || 'nominal_profit',
        });
      } catch (error) {
        if (status) status.textContent = error?.message || String(error);
        return;
      }
      const { body: payload, dates, points } = query;
      const identity = comparisonIdentity();
      const intent = { id: ++intentSequence, action: 'SURFACE', cancelled: false };
      activeIntent = intent; setBusy(true);
      const domainFeedback = byId('mtm-surface-domain-feedback');
      if (domainFeedback) domainFeedback.textContent = `${dates.length} datas por ${points} taxas explícitas; máximo G4: 5 datas x 21 taxas, com até 512 avaliações diretas e 10 segundos compartilhados.`;
      if (status) status.textContent = `Calculando grade G4: ${dates.length} data(s) por ${points} taxas diretas.`;
      try {
        const outcome = await request('SURFACE', 'simulator/workspace', payload);
        if (activeIntent !== intent) return;
        if (!outcome.accepted || identity !== comparisonIdentity()) {
          if (status) status.textContent = 'A posição, as premissas ou a revisão mudaram durante a grade. Execute a comparação novamente.';
          surfaceStale = Boolean(currentSurface);
          renderSurface(currentSurface, surfaceStale);
          return;
        }
        const response = outcome.response;
        if (!response?.result || !Array.isArray(response.result.points)) {
          throw new Error('O serviço não retornou os pontos avaliados da grade G4.');
        }
        currentG4FrontierContext = {
          input: cloneJson(payload.input),
          comparison_identity: identity,
          reference_id: payload.fixed_position.reference.id,
        };
        currentSurface = { result: response.result, coverage: response.coverage };
        surfaceStale = false; pendingSurfacePoint = null; activeSurfaceView = 'map';
        renderSurface(currentSurface, false);
        setPending(response.status === 'ready'
          ? `Grade G4 concluída: ${response.result.points.length} pontos avaliados diretamente; fronteiras mostram somente transições observadas em taxas adjacentes.`
          : `Grade G4 parcial: ${response.result.points.length} pontos representados; ausências e cobertura permanecem identificadas.`);
        if (status) status.textContent = 'Grade G4 carregada. Empates, metas sem declaração e pontos indisponíveis mantêm estados distintos.';
      } catch (error) {
        if (activeIntent === intent) {
          if (status) status.textContent = `Não foi possível carregar a grade G4. ${error?.message || ''}`.trim();
          setPending(`A comparação permanece válida; a grade de fronteiras não foi carregada. ${error?.message || ''}`.trim());
        }
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    function stressSourceInput(key) {
      if (key === 'current') {
        if (!lastValidResult || lastValidResult.identity !== resultIdentity()) return null;
        const selection = selectionForCurrentResult();
        const input = selection
          ? inputForSelection(JSON.parse(JSON.stringify(lastValidResult.input)), selection)
          : lastValidResult.input;
        return {
          key, id: 'current', label: 'Cenário atual', input,
          input_fingerprint: lastValidResult.response?.input_fingerprint,
          base_identity: lastValidResult.identity,
        };
      }
      const source = compareScenarioSources().find(item => item.key === key);
      const storedInput = source && frozenInput(source.scenario);
      const selection = source?.scenario?.selection;
      const input = storedInput
        ? (selection?.sale_date ? inputForSelection(JSON.parse(JSON.stringify(storedInput)), selection) : storedInput)
        : null;
      if (!source || !input) return null;
      return {
        key, id: source.key, label: source.label, input,
        input_fingerprint: source.scenario.input_fingerprint, base_identity: null,
      };
    }

    function stressResultContextKey(source) {
      if (!source || source.key !== 'current') return source?.id;
      return (comparisonResult?.result?.alternatives || [])
        .find(item => item.input_fingerprint === source.input_fingerprint)?.id || 'current';
    }

    function ensureStressQuickControls() {
      const section = byId('mtm-stress-mode');
      if (!section) return null;
      let root = byId('mtm-stress-shortcuts');
      if (!root) {
        root = doc.createElement('div');
        root.id = 'mtm-stress-shortcuts';
        root.className = 'mtm-stress-shortcuts';
        const anchor = section.querySelector('.mtm-stress-editor-heading');
        if (anchor) section.insertBefore(root, anchor);
        else section.append(root);
      }
      return root;
    }

    function renderStressQuickControls() {
      const root = ensureStressQuickControls();
      if (!root) return;
      const source = stressSourceInput(stressSource);
      const sourceModel = stressQuickPresetModel(source?.input);
      const blockedSourceReason = source
        ? null
        : 'Indisponível: avalie uma operação completa ou selecione uma referência/alternativa antes de testar.';
      const presets = sourceModel.map(item => blockedSourceReason
        ? { ...item, allowed: false, reason: blockedSourceReason } : item);
      const signature = JSON.stringify({
        source: stressSource, fingerprint: source?.input_fingerprint || source?.base_identity || null,
        presets: presets.map(item => [item.id, item.allowed, item.reason]),
        undo: Boolean(stressShortcutUndo), active: activeStressShortcutId,
      });
      if (root.dataset.signature === signature) return;
      root.dataset.signature = signature;
      root.replaceChildren(
        textElement('h5', 'Atalhos de sensibilidade'),
        textElement('p', 'Cada clique recalcula somente o choque escolhido em uma cópia independente do contexto. Choques anteriores são substituídos; o cenário-base e a referência permanecem intactos.'),
      );
      for (const [group, title] of [['rate', 'Taxa real de saída'], ['inflation', 'Inflação anual']]) {
        const fieldset = doc.createElement('fieldset');
        fieldset.className = 'mtm-stress-shortcut-group';
        fieldset.append(textElement('legend', title));
        const choices = doc.createElement('div');
        choices.className = 'mtm-stress-shortcut-options';
        for (const preset of presets.filter(item => item.group === group)) {
          const option = doc.createElement('div');
          option.className = 'mtm-stress-shortcut-option';
          const button = textElement('button', preset.label);
          button.type = 'button';
          button.className = 'subtle';
          button.dataset.stressShortcut = preset.id;
          button.dataset.stressBlocked = String(!preset.allowed);
          button.disabled = busy || !preset.allowed;
          button.setAttribute('aria-describedby', `mtm-stress-shortcut-reason-${preset.id}`);
          button.addEventListener('click', () => { void applyStressShortcut(preset.id); });
          option.append(button);
          const reason = preset.reason || 'Executa a variação declarada, sem reaproveitar outro choque.';
          const help = textElement('small', reason);
          help.id = `mtm-stress-shortcut-reason-${preset.id}`;
          help.className = preset.allowed ? 'mtm-stress-shortcut-help' : 'mtm-stress-shortcut-help is-blocked';
          option.append(help);
          choices.append(option);
        }
        fieldset.append(choices);
        root.append(fieldset);
      }
      const actions = doc.createElement('div');
      actions.className = 'mtm-stress-shortcut-actions';
      const undo = textElement('button', 'Desfazer último atalho');
      undo.type = 'button'; undo.className = 'subtle'; undo.id = 'mtm-stress-shortcut-undo';
      undo.hidden = !stressShortcutUndo; undo.disabled = busy || !stressShortcutUndo;
      undo.addEventListener('click', undoStressShortcut);
      actions.append(undo);
      root.append(actions);
    }

    async function applyStressShortcut(presetId) {
      if (busy) return;
      const source = stressSourceInput(stressSource);
      const preset = stressQuickPresetModel(source?.input).find(item => item.id === presetId);
      const output = byId('mtm-stress-status');
      if (!source || !preset?.allowed) {
        if (output) output.textContent = preset?.reason || 'Avalie uma operação completa ou selecione um contexto guardado antes de testar.';
        return;
      }
      const contextKey = stressResultContextKey(source);
      stressShortcutUndo = {
        shocks: cloneJson(stressShockDrafts), margins: cloneJson(stressMarginDrafts),
        result: currentStressResult, status: output?.textContent || '', contextKey,
        storedContextResult: stressResultsByContext.get(contextKey),
      };
      activeStressShortcutId = preset.id;
      stressShockDrafts = [{
        label: preset.label, rate: preset.group === 'rate' ? preset.points : '',
        inflation: preset.group === 'inflation' ? preset.points : '', entryCost: '', exitCost: '',
      }];
      stressMarginDrafts = [];
      stressResultsByContext.delete(contextKey);
      currentStressResult = null;
      renderStressShockEditors(); renderStressMarginEditors(); renderStressQuickControls();
      renderStressResults(); renderComparisonResult();
      if (output) output.textContent = `Calculando ${preset.label} em uma cópia de ${source.label}; nenhuma premissa do cenário-base foi alterada.`;
      await runStress();
    }

    function undoStressShortcut() {
      if (busy || !stressShortcutUndo) return;
      const previous = stressShortcutUndo;
      stressShortcutUndo = null; activeStressShortcutId = null;
      stressShockDrafts = previous.shocks; stressMarginDrafts = previous.margins;
      currentStressResult = previous.result;
      if (previous.storedContextResult) stressResultsByContext.set(previous.contextKey, previous.storedContextResult);
      else stressResultsByContext.delete(previous.contextKey);
      renderStressShockEditors(); renderStressMarginEditors(); renderStressQuickControls();
      const output = byId('mtm-stress-status');
      if (output) output.textContent = previous.result
        ? 'Atalho desfeito; a configuração de estresse anterior foi restaurada.'
        : 'Atalho desfeito; o cenário-base e a referência continuam intactos.';
      renderStressResults(); renderComparisonResult(); syncActionState();
    }

    function stressConstraintRows(input) {
      return Array.isArray(input?.constraints) ? input.constraints : [];
    }

    function markStressEdited(message = 'As configurações mudaram. Recalcule os estresses para atualizar o resultado.') {
      stressShortcutUndo = null; activeStressShortcutId = null;
      if (!openingSnapshot) invalidateSnapshotRecalculation();
      if (currentStressResult) currentStressResult.stale = true;
      const status = byId('mtm-stress-status');
      if (status) status.textContent = message;
      renderStressQuickControls();
      renderStressResults();
      syncActionState();
    }

    function stressDimensionLabel(dimension) {
      return ({
        rate_shock_ratio: 'Taxa real de saída (p.p.)',
        annual_inflation_ratio: 'Inflação anual (p.p.)',
        entry_expense_delta_brl: 'Variação do custo fixo de entrada (R$)',
        exit_expense_delta_brl: 'Variação do custo fixo de saída (R$)',
      })[dimension] || dimension;
    }

    function formatStressShock(shock) {
      const parts = [];
      for (const [dimension, value] of Object.entries(shock || {})) {
        if (dimension === 'id') continue;
        const decimal = presentation().decimalInfo(value);
        if (!decimal) continue;
        const signed = decimal.negative ? '− ' : decimal.zero ? '' : '+ ';
        if (dimension === 'rate_shock_ratio' || dimension === 'annual_inflation_ratio') {
          const label = stressDimensionLabel(dimension).replace(/\s*\(p\.p\.\)$/, '');
          parts.push(`${label}: ${signed}${presentation().formatRatioDeltaAsPercentagePoints(decimal.absolute, 2)}`);
        } else if (dimension === 'entry_expense_delta_brl' || dimension === 'exit_expense_delta_brl') {
          const label = stressDimensionLabel(dimension).replace(/\s*\(R\$\)$/, '');
          parts.push(`${label}: ${signed}${presentation().formatCurrency(decimal.absolute, 'BRL', 2)}`);
        }
      }
      return parts.join(' · ') || 'Sem choque';
    }

    function stressScenarioId(label) {
      return String(label || '').trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '').toLowerCase();
    }

    function stressScenarioLabel(id, result, labels) {
      if (id === 'reference') return 'Referência';
      if (labels?.has(id)) return labels.get(id);
      return (result.scenarios || []).find(item => item.id === id)?.label || 'Cenário nomeado';
    }

    function stressStatusLabel(status) {
      return presentation().label('status', status);
    }

    function stressMarginStatusLabel(status) {
      return presentation().label('status', status);
    }

    function riskLimitStatusLabel(status) {
      return presentation().label('status', status);
    }

    function comparisonDifferenceLabel(difference) {
      return ({
        instrument: 'Título ou série', purchase_date: 'Data de compra', sale_date: 'Data de venda',
        entry_price: 'PU de compra', exit_price: 'PU de venda', knowledge: 'Data de referência dos dados',
        intent: 'Finalidade da operação', source_versions: 'Versões das fontes',
        analysis_context: 'Modo e período da análise', constraints: 'Metas e critérios',
        settlement_profile: 'Perfil de liquidação', entry_fee: 'Custos de entrada',
        exit_fee_brl: 'Custo de saída', tax_cost_basis_brl: 'Base de custo tributário',
        inflation_projection: 'Projeção de inflação', explicit_settlements: 'Liquidações informadas',
        'data.index_anchors': 'Âncoras de índice', 'data.price_index_levels': 'Níveis do índice',
        'data.intermediate_paid_costs': 'Custos intermediários', evidence_quality: 'Qualidade da evidência',
      })[difference] || 'Outro parâmetro informado';
    }

    function stressDimensionOptions(select, selected) {
      const dimensions = ['rate_shock_ratio', 'annual_inflation_ratio', 'entry_expense_delta_brl', 'exit_expense_delta_brl'];
      select.replaceChildren(...dimensions.map(value => {
        const option = textElement('option', stressDimensionLabel(value)); option.value = value; return option;
      }));
      select.value = selected;
    }

    function renderStressShockEditors() {
      const root = byId('mtm-stress-shocks');
      if (!root) return;
      root.replaceChildren();
      stressShockDrafts.forEach((draft, index) => {
        const row = doc.createElement('fieldset'); row.className = 'mtm-stress-editor';
        const legend = textElement('legend', `Estresse ${index + 1}`); row.append(legend);
        const nameLabel = textElement('label', 'Nome do cenário');
        const nameInput = doc.createElement('input'); nameInput.type = 'text'; nameInput.maxLength = 120; nameInput.autocomplete = 'off'; nameInput.value = draft.label;
        nameLabel.append(nameInput); row.append(nameLabel);
        const fields = [
          ['rate', 'Choque na taxa real de saída (p.p.)'], ['inflation', 'Choque na inflação anual (p.p.)'],
          ['entryCost', 'Variação do custo de entrada (R$)'], ['exitCost', 'Variação do custo de saída (R$)'],
        ];
        for (const [key, label] of fields) {
          const fieldLabel = textElement('label', label);
          const input = doc.createElement('input'); input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.value = draft[key];
          fieldLabel.append(input); row.append(fieldLabel);
          input.addEventListener('input', () => { draft[key] = input.value; markStressEdited(); });
        }
        nameInput.addEventListener('input', () => { draft.label = nameInput.value; markStressEdited(); });
        const remove = textElement('button', 'Remover estresse'); remove.type = 'button'; remove.className = 'subtle';
        remove.dataset.stressRemove = 'true'; remove.disabled = busy || stressShockDrafts.length <= 1;
        remove.addEventListener('click', () => {
          if (stressShockDrafts.length <= 1) return;
          stressShockDrafts = stressShockDrafts.filter(item => item !== draft);
          renderStressShockEditors(); markStressEdited();
        });
        row.append(remove); root.append(row);
      });
    }

    function renderStressMarginEditors() {
      const root = byId('mtm-stress-margins');
      if (!root) return;
      root.replaceChildren();
      const source = stressSourceInput(stressSource);
      const criteria = stressConstraintRows(source?.input);
      stressMarginDrafts = stressMarginDrafts.slice(0, 4);
      if (!criteria.length) {
        root.append(textElement('p', 'Este contexto não tem limites nomeados para medir folga. Adicione e aplique metas antes de testar a margem.', 'muted'));
        return;
      }
      stressMarginDrafts.forEach((draft, index) => {
        if (!criteria.some(item => item.id === draft.criterion_id)) draft.criterion_id = criteria[0].id;
        const row = doc.createElement('fieldset'); row.className = 'mtm-stress-editor mtm-margin-editor';
        row.append(textElement('legend', `Busca de folga ${index + 1}`));
        const criterionLabel = textElement('label', 'Limite a verificar');
        const criterion = doc.createElement('select');
        criterion.replaceChildren(...criteria.map(item => { const option = textElement('option', `${item.id} · ${CONSTRAINT_METRICS[item.metric]?.label || item.metric}`); option.value = item.id; return option; }));
        criterion.value = draft.criterion_id; criterionLabel.append(criterion); row.append(criterionLabel);
        const dimensionLabel = textElement('label', 'Dimensão da busca');
        const dimension = doc.createElement('select'); stressDimensionOptions(dimension, draft.dimension);
        dimensionLabel.append(dimension); row.append(dimensionLabel);
        const directionLabel = textElement('label', 'Direção');
        const direction = doc.createElement('select');
        for (const [value, label] of [['INCREASE', 'Aumentar'], ['DECREASE', 'Reduzir']]) {
          const option = textElement('option', label); option.value = value; direction.append(option);
        }
        direction.value = draft.direction; directionLabel.append(direction); row.append(directionLabel);
        const maxLabel = textElement('label', `Magnitude máxima · ${stressDimensionLabel(draft.dimension).match(/\(.*\)/)?.[0] || ''}`);
        const maximum = doc.createElement('input'); maximum.type = 'text'; maximum.inputMode = 'decimal'; maximum.autocomplete = 'off'; maximum.value = draft.maximum;
        maxLabel.append(maximum); row.append(maxLabel);
        const resolutionLabel = textElement('label', `Resolução · ${stressDimensionLabel(draft.dimension).match(/\(.*\)/)?.[0] || ''}`);
        const resolution = doc.createElement('input'); resolution.type = 'text'; resolution.inputMode = 'decimal'; resolution.autocomplete = 'off'; resolution.value = draft.resolution;
        resolutionLabel.append(resolution); row.append(resolutionLabel);
        criterion.addEventListener('change', () => { draft.criterion_id = criterion.value; markStressEdited(); });
        dimension.addEventListener('change', () => { draft.dimension = dimension.value; renderStressMarginEditors(); markStressEdited(); });
        direction.addEventListener('change', () => { draft.direction = direction.value; markStressEdited(); });
        maximum.addEventListener('input', () => { draft.maximum = maximum.value; markStressEdited(); });
        resolution.addEventListener('input', () => { draft.resolution = resolution.value; markStressEdited(); });
        const remove = textElement('button', 'Remover busca'); remove.type = 'button'; remove.className = 'subtle';
        remove.addEventListener('click', () => { stressMarginDrafts = stressMarginDrafts.filter(item => item !== draft); renderStressMarginEditors(); markStressEdited(); });
        row.append(remove); root.append(row);
      });
    }

    function parseShockDelta(value, label, asPercentagePoints = false) {
      const raw = String(value || '').trim();
      if (!raw) return null;
      const parsed = parsePtDecimal(raw, label);
      if (parsed === null) throw new TypeError(`${label}: informe um número.`);
      return asPercentagePoints ? shiftDecimal(parsed, -2) : parsed;
    }

    function makeG5StressRequest(source) {
      if (!source || source.key === 'current') {
        throw new TypeError('Selecione a alternativa guardada da posição fixa para executar G5.');
      }
      const comparison = makeComparisonRequest();
      if (comparison.comparison_mode !== 'FIXED_POSITION' || comparison.alternatives?.length !== 1
          || comparison.alternatives[0].id !== source.id) {
        throw new TypeError('G5 exige a referência e a única alternativa fixa selecionada.');
      }
      comparison.alternatives[0].input = JSON.parse(JSON.stringify(source.input));
      return g5StressRequestFromComparison(comparison);
    }

    function makeStressRequest(source) {
      if (!source?.input) throw new TypeError('Selecione um contexto completo para estressar.');
      if (byId('mtm-compare-position-mode')?.value === 'FIXED_POSITION') {
        return makeG5StressRequest(source);
      }
      const shockIds = new Set();
      const shocks = stressShockDrafts.map((draft, index) => {
        const id = draft.id || stressScenarioId(draft.label);
        if (!id) throw new TypeError(`Estresse ${index + 1}: informe um nome com letras ou números.`);
        if (id === 'reference' || shockIds.has(id)) throw new TypeError(`Estresse ${index + 1}: informe um nome distinto dos demais cenários e da referência.`);
        shockIds.add(id);
        const shock = { id };
        const rate = parseShockDelta(draft.rate, 'Choque na taxa', true);
        const inflation = parseShockDelta(draft.inflation, 'Choque na inflação', true);
        const entry = parseShockDelta(draft.entryCost, 'Despesa de entrada');
        const exit = parseShockDelta(draft.exitCost, 'Despesa de saída');
        if (rate !== null) shock.rate_shock_ratio = rate;
        if (inflation !== null) shock.annual_inflation_ratio = inflation;
        if (entry !== null) shock.entry_expense_delta_brl = entry;
        if (exit !== null) shock.exit_expense_delta_brl = exit;
        if (Object.keys(shock).length === 1) throw new TypeError(`Estresse ${index + 1}: informe ao menos uma variação.`);
        return shock;
      });
      const margin_searches = stressMarginDrafts.map((draft, index) => {
        const maximum = parseShockDelta(draft.maximum, 'Magnitude máxima', draft.dimension.endsWith('_ratio'));
        const resolution = parseShockDelta(draft.resolution, 'Resolução', draft.dimension.endsWith('_ratio'));
        if (maximum === null || resolution === null) throw new TypeError(`Busca de folga ${index + 1}: preencha a magnitude e a resolução.`);
        return {
          id: draft.id, criterion_id: draft.criterion_id, dimension: draft.dimension,
          direction: draft.direction, maximum_magnitude: maximum, resolution,
        };
      });
      const input = JSON.parse(JSON.stringify(source.input));
      if (source.key === 'current') {
        const constraints = serializeCriteria(snapshot()?.criteria || []);
        if (constraints.length) input.constraints = constraints;
        else delete input.constraints;
      }
      return {
        schema_version: 2, action: 'STRESS', input, shocks, margin_searches,
        max_evaluations: 4096, deadline_ms: 10000,
      };
    }

    function stressIdentity(source, payload) {
      return JSON.stringify({
        source: source?.key, fingerprint: source?.input_fingerprint,
        input: source?.key === 'current' ? source.base_identity : undefined,
        criteria_revision: snapshot()?.revisions?.criteria_revision,
        shocks: payload.shocks, margins: payload.margin_searches,
        g5_context_identity: g5StressContextIdentity(payload, comparisonIdentity()),
      });
    }

    function stressShiftLabel(value, unit) {
      if (value == null) return presentation().MISSING;
      return unit === 'ratio' ? presentation().formatRatioDeltaAsPercentagePoints(value, 2)
        : formatCurrency(value, 2);
    }

    function signedStressDelta(value, formatter) {
      if (value == null) return presentation().MISSING;
      const decimal = presentation().decimalInfo(value);
      if (!decimal) return presentation().MISSING;
      const sign = decimal.negative ? '− ' : decimal.zero ? '' : '+ ';
      return `${sign}${formatter(decimal.absolute)}`;
    }

    function stressDeltaCurrency(value) {
      return signedStressDelta(value, amount => formatCurrency(amount, 2));
    }

    function stressDeltaReturn(value) {
      return signedStressDelta(value, amount => presentation().formatRatioDeltaAsPercentagePoints(amount, 2));
    }

    function stressDeltaDays(value) {
      if (value == null || !Number.isInteger(Number(value))) return presentation().MISSING;
      const days = Number(value);
      return `${days < 0 ? '− ' : days > 0 ? '+ ' : ''}${formatPtNumber(Math.abs(days), 0)} dias`;
    }

    function g5PointReason(point) {
      const reason = point?.reason;
      if (!reason) return '';
      return [reason.code, reason.message].filter(Boolean).join(': ');
    }

    function renderG5StressResults(summary, root, stored) {
      const view = g5DecisionMarginsViewModel(stored.result);
      if (!view) return false;
      const budget = view.computation_budget || {};
      const coverage = view.coverage || {};
      const nominal = view.margins.nominal_profit_goal;
      const wealth = view.margins.wealth_at_9_percent;
      const statusText = status => g5MarginStatusLabel(status);
      const formatMargin = margin => margin?.margin == null
        ? presentation().MISSING : formatCurrency(margin.margin, 2);
      const fragments = [
        `G5 FIXED_POSITION — cobertura ${view.complete ? 'completa' : 'parcial'}; ${budget.evaluated_points || 0} avaliações diretas de no máximo ${budget.max_evaluations || 64}, execução ${budget.execution || 'serial'}.`,
        'Base manual G3 governa margens, caixa e despesas; taxa, inflação e decomposição usam base explícita de reprecificação.',
        nominal ? `Meta de lucro nominal: ${formatCurrency(nominal.actual_value, 2)} contra ${formatCurrency(nominal.threshold, 2)}; margem ${formatMargin(nominal)} (${statusText(nominal.status)}).` : 'Margem da meta nominal indisponível.',
        wealth ? `Vantagem patrimonial a caixa líquido de 9%: ${formatCurrency(wealth.actual_value, 2)} (${statusText(wealth.status)}).` : 'Vantagem patrimonial a 9% indisponível.',
      ];
      summary.append(textElement('p', fragments.join(' '), 'mtm-compare-summary'));
      summary.append(textElement('p', 'Cada eixo é uma sensibilidade isolada nos pontos diretos declarados. Lacunas permanecem desconhecidas; os eixos não representam cenários conjuntos, probabilidades ou recomendações.', 'muted'));
      renderG5MarginReading(summary, view.margin_reading, view.axes, textElement);

      for (const axis of view.axes) {
        const table = doc.createElement('table');
        const basisLabel = axis.basis_id === G5_BASIS_IDS.repriced ? 'base reprecificada explícita'
          : axis.basis_id === G5_BASIS_IDS.manual ? 'base G3 manual'
            : axis.basis_id || 'base não informada';
        table.append(textElement('caption', `${axis.label} - ${basisLabel}; ${axis.points.length} pontos da grade G5.`));
        const head = doc.createElement('thead'), header = doc.createElement('tr');
        for (const label of ['Ponto', 'Estado', 'Vantagem patrimonial', 'Motivo']) header.append(textElement('th', label));
        head.append(header);
        const body = doc.createElement('tbody');
        for (const point of axis.points) {
          const row = doc.createElement('tr');
          const margin = point.margin?.margin;
          for (const value of [
            g5PointCoordinate(axis, point.coordinate), statusText(point.status),
            margin == null ? presentation().MISSING : formatCurrency(margin, 2),
            g5PointReason(point),
          ]) row.append(textElement('td', value));
          body.append(row);
        }
        table.append(head, body); root.append(table);
      }

      const decomposition = view.decomposition || {};
      const components = decomposition.components || {};
      const displayed = decomposition.displayed || {};
      summary.append(textElement('p',
        `Taxa–inflação 2×2: estado ${decomposition.status || 'indisponível'}; interação ${components.interaction == null ? presentation().MISSING : formatCurrency(components.interaction, 2)}; resíduo exibido ${displayed.observed_rounding_residual == null ? presentation().MISSING : formatCurrency(displayed.observed_rounding_residual, 2)}.`,
        'mtm-compare-summary'));
      const fiscal = view.fiscal_transition || {};
      const bridge = fiscal.bridge || {};
      const tax180 = fiscal.tax_control?.day_180?.income_tax_brl;
      const tax181 = fiscal.tax_control?.day_181?.income_tax_brl;
      summary.append(textElement('p',
        `Transição fiscal 180/181 dias: estado ${fiscal.status || 'indisponível'}; efeito de base ${bridge.tax_base_effect_brl == null ? presentation().MISSING : formatCurrency(bridge.tax_base_effect_brl, 2)}, mudança de alíquota ${bridge.rate_change_benefit_brl == null ? presentation().MISSING : formatCurrency(bridge.rate_change_benefit_brl, 2)}, caixa ${bridge.cash_timing_effect_brl == null ? presentation().MISSING : formatCurrency(bridge.cash_timing_effect_brl, 2)}, resíduo ${bridge.observed_residual_brl == null ? presentation().MISSING : formatCurrency(bridge.observed_residual_brl, 2)}.`,
        'mtm-compare-summary'));
      summary.append(textElement('p',
        `Controle fiscal independente sobre ganho de R$100: IR no dia 180 ${tax180 == null ? presentation().MISSING : formatCurrency(tax180, 2)} e no dia 181 ${tax181 == null ? presentation().MISSING : formatCurrency(tax181, 2)}.`,
        'muted'));

      if (stored.stale || comparisonIdentity() !== stored.identity_comparison
          || stored.identity !== stressIdentity(stored.source, stored.payload)) {
        summary.append(textElement('p', 'Este resultado pertence a uma configuração anterior.', 'mtm-surface-stale'));
      }
      return true;
    }

    function renderStressResults() {
      const summary = byId('mtm-stress-summary');
      const root = byId('mtm-stress-result-table');
      if (summary) summary.replaceChildren();
      if (root) root.replaceChildren();
      const stored = currentStressResult;
      if (!summary || !root || !stored?.result) return;
      const result = stored.result;
      if (renderG5StressResults(summary, root, stored)) return;
      const best = result.best_tested_result;
      const worst = result.worst_tested_result;
      const fragments = [
        `Cobertura ${result.coverage?.complete ? 'completa' : 'parcial'} · ${result.coverage?.evaluated_scenarios || 0} de ${(result.coverage?.requested_scenarios || 0) + 1} operações avaliadas.`,
        `Limite de metas: ${riskLimitStatusLabel(result.risk_limit?.status)}.`,
        best ? `Melhor lucro nominal entre os choques calculados: ${stressScenarioLabel(best.scenario_id, result, stored.labels)} · ${formatCurrency(best.value, 2)}.` : 'Melhor resultado indisponível; nenhum choque calculado tem lucro nominal válido.',
        worst ? `Pior lucro nominal entre os choques calculados: ${stressScenarioLabel(worst.scenario_id, result, stored.labels)} · ${formatCurrency(worst.value, 2)}.` : 'Pior resultado indisponível; nenhum choque calculado tem lucro nominal válido.',
      ];
      summary.append(textElement('p', fragments.join(' '), 'mtm-compare-summary'));
      if (!result.coverage?.complete) summary.append(textElement('p', 'Há cenários inelegíveis, incompletos ou fora do orçamento; eles não contam como perda zero nem como aprovação.', 'mtm-surface-stale'));
      const risk = result.risk_limit || {};
      if (risk.failed_scenarios?.length) summary.append(textElement('p', `Metas que falham: ${risk.failed_scenarios.join(', ')}.`, 'mtm-compare-risk'));
      if (risk.unknown_scenarios?.length) summary.append(textElement('p', `Cenários sem aprovação confirmável: ${risk.unknown_scenarios.join(', ')}.`, 'muted'));
      for (const margin of result.margins || []) {
        const boundary = margin.first_failing
          ? `último aprovado ${stressShiftLabel(margin.last_passing?.shift, margin.unit)}; primeiro reprovado ${stressShiftLabel(margin.first_failing.shift, margin.unit)}`
          : margin.last_passing ? `último tick verificado ${stressShiftLabel(margin.last_passing.shift, margin.unit)}` : 'sem folga demonstrada';
        summary.append(textElement('p', `${margin.criterion_id} · ${stressDimensionLabel(margin.dimension)}: ${stressMarginStatusLabel(margin.status)} · ${boundary}. ${margin.reason || ''}`, 'mtm-compare-margin'));
      }
      if (result.excluded_point_overrides?.length) summary.append(textElement('p', `Overrides de ponto removidos: ${result.excluded_point_overrides.join(', ')}.`, 'muted'));
      const table = doc.createElement('table');
      table.append(textElement('caption', 'A referência e cada choque são avaliações diretas. Deltas são relativos à referência. Melhor/pior considera somente choques nomeados com resultado válido; não representa previsão. Valores ausentes ficam indisponíveis.'));
      const head = doc.createElement('thead'), header = doc.createElement('tr');
      for (const label of ['Cenário', 'Estado', 'Choque', 'Qualidade', 'PU entrada', 'PU saída', 'Resgate líquido', 'Δ resgate vs. referência', 'Lucro nominal', 'Δ lucro vs. referência', 'Retorno nominal', 'Δ retorno nominal vs. referência', 'Prazo', 'Δ prazo vs. referência', 'Retorno real', 'Metas', 'Motivo']) header.append(textElement('th', label));
      head.append(header);
      const body = doc.createElement('tbody');
      const cases = [result.reference, ...(result.scenarios || [])];
      for (const item of cases) {
        const row = doc.createElement('tr');
        const shock = formatStressShock(item.shock);
        const constraints = item.constraints?.criteria || [];
        const goalStatus = item.constraints?.status === 'MET' ? 'Todas atendidas'
          : item.failed_constraint_ids?.length ? `Falha: ${item.failed_constraint_ids.join(', ')}`
            : item.unavailable_constraint_ids?.length ? `Desconhecido: ${item.unavailable_constraint_ids.join(', ')}` : 'Sem metas';
        const reason = item.reason?.message || (item.reason?.code ? 'Motivo não detalhado.' : '');
        const operation = item.operation || {};
        const deltas = item.metric_deltas_from_reference || {};
        const cells = [
          stressScenarioLabel(item.id, result, stored.labels), stressStatusLabel(item.status), shock, surfaceQualityLabel(item.quality),
          formatCurrency(operation.entry_pu, 4),
          formatCurrency(operation.exit_pu, 4),
          formatCurrency(operation.net_redemption, 2),
          item.id === 'reference' ? 'Referência' : stressDeltaCurrency(deltas.net_redemption),
          formatCurrency(operation.nominal_profit, 2),
          item.id === 'reference' ? 'Referência' : stressDeltaCurrency(deltas.nominal_profit),
          formatRatioPercent(operation.nominal_return, 2),
          item.id === 'reference' ? 'Referência' : stressDeltaReturn(deltas.nominal_return),
          operation.holding_days == null ? presentation().MISSING : presentation().formatDurationDays(operation.holding_days),
          item.id === 'reference' ? 'Referência' : stressDeltaDays(deltas.holding_days),
          formatRatioPercent(operation.real_return, 2),
          goalStatus, reason,
        ];
        for (const value of cells) row.append(textElement('td', value));
        body.append(row);
      }
      table.append(head, body); root.append(table);
      if (stored.stale || (stored.source.key === 'current' && stored.source.base_identity !== resultIdentity())
          || stored.identity !== stressIdentity(stored.source, stored.payload)) {
        summary.append(textElement('p', 'Este resultado pertence a uma configuração anterior.', 'mtm-surface-stale'));
      }
    }

    async function runStress() {
      if (busy) return;
      const output = byId('mtm-stress-status');
      const source = stressSourceInput(stressSource);
      let payload;
      try { payload = makeStressRequest(source); }
      catch (error) { if (output) output.textContent = error?.message || String(error); return; }
      const identity = stressIdentity(source, payload);
      const intent = { id: ++intentSequence, action: 'STRESS', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = 'Avaliando a cópia do contexto-base e cada choque; as margens percorrem somente a grade declarada…';
      try {
        const disposition = await handleStressResponse({
          request: request('STRESS', 'simulator/workspace', payload),
          isIntentCurrent: () => activeIntent === intent,
          isContextCurrent: () => identity === stressIdentity(source, payload),
          apply: response => {
            const result = response.response.result;
            const labels = new Map(stressShockDrafts.map(draft => [stressScenarioId(draft.label), draft.label.trim()]));
            currentStressResult = {
              result, identity, source, payload, labels,
              identity_comparison: payload.fixed_position ? comparisonIdentity() : null,
            };
            const signature = JSON.stringify(payload.fixed_position || payload.shocks);
            const rowKey = stressResultContextKey(source);
            stressResultsByContext.set(rowKey, {
              result, shock_signature: signature, base_fingerprint: source.input_fingerprint,
              complete: response.response.status === 'ready' && result.coverage?.complete === true,
            });
            if (output) output.textContent = response.response.status === 'ready'
              ? (payload.fixed_position ? `G5 concluído para ${source.label}.` : `Estresses concluídos para ${source.label}.`)
              : `${payload.fixed_position ? 'G5 parcial' : 'Estresses parciais'} para ${source.label}; a tabela mantém cada lacuna explícita.`;
            renderStressResults(); renderComparisonResult();
          },
        });
        if (disposition.status === 'superseded') return;
        if (disposition.status === 'rejected') {
          if (output) output.textContent = 'O resultado de estresse foi substituído por uma configuração mais recente.';
          return;
        }
        if (disposition.status === 'stale') {
          if (output) output.textContent = 'O contexto ou os choques mudaram durante o cálculo. Execute novamente.';
          return;
        }
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `Não foi possível concluir os estresses. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    function renderLastValidResult() {
      if (!lastValidResult) return false;
      const stale = resultStaleness(lastValidResult);
      renderResolved(lastValidResult.resolved, lastValidResult.response, lastValidResult.confirmedLocalExit,
        stale.financial, lastValidResult.input, stale.goals);
      return true;
    }

    function showLastValidIfStale() {
      if (currentStressResult?.source?.key === 'current'
          && currentStressResult.source.base_identity !== resultIdentity()) {
        currentStressResult.stale = true;
        renderStressResults();
      }
      const stale = resultStaleness(lastValidResult);
      if (!lastValidResult || (!stale.financial && !stale.goals)) return false;
      return renderLastValidResult();
    }

    function setBusy(value) {
      busy = Boolean(value);
      workspaceRoot.setAttribute('aria-busy', String(busy));
      syncActionState();
      syncSurfaceAction();
      updateRateDomainFeedback();
    }

    function copyCatalog() {
      syncTitleHint();
    }

    function marketInstrumentRows() {
      const digest = catalog?.market_sim_active?.market_sim;
      const version = catalog?.versions?.market_sim?.find(item => item.hash === digest);
      return version?.metadata?.instruments || [];
    }

    function catalogSeriesYear(item, family) {
      if (family === 'RENDA_PLUS') {
        const match = String(item?.title_type || '').match(/(\d{4})\s*$/);
        return match ? Number(match[1]) : null;
      }
      const match = String(item?.maturity_date || '').match(/^(\d{4})-/);
      return match ? Number(match[1]) : null;
    }

    function catalogTitle() {
      const family = chosenTitle();
      const year = Number(byId('mtm-workspace-series-year')?.value);
      if (!family || !Number.isInteger(year)) return null;
      return marketInstrumentRows().find(item => item.family === family
        && catalogSeriesYear(item, family) === year) || null;
    }

    function setInstrumentSeriesOptions(raw) {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.RENDA_PLUS)) return false;
      const years = [...new Set(raw.RENDA_PLUS.filter(year => Number.isSafeInteger(year) && year > 0))]
        .sort((left, right) => left - right);
      if (!years.length) return false;
      instrumentSeriesOptions = { ...instrumentSeriesOptions, RENDA_PLUS: years };
      const field = byId('mtm-workspace-series-year');
      if (field) {
        let list = byId('mtm-workspace-series-year-options');
        if (!list) {
          list = doc.createElement('datalist');
          list.id = 'mtm-workspace-series-year-options';
          form.append(list);
        }
        list.replaceChildren(...(chosenTitle() === 'RENDA_PLUS' ? years : []).map(year => {
          const option = doc.createElement('option');
          option.value = String(year);
          return option;
        }));
        field.setAttribute('list', list.id);
      }
      return true;
    }

    function clearUnsupportedRendaYear(family, requestedYear) {
      const supportedYears = instrumentSeriesOptions.RENDA_PLUS || [];
      const field = byId('mtm-workspace-series-year');
      if (family !== 'RENDA_PLUS' || !requestedYear || !field || !supportedYears.length
          || supportedYears.includes(Number(requestedYear))) return false;
      field.value = '';
      syncTitleHint();
      updateDraft();
      return true;
    }

    async function refreshInstrumentSeriesOptions(family) {
      if (!family) return;
      const sequence = ++instrumentOptionsRequestSequence;
      const yearField = byId('mtm-workspace-series-year');
      const requestedYear = yearField?.value.trim() || '';
      const instrument = { family };
      if (/^\d+$/.test(requestedYear)) instrument.series_year = Number(requestedYear);
      try {
        const outcome = await request('RESOLVE', 'simulator/workspace', {
          schema_version: 2, action: 'RESOLVE', input: { instrument },
        });
        if (!outcome.accepted || sequence !== instrumentOptionsRequestSequence
            || chosenTitle() !== family) return;
        const options = outcome.response?.resolved?.instrument_series_options;
        if (!setInstrumentSeriesOptions(options)) return;
        if ((yearField?.value.trim() || '') !== requestedYear) { syncTitleHint(); return; }
        if (!/^\d+$/.test(requestedYear) && requestedYear) {
          yearField.value = '';
          updateDraft();
        }
        // Keep the typed year visible; unsupported choices receive an explicit explanation.
        syncTitleHint();
      } catch (_) {
        // The ordinary RESOLVE action remains authoritative if this advisory
        // lookup is unavailable; do not erase or rewrite the user's selection.
      }
    }

    function syncTitleHint() {
      const hint = byId('mtm-workspace-instrument-hint');
      if (!hint) return;
      const matched = catalogTitle();
      const rendaYears = instrumentSeriesOptions.RENDA_PLUS || [];
      const yearField = byId('mtm-workspace-series-year');
      let picker = byId('mtm-series-picker');
      if (!picker && yearField) {
        const label = doc.createElement('label');
        label.textContent = 'Escolher série compatível';
        picker = doc.createElement('select');picker.id = 'mtm-series-picker';
        picker.setAttribute('aria-describedby','mtm-workspace-instrument-hint');
        label.append(picker);yearField.closest('label').before(label);
        picker.addEventListener('change',()=>{
          if (!picker.value) return;
          yearField.value = picker.value;
          yearField.dispatchEvent(new Event('input',{bubbles:true}));
          yearField.dispatchEvent(new Event('change',{bubbles:true}));
        });
      }
      if (picker) {
        const yearOption=(label,value)=>{const option=doc.createElement('option');option.textContent=label;option.value=String(value);return option;};
        const family=chosenTitle();
        const available=family==='RENDA_PLUS' ? rendaYears : [...new Set(marketInstrumentRows()
          .filter(row=>row.family===family).map(row=>catalogSeriesYear(row,family)).filter(Number.isInteger))].sort((a,b)=>a-b);
        const signature=JSON.stringify([family,available]);
        if(picker.dataset.catalog!==signature){
          picker.replaceChildren(yearOption(available.length?'Selecione uma série':'Nenhuma série no catálogo local',''));
          for(const year of available)picker.append(yearOption(`${family==='RENDA_PLUS'?'RendA+':'IPCA+ Principal'} ${year}`,year));
          picker.dataset.catalog=signature;
        }
        picker.value=available.includes(Number(yearField.value))?yearField.value:'';
        const list=byId('mtm-workspace-series-year-options');
        if(list)list.replaceChildren(...available.map(year=>yearOption(String(year),year)));
      }
      hint.textContent = matched
        ? 'Série exata encontrada no catálogo local. Datas e identificação vêm do registro importado.'
        : chosenTitle() === 'RENDA_PLUS'
          ? rendaYears.length
            ? `Ano de início da renda. Séries suportadas pelo perfil: ${rendaYears.join(', ')}; o servidor resolve o calendário das parcelas.`
            : 'Ano de início da renda. As séries disponíveis são carregadas do perfil do servidor ao selecionar RendA+.'
          : 'O seletor lista séries do catálogo local. Sem catálogo, informe o ano para uma hipótese de IPCA+ Principal; isso não comprova oferta ou preço disponível. O dia e o mês são resolvidos pelo motor.';
      const yearError=unsupportedRendaYearMessage(chosenTitle(),byId('mtm-workspace-series-year')?.value,rendaYears);
      if(yearError)hint.textContent=yearError;
    }

    function syncLegacyTitle() {
      const family = chosenTitle();
      const familyChanged = family !== lastSelectedFamily;
      lastSelectedFamily = family;
      syncTitleHint();
      updateDraft();
      if (familyChanged) void refreshInstrumentSeriesOptions(family);
    }

    function updateRendaFields() {
      syncTitleHint();
    }

    function syncDatesToLegacy() {
      const pairs = [['mtm-workspace-purchase-date', 'mtm-entry-order'], ['mtm-workspace-sale-date', 'mtm-exit-order']];
      for (const [newId, oldId] of pairs) {
        const current = byId(newId), old = byId(oldId);
        if (current && old && current.value !== old.value) {
          old.value = current.value;
          old.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    function indexLevelRowsFromForm() {
      const list = byId('mtm-workspace-index-levels');
      if (!list) return [];
      return [...list.querySelectorAll('[data-mtm-index-level-row]')].map(row => {
        const date = row.querySelector('[data-index-level-field="date"]')?.value || '';
        const value = row.querySelector('[data-index-level-field="value"]')?.value || '';
        const sourceRef = row.querySelector('[data-index-level-field="source"]')?.value || '';
        const item = { date, value, source_ref: sourceRef };
        if (row.dataset.originalDate === date
            && row.dataset.originalSource === sourceRef.trim()
            && sameDecimalValue(value, row.dataset.originalValue)
            && row.dataset.provenance) {
          try { item.provenance = JSON.parse(row.dataset.provenance); } catch (_) { /* discard invalid hidden metadata */ }
        }
        return item;
      });
    }

    function renderIndexLevelRows(levels = []) {
      const list = byId('mtm-workspace-index-levels');
      if (!list) return;
      list.replaceChildren();
      if (!Array.isArray(levels) || !levels.length) {
        const empty = doc.createElement('p');
        empty.className = 'mtm-index-level-empty';
        empty.textContent = 'Nenhum nível do índice informado. Retorno real e metas reais podem ficar sem dado.';
        list.append(empty);
        return;
      }
      levels.forEach((level, index) => {
        const row = doc.createElement('div');
        row.className = 'mtm-index-level-row';
        row.dataset.mtmIndexLevelRow = 'true';
        const date = String(level?.date || '');
        const value = String(level?.value ?? '');
        const sourceRef = String(level?.source_ref || '');
        row.dataset.originalDate = date;
        row.dataset.originalValue = value;
        row.dataset.originalSource = sourceRef.trim();
        if (level?.provenance && typeof level.provenance === 'object') row.dataset.provenance = JSON.stringify(level.provenance);

        const dateLabel = doc.createElement('label');
        dateLabel.textContent = `Data de referência ${index + 1}`;
        const dateInput = doc.createElement('input');
        dateInput.type = 'date'; dateInput.value = date; dateInput.dataset.indexLevelField = 'date';
        dateInput.setAttribute('aria-label', dateLabel.textContent); dateLabel.append(dateInput);

        const valueLabel = doc.createElement('label');
        valueLabel.textContent = `Nível do índice ${index + 1}`;
        const valueInput = doc.createElement('input');
        valueInput.type = 'text'; valueInput.inputMode = 'decimal'; valueInput.autocomplete = 'off';
        valueInput.value = value ? formatPtNumber(value, -1) : '';
        valueInput.placeholder = 'Ex.: 1.234,5678'; valueInput.dataset.indexLevelField = 'value';
        valueInput.setAttribute('aria-label', valueLabel.textContent); valueLabel.append(valueInput);

        const sourceLabel = doc.createElement('label');
        sourceLabel.textContent = `Referência da fonte ${index + 1}`;
        const sourceInput = doc.createElement('input');
        sourceInput.type = 'text'; sourceInput.maxLength = 512; sourceInput.autocomplete = 'off';
        sourceInput.value = sourceRef; sourceInput.placeholder = 'Ex.: tabela oficial · data de consulta';
        sourceInput.dataset.indexLevelField = 'source';
        sourceInput.setAttribute('aria-label', sourceLabel.textContent); sourceLabel.append(sourceInput);

        const remove = doc.createElement('button');
        remove.type = 'button'; remove.className = 'subtle';
        remove.textContent = 'Remover'; remove.setAttribute('aria-label', `Remover nível do índice ${index + 1}`);
        remove.addEventListener('click', () => {
          const next = indexLevelRowsFromForm().filter((_, rowIndex) => rowIndex !== index);
          renderIndexLevelRows(next); updateDraft();
        });
        for (const control of [dateInput, valueInput, sourceInput]) {
          control.addEventListener('input', updateDraft);
          control.addEventListener('change', updateDraft);
        }
        row.append(dateLabel, valueLabel, sourceLabel, remove);
        list.append(row);
      });
    }

    function updateDraft() {
      syncCostSummary();
      const raw = {};
      for (const id of [
        'mtm-workspace-instrument', 'mtm-budget-value', 'mtm-quantity-value',
        'mtm-workspace-purchase-date', 'mtm-workspace-sale-date', 'mtm-workspace-window-start',
        'mtm-workspace-window-end', 'mtm-workspace-series-year',
        'mtm-workspace-buy-rate', 'mtm-workspace-sell-rate',
        'mtm-workspace-entry-pu', 'mtm-workspace-exit-pu',
        'mtm-workspace-entry-pu-source', 'mtm-workspace-exit-pu-source',
        'mtm-workspace-buy-anchor', 'mtm-workspace-sell-anchor',
        'mtm-workspace-inflation-rate', 'mtm-workspace-future-inflation-rate', 'mtm-workspace-inflation-end-date', 'mtm-workspace-anchor-source',
        'mtm-workspace-settlement', 'mtm-workspace-entry-fee',
        'mtm-workspace-entry-rate', 'mtm-workspace-exit-fee', 'mtm-workspace-knowledge-date',
        'mtm-workspace-custody-actual', 'mtm-workspace-institution-net',
        'mtm-workspace-evidence-mode',
      ]) {
        const control = byId(id);
        if (control) raw[id] = control.type === 'checkbox' ? control.checked : control.value;
      }
      raw['mtm-workspace-index-levels'] = indexLevelRowsFromForm();
      const mode = form.querySelector('input[name="capital-mode"]:checked');
      raw.capital_mode = mode ? mode.value : 'BUDGET';
      raw.entry_price_mode = form.querySelector('input[name="entry-price-mode"]:checked')?.value || 'RATE';
      raw.exit_price_mode = byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY';
      raw.result_mode = form.querySelector('input[name="result-mode"]:checked')?.value || 'OPERATION';
      raw.timeline_mode = form.querySelector('input[name="timeline-mode"]:checked')?.value || 'POINT';
      const previousRaw = latestDraft.ui_form || {};
      const signature = JSON.stringify(raw);
      const initializing = draftSignature === null;
      const changed = !initializing && signature !== draftSignature;
      const changedField = changed ? Object.keys(raw).find(key => JSON.stringify(raw[key]) !== JSON.stringify(previousRaw[key])) : null;
      if (changed) {
        if (activeIntent?.action === 'GROSS_DV01') cancelCurrentIntent();
        else cancelAction('GROSS_DV01');
        baseContext = null;
        if (['mtm-workspace-instrument', 'mtm-workspace-series-year', 'mtm-workspace-purchase-date',
          'mtm-workspace-sale-date', 'mtm-workspace-settlement'].includes(changedField)) lastDateResolution = null;
        if (!openingSnapshot && openedWorkspaceInput) {
          openedFormTouched = true;
          if (changedField) openedChangedFields.add(changedField);
          invalidateSnapshotRecalculation();
        }
        if (!openingSnapshot && snapshot()?.selection && changedField) {
          dispatch({ type: 'CLEAR_SELECTION', undo_group: `ui_form:${changedField}` });
        }
        resolvedInputJson = null;
        resolvedExitValue = null;
        resolvedSaleDate = null;
        pendingResolution = null;
        if (confirmResolved) confirmResolved.hidden = true;
        if (!preserveErrorFeedbackDuringDraft) clearErrorFeedback();
        if (currentSurface) {
          surfaceStale = true;
          renderSurface(currentSurface, true);
        }
        if (unitPriceResult) renderUnitPriceResult(unitPriceResult, true);
      }
      draftSignature = signature;
      if (initializing) {
        dispatch({ type: 'INITIALIZE_DRAFT', draft: { ui_form: raw } });
        latestDraft = { ...latestDraft, ui_form: raw };
      } else observeDraft('ui_form', raw, changedField ? `ui_form:${changedField}` : null);
      renderAlternativeDifferences(raw);
      if (changed) showLastValidIfStale();
      syncAnalysisModeVisibility();
      syncActionState();
    }

    function chosenTitle() {
      return visibleSelect?.value || '';
    }

    function syncCostSummary() {
      const summary = byId('mtm-workspace-cost-summary');
      if (!summary) return;
      const fixed = byId('mtm-workspace-entry-fee')?.value.trim() || '0';
      const rate = byId('mtm-workspace-entry-rate')?.value.trim() || '0';
      const exit = byId('mtm-workspace-exit-fee')?.value.trim() || '0';
      const zero = value => /^0+(?:[,.]0+)?$/.test(value);
      summary.textContent = [fixed, rate, exit].every(zero)
        ? 'Custos da instituição: R$ 0,00 por hipótese inicial. Tributos e custódia seguem as regras do motor. Ajuste os custos se sua instituição cobrar.'
        : `Custos informados: entrada fixa R$ ${fixed}; entrada proporcional ${rate}%; saída R$ ${exit}. Tributos e custódia seguem as regras do motor.`;
    }

    function makeInstrument() {
      const family = chosenTitle();
      const yearRaw = byId('mtm-workspace-series-year')?.value || '';
      if (!family) return null;
      if (!yearRaw) return { family };
      const year = Number(yearRaw);
      if (!Number.isInteger(year) || year < 1900 || year > 9979) throw new TypeError('Informe um ano válido do título.');
      const opened = openedWorkspaceInput?.instrument;
      const openedYear = opened?.family === 'RENDA_PLUS'
        ? Number(opened.conversion_date?.slice(0, 4) || opened.series_year)
        : Number(opened?.maturity_date?.slice(0, 4) || opened?.series_year);
      if (opened && opened.family === family && openedYear === year
          && !openedChangedFields.has('mtm-workspace-instrument')
          && !openedChangedFields.has('mtm-workspace-series-year')) return cloneJson(opened);
      const title = catalogTitle();
      if (title) {
        return { family, series_year: year };
      }
      return { family, series_year: year };
    }

    function localPriceQuote(side, date) {
      if (!catalogTitle() || !catalog?.market_sim_active?.market_sim || !date) return null;
      return {
        mode: 'AUTO_LOCAL', dataset_kind: 'market_sim', version_hash: catalog.market_sim_active.market_sim,
        observation_date: date, quoted_side: side === 'entry' ? 'BUY' : 'SELL',
      };
    }

    function syncPriceModeVisibility() {
      const entryMode = form.querySelector('input[name="entry-price-mode"]:checked')?.value || 'RATE';
      const exitMode = byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY';
      const visibility = priceFieldVisibility(entryMode, exitMode);
      const entryRate = byId('mtm-workspace-entry-rate-wrap');
      const entryPu = byId('mtm-workspace-entry-pu-wrap');
      const exitRate = byId('mtm-workspace-exit-rate-wrap');
      const exitPu = byId('mtm-workspace-exit-pu-wrap');
      if (entryRate) entryRate.hidden = visibility.entryRate;
      if (entryPu) entryPu.hidden = visibility.entryPu;
      if (exitRate) exitRate.hidden = visibility.exitRate;
      if (exitPu) exitPu.hidden = visibility.exitPu;
    }

    function activatePriceMode(side, mode) {
      if (side === 'entry') {
        let changed = false;
        for (const radio of form.querySelectorAll('input[name="entry-price-mode"]')) {
          const checked = radio.value === mode;
          if (radio.checked !== checked) changed = true;
          radio.checked = checked;
        }
        syncPriceModeVisibility();
        return changed;
      }
      const select = byId('mtm-workspace-exit-price-mode');
      if (!select) return false;
      const changed = select.value !== mode;
      select.value = mode;
      syncPriceModeVisibility();
      byId('mtm-workspace-price-details').open = true;
      return changed;
    }

    function priceSelection(side, date, quality = 'INFORMED') {
      const entryMode = form.querySelector('input[name="entry-price-mode"]:checked')?.value || 'RATE';
      const exitMode = byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY';
      if (side === 'entry') return serializePriceChoice({
        side, mode: entryMode,
        rate: byId('mtm-workspace-buy-rate')?.value || '',
        pu: byId('mtm-workspace-entry-pu')?.value || '',
        sourceRef: byId('mtm-workspace-entry-pu-source')?.value || '',
        quality,
        localQuote: localPriceQuote(side, date),
      });
      return serializePriceChoice({
        side, mode: exitMode,
        rate: byId('mtm-workspace-sell-rate')?.value || '',
        pu: byId('mtm-workspace-exit-pu')?.value || '',
        sourceRef: byId('mtm-workspace-exit-pu-source')?.value || '',
        quality,
        entryMode,
        entryRate: byId('mtm-workspace-buy-rate')?.value || '',
        entryPu: byId('mtm-workspace-entry-pu')?.value || '',
      });
    }

    function sameEntryPu(pu) { return sameEntryPuSelection(pu); }

    function selectedAnalysisModes() {
      const resultMode = form.querySelector('input[name="result-mode"]:checked')?.value === 'UNIT_PRICE'
        ? 'UNIT_PRICE' : 'OPERATION';
      const timelineMode = form.querySelector('input[name="timeline-mode"]:checked')?.value === 'WINDOW'
        ? 'WINDOW' : 'POINT';
      return { resultMode, timelineMode };
    }

    function syncAnalysisModeVisibility() {
      const { resultMode, timelineMode } = selectedAnalysisModes();
      const visibility = analysisFieldVisibility(resultMode, timelineMode);
      const unitMode = resultMode === 'UNIT_PRICE';
      for (const [id, text] of [
        ['mtm-purchase-group-title', unitMode ? 'Referência de preço' : 'Compra'],
        ['mtm-entry-pu-label', unitMode ? 'PU de referência (R$/título)' : 'PU de compra (R$/título)'],
        ['mtm-entry-pu-source-label', unitMode ? 'Fonte do PU de referência (opcional)' : 'Fonte do PU de compra (opcional)'],
        ['mtm-purchase-date-label', unitMode ? 'Data de referência' : 'Data da compra'],
        ['mtm-entry-price-legend', unitMode ? 'Preço de referência' : 'Preço de compra'],
        ['mtm-entry-rate-label', unitMode ? 'IPCA + taxa de referência (% a.a.)' : 'Taxa contratada: IPCA + (% a.a.)'],
        ['mtm-series-year-label', chosenTitle() === 'RENDA_PLUS' ? 'Ano de início da renda' : 'Ano do vencimento'],
      ]) if (byId(id)) byId(id).textContent = text;
      const exitHypothesis = byId('mtm-exit-hypothesis');
      if (exitHypothesis) {
        exitHypothesis.hidden = unitMode;
        const exitMode = byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY';
        const entryMode = form.querySelector('[name="entry-price-mode"]:checked')?.value || 'RATE';
        exitHypothesis.textContent = timelineMode === 'WINDOW'
          ? 'Condição inicial do período: taxa ou PU de compra mantidos como hipótese. Selecione um ponto para avaliar.'
          : exitMode === 'SAME_ENTRY'
            ? (entryMode === 'PU' ? 'Hipótese de saída: mesmo PU de compra, sem inferir taxa de venda.' : 'Hipótese de saída: mesma taxa real de compra; o PU é recalculado para a data de venda.')
            : exitMode === 'RATE' ? 'Condição de saída: taxa real de venda informada por você.' : 'Condição de saída: PU de venda informado por você.';
      }
      const setHidden = (id, hidden) => { const node = byId(id); if (node) node.hidden = hidden; };
      const analysisGuidance = byId('mtm-analysis-mode')?.querySelector('p');
      if (analysisGuidance) analysisGuidance.textContent = unitPriceGoalGuidance(resultMode);
      setHidden('mtm-timeline-mode', !visibility.timeline);
      setHidden('mtm-window-fields', !visibility.window);
      setHidden('mtm-capital-field', !visibility.capital);
      setHidden('mtm-workspace-sale-date-wrap', !visibility.saleDate);
      setHidden('mtm-workspace-price-details', !visibility.exitPrice);
      setHidden('mtm-workspace-cost-details', !visibility.operationCosts);
      setHidden('mtm-workspace-cost-summary', !visibility.operationCosts);
      const pendingCount = (pendingBlocking?.childElementCount || 0) + (pendingOptionalItems?.childElementCount || 0);
      if (resultMode === 'UNIT_PRICE') pendingPanel.hidden = true;
      else pendingPanel.hidden = pendingCount === 0;
      setHidden('mtm-workspace-money', !visibility.operationResults || byId('mtm-workspace-money')?.childElementCount === 0);
      setHidden('mtm-workspace-assumptions-used', !visibility.operationResults || byId('mtm-workspace-assumptions-used')?.childElementCount === 0);
      setHidden('mtm-tablist', !visibility.operationResults);
      setHidden('mtm-alternative-save-status', !visibility.operationResults);
      const activeTab = workspaceRoot.querySelector('[data-mtm-tab][aria-selected="true"]')?.dataset.mtmTab || 'map';
      for (const panel of workspaceRoot.querySelectorAll('[data-mtm-panel]')) {
        panel.hidden = !visibility.operationResults || panel.dataset.mtmPanel !== activeTab;
      }
      const unitResults = byId('mtm-unit-price-results');
      if (unitResults) unitResults.hidden = !visibility.unitPriceResults || !unitPriceResult;
      const unitAssumptions = byId('mtm-unit-price-assumptions-used');
      if (unitAssumptions) unitAssumptions.hidden = !visibility.unitPriceResults || !unitPriceResult;
      const futureInflation = byId('mtm-workspace-future-inflation-rate')?.closest('label');
      if (futureInflation) futureInflation.hidden = resultMode === 'UNIT_PRICE' || timelineMode === 'WINDOW';
      const submitButton = byId('mtm-workspace-submit');
      if (submitButton) {
        const staleOperation = resultMode === 'OPERATION' && lastValidResult
          && resultStaleness(lastValidResult).financial;
        const staleUnitPrice = resultMode === 'UNIT_PRICE' && unitPriceResultStale;
        submitButton.textContent = workspaceResultActionLabel(
          resultMode, timelineMode, Boolean(staleOperation || staleUnitPrice));
      }
      const eyebrow = byId('mtm-output-eyebrow');
      if (eyebrow) eyebrow.textContent = resultMode === 'UNIT_PRICE' ? 'PREÇO POR TÍTULO' : 'RESUMO DA ANÁLISE';
      if (resultMode === 'UNIT_PRICE' && !unitPriceResult) {
        if (byId('mtm-output-context')) byId('mtm-output-context').textContent = '';
        byId('mtm-output-title').textContent = 'Preço por título';
        byId('mtm-workspace-summary').textContent = 'Informe título, data e taxa real de compra ou PU para calcular o preço de um título, sem capital ou resultado patrimonial.';
        byId('mtm-workspace-quality').textContent = 'Aguardando cálculo';
      } else if (resultMode === 'OPERATION' && !lastValidResult && !currentSurface) {
        byId('mtm-output-title').textContent = timelineMode === 'WINDOW' ? 'Período a explorar' : 'Aguardando os dados mínimos';
        byId('mtm-workspace-summary').textContent = timelineMode === 'WINDOW'
          ? 'Escolha um início e fim. A análise mantém a taxa real de compra ou o PU de compra constante ao longo do período como hipótese explícita.'
          : 'Escolha uma data para avaliar o resultado do investimento. A data e o preço de saída seguem a premissa informada.';
        byId('mtm-workspace-quality').textContent = 'Aguardando cálculo';
      }
      const unitLink = byId('mtm-unit-price-link');
      if (unitLink) unitLink.hidden = resultMode === 'UNIT_PRICE';
      renderFormatErrors();
    }

    function makeInput() {
      const { resultMode, timelineMode: selectedTimelineMode } = selectedAnalysisModes();
      const isUnitPrice = resultMode === 'UNIT_PRICE';
      const isWindow = !isUnitPrice && selectedTimelineMode === 'WINDOW';
      const timelineMode = isUnitPrice ? 'POINT' : selectedTimelineMode;
      const mode = form.querySelector('input[name="capital-mode"]:checked')?.value || 'BUDGET';
      const capitalRaw = byId(mode === 'BUDGET' ? 'mtm-budget-value' : 'mtm-quantity-value')?.value || '';
      const capitalValue = isUnitPrice || !capitalRaw.trim()
        ? null : parsePtDecimal(capitalRaw, mode === 'BUDGET' ? 'Orçamento' : 'Quantidade');
      if (!isUnitPrice && capitalValue !== null && (capitalValue.startsWith('-') || /^0(?:\.0+)?$/.test(capitalValue))) throw new TypeError('Capital precisa ser maior que zero.');
      const purchaseDate = byId('mtm-workspace-purchase-date')?.value || '';
      const saleDate = isUnitPrice || isWindow ? '' : (byId('mtm-workspace-sale-date')?.value || '');
      const windowStart = isWindow ? (byId('mtm-workspace-window-start')?.value || '') : '';
      const windowEnd = isWindow ? (byId('mtm-workspace-window-end')?.value || '') : '';
      if (!isUnitPrice && !isWindow && purchaseDate && saleDate && saleDate <= purchaseDate) throw new TypeError('A data de venda precisa ser posterior à data de compra.');
      const knowledgeDate = byId('mtm-workspace-knowledge-date')?.value || localISODate();
      const future = [purchaseDate, saleDate, windowEnd].some(day => day && day > knowledgeDate);
      const entryDate = purchaseDate || null, exitDate = saleDate || null;
      const priceQuality = future || isWindow ? 'HYPOTHETICAL' : 'INFORMED';
      const entryPrice = priceSelection('entry', entryDate, priceQuality);
      const exitPrice = isUnitPrice || isWindow ? null : priceSelection('exit', exitDate, priceQuality);
      const inferredExit = !isUnitPrice && !isWindow
        && (byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY') === 'SAME_ENTRY';
      const assumptions = { settlement_profile: byId('mtm-workspace-settlement')?.value || 'SIMULATED_BUY_D1_SELL_D1' };
      if (!isUnitPrice) {
        const fixedRaw = byId('mtm-workspace-entry-fee')?.value || '';
        const rateRaw = byId('mtm-workspace-entry-rate')?.value || '';
        const exitRaw = byId('mtm-workspace-exit-fee')?.value || '';
        const fixed = fixedRaw.trim() ? parsePtDecimal(fixedRaw, 'Custo fixo de entrada') : '0';
        const percent = rateRaw.trim() ? parsePtDecimal(rateRaw, 'Custo proporcional de entrada') : '0';
        const exitFee = exitRaw.trim() ? parsePtDecimal(exitRaw, 'Custo de saída') : '0';
        if ([fixed, percent, exitFee].some(value => value.startsWith('-'))) throw new TypeError('Custos não podem ser negativos.');
        assumptions.entry_fee = { fixed_brl: fixed, proportional_rate: shiftDecimal(percent, -2) };
        assumptions.exit_fee_brl = exitFee;
        const custodyRaw = byId('mtm-workspace-custody-actual')?.value.trim() || '';
        const netRaw = byId('mtm-workspace-institution-net')?.value.trim() || '';
        if (custodyRaw) assumptions.custody_override_brl = parsePtDecimal(custodyRaw, 'Custódia cobrada');
        if (netRaw) assumptions.institution_net_brl = parsePtDecimal(netRaw, 'Resgate líquido informado');
        if ([assumptions.custody_override_brl, assumptions.institution_net_brl].some(value => value?.startsWith('-'))) {
          throw new TypeError('Valores da instituição não podem ser negativos.');
        }
        if (netRaw && (custodyRaw || !/^0(?:\.0+)?$/.test(exitFee))) {
          throw new TypeError('O líquido informado já inclui deduções. Limpe a custódia e zere o custo de saída.');
        }
      }
      const versions = sourceVersionsOverride
        ? { market_sim: sourceVersionsOverride.market_sim ?? null, market_sim_indexes: sourceVersionsOverride.market_sim_indexes ?? null }
        : {
          market_sim: catalog?.market_sim_active?.market_sim || null,
          market_sim_indexes: catalog?.market_sim_active?.market_sim_indexes || null,
        };
      const input = {
        ...(!isUnitPrice ? { capital: { mode, ...(capitalValue === null ? {} : { value: capitalValue }) } } : {}),
        knowledge: { date: knowledgeDate, mode: byId('mtm-workspace-evidence-mode')?.value || 'CAUSAL' },
        intent: isWindow || future || inferredExit ? 'HYPOTHETICAL' : 'HISTORICAL_REVIEW',
        assumptions,
        source_versions: versions,
        analysis_context: analysisContextForForm(resultMode, timelineMode, windowStart, windowEnd),
      };
      const indexLevels = normalizePriceIndexLevelRows(indexLevelRowsFromForm());
      const inheritedData = openedWorkspaceInput?.data && typeof openedWorkspaceInput.data === 'object'
        ? cloneJson(openedWorkspaceInput.data) : {};
      const originalAnchorForm = openedWorkspaceInput ? inputToFormRaw(openedWorkspaceInput) : null;
      const anchorsUnchanged = originalAnchorForm
        && ['mtm-workspace-buy-anchor', 'mtm-workspace-sell-anchor', 'mtm-workspace-anchor-source']
          .every(id => String(byId(id)?.value || '') === String(originalAnchorForm[id] || ''))
        && !['mtm-workspace-instrument', 'mtm-workspace-series-year',
          'mtm-workspace-purchase-date', 'mtm-workspace-sale-date', 'mtm-workspace-settlement']
          .some(id => openedChangedFields.has(id));
      // Original snapshots retain their recorded values; every new calculation uses monthly IPCA.
      delete inheritedData.index_anchors;
      if ((isUnitPrice || isWindow) && lastDateResolution?.purchase?.settlement_date
          && Array.isArray(inheritedData.index_anchors)) {
        inheritedData.index_anchors = inheritedData.index_anchors.filter(anchor =>
          anchor.reference_date === lastDateResolution.purchase.settlement_date);
        if (!inheritedData.index_anchors.length) delete inheritedData.index_anchors;
      }
      const anchorSource = byId('mtm-workspace-anchor-source')?.value.trim()
        || 'Valor informado pelo usuário, sem fonte externa verificada';
      const inflationRaw = byId('mtm-workspace-inflation-rate')?.value.trim() || '';
      const futureInflationRaw = byId('mtm-workspace-future-inflation-rate')?.value.trim() || '';
      const activeFutureInflationRaw = isUnitPrice || isWindow ? '' : futureInflationRaw;
      if (activeFutureInflationRaw && !inflationRaw) throw new TypeError('Informe o IPCA inicial para interpolar até o IPCA futuro.');
      const projectionUnchanged = anchorsUnchanged && originalAnchorForm
        && inflationRaw === String(originalAnchorForm['mtm-workspace-inflation-rate'] || '')
        && activeFutureInflationRaw === String(originalAnchorForm['mtm-workspace-future-inflation-rate'] || '')
        && (byId('mtm-workspace-inflation-end-date')?.value || '') === String(originalAnchorForm['mtm-workspace-inflation-end-date'] || '');
      if (projectionUnchanged && openedWorkspaceInput?.assumptions?.inflation_projection) {
        assumptions.inflation_projection = cloneJson(openedWorkspaceInput.assumptions.inflation_projection);
      } else if (inflationRaw && lastDateResolution?.purchase?.settlement_date) {
        const endDate = activeFutureInflationRaw
          ? byId('mtm-workspace-inflation-end-date')?.value || lastDateResolution?.sale?.settlement_date : null;
        if (activeFutureInflationRaw && !endDate) throw new TypeError('Informe a data de venda para posicionar o IPCA futuro.');
        assumptions.inflation_projection = {
          mode: activeFutureInflationRaw ? 'INTERPOLATED_ANNUAL' : 'CONSTANT_ANNUAL',
          annual_rate: shiftDecimal(parsePtDecimal(inflationRaw, 'Inflação anual hipotética'), -2),
          anchor_date: lastDateResolution.purchase.settlement_date,
          anchor_level: '1',
          source_ref: `${anchorSource}; trajetória anual hipotética declarada pelo usuário`,
          ...(activeFutureInflationRaw ? {
            end_annual_rate: shiftDecimal(parsePtDecimal(activeFutureInflationRaw, 'IPCA futuro'), -2),
            end_date: endDate,
          } : {}),
        };
      }
      if (indexLevels.length || Object.prototype.hasOwnProperty.call(inheritedData, 'price_index_levels')) {
        inheritedData.price_index_levels = indexLevels;
      }
      if (Object.keys(inheritedData).length) input.data = inheritedData;
      if (!isUnitPrice) {
        const constraints = serializeCriteria(snapshot()?.criteria || []);
        if (constraints.length) input.constraints = constraints;
      }
      const instrument = makeInstrument();
      if (instrument) input.instrument = instrument;
      if (purchaseDate) input.purchase_date = purchaseDate;
      if (saleDate) input.sale_date = saleDate;
      if (entryPrice) input.entry_price = entryPrice;
      if (exitPrice) input.exit_price = exitPrice;
      return isUnitPrice ? unitPriceInputFrom(input) : input;
    }

    function serializeCriteria(criteria) {
      if (criteria.length > 8) throw new RangeError('O conjunto aceita até oito objetivos.');
      return criteria.map((item, index) => {
        const goal = constraintGoalForCriterion(item);
        if (!goal) throw new TypeError(`Objetivo ${index + 1}: escolha uma condição compatível.`);
        const definition = CONSTRAINT_METRICS[goal.metric];
        const rawValue = goal.id === 'LOSS_CAP' && String(item.value ?? '').trim().startsWith('-')
          ? String(item.value).trim().slice(1) : item.value;
        let value;
        try { value = constraintThresholdForGoal(goal.id, rawValue); }
        catch (error) { throw new TypeError(`Objetivo ${index + 1}: ${error?.message || String(error)}`); }
        return { id: item.id, metric: goal.metric, operator: goal.operator, value, unit: definition.unit };
      });
    }

    function renderCriteria(preferredFocus = null) {
      const root = byId('mtm-criteria-list');
      const current = snapshot()?.criteria || [];
      if (!root) return;
      const rows = current.map((criterion, index) => {
        const goal = constraintGoalForCriterion(criterion) || CONSTRAINT_GOALS[0];
        const definition = CONSTRAINT_METRICS[goal.metric];
        const row = doc.createElement('div');
        row.className = 'mtm-criterion-row';
        row.dataset.criterionId = criterion.id;
        const metricLabel = doc.createElement('label');
        metricLabel.textContent = `Objetivo ${index + 1}`;
        const goalSelect = doc.createElement('select');
        goalSelect.dataset.criterionField = 'goal';
        goalSelect.setAttribute('aria-label', metricLabel.textContent);
        for (const item of CONSTRAINT_GOALS) {
          const option = doc.createElement('option');
          option.value = item.id; option.textContent = item.label; goalSelect.append(option);
        }
        goalSelect.value = goal.id;
        goalSelect.addEventListener('change', () => {
          const nextGoal = CONSTRAINT_GOALS.find(item => item.id === goalSelect.value);
          const next = snapshot().criteria.map(item => item.id === criterion.id
            ? { ...item, goal_type: nextGoal.id, metric: nextGoal.metric, operator: nextGoal.operator, value: '' } : item);
          dispatch({ type: 'UPDATE_CONSTRAINTS', criteria: next, undo_group: `criterion:${criterion.id}` });
          renderCriteria({ id: criterion.id, field: 'goal' });
          onCriteriaEdited();
        });
        metricLabel.append(goalSelect);

        const valueLabel = doc.createElement('label');
        valueLabel.textContent = goal.label;
        const valueWrap = doc.createElement('span');
        valueWrap.className = 'mtm-criterion-value';
        const value = doc.createElement('input');
        value.dataset.criterionField = 'value';
        value.type = definition.unit === 'date' ? 'date' : 'text';
        if (value.type === 'text') value.inputMode = 'decimal';
        value.autocomplete = 'off';
        const legacyLossLimitValue = goal.id === 'LOSS_CAP' && String(criterion.value ?? '').startsWith('-')
          ? String(criterion.value).slice(1) : criterion.value;
        value.value = legacyLossLimitValue || '';
        value.setAttribute('aria-label', `${goal.label} (${definition.displayUnit}) do objetivo ${index + 1}`);
        value.addEventListener('input', () => {
          const next = snapshot().criteria.map(item => item.id === criterion.id ? { ...item, value: value.value } : item);
          dispatch({ type: 'UPDATE_CONSTRAINTS', criteria: next, undo_group: `criterion:${criterion.id}` });
          onCriteriaEdited();
        });
        valueWrap.append(value);
        const unit = doc.createElement('span'); unit.className = 'mtm-criterion-unit'; unit.textContent = definition.displayUnit;
        valueWrap.append(unit);
        valueLabel.append(valueWrap);

        const remove = doc.createElement('button');
        remove.type = 'button'; remove.className = 'subtle'; remove.textContent = 'Excluir';
        remove.setAttribute('aria-label', `Excluir objetivo ${index + 1}`);
        remove.addEventListener('click', () => {
          dispatch({ type: 'UPDATE_CONSTRAINTS', criteria: snapshot().criteria.filter(item => item.id !== criterion.id) });
          renderCriteria();
          onCriteriaEdited();
        });
        row.append(metricLabel, valueLabel, remove);
        return row;
      });
      root.replaceChildren(...rows);
      const add = byId('mtm-criteria-add');
      if (add) add.disabled = current.length >= 8 || busy;
      if (preferredFocus) [...root.querySelectorAll('[data-criterion-id]')]
        .find(row => row.dataset.criterionId === preferredFocus.id)
        ?.querySelector(`[data-criterion-field="${preferredFocus.field}"]`)?.focus();
      const message = byId('mtm-criteria-message');
      if (message && !current.length) message.textContent = 'Nenhum objetivo pessoal definido.';
    }

    function surfaceMetricForConstraint(metric) {
      return {
        NET_REDEMPTION: 'net_redemption', NOMINAL_PROFIT: 'nominal_profit',
        NOMINAL_RETURN: 'nominal_return', REAL_RETURN: 'real_return',
        ANNUALIZED_NOMINAL_RETURN: 'annualized_nominal_return',
      }[metric] || (SURFACE_METRICS[byId('mtm-surface-metric')?.value] ? byId('mtm-surface-metric').value : 'net_redemption');
    }

    function renderConstraintEvaluation(evaluation, stale = false, goalGaps = []) {
      const section = byId('mtm-criteria-evaluation');
      const summary = byId('mtm-criteria-summary');
      const list = byId('mtm-criteria-results');
      if (!section || !list) return;
      section.hidden = !evaluation || evaluation.status === 'NO_CONSTRAINTS';
      if (section.hidden) return;
      ensureFirstDateSearch();
      ensureEntryBoundarySearch();
      ensureRateBoundarySearch();
      syncConstraintMode();
      syncEntryBoundaryInputs();
      renderFirstDateSearchResult();
      renderEntryBoundarySearchResult();
      renderRateBoundarySearchResults();
      if (summary) summary.textContent = `${stale ? 'Última avaliação · ' : ''}${presentation().label('status', evaluation.status)}${stale ? ' · Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.' : ''}`;
      const gapsByCriterion = new Map((Array.isArray(goalGaps) ? goalGaps : [])
        .filter(item => item && typeof item.criterion_id === 'string')
        .map(item => [item.criterion_id, item]));
      list.replaceChildren(...(evaluation.criteria || []).map(item => {
        const criterion = (snapshot()?.criteria || []).find(candidate => candidate.id === item.constraint_id);
        const li = doc.createElement('li');
        const title = doc.createElement('div'); title.className = 'mtm-criteria-result-title';
        title.textContent = criterionGoalTitle({ ...item, goal_type: criterion?.goal_type });
        const detail = doc.createElement('p'); detail.className = 'mtm-criteria-result-detail';
        const gapLabel = criterionGoalGapLabel({ ...item, goal_type: criterion?.goal_type }, gapsByCriterion.get(item.constraint_id));
        const statusLabel = presentation().label('criterion', item.status);
        const detailBase = gapLabel.startsWith('Distância à meta:')
          ? (item.status === 'UNKNOWN' ? gapLabel : `${statusLabel} · ${gapLabel}`)
          : `Calculado: ${formatCriterionValue(item.achieved_value, item.unit)} · ${gapLabel}`;
        detail.textContent = detailBase
          + `${item.quality ? ` · Qualidade: ${surfaceQualityLabel(item.quality)}` : ''}`
          + `${item.reference_date ? ` · Base real: ${surfaceDateLabel(item.reference_date)}` : ''}`
          + `${item.status === 'UNKNOWN' && item.reason ? ` · ${item.reason}` : ''}`;
        li.append(title, detail);
        const explore = doc.createElement('button');
        explore.type = 'button'; explore.className = 'subtle mtm-criteria-result-actions';
        explore.textContent = 'Explorar no mapa'; explore.dataset.exploreMetric = surfaceMetricForConstraint(item.metric);
        explore.disabled = stale || !currentSurface || surfaceStale || busy;
        explore.addEventListener('click', () => {
          const metricSelect = byId('mtm-surface-metric');
          if (metricSelect) metricSelect.value = explore.dataset.exploreMetric;
          changeView({ tab: 'map', metric: explore.dataset.exploreMetric });
          renderTabs('map');
          if (currentSurface) renderSurface(currentSurface, false);
          byId('mtm-surface-view')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        li.append(explore);
        return li;
      }));
    }

    function firstDateSearchIdentity() {
      const start = byId('mtm-first-date-start')?.value || '';
      const end = byId('mtm-first-date-end')?.value || '';
      const unit = byId('mtm-first-date-unit')?.value || '';
      const value = byId('mtm-first-date-value')?.value || '';
      return JSON.stringify({ result: resultIdentity(), start, end, unit, value });
    }

    function entryBoundarySearchIdentity() {
      const minimum = byId('mtm-entry-boundary-minimum')?.value || '';
      const maximum = byId('mtm-entry-boundary-maximum')?.value || '';
      const tick = byId('mtm-entry-boundary-tick')?.value || '';
      return JSON.stringify({ result: resultIdentity(), minimum, maximum, tick,
        entryMode: lastValidResult?.input?.capital?.mode || '' });
    }

    function selectedLimitMode() {
      const selected = snapshot()?.view?.focus;
      return ['exit', 'entry', 'date'].includes(selected) ? selected : 'exit';
    }

    function syncConstraintMode() {
      const mode = selectedLimitMode();
      for (const button of doc.querySelectorAll('[data-mtm-limit-mode-button]')) {
        button.setAttribute('aria-pressed', String(button.dataset.mtmLimitModeButton === mode));
      }
      for (const panel of doc.querySelectorAll('[data-mtm-limit-panel]')) {
        panel.hidden = panel.dataset.mtmLimitPanel !== mode;
      }
    }

    function chooseConstraintMode(mode) {
      if (!['exit', 'entry', 'date'].includes(mode)) return;
      changeView({ focus: mode }, 'view:constraint-mode');
      syncConstraintMode();
    }

    function currentEntryPU() {
      const result = lastValidResult?.response?.result || {};
      const input = lastValidResult?.input || {};
      const resolved = lastValidResult?.resolved || {};
      return result.entry_pu
        || input.entry_price?.pu
        || resolved.resolved_prices?.entry_price?.value
        || null;
    }

    function syncEntryBoundaryInputs() {
      const minimum = byId('mtm-entry-boundary-minimum');
      const maximum = byId('mtm-entry-boundary-maximum');
      const tick = byId('mtm-entry-boundary-tick');
      const currentPU = currentEntryPU();
      if (minimum && maximum && !minimum.value && !maximum.value && currentPU) {
        const defaults = entryBoundaryDomainDefaults(currentPU);
        if (defaults) { minimum.value = defaults.minimum; maximum.value = defaults.maximum; }
      }
      if (tick && !tick.value) tick.value = '0.01';
      const modeLabel = byId('mtm-entry-boundary-mode');
      if (modeLabel) modeLabel.textContent = lastValidResult?.input?.capital?.mode === 'QUANTITY'
        ? 'Modo ativo: quantidade fixa.' : 'Modo ativo: orçamento fixo.';
      const currentLabel = byId('mtm-entry-boundary-current');
      if (currentLabel) currentLabel.textContent = currentPU
        ? `PU de entrada da operação avaliada: ${formatCurrency(currentPU, 2)}.`
        : 'PU de entrada da operação avaliada indisponível.';
      const selection = selectionForCurrentResult();
      const exitLabel = byId('mtm-entry-boundary-exit');
      if (exitLabel) exitLabel.textContent = selection
        ? `Saída congelada: ${surfaceDateLabel(selection.sale_date)}; ${selection.exit_pu !== undefined
        ? `PU ${formatCurrency(selection.exit_pu, 2)}`
        : `taxa real ${formatAnnualRate(selection.annual_real_rate, 4)}`}. A data-limite de uma meta continua sendo critério, não troca esta data de venda.`
        : 'Seleção de saída indisponível; avalie novamente a operação.';
    }

    function ensureEntryBoundarySearch() {
      const panel = byId('mtm-entry-boundary-search');
      if (!panel) return;
      for (const id of ['mtm-entry-boundary-minimum', 'mtm-entry-boundary-maximum', 'mtm-entry-boundary-tick']) {
        const field = byId(id);
        if (field && !field.dataset.boundaryListener) {
          field.dataset.boundaryListener = 'true';
          field.addEventListener('change', renderEntryBoundarySearchResult);
        }
      }
      syncEntryBoundaryInputs();
    }

    function renderEntryBoundarySearchResult() {
      const output = byId('mtm-entry-boundary-status');
      const detail = byId('mtm-entry-boundary-detail');
      const explore = byId('mtm-entry-boundary-explore');
      if (!output || !detail) return;
      detail.replaceChildren();
      if (!currentEntryBoundarySearch) {
        output.textContent = 'Informe o domínio de PU e busque o limite sob as metas aplicadas.';
        if (explore) explore.hidden = true;
        return;
      }
      const { result, identity } = currentEntryBoundarySearch;
      const stale = identity !== entryBoundarySearchIdentity();
      const labels = {
        SOLVED: 'PU máximo de entrada verificado', INCOMPLETE: 'Busca incompleta; não há prova de máximo global',
        NO_SOLUTION: 'Nenhum PU atende no domínio coberto', UNKNOWN: 'Busca sem dado suficiente',
        OUTSIDE_DOMAIN: 'Orçamento insuficiente no domínio declarado',
        BLOCKED_POLICY: 'Busca bloqueada pela política do produto', UNSUPPORTED: 'Busca não suportada para estas premissas',
      };
      const candidate = result.candidate;
      const currentPU = currentEntryPU();
      const maximumPU = result.maximum_entry_pu;
      const margin = maximumPU && currentPU ? exactDecimalDifference(currentPU, maximumPU) : null;
      let marginText = '';
      if (margin !== null) {
        const numericSign = margin.startsWith('-');
        const absoluteMargin = numericSign ? margin.slice(1) : margin;
        marginText = numericSign
          ? ` Folga até o limite: ${formatCurrency(absoluteMargin, 2)} por título.`
          : margin === '0'
            ? ' O PU atual coincide com o limite.'
            : ` O PU atual está ${formatCurrency(absoluteMargin, 2)} por título acima do limite.`;
      }
      const fixedExit = result.fixed_exit_condition || {};
      const exitText = fixedExit.sale_order_date
        ? ` Saída congelada em ${surfaceDateLabel(fixedExit.sale_order_date)} (liquidação ${surfaceDateLabel(fixedExit.sale_settlement_date)}), ${fixedExit.exit_pu
          ? `PU ${formatCurrency(fixedExit.exit_pu, 2)}`
          : `taxa real ${formatAnnualRate(fixedExit.exit_rate, 4)}`}.`
        : '';
      const coverage = result.coverage || {};
      const domain = result.domain || {};
      const domainText = domain.minimum_pu
        ? ` Domínio: ${formatCurrency(domain.minimum_pu, 2)} a ${formatCurrency(domain.maximum_pu, 2)}, efetivo até ${formatCurrency(domain.effective_maximum_pu, 2)}, tick ${formatCurrency(domain.tick, 2)}.`
        : '';
      const excludedText = coverage.excluded_above_effective_maximum === 'INSUFFICIENT_BUDGET'
        ? ' PUs superiores excluídos pelo orçamento.' : '';
      output.textContent = `${stale ? 'Desatualizado · ' : ''}${labels[result.status] || presentation().label('status', result.status)}. ${maximumPU
        ? `Limite ${formatCurrency(maximumPU, 2)} por título; PU atual ${formatCurrency(currentPU, 2)}.${marginText}` : ''}${exitText}${domainText}${excludedText} ${coverage.evaluated_candidates || 0} candidatos avaliados; cobertura máxima ${coverage.complete_for_maximum ? 'completa' : 'incompleta'}. ${result.reason || ''}`;
      if (candidate) {
        const quantity = candidate.quantity?.value;
        const remainder = candidate.cash_remainder?.value;
        const direct = doc.createElement('p'); direct.className = 'mtm-criteria-message';
        direct.textContent = `Candidato reavaliado: quantidade ${quantity ? formatPtNumber(quantity, -1) : presentation().MISSING} título(s); sobra ${remainder !== null && remainder !== undefined ? formatCurrency(remainder, 2) : 'não aplicável'}; metas ${presentation().label('status', candidate.constraint_evaluation?.status)}.`;
        detail.append(direct);
      }
      const canExplore = !stale && result.status === 'SOLVED' && Boolean(maximumPU) && Boolean(candidate);
      if (explore) { explore.hidden = !canExplore; explore.disabled = busy || !canExplore; }
    }

    function rateBoundaryControlId(side, field) {
      return `mtm-rate-boundary-${side.toLowerCase()}-${field}`;
    }

    function rateBoundarySearchIdentity(side) {
      return JSON.stringify({
        result: resultIdentity(), side,
        minimum: byId(rateBoundaryControlId(side, 'minimum'))?.value || '',
        maximum: byId(rateBoundaryControlId(side, 'maximum'))?.value || '',
        step: byId(rateBoundaryControlId(side, 'step'))?.value || '',
        entryMode: lastValidResult?.input?.capital?.mode || '',
      });
    }

    function ensureRateBoundarySearch() {
      const targets = [
        ['ENTRY', byId('mtm-entry-boundary-search')],
        ['EXIT', doc.querySelector('[data-mtm-limit-panel="exit"]')],
      ];
      for (const [side, parent] of targets) {
        const sectionId = `mtm-rate-boundary-${side.toLowerCase()}`;
        if (!parent || byId(sectionId)) continue;
        const section = doc.createElement('section');
        section.id = sectionId; section.className = 'mtm-rate-boundary';
        section.dataset.rateBoundarySide = side;
        const title = doc.createElement('h4');
        title.textContent = side === 'ENTRY'
          ? 'Qual taxa de compra atende à meta?'
          : 'Até qual taxa na venda a meta é atendida?';
        const intro = doc.createElement('p'); intro.className = 'muted';
        intro.textContent = side === 'ENTRY'
          ? 'Busca a menor taxa entre os pontos da grade informada. Orçamento ou quantidade, saída, datas, âncoras e custos seguem a operação atual; orçamento e quantidade derivada são recalculados em cada taxa.'
          : 'Busca o limite de taxa dentro da faixa informada, com a compra, capital, data de venda, âncoras e custos da operação atual. PU e metas são reavaliados no motor antes da resposta.';
        const assumptions = doc.createElement('p'); assumptions.id = `mtm-rate-boundary-${side.toLowerCase()}-assumptions`;
        assumptions.className = 'mtm-rate-boundary-assumptions';
        const fields = doc.createElement('div'); fields.className = 'mtm-rate-boundary-domain';
        for (const [field, labelText, value] of [
          ['minimum', 'Taxa mínima (% a.a.)', '-5'],
          ['maximum', 'Taxa máxima (% a.a.)', '15'],
          ['step', 'Passo (% a.a.)', '0,25'],
        ]) {
          const id = rateBoundaryControlId(side, field);
          const label = doc.createElement('label'); label.htmlFor = id; label.textContent = labelText;
          const input = doc.createElement('input'); input.id = id; input.type = 'text';
          input.inputMode = 'decimal'; input.autocomplete = 'off'; input.value = value;
          label.append(input); fields.append(label);
          input.addEventListener('change', () => renderRateBoundarySearchResult(side));
        }
        const precision = doc.createElement('p'); precision.className = 'muted';
        precision.textContent = 'Informe limites e passo em percentual ao ano. A consulta cobre no máximo 101 pontos e não amplia a faixa automaticamente.';
        const run = doc.createElement('button'); run.type = 'button'; run.className = 'primary';
        run.dataset.rateBoundaryRun = side; run.textContent = side === 'ENTRY'
          ? 'Buscar taxa mínima de compra' : 'Buscar taxa-limite de venda';
        const status = doc.createElement('p'); status.id = `mtm-rate-boundary-${side.toLowerCase()}-status`;
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        status.textContent = 'Aplique as metas antes de buscar uma taxa-limite.';
        const detail = doc.createElement('div'); detail.id = `mtm-rate-boundary-${side.toLowerCase()}-detail`;
        detail.setAttribute('aria-live', 'polite');
        const explore = doc.createElement('button'); explore.type = 'button'; explore.className = 'subtle';
        explore.dataset.rateBoundaryExplore = side; explore.hidden = true;
        explore.textContent = 'Explorar taxa verificada';
        run.addEventListener('click', () => runRateBoundarySearch(side));
        explore.addEventListener('click', () => exploreRateBoundary(side));
        section.append(title, intro, assumptions, fields, precision, run, status, detail, explore);
        parent.append(section);
      }
      renderRateBoundaryAssumptions();
    }

    function rateBoundaryAssumptionSummary(side) {
      const input = lastValidResult?.input || {};
      const resolved = lastValidResult?.resolved || {};
      const instrument = resolved.normalized_input?.instrument || input.instrument || {};
      const title = instrument.family === 'RENDA_PLUS'
        ? `Tesouro RendA+ ${instrument.conversion_date?.slice(0, 4) || instrument.first_income_date?.slice(0, 4) || ''}`.trim()
        : instrument.family === 'IPCA_PRINCIPAL'
          ? `Tesouro IPCA+ ${instrument.series_year || instrument.maturity_date?.slice(0, 4) || ''}`.trim()
          : (instrument.instrument_id || 'título atual');
      const purchaseDate = resolved.dates?.purchase?.order_date || input.purchase_date || 'indisponível';
      const saleDate = resolved.dates?.sale?.order_date || input.sale_date || 'indisponível';
      const capital = input.capital?.mode === 'QUANTITY'
        ? `quantidade fixa de ${input.capital.value} título(s)`
        : `orçamento fixo de ${input.capital?.value ? formatCurrency(input.capital.value, 2) : 'indisponível'}`;
      const entry = input.entry_price || {};
      const entryText = entry.mode === 'MANUAL_RATE' && entry.annual_real_rate != null
        ? `compra a ${formatPtNumber(shiftDecimal(entry.annual_real_rate, 2), 6)}% a.a.`
        : entry.mode === 'MANUAL_PU' && entry.pu != null
          ? `compra por PU ${formatCurrency(entry.pu, 2)}` : 'condição de compra atual';
      const selection = selectionForCurrentResult();
      const exitText = selection?.annual_real_rate != null
        ? `venda à taxa ${formatPtNumber(shiftDecimal(selection.annual_real_rate, 2), 6)}% a.a.`
        : selection?.exit_pu != null ? `venda por PU ${formatCurrency(selection.exit_pu, 2)}` : 'condição de venda atual';
      const dates = `compra pedida em ${surfaceDateLabel(purchaseDate)} e venda pedida em ${surfaceDateLabel(saleDate)}`;
      const variable = side === 'ENTRY' ? 'taxa de compra' : 'taxa de venda';
      const unchanged = side === 'ENTRY' ? exitText : entryText;
      const size = side === 'ENTRY' && input.capital?.mode === 'BUDGET'
        ? ' A quantidade e o saldo são recalculados a cada ponto.' : '';
      return `${title} · ${capital} · ${dates} · ${unchanged}. Varia apenas a ${variable}; PU é recalculado com a âncora e o calendário desta operação.${size}`;
    }

    function renderRateBoundaryAssumptions() {
      for (const side of ['ENTRY', 'EXIT']) {
        const assumptions = byId(`mtm-rate-boundary-${side.toLowerCase()}-assumptions`);
        if (assumptions) assumptions.textContent = `Premissas mantidas: ${rateBoundaryAssumptionSummary(side)}`;
      }
    }

    function ratePercentLabel(value) {
      return value == null ? 'indisponível' : `${formatPtNumber(shiftDecimal(String(value), 2), 8)}% a.a.`;
    }

    function rateBoundaryConstraintLines(candidate) {
      const criteria = candidate?.constraint_evaluation?.criteria;
      if (!Array.isArray(criteria) || !criteria.length) return [];
      return criteria.map(item => {
        const criterion = (snapshot()?.criteria || []).find(value => value.id === item.constraint_id);
        const title = criterionGoalTitle({ ...item, goal_type: criterion?.goal_type });
        const stateLabel = presentation().label('criterion', item.status);
        const achieved = item.achieved_value == null ? '' : ` · calculado ${formatCriterionValue(item.achieved_value, item.unit)}`;
        return `${title}: ${stateLabel}${achieved}`;
      });
    }

    function renderRateBoundaryCandidate(label, candidate, detail) {
      if (!candidate) return;
      const block = doc.createElement('section'); block.className = 'mtm-rate-boundary-candidate';
      const heading = doc.createElement('h5'); heading.textContent = label;
      const summary = doc.createElement('p');
      summary.textContent = `Taxa ${ratePercentLabel(candidate.rate)} · PU ${candidate.unit_price == null
        ? 'indisponível' : formatCurrency(candidate.unit_price, 2)} · ${presentation().label('criterion', candidate.status)}.`;
      block.append(heading, summary);
      const lines = rateBoundaryConstraintLines(candidate);
      if (lines.length) {
        const list = doc.createElement('ul');
        for (const line of lines) { const item = doc.createElement('li'); item.textContent = line; list.append(item); }
        block.append(list);
      }
      detail.append(block);
    }

    function renderRateBoundarySearchResult(side) {
      const suffix = side.toLowerCase();
      const output = byId(`mtm-rate-boundary-${suffix}-status`);
      const detail = byId(`mtm-rate-boundary-${suffix}-detail`);
      const explore = doc.querySelector(`[data-rate-boundary-explore="${side}"]`);
      if (!output || !detail) return;
      detail.replaceChildren();
      const current = currentRateBoundarySearch[side];
      if (!current) {
        output.textContent = 'Informe a faixa e o passo; a consulta fica limitada aos pontos declarados.';
        if (explore) explore.hidden = true;
        return;
      }
      const { result, identity } = current;
      const stale = identity !== rateBoundarySearchIdentity(side);
      const labels = {
        SOLVED: side === 'ENTRY' ? 'Taxa mínima na grade declarada verificada' : 'Taxa-limite de venda verificada',
        INCOMPLETE: 'Candidato direto encontrado; cobertura incompleta',
        UNKNOWN: 'Não foi possível avaliar toda a faixa',
        NO_SOLUTION: side === 'ENTRY' ? 'Nenhum ponto atende na faixa e no passo informados'
          : 'Nenhuma fronteira foi encontrada na faixa de venda consultada',
        OUTSIDE_DOMAIN: 'Nenhuma taxa atende dentro do domínio declarado',
        UNSUPPORTED: 'Busca não suportada para estas premissas',
        VERIFICATION_FAILED: 'A taxa não passou na verificação direta',
      };
      const domain = result.rate_domain || {};
      const domainText = `Faixa ${ratePercentLabel(domain.minimum)} a ${ratePercentLabel(domain.maximum)}; passo ${ratePercentLabel(domain.step)}.`;
      const rate = result.boundary_rate ?? result.candidate?.rate ?? null;
      const precision = result.rate_solution?.precision;
      const bracket = result.rate_solution?.rate_bracket;
      const precisionText = side === 'ENTRY'
        ? `Precisão: grade discreta com passo ${ratePercentLabel(precision?.step || domain.step)}.`
        : Array.isArray(bracket) && bracket.length === 2
          ? `Precisão: bracket ${ratePercentLabel(bracket[0])} a ${ratePercentLabel(bracket[1])}.` : '';
      const coverage = result.coverage || {};
      const completion = side === 'ENTRY'
        ? coverage.complete_for_minimum_in_declared_domain
          ? 'Todos os pontos anteriores foram avaliados; o mínimo na grade está provado.'
          : coverage.complete_in_declared_domain
            ? 'Toda a grade declarada foi avaliada.'
            : `Prefixo incompleto (${coverage.rate_points_checked || coverage.evaluated_candidates || 0} ponto(s) de taxa avaliados).`
        : result.status === 'SOLVED'
          ? `Monotonicidade conferida em ${coverage.rate_points_checked || 0} ponto(s) da grade; bracket refinado e reavaliado.`
          : `Faixa verificada parcialmente (${coverage.rate_points_checked || coverage.evaluated_candidates || 0} ponto(s) de taxa avaliados).`;
      const proof = result.verification_status === 'PROVEN_GRID_STEP'
        ? 'O ponto imediatamente anterior foi reavaliado e não atende.'
        : result.verification_status === 'PROVEN'
          ? 'O vizinho do lado de violação foi reavaliado e não atende.'
          : result.verification_status === 'DOMAIN_MINIMUM'
            ? 'O limite inferior declarado atende diretamente.'
            : result.verification_status === 'ALL_DOMAIN'
              ? 'A faixa inteira atende à condição.' : '';
      output.textContent = `${stale ? 'Resultado desatualizado · ' : ''}${labels[result.status] || presentation().label('status', result.status)}. ${rate == null ? '' : `${side === 'ENTRY' ? 'Menor taxa candidata' : 'Taxa candidata'}: ${ratePercentLabel(rate)}; PU correspondente ${result.unit_price_at_rate == null ? 'indisponível' : formatCurrency(result.unit_price_at_rate, 2)}. `}${domainText} ${precisionText} ${completion} ${proof} ${result.reason || ''}`.trim();
      renderRateBoundaryCandidate('Candidato reavaliado', result.candidate, detail);
      renderRateBoundaryCandidate('Vizinho do lado de violação', result.violation_neighbor, detail);
      const canExplore = !stale && result.candidate?.status === 'MET' && Boolean(result.candidate?.rate);
      if (explore) {
        explore.hidden = !canExplore;
        explore.textContent = result.status === 'SOLVED'
          ? 'Explorar taxa-limite verificada' : 'Explorar taxa candidata; limite incompleto';
        explore.disabled = busy || !canExplore;
      }
    }

    function renderRateBoundarySearchResults() {
      renderRateBoundaryAssumptions();
      renderRateBoundarySearchResult('ENTRY');
      renderRateBoundarySearchResult('EXIT');
    }

    async function runRateBoundarySearch(side) {
      if (busy) return;
      const suffix = side.toLowerCase();
      const output = byId(`mtm-rate-boundary-${suffix}-status`);
      if (!lastValidResult || lastValidResult.identity !== resultIdentity()) {
        if (output) output.textContent = 'Aplique as metas e avalie a operação atual antes de buscar uma taxa-limite.';
        return;
      }
      const selection = selectionForCurrentResult();
      if (!selection) {
        if (output) output.textContent = 'A condição de saída avaliada não está disponível; avalie novamente a operação.';
        return;
      }
      let input, query;
      try {
        const entryMode = lastValidResult.input?.capital?.mode;
        const plan = rateBoundaryQueryFromPercentages(
          side,
          byId(rateBoundaryControlId(side, 'minimum'))?.value,
          byId(rateBoundaryControlId(side, 'maximum'))?.value,
          byId(rateBoundaryControlId(side, 'step'))?.value,
          lastValidResult.input?.instrument?.family || '', entryMode,
        );
        const constraints = serializeCriteria(snapshot()?.criteria || []);
        if (!constraints.length) throw new TypeError('Aplique ao menos uma meta antes de buscar uma taxa-limite.');
        input = inputForSelection(JSON.parse(JSON.stringify(lastValidResult.input)), selection);
        input.constraints = constraints;
        query = plan.query;
      } catch (error) {
        if (output) output.textContent = error?.message || String(error);
        return;
      }
      const searchIdentity = rateBoundarySearchIdentity(side);
      const intent = { id: ++intentSequence, action: 'CONSTRAINTS', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = 'Recalculando PU, dimensionamento e metas em cada ponto do domínio de taxa…';
      try {
        const response = await request('CONSTRAINTS', 'simulator/workspace', {
          schema_version: 2, action: 'CONSTRAINTS', input, query,
        });
        if (activeIntent !== intent) return;
        if (!response.accepted || !response.response?.result) {
          if (output) output.textContent = 'A busca não foi aceita; a faixa, as metas e a operação atual permanecem preservadas.';
          return;
        }
        currentRateBoundarySearch[side] = { result: response.response.result, identity: searchIdentity };
        renderRateBoundarySearchResult(side);
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `Não foi possível concluir a busca. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    async function exploreRateBoundary(side) {
      const current = currentRateBoundarySearch[side];
      if (busy || !current || current.identity !== rateBoundarySearchIdentity(side)
          || current.result?.candidate?.status !== 'MET' || !current.result.candidate.rate) return;
      const alternatives = snapshot()?.alternatives || [];
      const output = byId(`mtm-rate-boundary-${side.toLowerCase()}-status`);
      if (alternatives.length >= 2) {
        if (output) output.textContent = 'A taxa não foi explorada porque o limite de duas alternativas salvas já foi atingido.';
        return;
      }
      const selection = selectionForCurrentResult();
      if (!selection || !lastValidResult) return;
      let constraints;
      try { constraints = serializeCriteria(snapshot()?.criteria || []); }
      catch (error) {
        if (output) output.textContent = error?.message || String(error);
        return;
      }
      const rate = String(current.result.candidate.rate);
      const input = inputForSelection(JSON.parse(JSON.stringify(lastValidResult.input)), selection);
      if (side === 'ENTRY') input.entry_price = { mode: 'MANUAL_RATE', annual_real_rate: rate };
      else input.exit_price = { mode: 'MANUAL_RATE', annual_real_rate: rate, quoted_side: 'SELL' };
      input.intent = 'HYPOTHETICAL'; input.constraints = constraints;
      const nextSelection = side === 'EXIT'
        ? { sale_date: selection.sale_date, annual_real_rate: rate } : selection;
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent; setBusy(true);
      setPending('Reavaliando diretamente a taxa candidata antes de abrir o rascunho…');
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection: nextSelection,
        });
        if (activeIntent !== intent) return;
        const response = evaluated.response;
        const operation = response?.result?.operation;
        const goalStatus = response?.result?.constraint_evaluation?.status;
        if (!evaluated.accepted || evaluated.goals_current === false || !operation || goalStatus !== 'MET') {
          if (output) output.textContent = 'A reavaliação direta não confirmou todas as metas. O resultado e a operação atuais foram preservados.';
          return;
        }
        const previous = lastValidResult;
        const fingerprint = previous.response?.input_fingerprint;
        if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(fingerprint || ''))) {
          if (output) output.textContent = 'O cenário anterior não trouxe fingerprint verificável; a operação atual foi preservada.';
          return;
        }
        const previousProvenance = {
          resolved_prices: previous.resolved?.resolved_prices || {},
          source_resolution: previous.resolved?.source_resolution || previous.response?.source_versions || {},
          quality: previous.response?.result?.quality || previous.response?.result?.operation?.quality || null,
        };
        dispatch({ type: 'PIN_ALTERNATIVE', alternative: {
          id: `rate-boundary-origin-${++intentSequence}`,
          label: 'Operação antes da exploração da taxa', draft: snapshot()?.draft, input: previous.input,
          source_versions: previous.input?.source_versions || previous.resolved?.source_versions || {},
          provenance: previousProvenance, input_fingerprint: fingerprint, selection: snapshot()?.selection,
        } });
        renderCompareContexts();
        const raw = inputToFormRaw(input);
        dispatch({ type: 'EDIT_DRAFT', path: 'ui_form', value: raw });
        syncFormFromRaw(raw);
        if (side === 'EXIT') dispatch({ type: 'SELECT_POINT', point: nextSelection });
        updateDraft();
        const selected = side === 'EXIT' ? nextSelection : selection;
        lastValidResult = { input, resolved: response.resolved || previous.resolved, response,
          confirmedLocalExit: false, ...resultIdentityFields(), goals_evaluated: evaluated.goals_current !== false };
        currentRateBoundarySearch[side] = null;
        surfaceStale = Boolean(currentSurface);
        renderResolved(lastValidResult.resolved, response, false, false, inputForSelection(input, selected));
        if (currentSurface) renderSurface(currentSurface, true);
        await loadConstraintLimit(input, selected, intent);
        await loadSurface(input, selected, intent, 'RATE_CURVE');
        if (activeIntent === intent && output) output.textContent = 'Taxa reavaliada diretamente. A operação anterior foi preservada como alternativa e o resultado atual virou rascunho.';
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `A reavaliação da taxa falhou; a operação atual foi preservada. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    function ensureFirstDateSearch() {
      const section = byId('mtm-criteria-evaluation');
      if (!section || byId('mtm-first-date-search')) return;
      const panel = doc.createElement('section');
      panel.id = 'mtm-first-date-search';
      panel.className = 'mtm-exit-limit';
      panel.dataset.mtmLimitPanel = 'date';
      panel.hidden = true;
      const title = doc.createElement('h4'); title.textContent = 'A partir de qual data esta meta é atendida neste cenário?';
      const intro = doc.createElement('p');
      intro.textContent = 'A busca percorre sessões financeiras elegíveis em ordem cronológica, reavalia cada data diretamente e para no fim informado. Datas futuras são hipóteses, não previsões nem ordens.';
      const fields = doc.createElement('div'); fields.className = 'mtm-criteria-actions';
      const makeField = (id, labelText, type) => {
        const label = doc.createElement('label'); label.htmlFor = id; label.textContent = labelText;
        const input = doc.createElement('input'); input.id = id; input.type = type;
        if (type === 'number') { input.inputMode = 'decimal'; input.placeholder = 'Informe o valor'; }
        fields.append(label, input);
        return input;
      };
      const start = makeField('mtm-first-date-start', 'Início da busca', 'date');
      const end = makeField('mtm-first-date-end', 'Fim da busca', 'date');
      const conditionLabel = doc.createElement('label'); conditionLabel.htmlFor = 'mtm-first-date-unit'; conditionLabel.textContent = 'Condição de venda mantida';
      const unit = doc.createElement('select'); unit.id = 'mtm-first-date-unit';
      for (const [value, text] of [['BRL_PER_TITLE', 'PU de saída'], ['ratio', 'Taxa real de saída anual']]) {
        const option = doc.createElement('option'); option.value = value; option.textContent = text; unit.append(option);
      }
      const conditionValueLabel = doc.createElement('label'); conditionValueLabel.htmlFor = 'mtm-first-date-value'; conditionValueLabel.textContent = 'Valor mantido em cada data';
      const conditionValue = doc.createElement('input'); conditionValue.id = 'mtm-first-date-value'; conditionValue.type = 'text'; conditionValue.inputMode = 'decimal'; conditionValue.placeholder = 'Informe o valor';
      fields.append(conditionLabel, unit, conditionValueLabel, conditionValue);
      const selection = selectionForCurrentResult();
      const startValue = selection?.sale_date || lastValidResult?.input?.sale_date || '';
      if (startValue) start.value = startValue;
      const plusDays = new Date(`${startValue || localISODate()}T00:00:00Z`);
      plusDays.setUTCDate(plusDays.getUTCDate() + 90);
      let endValue = plusDays.toISOString().slice(0, 10);
      const resolvedInstrument = lastValidResult?.resolved?.normalized_input?.instrument;
      const productHorizon = resolvedInstrument?.family === 'RENDA_PLUS'
        ? resolvedInstrument.conversion_date : resolvedInstrument?.maturity_date;
      if (productHorizon) {
        const cutoff = new Date(`${productHorizon}T00:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate() - 1);
        const cutoffText = cutoff.toISOString().slice(0, 10);
        if (cutoffText < endValue) endValue = cutoffText;
      }
      end.value = endValue;
      if (selection?.annual_real_rate !== undefined) {
        unit.value = 'ratio'; conditionValue.value = formatPtNumber(shiftDecimal(selection.annual_real_rate, 2), 4);
      } else if (selection?.exit_pu !== undefined) conditionValue.value = formatPtNumber(selection.exit_pu, 2);
      const assumptions = doc.createElement('div'); assumptions.id = 'mtm-first-date-assumptions';
      assumptions.className = 'mtm-first-date-assumptions'; assumptions.setAttribute('aria-label', 'Premissas mantidas na busca');
      const budget = doc.createElement('p'); budget.className = 'muted'; budget.textContent = 'Limite desta busca: 4.096 sessões avaliadas ou 10 segundos.';
      const runButton = doc.createElement('button'); runButton.id = 'mtm-first-date-run'; runButton.type = 'button'; runButton.className = 'primary'; runButton.textContent = 'Buscar primeira data';
      const output = doc.createElement('p'); output.id = 'mtm-first-date-status'; output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite'); output.textContent = 'A busca será feita somente após uma avaliação direta das metas.';
      const explore = doc.createElement('button'); explore.id = 'mtm-first-date-explore'; explore.type = 'button';
      explore.className = 'subtle mtm-criteria-result-actions'; explore.hidden = true;
      explore.addEventListener('click', exploreFirstDateCandidate);
      const coverage = doc.createElement('div'); coverage.id = 'mtm-first-date-coverage';
      runButton.addEventListener('click', runFirstDateSearch);
      for (const input of [start, end, unit, conditionValue]) {
        input.addEventListener('input', renderFirstDateAssumptions);
        input.addEventListener('change', renderFirstDateSearchResult);
      }
      panel.append(title, intro, fields, assumptions, budget, runButton, output, explore, coverage);
      section.append(panel);
      renderFirstDateAssumptions();
      syncActionState();
    }

    function renderFirstDateAssumptions() {
      const target = byId('mtm-first-date-assumptions');
      if (!target) return;
      let condition = null;
      const unit = byId('mtm-first-date-unit')?.value;
      const rawValue = byId('mtm-first-date-value')?.value;
      try {
        const value = parsePtDecimal(rawValue, 'Condição de venda');
        if (value !== null) condition = { unit, value: unit === 'ratio' ? shiftDecimal(value, -2) : value };
      } catch (_) { /* The field-level message is shown on submit. */ }
      const summary = firstDateAssumptionsViewModel(lastValidResult?.input || {}, {
        start: byId('mtm-first-date-start')?.value || '',
        end: byId('mtm-first-date-end')?.value || '',
      }, condition);
      target.replaceChildren(
        textElement('p', summary.scenario, 'mtm-first-date-assumption'),
        textElement('p', summary.exit, 'mtm-first-date-assumption'),
        textElement('p', summary.inflation, 'mtm-first-date-assumption'),
        textElement('p', summary.domain, 'mtm-first-date-assumption'),
      );
    }

    function renderFirstDateSearchResult() {
      const output = byId('mtm-first-date-status');
      const coverage = byId('mtm-first-date-coverage');
      if (!output || !coverage) return;
      renderFirstDateAssumptions();
      coverage.replaceChildren();
      const explore = byId('mtm-first-date-explore');
      if (!currentFirstDateSearch) { if (explore) explore.hidden = true; return; }
      const { result, identity } = currentFirstDateSearch;
      const stale = identity !== firstDateSearchIdentity();
      const view = firstDateSearchViewModel(result, stale);
      const candidateText = view.candidateDate
        ? `${view.candidateLabel}: ${surfaceDateLabel(view.candidateDate)}${view.settlementDate ? `; liquidação ${surfaceDateLabel(view.settlementDate)}` : ''}.`
        : '';
      const condition = result.fixed_exit_condition || {};
      const conditionText = condition.unit === 'ratio'
        ? `Hipótese fixa: taxa real ${formatAnnualRate(condition.value, 4)}`
        : `Hipótese fixa: PU de saída ${formatCurrency(condition.value, 2)}.`;
      const previous = result.previous_coverage || {};
      const unknownRangeText = (previous.unknown_ranges || []).map(item => `Faixa sem cobertura: ${surfaceDateLabel(item.start)}–${surfaceDateLabel(item.end)}. ${item.reason}`).join(' ');
      output.textContent = `${stale ? 'Desatualizado · ' : ''}${view.statusLabel}. ${candidateText} ${conditionText} ${view.coveredEarlier} sessões anteriores avaliadas ou excluídas; ${view.unknownEarlier} candidatas sem dado. ${unknownRangeText} ${result.reason || ''}`;
      const candidate = view.candidate;
      const operation = candidate?.financial_result?.operation;
      if (operation) {
        const direct = doc.createElement('p'); direct.className = 'mtm-criteria-message';
        direct.textContent = `Reavaliação direta: lucro líquido nominal ${formatCriterionValue(operation.nominal_profit, 'BRL')}; resgate líquido ${formatCriterionValue(operation.net_redemption, 'BRL')}.`;
        coverage.append(direct);
      }
      const criteria = candidate?.constraint_evaluation?.criteria;
      if (Array.isArray(criteria) && criteria.length) {
        const list = doc.createElement('ul'); list.className = 'mtm-first-date-criteria';
        for (const item of criteria) {
          const criterion = (snapshot()?.criteria || []).find(value => value.id === item.constraint_id);
          const row = doc.createElement('li');
          const achieved = item.achieved_value == null ? '' : ` · calculado ${formatCriterionValue(item.achieved_value, item.unit)}`;
          row.textContent = `${criterionGoalTitle({ ...item, goal_type: criterion?.goal_type })}: ${presentation().label('criterion', item.status)}${achieved}${item.reason ? ` · ${item.reason}` : ''}`;
          list.append(row);
        }
        coverage.append(list);
      }
      if (explore) {
        explore.hidden = !view.canExplore;
        explore.disabled = busy || !view.canExplore;
        explore.textContent = view.exploreLabel;
      }
      if (result.eligibility_exclusions?.length) {
        const excluded = doc.createElement('p'); excluded.className = 'mtm-criteria-result-detail';
        excluded.textContent = `Sessões excluídas por regra: ${result.eligibility_exclusions.map(item => `${surfaceDateLabel(item.start)}–${surfaceDateLabel(item.end)} (${item.reason})`).join('; ')}.`;
        coverage.append(excluded);
      }
      if (previous.entries?.length) {
        const details = doc.createElement('details');
        const summary = doc.createElement('summary'); summary.textContent = `Cobertura anterior (${previous.entries.length} sessões)`;
        const list = doc.createElement('ol'); list.className = 'mtm-criteria-results';
        for (const entry of previous.entries) {
          const item = doc.createElement('li');
          const title = doc.createElement('div'); title.className = 'mtm-criteria-result-title';
          title.textContent = `${surfaceDateLabel(entry.order_date)} · liquidação ${entry.settlement_date ? surfaceDateLabel(entry.settlement_date) : 'não resolvida'} · ${entry.status === 'NOT_MET' ? 'não atendida' : entry.status === 'EXCLUDED' ? 'excluída por regra' : 'sem dado'}`;
          const reason = doc.createElement('p'); reason.className = 'mtm-criteria-result-detail';
          const criterionReason = (entry.criteria || []).find(item => item.reason)?.reason;
          reason.textContent = entry.reason || criterionReason || 'Avaliada diretamente antes do candidato encontrado.';
          item.append(title, reason); list.append(item);
        }
        details.append(summary, list); coverage.append(details);
      }
    }

    async function exploreFirstDateCandidate() {
      const current = currentFirstDateSearch;
      const output = byId('mtm-first-date-status');
      if (busy || !current || current.identity !== firstDateSearchIdentity()) {
        if (output) output.textContent = 'A busca está desatualizada. Repita-a com as metas e premissas atuais antes de explorar uma data.';
        return;
      }
      const view = firstDateSearchViewModel(current.result, false);
      const candidate = view.candidate;
      const condition = current.result.fixed_exit_condition || {};
      if (!view.canExplore || !candidate || !['ratio', 'BRL_PER_TITLE'].includes(condition.unit)
          || condition.value == null || !lastValidResult) {
        if (output) output.textContent = 'Só é possível explorar um candidato reavaliável que atenda às metas; a operação atual foi preservada.';
        return;
      }
      const selection = firstDateCandidateSelection(candidate, condition);
      if (!selection) {
        if (output) output.textContent = 'A condição encontrada não pode ser enviada para avaliação direta; a operação atual foi preservada.';
        return;
      }
      const input = withoutInstitutionalPointOverrides(lastValidResult.input);
      input.sale_date = selection.sale_date;
      input.exit_price = condition.unit === 'ratio'
        ? { mode: 'MANUAL_RATE', annual_real_rate: String(condition.value), quoted_side: 'SELL' }
        : { mode: 'MANUAL_PU', pu: String(condition.value) };
      input.constraints = serializeCriteria(snapshot()?.criteria || []);
      if (input.knowledge?.date && candidate.order_date > input.knowledge.date) input.intent = 'HYPOTHETICAL';
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = `Reavaliando diretamente ${surfaceDateLabel(candidate.order_date)} com a condição de venda mantida…`;
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        const response = evaluated.response;
        const operation = response?.result?.operation;
        const goalStatus = response?.result?.constraint_evaluation?.status;
        if (!evaluated.accepted || evaluated.goals_current === false || !operation || goalStatus !== 'MET') {
          if (output) output.textContent = 'A avaliação direta não confirmou todas as metas. O resultado anterior e a referência foram preservados.';
          return;
        }
        dispatch({ type: 'SELECT_POINT', point: { ...selection, origin: 'first-date-confirmed' } });
        currentFirstDateSearch = null;
        currentConstraintLimit = null;
        currentEntryBoundarySearch = null;
        currentRateBoundarySearch = { ENTRY: null, EXIT: null };
        surfaceStale = Boolean(currentSurface);
        lastValidResult = {
          input, resolved: response.resolved || currentResolution, response,
          confirmedLocalExit: false, ...resultIdentityFields(), goals_evaluated: true,
        };
        renderResolved(lastValidResult.resolved, response, false, false, inputForSelection(input, selection));
        if (currentSurface) renderSurface(currentSurface, true);
        if (output) output.textContent = `Data ${surfaceDateLabel(candidate.order_date)} explorada e reavaliada diretamente com as metas atendidas. A hipótese de saída e as demais premissas foram mantidas; a referência congelada não foi alterada.`;
        await loadConstraintLimit(input, selection, intent);
        await loadSurface(input, selection, intent, 'RATE_CURVE');
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `A data não foi explorada; o resultado anterior e a referência foram preservados. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); syncActionState(); }
      }
    }

    async function runFirstDateSearch() {
      if (busy) return;
      if (!lastValidResult || lastValidResult.identity !== resultIdentity()) {
        const output = byId('mtm-first-date-status');
        if (output) output.textContent = 'Aplique as metas e avalie a operação atual antes de iniciar a busca.';
        return;
      }
      const start = byId('mtm-first-date-start')?.value;
      const end = byId('mtm-first-date-end')?.value;
      const unit = byId('mtm-first-date-unit')?.value;
      const rawValue = byId('mtm-first-date-value')?.value;
      const output = byId('mtm-first-date-status');
      let fixedValue;
      try {
        if (!start || !end || end < start) throw new TypeError('Informe uma janela de datas válida.');
        const parsed = parsePtDecimal(rawValue, 'Condição fixa');
        if (parsed === null) throw new TypeError('Informe o valor da hipótese fixa.');
        fixedValue = unit === 'ratio' ? shiftDecimal(parsed, -2) : parsed;
        serializeCriteria(snapshot()?.criteria || []);
      } catch (error) {
        if (output) output.textContent = error?.message || String(error);
        return;
      }
      const input = JSON.parse(JSON.stringify(lastValidResult.input));
      input.constraints = serializeCriteria(snapshot()?.criteria || []);
      const query = { kind: 'FIRST_DATE', date_domain: { start, end },
        fixed_exit_condition: { value: fixedValue, unit }, max_evaluations: 4096, deadline_ms: 10000 };
      renderFirstDateAssumptions();
      const searchIdentity = firstDateSearchIdentity();
      const intent = { id: ++intentSequence, action: 'CONSTRAINTS', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = 'Avaliando sessões elegíveis em ordem cronológica…';
      try {
        const response = await request('CONSTRAINTS', 'simulator/workspace', {
          schema_version: 2, action: 'CONSTRAINTS', input, query,
        });
        if (activeIntent !== intent) return;
        if (!response.accepted || !response.response?.result) {
          if (output) output.textContent = 'A busca não foi aceita; as metas e a operação permanecem preservadas.';
          return;
        }
        currentFirstDateSearch = { result: response.response.result, identity: searchIdentity };
        renderFirstDateSearchResult();
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `Não foi possível concluir a busca. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) {
          activeIntent = null; setBusy(false); renderFirstDateSearchResult();
        }
      }
    }

    async function runEntryBoundarySearch() {
      if (busy) return;
      const output = byId('mtm-entry-boundary-status');
      if (!lastValidResult || lastValidResult.identity !== resultIdentity()) {
        if (output) output.textContent = 'Aplique as metas e avalie a operação atual antes de buscar o limite de entrada.';
        return;
      }
      const selection = selectionForCurrentResult();
      if (!selection) {
        if (output) output.textContent = 'A condição de saída avaliada não está disponível; preserve as metas e avalie novamente.';
        return;
      }
      const entryMode = lastValidResult.input?.capital?.mode;
      if (!['BUDGET', 'QUANTITY'].includes(entryMode)) {
        if (output) output.textContent = 'Modo de orçamento/quantidade indisponível para esta operação.';
        return;
      }
      let query;
      let input;
      try {
        const minimum = parsePtDecimal(byId('mtm-entry-boundary-minimum')?.value, 'PU mínimo');
        const maximum = parsePtDecimal(byId('mtm-entry-boundary-maximum')?.value, 'PU máximo');
        const tick = parsePtDecimal(byId('mtm-entry-boundary-tick')?.value, 'Tick de PU');
        if (minimum === null || maximum === null || tick === null) throw new TypeError('Informe PU mínimo, PU máximo e tick.');
        input = inputForSelection(JSON.parse(JSON.stringify(lastValidResult.input)), selection);
        input.constraints = serializeCriteria(snapshot()?.criteria || []);
        query = { kind: 'ENTRY_BOUNDARY', entry_mode: entryMode,
          pu_domain: { minimum, maximum, tick }, max_evaluations: 4096, deadline_ms: 10000 };
      } catch (error) {
        if (output) output.textContent = error?.message || String(error);
        return;
      }
      const searchIdentity = entryBoundarySearchIdentity();
      const intent = { id: ++intentSequence, action: 'CONSTRAINTS', cancelled: false };
      activeIntent = intent; setBusy(true);
      if (output) output.textContent = 'Recalculando quantidade, custos e impostos em cada PU do domínio…';
      try {
        const response = await request('CONSTRAINTS', 'simulator/workspace', {
          schema_version: 2, action: 'CONSTRAINTS', input, query,
        });
        if (activeIntent !== intent) return;
        if (!response.accepted || !response.response?.result) {
          if (output) output.textContent = 'A busca não foi aceita; metas, saída e operação atual permanecem preservadas.';
          return;
        }
        currentEntryBoundarySearch = { result: response.response.result, identity: searchIdentity };
        renderEntryBoundarySearchResult();
      } catch (error) {
        if (activeIntent === intent && output) output.textContent = `Não foi possível concluir a busca. ${error?.message || ''}`.trim();
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    async function exploreEntryBoundary() {
      const current = currentEntryBoundarySearch;
      if (busy || !current || current.identity !== entryBoundarySearchIdentity()
          || current.result?.status !== 'SOLVED' || !current.result.maximum_entry_pu || !current.result.candidate) return;
      const alternatives = snapshot()?.alternatives || [];
      if (alternatives.length >= 2) {
        const output = byId('mtm-entry-boundary-status');
        if (output) output.textContent = 'A alternativa não foi explorada porque o limite de duas alternativas salvas já foi atingido.';
        return;
      }
      const selection = selectionForCurrentResult();
      if (!selection || !lastValidResult) return;
      let constraints;
      try { constraints = serializeCriteria(snapshot()?.criteria || []); }
      catch (error) {
        const output = byId('mtm-entry-boundary-status');
        if (output) output.textContent = error?.message || String(error);
        return;
      }
      const input = inputForSelection(JSON.parse(JSON.stringify(lastValidResult.input)), selection);
      input.entry_price = { mode: 'MANUAL_PU', pu: String(current.result.maximum_entry_pu) };
      input.intent = 'HYPOTHETICAL';
      input.constraints = constraints;
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent; setBusy(true);
      setPending('Reavaliando diretamente o PU-limite antes de alterar o resumo…');
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        const response = evaluated.response;
        const operation = response?.result?.operation;
        const goalStatus = response?.result?.constraint_evaluation?.status;
        if (!evaluated.accepted || evaluated.goals_current === false || !operation || goalStatus !== 'MET') {
          const output = byId('mtm-entry-boundary-status');
          if (output) output.textContent = 'A reavaliação direta não confirmou todas as metas. O resumo e a operação atuais foram preservados.';
          return;
        }
        const previous = lastValidResult;
        const fingerprint = previous.response?.input_fingerprint;
        if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(fingerprint || ''))) {
          const output = byId('mtm-entry-boundary-status');
          if (output) output.textContent = 'O cenário anterior não trouxe fingerprint verificável; a operação atual foi preservada.';
          return;
        }
        const previousInput = previous.input;
        const previousVersions = previous.input?.source_versions || previous.resolved?.source_versions || {};
        const previousProvenance = {
          resolved_prices: previous.resolved?.resolved_prices || {},
          source_resolution: previous.resolved?.source_resolution || previous.response?.source_versions || {},
          quality: previous.response?.result?.quality || previous.response?.result?.operation?.quality || null,
        };
        dispatch({ type: 'PIN_ALTERNATIVE', alternative: {
          id: `entry-boundary-origin-${++intentSequence}`,
          label: 'Operação antes do limite de entrada', draft: snapshot()?.draft, input: previousInput,
          source_versions: previousVersions, provenance: previousProvenance,
          input_fingerprint: fingerprint, selection: snapshot()?.selection,
        } });
        renderCompareContexts();
        const entryField = byId('mtm-workspace-entry-pu');
        if (entryField) entryField.value = formatPtNumber(current.result.maximum_entry_pu, 2);
        updateDraft();
        lastValidResult = { input, resolved: response.resolved || previous.resolved, response,
          confirmedLocalExit: false, ...resultIdentityFields(), goals_evaluated: evaluated.goals_current !== false };
        currentEntryBoundarySearch = null;
        surfaceStale = Boolean(currentSurface);
        renderResolved(lastValidResult.resolved, response, false, false, input);
        if (currentSurface) renderSurface(currentSurface, true);
        await loadConstraintLimit(input, selection, intent);
        await loadSurface(input, selection, intent, 'RATE_CURVE');
        if (activeIntent === intent) setPending('PU-limite reavaliado diretamente. O cenário anterior foi preservado como alternativa.');
      } catch (error) {
        if (activeIntent === intent) {
          const output = byId('mtm-entry-boundary-status');
          if (output) output.textContent = `A reavaliação do limite falhou; a operação atual foi preservada. ${error?.message || ''}`.trim();
        }
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    function renderConstraintLimit(value = currentConstraintLimit) {
      const output = byId('mtm-constraint-limit-status');
      const explore = byId('mtm-constraint-explore');
      if (!output) return;
      if (!value?.result) {
        output.textContent = (snapshot()?.criteria || []).length
          ? 'Limite combinado ainda não calculado para esta seleção.'
          : 'Adicione e aplique ao menos um objetivo para calcular limites.';
        if (explore) explore.hidden = true;
        return;
      }
      const result = value.result;
      const stale = value.identity !== resultIdentity();
      const statusLabels = {
        SOLVED: 'Limite combinado verificado', INFEASIBLE: 'Intervalo sem solução no domínio de PU declarado',
        UNKNOWN: 'Limite sem dado suficiente', AMBIGUOUS: 'Monotonicidade insuficiente no domínio examinado',
        BLOCKED_POLICY: 'Limite bloqueado pela política do produto', VERIFICATION_FAILED: 'Verificação do limite falhou',
        NO_FINANCIAL_BOUND: 'As metas não definem um limite financeiro de PU', NO_CONSTRAINTS: 'Sem metas ativas',
      };
      const date = result.requested_order_date ? ` para ${surfaceDateLabel(result.requested_order_date)}` : '';
      const puRange = result.minimum_exit_pu || result.maximum_exit_pu
        ? ` PU mínimo: ${result.minimum_exit_pu ? formatCurrency(result.minimum_exit_pu, 2) : 'sem piso financeiro'}; PU máximo: ${result.maximum_exit_pu ? formatCurrency(result.maximum_exit_pu, 2) : 'sem teto financeiro'}.`
        : '';
      const candidate = result.candidate_pu ? ` PU reavaliado: ${formatCurrency(result.candidate_pu, 2)}.` : '';
      const domain = result.domain || {};
      const domainText = domain.minimum_pu && domain.maximum_pu
        ? ` Domínio examinado: ${formatCurrency(domain.minimum_pu, 2)} a ${formatCurrency(domain.maximum_pu, 2)}, passo de ${formatCurrency(domain.tick, 2)}; monotonicidade amostrada e bordas/ticks adjacentes reavaliados.`
        : '';
      const rate = result.rate_solution?.status === 'SOLVED' && result.rate_solution.rate
        ? ` Taxa real associada ao PU verificado: ${formatAnnualRate(result.rate_solution.rate, 4)}`
        : '';
      output.textContent = `${stale ? 'Desatualizado · ' : ''}${statusLabels[result.status] || presentation().label('status', result.status)}${date}.${puRange}${candidate}${domainText}${rate}${result.reason ? ` ${result.reason}` : ''}`;
      const canExplore = !stale && result.status === 'SOLVED' && Boolean(result.candidate_pu);
      if (explore) { explore.hidden = !canExplore; explore.disabled = busy || !canExplore; }
    }

    function onCriteriaEdited() {
      if (!openingSnapshot) invalidateSnapshotRecalculation();
      const message = byId('mtm-criteria-message');
      if (message) message.textContent = 'Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.';
      const stale = Boolean(lastValidResult && lastValidResult.identity !== resultIdentity());
      renderConstraintEvaluation(currentEvaluation?.result?.constraint_evaluation, stale, currentEvaluation?.result?.goal_gap);
      renderConstraintLimit();
      showLastValidIfStale();
      syncActionState();
    }

    function explainField(field) {
      if (String(field).startsWith('data.index_anchors')) return 'IPCA mensal no cache local para calcular VNA/VNI';
      if (field === 'data.ipca_monthly_indexes') return 'IPCA mensal no cache local para calcular VNA/VNI';
      const labels = {
        'instrument.family': 'tipo do título', 'instrument.series_year': 'ano do título',
        'analysis_context.timeline.start': 'início do período',
        'analysis_context.timeline.end': 'fim do período',
        'instrument.instrument_id': 'ano do título', 'instrument.maturity_date': 'ano do título',
        'instrument.conversion_date': 'ano do RendA+', 'instrument.first_income_date': 'ano do RendA+',
        'capital.mode': 'modo do capital',
        'capital.value': 'orçamento ou quantidade', purchase_date: 'data da compra', sale_date: 'data da venda',
        'entry_price.mode': 'taxa ou PU de compra', 'exit_price.mode': 'hipótese de saída',
        'assumptions.inflation_projection': 'hipótese explícita de inflação para os meses ainda não disponíveis',
        'assumptions.entry_fee': 'custos de entrada',
        'assumptions.entry_fee.fixed_brl': 'custo fixo de entrada',
        'assumptions.entry_fee.proportional_rate': 'custo proporcional de entrada',
        'assumptions.exit_fee_brl': 'custo de saída',
        'assumptions.custody_override_brl': 'custódia efetivamente cobrada',
        'assumptions.institution_net_brl': 'resgate líquido informado pela instituição',
      };
      return labels[field] || String(field).replaceAll('_', ' ');
    }

    function capabilityMessages(resolved) {
      const missing = [];
      const caps = resolved?.capabilities || {};
      for (const key of ['input_resolution', 'date_resolution', 'price_resolution', 'nominal_evaluation', 'purchase_sizing']) {
        const capability = caps[key];
        if (!capability) continue;
        for (const field of capability.missing_fields || []) if (!missing.includes(field)) missing.push(field);
      }
      return missing.map(explainField);
    }

    function focusPendingAlternative(item, alternative, { focus = true, preserveErrorFeedback = false } = {}) {
      const targetField = alternative?.target_field;
      if (targetField === 'source_versions') {
        doc.querySelector('[data-page="data"]')?.click();
        return null;
      }
      const side = item?.side_names?.[0] || 'purchase';
      const controls = {
        purchase_date: 'mtm-workspace-purchase-date', sale_date: 'mtm-workspace-sale-date',
        'analysis_context.timeline.start': 'mtm-workspace-window-start',
        'analysis_context.timeline.end': 'mtm-workspace-window-end',
        'dates.purchase.confirmation': 'mtm-workspace-purchase-date',
        'dates.sale.confirmation': 'mtm-workspace-sale-date',
        'assumptions.settlement_profile': 'mtm-workspace-settlement',
        'assumptions.inflation_projection': 'mtm-workspace-inflation-rate',
        'data.index_anchors': side === 'sale' ? 'mtm-workspace-sell-anchor' : 'mtm-workspace-buy-anchor',
        'data.price_index_levels': 'mtm-workspace-index-level-add',
        'data.ipca_monthly_indexes': 'mtm-workspace-inflation-rate',
        'entry_price.pu': 'mtm-workspace-entry-pu', 'exit_price.pu': 'mtm-workspace-exit-pu',
        'entry_price.rate': 'mtm-workspace-buy-rate', 'exit_price.rate': 'mtm-workspace-sell-rate',
        'instrument.family': 'mtm-workspace-instrument', 'instrument.series_year': 'mtm-workspace-series-year',
        'instrument.instrument_id': 'mtm-workspace-series-year', 'instrument.maturity_date': 'mtm-workspace-series-year',
        'instrument.conversion_date': 'mtm-workspace-series-year', 'instrument.first_income_date': 'mtm-workspace-series-year',
        knowledge: 'mtm-workspace-knowledge-date',
        'assumptions.entry_fee': 'mtm-workspace-entry-fee',
        'assumptions.entry_fee.fixed_brl': 'mtm-workspace-entry-fee',
        'assumptions.entry_fee.proportional_rate': 'mtm-workspace-entry-rate',
        'assumptions.exit_fee_brl': 'mtm-workspace-exit-fee',
      };
      let priceModeChanged = false;
      if (targetField === 'entry_price.pu') priceModeChanged = activatePriceMode('entry', 'PU');
      else if (targetField === 'entry_price.rate') priceModeChanged = activatePriceMode('entry', 'RATE');
      else if (targetField === 'exit_price.pu') priceModeChanged = activatePriceMode('exit', 'PU');
      else if (targetField === 'exit_price.rate') priceModeChanged = activatePriceMode('exit', 'RATE');
      if (priceModeChanged) {
        const previousPreservation = preserveErrorFeedbackDuringDraft;
        preserveErrorFeedbackDuringDraft = preserveErrorFeedback || previousPreservation;
        try { updateDraft(); }
        finally { preserveErrorFeedbackDuringDraft = previousPreservation; }
      }
      let targetId = controls[targetField];
      if (targetField === 'capital.value') {
        targetId = form.querySelector('input[name="capital-mode"]:checked')?.value === 'QUANTITY'
          ? 'mtm-quantity-value' : 'mtm-budget-value';
      }
      if (targetField === 'assumptions.explicit_settlements.purchase') targetId = 'mtm-workspace-purchase-date';
      if (targetField === 'assumptions.explicit_settlements.sale') targetId = 'mtm-workspace-sale-date';
      const target = targetId ? byId(targetId) : null;
      if (!target) return null;
      doc.dispatchEvent(new CustomEvent('mtm:focus-field', { detail: { id: target.id } }));
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      }
      target.scrollIntoView?.({ block: 'nearest' });
      if (focus) target.focus();
      return target;
    }

    function clearInvalidField() {
      if (!invalidField) return;
      invalidField.removeAttribute('aria-invalid');
      if (invalidFieldDescriptionAdded && errorBox?.id) {
        const descriptions = (invalidField.getAttribute('aria-describedby') || '')
          .split(/\s+/).filter(id => id && id !== errorBox.id);
        if (descriptions.length) invalidField.setAttribute('aria-describedby', descriptions.join(' '));
        else invalidField.removeAttribute('aria-describedby');
      }
      invalidField = null;
      invalidFieldDescriptionAdded = false;
    }

    function clearErrorFeedback() {
      clearInvalidField();
      if (!errorBox) return;
      errorBox.textContent = '';
      errorBox.hidden = true;
    }

    function pendingIssueElement(item) {
      const panel = pendingItemPanelModel(item);
      const row = doc.createElement('li');
      row.className = item.severity === 'BLOCKING' ? 'mtm-pending-item is-blocking' : 'mtm-pending-item is-advisory';
      const title = doc.createElement('h4');
      title.textContent = panel.title;
      const message = doc.createElement('p');
      message.textContent = panel.message;
      const severity = doc.createElement('p');
      severity.className = 'mtm-pending-severity';
      severity.textContent = panel.severity_text;
      row.append(title, message, severity);
      if (panel.relevant_date_text) {
        const dates = doc.createElement('p');
        dates.className = 'mtm-pending-date';
        dates.textContent = panel.relevant_date_text;
        row.append(dates);
      }
      const actions = doc.createElement('div');
      actions.className = 'mtm-pending-actions';
      const dateField = item.field_path === 'dates.purchase.confirmation' ? 'mtm-workspace-purchase-date'
        : item.field_path === 'dates.sale.confirmation' ? 'mtm-workspace-sale-date' : null;
      const suggestion = pendingDateSuggestion(item, pendingResolution?.dates, byId(dateField)?.value);
      if (suggestion) {
        const suggestionDraft = JSON.stringify(snapshot()?.draft);
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'primary';
        button.dataset.confirmDate = suggestion.side;
        button.textContent = `Usar ${suggestion.side === 'sale' ? 'venda' : 'compra'} em ${presentation().formatDate(suggestion.proposed)} e recalcular`;
        button.addEventListener('click', async () => {
          if (busy) return;
          if (JSON.stringify(snapshot()?.draft) !== suggestionDraft) { setPending('As entradas mudaram. Analise novamente antes de usar a data sugerida.'); return; }
          const latest = pendingDateSuggestion(item, pendingResolution?.dates, byId(dateField)?.value);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(suggestion)) { setPending('A data ou o calendário mudou. Analise novamente para obter uma sugestão atual.'); return; }
          byId(dateField).value = suggestion.proposed;
          byId(dateField).dispatchEvent(new Event('input', { bubbles: true }));
          byId(dateField).dispatchEvent(new Event('change', { bubbles: true }));
          await run();
          if (lastValidResult && !resultStaleness(lastValidResult).financial) byId('mtm-output-title')?.focus();
        });
        actions.append(button);
        const explanation = doc.createElement('p'); explanation.className = 'muted';
        explanation.textContent = `A data solicitada será substituída pela ordem sugerida no calendário do simulador; liquidação prevista em ${presentation().formatDate(suggestion.settlement)}.`;
        actions.append(explanation);
      }
      for (const alternative of panel.alternatives) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'subtle';
        button.textContent = alternative.label;
        button.setAttribute('aria-label', `${alternative.label}. ${panel.title}`.trim());
        button.addEventListener('click', () => focusPendingAlternative(item, alternative));
        actions.append(button);
      }
      if (actions.childElementCount) row.append(actions);
      const detail = doc.createElement('details');
      detail.className = 'mtm-pending-origin';
      const summary = doc.createElement('summary');
      summary.textContent = 'Detalhes da pendência';
      const body = doc.createElement('p');
      body.textContent = panel.details_text;
      detail.append(summary, body);
      row.append(detail);
      return row;
    }

    function renderPendingItems(items) {
      const pendingItems = root.MTMEase ? root.MTMEase.orderPending(items) : Array.isArray(items) ? items : [];
      const blocking = pendingItems.filter(item => item?.severity === 'BLOCKING');
      const advisory = pendingItems.filter(item => item?.severity !== 'BLOCKING');
      pendingPanel.hidden = pendingItems.length === 0;
      pendingBlocking.replaceChildren(...blocking.map(pendingIssueElement));
      pendingOptionalItems.replaceChildren(...advisory.map(pendingIssueElement));
      pendingOptionalDetails.hidden = advisory.length === 0;
      if (!pendingItems.length) {
        pendingSummary.textContent = '';
        return;
      }
      pendingTitle.textContent = blocking.length ? 'Pendências desta avaliação' : 'Outras saídas';
      pendingSummary.textContent = blocking.length
        ? `${blocking.length} pendência${blocking.length === 1 ? '' : 's'} impede${blocking.length === 1 ? '' : 'm'} esta operação. Comece pela primeira abaixo; as demais seguem a ordem de preenchimento.`
        : `A operação está disponível. ${advisory.length} saída${advisory.length === 1 ? ' opcional ainda depende' : 's opcionais ainda dependem'} de dados adicionais.`;
      pendingOptionalSummary.textContent = `Outras saídas (${advisory.length})`;
    }

    function setPending(message) {
      const advanced = byId('decision-advanced');
      const compactCurveNotice = advanced && !advanced.open && /^Curva por taxa pronta/.test(message || '');
      if (pending) pending.textContent = compactCurveNotice
        ? 'Resultado calculado. A curva por taxa está disponível em Análise técnica completa.' : message || '';
    }

    function showError(message) {
      if (!errorBox) return;
      clearInvalidField();
      if (!message) {
        errorBox.textContent = '';
        errorBox.hidden = true;
        return;
      }
      const normalized = String(message).toLocaleLowerCase('pt-BR');
      const targetField = /ano do título/.test(normalized) ? 'instrument.series_year'
        : /data de compra|purchase_date/.test(normalized) ? 'purchase_date'
        : /data de venda|sale_date/.test(normalized) ? 'sale_date'
          : /vna|vni|âncora/.test(normalized) ? 'data.index_anchors'
            : /índice de preços/.test(normalized) ? 'data.price_index_levels'
              : /capital|orçamento|quantidade/.test(normalized) ? 'capital.value'
                : /pu de compra/.test(normalized) ? 'entry_price.pu'
                  : /pu de venda/.test(normalized) ? 'exit_price.pu'
                    : /taxa(?: real)? de compra|entry_price/.test(normalized) ? 'entry_price.rate'
                      : /taxa(?: real)? de venda|exit_price/.test(normalized) ? 'exit_price.rate' : null;
      let target = null;
      if (targetField) {
        const side = /data de venda|sale_date/.test(normalized) ? 'sale' : 'purchase';
        target = focusPendingAlternative({ side_names: [side] }, { target_field: targetField }, {
          focus: false,
          preserveErrorFeedback: true,
        });
        if (target?.matches?.('input:not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea')) {
          target.setAttribute('aria-invalid', 'true');
          const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
          invalidFieldDescriptionAdded = !descriptions.includes(errorBox.id);
          if (invalidFieldDescriptionAdded) {
            target.setAttribute('aria-describedby', [...descriptions, errorBox.id].join(' '));
          }
          invalidField = target;
        }
      }
      errorBox.textContent = message;
      errorBox.hidden = false;
      (invalidField || errorBox).focus();
    }

    function fillDetails(resolved, inputOverride = null) {
      const dates = resolved?.dates || {};
      const purchase = dates.purchase || {}, sale = dates.sale || {};
      const profileCode = inputOverride?.assumptions?.settlement_profile || 'SIMULATED_BUY_D1_SELL_D1';
      const profile = presentation().labelWithCode('profile', profileCode);
      const rows = [
        ['Compra pedida', surfaceDateLabel(inputOverride?.purchase_date || byId('mtm-workspace-purchase-date')?.value)],
        ['Compra sugerida pelo calendário', purchase.proposed_order_date || purchase.requested_date
          ? surfaceDateLabel(purchase.proposed_order_date || purchase.requested_date) : 'Não resolvida'],
        ['Liquidação da compra', purchase.settlement_date ? surfaceDateLabel(purchase.settlement_date) : 'Não resolvida'],
        ['Venda pedida', surfaceDateLabel(inputOverride?.sale_date || byId('mtm-workspace-sale-date')?.value)],
        ['Venda sugerida pelo calendário', sale.proposed_order_date || sale.requested_date
          ? surfaceDateLabel(sale.proposed_order_date || sale.requested_date) : 'Não resolvida'],
        ['Liquidação da venda', sale.settlement_date ? surfaceDateLabel(sale.settlement_date) : 'Não resolvida'],
        ['Perfil de liquidação', profile],
      ];
      const list = byId('mtm-workspace-dates');
      if (!list) return;
      list.replaceChildren(...rows.map(([term, description]) => {
        const row = doc.createElement('div'), dt = doc.createElement('dt'), dd = doc.createElement('dd');
        dt.textContent = term; dd.textContent = description; row.append(dt, dd); return row;
      }));
    }

    function focusAssumptionEditTarget(target) {
      if (!target) return;
      let control = null;
      if (target.selector) control = doc.querySelector(target.selector);
      else if (target.kind === 'index-level' && target.date) {
        const row = [...(byId('mtm-workspace-index-levels')?.querySelectorAll('[data-mtm-index-level-row]') || [])]
          .find(item => item.dataset.originalDate === target.date);
        control = row?.querySelector('[data-index-level-field="value"]') || null;
      }
      if (!control) return;
      let ancestor = control.parentElement;
      while (ancestor) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      control.scrollIntoView?.({ block: 'nearest' });
      control.focus();
    }

    function renderAssumptionsUsed(result, resolved, stale = false, unitMode = false) {
      const panelId = unitMode ? 'mtm-unit-price-assumptions-used' : 'mtm-workspace-assumptions-used';
      let panel = byId(panelId);
      if (!panel) {
        panel = doc.createElement('section');
        panel.id = panelId;
        panel.className = 'mtm-execution-assumptions';
        if (unitMode) byId('mtm-unit-price-results')?.append(panel);
        else byId('mtm-workspace-money')?.after(panel);
      }
      const model = workspaceAssumptionsViewModel(result, resolved, stale);
      panel.replaceChildren();
      panel.hidden = model.rows.length === 0 && model.warnings.length === 0;
      if (panel.hidden) return;

      if (model.rows.length) {
        const heading = doc.createElement('h3');
        heading.textContent = model.resolvedOnly ? model.heading : 'Condições usadas';
        const conditionIds = unitMode ? ['entry_price', 'entry_rate', 'inflation_projection']
          : ['exit_price', 'exit_rate', 'inflation_projection'];
        const conditions = model.rows.filter(item => conditionIds.includes(item.id))
          .map(item => `${item.label}: ${item.value} · ${item.state}`);
        const summary = textElement('p', conditions.length ? conditions.join('; ') : model.summary, 'mtm-assumptions-used-summary');
        panel.append(heading, summary);
        if (model.interpolationNote) panel.append(textElement('p', model.interpolationNote, 'mtm-assumptions-interpolation'));
        if (model.stale) panel.append(textElement('p',
          'Esta execução pertence à revisão anterior. Altere os campos e atualize a análise para obter novas premissas.',
          'mtm-assumptions-used-stale'));
      }

      if (model.warnings.length) {
        const warningDetails = doc.createElement('details');
        warningDetails.className = 'mtm-assumptions-warnings';
        warningDetails.append(textElement('summary', `Advertências desta avaliação (${model.warnings.length})`));
        const warningList = doc.createElement('ul');
        for (const warning of model.warnings) warningList.append(textElement('li', warning));
        warningDetails.append(warningList);
        panel.append(warningDetails);
      }
      if (!model.rows.length) return;

      const disclosure = doc.createElement('details');
      disclosure.className = 'mtm-assumptions-used-details';
      disclosure.append(textElement('summary', 'Ver premissas, qualidade e evidências'));
      disclosure.append(textElement('p', model.summary, 'mtm-assumptions-full-context'));
      const groups = new Map();
      for (const item of model.rows) {
        if (!groups.has(item.group)) groups.set(item.group, []);
        groups.get(item.group).push(item);
      }
      for (const [groupName, items] of groups) {
        const group = doc.createElement('section');
        group.className = 'mtm-assumptions-used-group';
        group.append(textElement('h4', groupName));
        const list = doc.createElement('dl');
        list.className = 'mtm-assumptions-used-list';
        for (const item of items) {
          const row = doc.createElement('div');
          row.className = 'mtm-assumptions-used-row';
          const term = doc.createElement('dt');
          term.textContent = item.label;
          const description = doc.createElement('dd');
          description.textContent = item.value;
          row.append(term, description, textElement('small', item.state, 'mtm-assumption-state'));
          if (item.source) row.append(textElement('small', `Fonte: ${item.source}`, 'mtm-assumption-source'));
          if (item.evidence.length) {
            const evidence = doc.createElement('details');
            evidence.className = 'mtm-assumption-evidence';
            evidence.append(textElement('summary', 'Detalhes da evidência'));
            const evidenceList = doc.createElement('dl');
            for (const detail of item.evidence) {
              const evidenceRow = doc.createElement('div');
              evidenceRow.append(textElement('dt', detail.label), textElement('dd', detail.value));
              evidenceList.append(evidenceRow);
            }
            evidence.append(evidenceList);
            row.append(evidence);
          }
          if (item.editTarget) {
            const edit = doc.createElement('button');
            edit.type = 'button';
            edit.className = 'subtle mtm-assumption-edit';
            edit.textContent = 'Alterar';
            edit.setAttribute('aria-label', `Alterar ${item.label}`);
            edit.addEventListener('click', () => focusAssumptionEditTarget(item.editTarget));
            row.append(edit);
          }
          list.append(row);
        }
        group.append(list);
        disclosure.append(group);
      }
      panel.append(disclosure);
      if (!unitMode) syncAnalysisModeVisibility();
    }

    function fillCalculationMemory(steps, stale = false) {
      const section = byId('mtm-workspace-memory');
      const list = byId('mtm-workspace-memory-steps');
      if (!section || !list) return;
      list.replaceChildren();
      if (!Array.isArray(steps) || !steps.length) {
        section.hidden = true;
        return;
      }
      section.hidden = false;
      section.querySelector('summary').textContent = `Memória de cálculo e estados · ${steps.length} etapas${stale ? ' · resultado anterior' : ''}`;
      for (const step of steps) {
        const item = doc.createElement('li');
        const title = doc.createElement('h4');
        title.textContent = step.name || 'Etapa do cálculo';
        item.append(title);
        if (step.formula) {
          const formula = doc.createElement('p');
          formula.textContent = `Regra aplicada: ${step.formula}`;
          item.append(formula);
        }
        if (Array.isArray(step.inputs) && step.inputs.length) {
          const inputs = doc.createElement('dl');
          for (const [name, value] of step.inputs) {
            const term = doc.createElement('dt'), description = doc.createElement('dd');
            term.textContent = name || 'Entrada';
            description.textContent = value == null ? presentation().MISSING : String(value);
            inputs.append(term, description);
          }
          item.append(inputs);
        }
        const output = doc.createElement('p');
        output.textContent = `Saída do motor: ${step.output ?? presentation().MISSING} · Qualidade: ${surfaceQualityLabel(step.quality)}`
          + `${step.policy_id ? ` · Política: ${step.policy_id}` : ''}`
          + `${step.source_ref ? ` · Fonte: ${step.source_ref}` : ''}`;
        item.append(output);
        list.append(item);
      }
    }

    function renderMoney(evaluation, resolved, stale = false) {
      const root = byId('mtm-workspace-money');
      if (!root) return;
      if (!evaluation) {
        root.replaceChildren();
        root.hidden = true;
        delete root.dataset.stale;
        return;
      }
      const model = workspaceMoneyViewModel(evaluation, resolved, stale);
      const nodes = [];
      if (model.stale) nodes.push(textElement('p',
        'Último resultado válido · atualize a análise para refletir os campos atuais.', 'mtm-money-stale'));
      const primary = doc.createElement('div');
      primary.className = 'mtm-money-primary';
      primary.setAttribute('role', 'list');
      for (const item of model.primary) {
        const card = doc.createElement('article');
        card.className = 'mtm-money-item' + (item.metricId === 'net_redemption' ? ' is-headline' : '')
          + (item.available ? '' : ' is-unavailable');
        card.dataset.metricId = item.metricId;
        card.setAttribute('role', 'listitem');
        card.append(textElement('span', item.label, 'mtm-money-label'));
        card.append(textElement('strong', item.value));
        if (item.available && item.metricId === 'real_return') card.append(textElement('small', 'Variação do poder de compra, depois da inflação, impostos e custos.', 'mtm-money-note'));
        if (item.note) card.append(textElement('small', item.note, 'mtm-money-note'));
        if (item.precisionNote) card.append(textElement('small', item.precisionNote, 'mtm-money-note'));
        primary.append(card);
      }
      nodes.push(primary, textElement('p', model.horizon, 'mtm-money-horizon'));
      const decisionContext = doc.createElement('dl');
      decisionContext.className = 'decision-financial-context';
      for (const id of ['initial_outflow', 'nominal_return', 'cash_remainder']) {
        const item = model.secondary.find(metric => metric.metricId === id);
        if (!item) continue;
        const row = doc.createElement('div');
        row.append(textElement('dt', item.label), textElement('dd', item.value));
        decisionContext.append(row);
      }
      nodes.push(decisionContext);
      if (model.secondary.length) {
        const details = doc.createElement('details');
        details.className = 'mtm-money-secondary';
        details.append(textElement('summary', 'Outros valores e bases de retorno'));
        const list = doc.createElement('dl');
        list.className = 'mtm-money-secondary-list';
        for (const item of model.secondary) {
          const row = doc.createElement('div');
          row.dataset.metricId = item.metricId;
          row.append(textElement('dt', item.label), textElement('dd', item.value));
          if (item.note) row.append(textElement('small', item.note, 'mtm-money-note'));
          list.append(row);
        }
        details.append(list);
        nodes.push(details);
      }
      const conclusionModel = workspaceConclusionViewModel(evaluation, stale, false, snapshot()?.criteria || []);
      const conclusion = doc.createElement('section');
      conclusion.className = 'mtm-workspace-conclusion';
      conclusion.append(textElement('h3', 'Leitura deste cenário'));
      const financialSale = resolved?.dates?.sale?.settlement_date;
      if (financialSale) conclusion.append(textElement('p', `Valores da venda com liquidação em ${presentation().formatDate(financialSale)}.`, 'decision-answer-date'));
      conclusion.append(textElement('p', conclusionModel.text, 'mtm-conclusion-copy'));
      const visibleGoalLines = conclusionModel.goalDescriptions || conclusionModel.goalLines;
      if (visibleGoalLines.length) {
        const goals = doc.createElement('ul');
        goals.className = 'mtm-conclusion-goals';
        for (const item of visibleGoalLines) goals.append(textElement('li', item));
        conclusion.append(goals);
      }
      nodes.unshift(conclusion);
      if (window.MTMDecisionCharts?.renderBars) {
        const payload = evaluation?.result || evaluation;
        const metrics = payload?.presentation_summary?.metrics || [];
        const chartItems = [['initial_outflow', 'Valor aplicado', 'invested'], ['net_redemption', 'Você recebe líquido', 'reference']].map(([id, label, series]) => {
          const metric = metrics.find(item => item.metric_id === id && ['AVAILABLE', 'ESTIMATED'].includes(item.status) && ['BRL', 'BRL_EXIT_DATE'].includes(item.unit));
          const view = [...model.primary, ...model.secondary].find(item => item.metricId === id);
          return { label, series, value: metric?.value ?? null, formatted: view?.value || presentation().MISSING };
        });
        const visual = window.MTMDecisionCharts.renderBars(doc, stale ? 'Último cenário calculado · entradas alteradas' : 'Do valor aplicado ao resgate líquido', chartItems,
          `Valores nominais na mesma escala, a partir de R$ 0. ${financialSale ? 'Resgate com liquidação em ' + presentation().formatDate(financialSale) + '. ' : ''}A sobra do orçamento fica separada; retorno real considera também a inflação.`);
        visual.id = 'decision-result-chart'; nodes.unshift(visual);
      }

      const bridge = workspaceCashBridgeViewModel(evaluation);
      if (bridge) {
        const story = doc.createElement('section'); story.className = 'decision-cash-story';
        story.append(textElement('h4', 'Do valor bruto ao que você recebe'));
        const flow = doc.createElement('dl'); flow.className = 'decision-cash-flow';
        for (const id of ['gross_redemption', 'iof', 'income_tax', 'custody', 'exit_expense', 'net_redemption']) {
          const item = bridge.summaryLines.find(line => line.id === id);
          if (!item) continue;
          const row = doc.createElement('div'); row.dataset.cashStep = id;
          row.append(textElement('dt', item.label), textElement('dd', item.amount));
          if (!['Disponível', 'Estimado'].includes(item.status)) row.append(textElement('small', item.status));
          flow.append(row);
        }
        story.append(flow, textElement('p', `Componentes calculados pelo motor. A sobra do orçamento permanece separada. ${bridge.reconciliation}`, 'muted'));
        nodes.push(story);
        const section = doc.createElement('details');
        section.className = 'mtm-cash-bridge decision-cash-details';
        section.append(textElement('summary', 'Ver impostos, custos e caminho do dinheiro'));
        if (bridge.status === 'partial') section.append(textElement('p',
          'A ponte é parcial; componentes sem valor disponível permanecem identificados.', 'mtm-bridge-note'));
        if (bridge.hasCashRemainder) section.append(textElement('p',
          'A sobra de caixa após a compra fica separada do ganho do título.', 'mtm-bridge-note'));
        for (const [name, ids] of [
          ['Compra', ['purchase_gross', 'entry_expense']],
          ['Saída', ['gross_redemption', 'iof', 'income_tax', 'custody', 'exit_expense', 'net_redemption']],
          ['Caixa separado e reconciliação', ['cash_remainder_after_purchase', 'rounding_residual']],
        ]) {
          const items = bridge.summaryLines.filter(item => ids.includes(item.id));
          if (!items.length) continue;
          const group = doc.createElement('section');
          group.className = 'mtm-cash-group';
          group.append(textElement('h4', name));
          const compact = doc.createElement('dl');
          compact.className = 'mtm-cash-bridge-compact';
          for (const item of items) {
            const row = doc.createElement('div');
            row.dataset.componentId = item.id;
            row.append(textElement('dt', item.label), textElement('dd', item.amount));
            row.append(textElement('small', `${item.movement} · ${item.status}`, 'mtm-bridge-line-note'));
            compact.append(row);
          }
          group.append(compact);
          section.append(group);
        }
        const details = doc.createElement('details');
        details.className = 'mtm-cash-bridge-details';
        details.append(textElement('summary', 'Ver ponte completa e reconciliação'));
        const table = doc.createElement('table');
        table.className = 'mtm-cash-bridge-table';
        const caption = doc.createElement('caption');
        caption.textContent = 'Componentes informados pelo cálculo, sem somas estimadas pela tela.';
        table.append(caption);
        const head = doc.createElement('thead'), header = doc.createElement('tr');
        for (const label of ['Componente', 'Movimento', 'Valor', 'Estado', 'Origem']) {
          const cell = doc.createElement('th'); cell.scope = 'col'; cell.textContent = label; header.append(cell);
        }
        head.append(header); table.append(head);
        const body = doc.createElement('tbody');
        for (const item of bridge.lines) {
          const row = doc.createElement('tr');
          for (const [index, value] of [item.label, item.movement, item.amount, item.status, item.source].entries()) {
            const cell = doc.createElement(index === 0 ? 'th' : 'td');
            if (index === 0) cell.scope = 'row';
            cell.textContent = value; row.append(cell);
          }
          body.append(row);
        }
        table.append(body);
        const tableRegion = doc.createElement('div');
        tableRegion.className = 'mtm-cash-bridge-table-wrap';
        tableRegion.setAttribute('role', 'region');
        tableRegion.tabIndex = 0;
        tableRegion.setAttribute('aria-label', 'Tabela completa do caminho do dinheiro');
        tableRegion.append(table);
        details.append(tableRegion);
        const totals = doc.createElement('dl');
        totals.className = 'mtm-cash-bridge-totals';
        for (const item of bridge.totals) {
          const row = doc.createElement('div');
          row.append(textElement('dt', item.label), textElement('dd', item.value)); totals.append(row);
        }
        details.append(totals, textElement('p', bridge.reconciliation, 'mtm-bridge-note'));
        section.append(details); nodes.push(section);
      }
      root.replaceChildren(...nodes);
      root.hidden = false;
      root.dataset.stale = model.stale ? 'true' : 'false';
    }

    function surfaceDateLabel(value) {
      return presentation().formatDate(value);
    }

    function surfaceCoordinateLabel(point) {
      if (point.coordinateRaw == null) return presentation().MISSING;
      return point.coordinateUnit === 'ratio'
        ? formatAnnualRate(point.coordinateRaw, 2)
        : formatCurrency(point.coordinateRaw, 2);
    }

    function surfaceMetricValueLabel(point) {
      if (point.valueRaw == null || point.metricStatus !== 'ready') return presentation().MISSING;
      if (point.metricUnit === 'BRL_PER_TITLE') return `${formatCurrency(point.valueRaw, 4)} por título`;
      return point.metricUnit === 'BRL'
        ? formatCurrency(point.valueRaw, 2)
        : formatRatioPercent(point.valueRaw, 2);
    }

    function surfaceStatusLabel(status) {
      return presentation().label('status', status);
    }

    function surfaceQualityLabel(quality) {
      return presentation().label('quality', quality);
    }

    function surfacePointWarningMessages(point) {
      const explanation = deduplicateSurfaceMessage(point.reason);
      const source = surfaceSourceReferenceLabel(point.sourceRef);
      const sourceDetail = source && explanation
        && (explanation.includes(source) || source.includes(explanation)) ? '' : source;
      return [...new Set([explanation, sourceDetail].filter(Boolean).map(localizeWarning).filter(Boolean))];
    }

    function setSurfaceSelectionNotice(message, action = null) {
      const status = byId('mtm-surface-selection-status');
      if (status) status.textContent = message;
      surfaceTableSelectionAction = action;
      surfaceSelectionActionButton.hidden = !action;
      if (!action) return;
      surfaceSelectionActionButton.textContent = action.type === 'clear_filters'
        ? 'Mostrar seleção na tabela' : 'Ir à página da seleção';
      surfaceSelectionActionButton.title = action.type === 'clear_filters'
        ? 'Remove os filtros atuais para mostrar o ponto selecionado.'
        : `Mostra o ponto selecionado na página ${action.page + 1} sem alterar os filtros.`;
    }

    function surfaceConstraintLabel(point) {
      if (surfaceStale && (snapshot()?.criteria || []).length) return 'Mapa desatualizado';
      return presentation().label('goal', point.constraintEvaluation?.status);
    }

    function surfaceFrontierConditionText(point, id, withMargin = false) {
      const condition = point?.frontier_conditions?.[id];
      if (!condition) return presentation().MISSING;
      let value = g4FrontierConditionLabel(condition.status);
      if (withMargin && condition.margin?.value != null) value += `; margem ${formatCurrency(condition.margin.value, 2)}`;
      if (condition.reason) value += `; ${condition.reason}`;
      return value;
    }

    function populateSurfaceFilter(select, values, allLabel, formatter) {
      if (!select) return;
      const prior = select.value;
      const options = [doc.createElement('option')];
      options[0].value = '';
      options[0].textContent = allLabel;
      for (const value of values) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = formatter(value);
        options.push(option);
      }
      select.replaceChildren(...options);
      select.value = values.includes(prior) ? prior : '';
    }

    function syncSurfaceAction() {
      const button = byId('mtm-surface-apply');
      if (button) button.disabled = busy || surfaceStale || !pendingSurfacePoint || pendingSurfacePoint.metricStatus !== 'ready';
      const tableRoot = byId('mtm-unified-surface-table');
      for (const choose of tableRoot?.querySelectorAll('button[data-metric-status]') || []) {
        choose.disabled = busy || surfaceStale || choose.dataset.metricStatus !== 'ready';
      }
    }

    function stageSurfacePoint(pointId) {
      if (surfaceStale || !currentSurface || currentSurface.result?.mode === 'UNIT_PRICE_RATE_CURVE') return;
      const point = currentSurface.result?.points?.find(item => (item.identity || `${item.order_date}|${item.coordinate?.value}`) === pointId);
      if (!point) return;
      const modelPoint = surfaceViewModel(currentSurface, byId('mtm-surface-metric')?.value)?.points
        .find(item => item.pointId === pointId);
      if (!modelPoint || modelPoint.metricStatus !== 'ready') return;
      pendingSurfacePoint = { ...modelPoint };
      surfaceTableState.ensureSelectionPage = true;
      const status = byId('mtm-surface-selection-status');
      if (status) status.textContent = `Ponto escolhido: ${surfaceDateLabel(point.order_date)} · ${surfaceCoordinateLabel(modelPoint)} · liquidação ${surfaceDateLabel(point.settlement_date)} · ${surfaceMetricValueLabel(modelPoint)}. Avalie para atualizar o resumo.`;
      syncSurfaceAction();
      renderSurface(currentSurface, false);
      byId('mtm-surface-apply')?.focus();
    }

    function renderSurfaceChart(model, visiblePoints) {
      const plot = byId('mtm-surface-plot'), fallback = byId('mtm-surface-fallback');
      if (!plot || !fallback) return;
      const plotly = typeof window !== 'undefined' ? window.Plotly : null;
      const unavailableMessage = surfaceChartFallbackMessage(plotly);
      if (unavailableMessage) {
        plot.hidden = true;
        fallback.hidden = false;
        fallback.textContent = unavailableMessage;
        return;
      }
      if (!visiblePoints.length || !model.dates.length || !model.coordinates.length) {
        plot.hidden = true;
        fallback.hidden = false;
        fallback.textContent = 'Não há coordenadas para este recorte. Limpe os filtros ou consulte a tabela.';
        if (typeof plotly.purge === 'function') plotly.purge(plot);
        return;
      }
      plot.hidden = false;
      fallback.hidden = true;
      if (model.mode === 'DATE_CURVE') {
        const ordered = [...visiblePoints].sort((left, right) => left.order_date.localeCompare(right.order_date));
        const unavailablePoints = ordered.filter(point => point.valueNumber === null);
        const customdata = ordered.map(point => ({
          settlement: surfaceDateLabel(point.settlement_date),
          coordinate: surfaceCoordinateLabel(point),
          value: surfaceMetricValueLabel(point),
          status: surfaceStatusLabel(point.metricStatus),
          quality: surfaceQualityLabel(point.quality),
        }));
        const unitSuffix = model.metricUnit === 'BRL' ? 'R$' : model.metricUnit === 'ratio_per_year' ? '% a.a.' : '%';
        const traces = [{
          type: 'scatter', mode: 'lines+markers', name: model.metricLabel,
          x: ordered.map(point => point.order_date),
          y: ordered.map(point => point.valueNumber),
          customdata,
          connectgaps: false,
          line: { color: '#167b66', width: 2.5 },
          marker: { size: 6, color: '#167b66' },
          hovertemplate: '<b>Solicitação: %{x}</b><br>Liquidação: %{customdata.settlement}<br>'
            + '%{customdata.coordinate}<br>' + `${model.metricLabel}: %{customdata.value}<br>`
            + '%{customdata.status} · %{customdata.quality}<extra></extra>',
        }];
        if (unavailablePoints.length) traces.push({
          type: 'scatter', mode: 'markers', name: 'Sem valor disponível',
          x: unavailablePoints.map(point => point.order_date),
          y: unavailablePoints.map(() => null),
          customdata: unavailablePoints.map(point => ({
            settlement: surfaceDateLabel(point.settlement_date), status: surfaceStatusLabel(point.metricStatus),
            quality: surfaceQualityLabel(point.quality),
          })),
          marker: { symbol: 'x', size: 9, color: '#263b45' },
          hovertemplate: '<b>Sem valor disponível</b><br>Solicitação: %{x}<br>Liquidação: %{customdata.settlement}<br>'
            + '%{customdata.status} · %{customdata.quality}<extra></extra>',
        });
        const tickCount = Math.min(model.dates.length, Math.max(2, Math.floor(plot.clientWidth / 100)));
        surfaceChartTickCount = tickCount;
        surfaceChartNarrowLayout = plot.clientWidth < 480;
        const layout = {
          autosize: true, margin: { l: 78, r: 25, t: 18, b: 70 },
          uirevision: 'mtm-workspace-date-curve', paper_bgcolor: '#fff', plot_bgcolor: '#fff',
          font: { family: 'system-ui, Segoe UI, sans-serif', color: '#17313D', size: 13 },
          xaxis: { title: { text: 'Data solicitada' }, type: 'date', tickformat: '%d/%m/%Y',
            tickangle: surfaceChartNarrowLayout ? -45 : -30, gridcolor: '#e3eaed', automargin: true },
          yaxis: { title: { text: `${model.metricLabel} (${unitSuffix})` }, gridcolor: '#e3eaed', automargin: true,
            tickprefix: model.metricUnit === 'BRL' ? 'R$ ' : '',
            ticksuffix: model.metricUnit === 'ratio' || model.metricUnit === 'ratio_per_year' ? '%' : '',
            tickformat: model.metricUnit === 'BRL' ? ',.2f' : '.2f' },
          hovermode: 'closest', dragmode: 'zoom', showlegend: false,
        };
        plot.setAttribute('aria-label', `${model.metricLabel} durante ${model.dates.length} datas do período, mantendo ${model.coordinateLabel} constante.`);
        try {
          const rendered = plotly.react(plot, traces, layout, {
            responsive: true, scrollZoom: true, displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
          });
          if (rendered?.then) rendered.catch(error => {
            fallback.hidden = false;
            fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
          });
        } catch (error) {
          fallback.hidden = false;
          fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
        }
        return;
      }
      if (model.mode === 'RATE_CURVE' || model.mode === 'UNIT_PRICE_RATE_CURVE') {
        const ordered = [...visiblePoints].sort((left, right) => left.coordinateNumber - right.coordinateNumber);
        const unitPriceCurve = model.mode === 'UNIT_PRICE_RATE_CURVE';
        const customdata = ordered.map(point => ({
          date: surfaceDateLabel(point.order_date), value: surfaceMetricValueLabel(point),
          status: surfaceStatusLabel(point.metricStatus), quality: surfaceQualityLabel(point.quality), pointId: point.pointId,
        }));
        const unitSuffix = model.metricUnit === 'BRL' ? 'R$'
          : model.metricUnit === 'BRL_PER_TITLE' ? 'R$/título'
            : model.metricUnit === 'ratio_per_year' ? '% a.a.' : '%';
        const traces = [{
          type: 'scatter', mode: 'lines+markers', name: model.metricLabel,
          x: ordered.map(point => point.coordinateNumber),
          y: ordered.map(point => point.valueNumber), customdata, connectgaps: false,
          line: { color: '#167b66', width: 2.5 }, marker: { size: 7, color: '#167b66' },
          hovertemplate: '<b>Taxa: %{x:.2f}% a.a.</b><br>Data: %{customdata.date}<br>'
            + `${model.metricLabel}: %{customdata.value}<br>%{customdata.status} · %{customdata.quality}<extra></extra>`,
        }];
        const selectedPoints = ordered.filter(point => point.selected && point.valueNumber !== null);
        if (selectedPoints.length) traces.push({
          type: 'scatter', mode: 'markers', name: 'Seleção avaliada',
          x: selectedPoints.map(point => point.coordinateNumber),
          y: selectedPoints.map(point => point.valueNumber),
          customdata: selectedPoints.map(point => ({
            date: surfaceDateLabel(point.order_date), value: surfaceMetricValueLabel(point),
            status: surfaceStatusLabel(point.metricStatus), quality: surfaceQualityLabel(point.quality), pointId: point.pointId,
          })),
          marker: { symbol: 'square-open', size: 15, color: '#172c37', line: { width: 2.5, color: '#172c37' } },
          hovertemplate: '<b>Seleção avaliada</b><br>Taxa: %{x:.2f}% a.a.<br>Data: %{customdata.date}<br>'
            + `${model.metricLabel}: %{customdata.value}<extra></extra>`,
        });
        const tickCount = Math.min(ordered.length, Math.max(2, Math.floor(plot.clientWidth / 100)));
        surfaceChartTickCount = tickCount;
        surfaceChartNarrowLayout = plot.clientWidth < 480;
        const layout = {
          autosize: true, margin: { l: 88, r: 25, t: 18, b: 70 },
          uirevision: `mtm-workspace-rate-curve-${unitPriceCurve ? 'unit' : 'operation'}`,
          paper_bgcolor: '#fff', plot_bgcolor: '#fff',
          font: { family: 'system-ui, Segoe UI, sans-serif', color: '#17313D', size: 13 },
          xaxis: { title: { text: 'Taxa real (% a.a.)' }, ticksuffix: '%', tickformat: '.2f',
            gridcolor: '#e3eaed', automargin: true },
          yaxis: { title: { text: `${model.metricLabel} (${unitSuffix})` }, gridcolor: '#e3eaed', automargin: true,
            tickprefix: ['BRL', 'BRL_PER_TITLE'].includes(model.metricUnit) ? 'R$ ' : '',
            ticksuffix: model.metricUnit === 'ratio' || model.metricUnit === 'ratio_per_year' ? '%' : '',
            tickformat: model.metricUnit === 'BRL' || model.metricUnit === 'BRL_PER_TITLE' ? ',.4f' : '.2f' },
          hovermode: 'closest', dragmode: 'zoom', showlegend: false,
        };
        plot.setAttribute('aria-label', `${model.metricLabel} por taxa real anual, em ${ordered.length} taxas calculadas; pontos sem valor não são ligados.`);
        plot._mtmSurfaceSelect = stageSurfacePoint;
        try {
          const rendered = plotly.react(plot, traces, layout, {
            responsive: true, scrollZoom: true, displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
          });
          const bindClick = () => {
            if (typeof plot.on !== 'function' || plot._mtmSurfaceClickBound) return;
            plot._mtmSurfaceClickBound = true;
            plot.on('plotly_click', event => {
              const clicked = event?.points?.find(item => item?.customdata?.pointId);
              if (clicked?.customdata?.pointId) plot._mtmSurfaceSelect?.(clicked.customdata.pointId);
            });
          };
          if (rendered?.then) rendered.then(bindClick).catch(error => {
            fallback.hidden = false;
            fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
          });
          else bindClick();
        } catch (error) {
          fallback.hidden = false;
          fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
        }
        return;
      }
      const criteriaConfigured = Boolean((snapshot()?.criteria || []).length);
      const cells = new Map(visiblePoints.map(point => [`${point.order_date}\u0000${point.coordinateRaw}`, point]));
      const customdata = model.coordinates.map(coordinate => model.dates.map(orderDate => {
        const point = cells.get(`${orderDate}\u0000${coordinate}`);
        return point ? {
          pointId: point.pointId,
          settlement: surfaceDateLabel(point.settlement_date),
          coordinate: surfaceCoordinateLabel(point),
          value: surfaceMetricValueLabel(point),
          status: surfaceStatusLabel(point.metricStatus),
          quality: surfaceQualityLabel(point.quality),
          goals: surfaceHoverGoalSummary(point, surfaceStale && criteriaConfigured),
        } : { status: 'Fora deste recorte', value: presentation().MISSING };
      }));
      const yValues = model.coordinates.map(value => {
        const numeric = Number(value);
        return model.coordinateUnit === 'ratio' ? numeric * 100 : numeric;
      });
      const visibleCells = new Set(visiblePoints.map(point => `${point.order_date}\u0000${point.coordinateRaw}`));
      const visiblePointByCell = new Map(visiblePoints.map(point => [`${point.order_date}\u0000${point.coordinateRaw}`, point]));
      const goalsActive = model.constraintsActive && !surfaceStale && criteriaConfigured;
      const visibleMatrix = model.coordinates.map(coordinate => model.dates.map(orderDate => (
        visibleCells.has(`${orderDate}\u0000${coordinate}`) ? visiblePointByCell.get(`${orderDate}\u0000${coordinate}`)?.valueNumber ?? null : null
      )));
      const unavailable = visiblePoints.filter(point => point.valueNumber === null);
      const traces = [{
        type: 'heatmap',
        x: model.dates,
        y: yValues,
        z: visibleMatrix,
        customdata,
        colorscale: model.colorscale,
        zmin: model.range.zmin,
        zmax: model.range.zmax,
        colorbar: { title: { text: `${model.metricLabel} (${model.unitLabel})`, side: 'right' }, ticks: 'outside' },
        hoverongaps: true,
        hovertemplate: '<b>Solicitação: %{x}</b><br>Liquidação: %{customdata.settlement}<br>%{customdata.coordinate}<br>'
          + `${model.metricLabel}: %{customdata.value}<br>%{customdata.status} · %{customdata.quality}`
          + '<br>%{customdata.goals}<extra></extra>',
      }];
      if (unavailable.length) {
        traces.push({
          type: 'scatter', mode: 'markers', name: 'Sem valor disponível',
          x: unavailable.map(point => point.order_date),
          y: unavailable.map(point => point.coordinateNumber),
          customdata: unavailable.map(point => ({
            settlement: surfaceDateLabel(point.settlement_date),
            coordinate: surfaceCoordinateLabel(point),
            status: surfaceStatusLabel(point.metricStatus),
            quality: surfaceQualityLabel(point.quality),
            goals: surfaceHoverGoalSummary(point, surfaceStale && criteriaConfigured),
          })),
          marker: { symbol: 'x', size: 10, color: '#263b45', line: { width: 1.5 } },
          hovertemplate: '<b>Sem valor disponível</b><br>Solicitação: %{x}<br>Liquidação: %{customdata.settlement}<br>'
            + '%{customdata.coordinate}<br>%{customdata.status} · %{customdata.quality}'
            + '<br>%{customdata.goals}<extra></extra>',
        });
      }
      const goalOverlay = goalsActive
        ? surfaceGoalOverlayModel(visiblePoints, model.dates, model.coordinates)
        : { matrix: [], met: [], unknown: [] };
      const meetingGoals = goalOverlay.met;
      const unknownGoals = goalOverlay.unknown;
      const goalStates = goalOverlay.matrix;
      if (model.dates.length > 1 && model.coordinates.length > 1
          && meetingGoals.length && visiblePoints.some(point => point.constraintStatus === 'NOT_MET')) {
        traces.push({
          type: 'contour', name: 'Limite aproximado na grade', x: model.dates, y: yValues, z: goalStates,
          autocontour: false, ncontours: 1, connectgaps: false,
          contours: { start: .5, end: .5, size: 1, coloring: 'none', showlabels: false },
          line: { color: '#0b6748', width: 2, dash: 'dash' }, showscale: false,
          hoverinfo: 'skip',
        });
      }
      if (meetingGoals.length) {
        traces.push({
          type: 'scatter', mode: 'markers', name: 'Atende todas as metas',
          x: meetingGoals.map(point => point.order_date),
          y: meetingGoals.map(point => point.coordinateNumber),
          customdata: meetingGoals.map(point => ({
            settlement: surfaceDateLabel(point.settlement_date), coordinate: surfaceCoordinateLabel(point),
            value: surfaceMetricValueLabel(point),
          })),
          marker: {
            symbol: 'circle', size: plot.clientWidth < 480 ? 4 : 6, color: '#0b6748',
            line: { width: 1, color: '#ffffff' },
          },
          hovertemplate: '<b>Atende todas as metas</b><br>Solicitação: %{x}<br>Liquidação: %{customdata.settlement}'
            + '<br>%{customdata.coordinate}<br>' + `${model.metricLabel}: %{customdata.value}<extra></extra>`,
        });
      }
      if (unknownGoals.length) {
        traces.push({
          type: 'scatter', mode: 'markers', name: 'Meta sem dado suficiente',
          x: unknownGoals.map(point => point.order_date), y: unknownGoals.map(point => point.coordinateNumber),
          customdata: unknownGoals.map(point => ({ goal: surfaceHoverGoalSummary(point) })),
          marker: { symbol: 'diamond-open', size: plot.clientWidth < 480 ? 7 : 9, color: '#9a5b00', line: { width: 1.6 } },
          hovertemplate: '<b>Meta sem dado suficiente</b><br>%{customdata.goal}<extra></extra>',
        });
      }
      const current = snapshot();
      const evaluatedSelection = selectionForCurrentResult();
      const baseSelection = current?.scenario_mode === 'EXPLORANDO'
        ? surfaceSelectionForScenario(baseContext?.input, baseContext?.selection) : evaluatedSelection;
      const selectionSelection = pendingSurfacePoint
        ? surfaceSelectionForScenario({}, {
          sale_date: pendingSurfacePoint.order_date,
          ...(pendingSurfacePoint.coordinateUnit === 'ratio'
            ? { annual_real_rate: pendingSurfacePoint.coordinateRaw }
            : { exit_pu: pendingSurfacePoint.coordinateRaw }),
        }) : evaluatedSelection;
      const reference = current?.reference;
      const referenceSelection = surfaceSelectionForScenario(reference?.input, reference?.selection);
      const contextMarkers = surfaceContextMarkers(model.points, {
        base: baseSelection, selection: selectionSelection, reference: referenceSelection,
      });
      const markerStyle = {
        base: { symbol: 'diamond-open', size: 22, color: '#167b66', line: { width: 2.5, color: '#167b66' } },
        selection: { symbol: 'square-open', size: 16, color: '#172c37', line: { width: 2.5, color: '#172c37' } },
        reference: { symbol: 'circle-open', size: 10, color: '#7045a2', line: { width: 2.5, color: '#7045a2' } },
      };
      for (const role of ['base', 'selection', 'reference']) {
        const marker = contextMarkers.find(item => item.role === role);
        if (!marker) continue;
        const isVisible = marker.point && visibleCells.has(`${marker.point.order_date}\u0000${marker.point.coordinateRaw}`);
        const label = role === 'base' ? 'Cenário-base'
          : role === 'selection' ? (pendingSurfacePoint ? 'Ponto escolhido' : 'Seleção avaliada') : 'Referência salva';
        const point = isVisible ? marker.point : null;
        const outsideLabel = isVisible ? '' : marker.point ? ' (fora do filtro)' : ' (fora da grade)';
        traces.push({
          type: 'scatter', mode: 'markers', name: `${label}${outsideLabel}`,
          x: point ? [point.order_date] : [null], y: point ? [point.coordinateNumber] : [null],
          marker: markerStyle[role], hoverinfo: 'skip',
        });
      }
      const zoom = snapshot()?.view?.zoom || {};
      const dateTickCount = Math.min(model.dates.length, Math.max(2, Math.floor(plot.clientWidth / 100)));
      surfaceChartTickCount = dateTickCount;
      surfaceChartNarrowLayout = plot.clientWidth < 480;
      const firstDate = Date.parse(model.dates[0]), lastDate = Date.parse(model.dates[model.dates.length - 1]);
      let previousIndex = -1;
      const chartDateTicks = Array.from({ length: dateTickCount }, (_, tickIndex) => {
        const target = firstDate + (lastDate - firstDate) * tickIndex / (dateTickCount - 1);
        const latestIndex = model.dates.length - (dateTickCount - tickIndex);
        let bestIndex = previousIndex + 1, bestDistance = Infinity;
        for (let index = bestIndex; index <= latestIndex; index += 1) {
          const distance = Math.abs(Date.parse(model.dates[index]) - target);
          if (distance < bestDistance) { bestIndex = index; bestDistance = distance; }
        }
        previousIndex = bestIndex;
        return model.dates[bestIndex];
      });
      const layout = {
        autosize: true, margin: { l: 78, r: 35, t: 18, b: goalsActive || contextMarkers.length ? 118 : 76 },
        uirevision: 'mtm-workspace-surface',
        paper_bgcolor: '#fff', plot_bgcolor: '#fff',
        font: { family: 'system-ui, Segoe UI, sans-serif', color: '#17313D', size: 13 },
        xaxis: { title: { text: 'Data solicitada' }, type: 'date', tickformat: '%d/%m/%Y',
          tickvals: chartDateTicks, ticktext: chartDateTicks.map(surfaceDateLabel),
          tickangle: surfaceChartNarrowLayout ? -45 : -30,
          ...(surfaceChartNarrowLayout ? { tickfont: { size: 12 } } : {}), gridcolor: '#e3eaed', automargin: true,
          ...(zoom.x ? { range: zoom.x, autorange: false } : {}) },
        yaxis: {
          title: { text: model.coordinateLabel }, gridcolor: '#e3eaed', automargin: true,
          ticksuffix: model.coordinateUnit === 'ratio' ? '%' : '',
          tickprefix: model.coordinateUnit === 'BRL_PER_TITLE' ? 'R$ ' : '',
          tickformat: model.coordinateUnit === 'ratio' ? '.2f' : ',.2f',
          ...(zoom.y ? { range: zoom.y, autorange: false } : {}),
        },
        hovermode: 'closest', dragmode: 'zoom', showlegend: goalsActive || contextMarkers.length > 0,
        ...(goalsActive || contextMarkers.length ? { legend: { orientation: 'h', y: -0.4, font: { size: 12 } } } : {}),
      };
      plot.setAttribute('aria-label', `${model.metricLabel}, ${model.coordinateLabel}, ${model.dates.length} datas e ${model.coordinates.length} coordenadas.`
        + (goalsActive ? ` ${meetingGoals.length} células da grade amostrada atendem a todas as metas; contagem do domínio examinado, não probabilidade.` : '')
        + (contextMarkers.length ? ` A legenda identifica base, seleção e referência; cada marcador aparece quando a coordenada pertence ao recorte visível.` : ''));
      const bindClick = () => {
        if (typeof plot.on !== 'function') return;
        if (!plot._mtmSurfaceClickBound) {
          plot._mtmSurfaceClickBound = true;
          plot.on('plotly_click', event => {
            const clicked = event?.points?.find(item => item?.customdata?.pointId);
            if (clicked?.customdata?.pointId) plot._mtmSurfaceSelect?.(clicked.customdata.pointId);
          });
        }
        if (!plot._mtmSurfaceRelayoutBound) {
          plot._mtmSurfaceRelayoutBound = true;
          plot.on('plotly_relayout', event => {
            const next = { ...(snapshot()?.view?.zoom || {}) };
            if (event?.['xaxis.autorange']) delete next.x;
            else if (event?.['xaxis.range[0]'] !== undefined && event?.['xaxis.range[1]'] !== undefined) {
              next.x = [String(event['xaxis.range[0]']), String(event['xaxis.range[1]'])];
            }
            if (event?.['yaxis.autorange']) delete next.y;
            else if (event?.['yaxis.range[0]'] !== undefined && event?.['yaxis.range[1]'] !== undefined) {
              next.y = [event['yaxis.range[0]'], event['yaxis.range[1]']];
            }
            changeView({ zoom: next }, 'view:zoom');
          });
        }
      };
      plot._mtmSurfaceSelect = stageSurfacePoint;
      try {
        const rendered = plotly.react(plot, traces, layout, {
          responsive: true, scrollZoom: true, displaylogo: false,
          modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
        });
        if (rendered?.then) rendered.then(bindClick).catch(error => {
          fallback.hidden = false;
          fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
        });
        else bindClick();
      } catch (error) {
        fallback.hidden = false;
        fallback.textContent = `Gráfico indisponível; a tabela acessível continua disponível. ${error?.message || ''}`;
      }
    }

    function renderSurface(surfaceResponse, stale = false) {
      if (surfaceResponse) currentSurface = surfaceResponse;
      if (typeof stale === 'boolean') surfaceStale = stale;
      const section = byId('mtm-surface-view');
      if (!section || !currentSurface?.result) {
        if (section) section.hidden = true;
        syncSurfaceAction();
        return;
      }
      section.hidden = false;
      const staleNotice = byId('mtm-surface-stale');
      if (staleNotice) staleNotice.hidden = !surfaceStale;
      const metricSelect = byId('mtm-surface-metric');
      const metricId = metricSelect?.value || 'net_redemption';
      const model = surfaceViewModel(currentSurface, metricId);
      if (!model) {
        section.hidden = true;
        syncSurfaceAction();
        return;
      }
      const isReadOnlyDateCurve = model?.mode === 'DATE_CURVE'
        && selectedAnalysisModes().resultMode === 'OPERATION'
        && selectedAnalysisModes().timelineMode === 'WINDOW';
      const isUnitPriceCurve = model.mode === 'UNIT_PRICE_RATE_CURVE';
      const readOnlyCurve = isReadOnlyDateCurve || isUnitPriceCurve;
      activeSurfaceView = model.mode === 'DATE_CURVE' ? 'time'
        : model.mode === 'UNIT_PRICE_RATE_CURVE' || model.mode === 'RATE_CURVE' ? 'rate' : 'map';
      for (const button of doc.querySelectorAll('[data-mtm-surface-view]')) {
        const view = button.dataset.mtmSurfaceView;
        button.setAttribute('aria-pressed', String(view === activeSurfaceView));
        button.hidden = (view === 'time' && selectedAnalysisModes().timelineMode !== 'WINDOW')
          || (view === 'map' && selectedAnalysisModes().resultMode === 'UNIT_PRICE');
      }
      const metricWrap = byId('mtm-surface-metric-wrap');
      if (metricWrap) metricWrap.hidden = isUnitPriceCurve;
      const selectionRow = byId('mtm-surface-select-row');
      if (selectionRow) selectionRow.hidden = readOnlyCurve;
      const surfaceTitle = byId('mtm-surface-title');
      if (surfaceTitle) surfaceTitle.textContent = isReadOnlyDateCurve ? 'Resultado ao longo do período'
        : isUnitPriceCurve ? 'Preço unitário por taxa real' : model.mode === 'RATE_CURVE'
          ? 'Resultado por taxa real' : 'Mapa avançado de sensibilidade';
      const isG4Frontier = Boolean(currentSurface.result?.frontiers);
      if (isG4Frontier && surfaceTitle) surfaceTitle.textContent = 'Fronteiras G4: taxa real e data de saída';
      const coverageText = byId('mtm-surface-coverage');
      if (coverageText) {
        const coverage = currentSurface.coverage || {};
        const domain = coverage.domain || {};
        const sampledDates = domain.sampled_order_dates?.length ?? currentSurface.result.points.length;
        const candidateDates = domain.candidate_order_dates?.length ?? sampledDates;
        const sampledValues = domain.sampled_values?.length ?? 1;
        const omittedDates = coverage.omitted_dates?.length || 0;
        const omittedValues = coverage.omitted_values?.length || 0;
        if (isUnitPriceCurve) {
          coverageText.textContent = `${coverage.priced_points ?? 0} de ${coverage.requested_points ?? model.points.length} preços unitários disponíveis. Curva hipotética; não cria capital nem operação.`;
        } else {
          const modeLabel = coverage.status === 'sampled' ? 'Amostrada' : 'Completa no domínio discreto';
          coverageText.textContent = `${modeLabel}: ${sampledDates} de ${candidateDates} datas × ${sampledValues} valores · `
            + `${coverage.requested_points ?? currentSurface.result.requested_points ?? currentSurface.result.points.length} células · `
            + `${omittedDates} datas e ${omittedValues} valores omitidos. Grade visual; não prova um ótimo global.`;
        }
        const frontierView = g4FrontierViewModel(currentSurface.result);
        if (frontierView) {
          const conditionText = frontierView.conditions.map(item => {
            const observed = `${item.available_points} de ${item.requested_points} pontos avaliados`;
            const notApplicable = item.not_applicable_points ? `; ${item.not_applicable_points} sem aplicação` : '';
            return `${item.label}: ${item.coverage_label}, ${observed}${notApplicable}, ${item.bracket_count} transição(ões) observada(s), ${item.tie_count} empate(s)`;
          }).join('. ');
          coverageText.textContent += ` Fronteiras: ${conditionText}.`;
          coverageText.textContent += ' Transições referem-se a taxas adjacentes avaliadas; sem interpolação ou afirmação de raiz.';
          if (frontierView.reference_status !== 'ready') {
            coverageText.textContent += ' A venda de referência não foi avaliada; a indiferença patrimonial fica indisponível.';
          } else if (frontierView.common_horizon) {
            coverageText.textContent += ` Referência comum até ${surfaceDateLabel(frontierView.common_horizon)}.`;
          }
        }
        if (!isUnitPriceCurve && (snapshot()?.criteria || []).length && surfaceStale) {
          coverageText.textContent += ' Os estados de metas pertencem à última grade avaliada e não refletem os critérios atuais.';
        } else if (!isUnitPriceCurve && (snapshot()?.criteria || []).length) {
          const points = currentSurface.result.points || [];
          const met = points.filter(point => point.constraint_evaluation?.status === 'MET').length;
          const unknown = points.filter(point => point.constraint_evaluation?.status === 'UNKNOWN').length;
          coverageText.textContent += ` Na grade atual, ${met} de ${points.length} células amostradas atendem simultaneamente a todas as metas; ${unknown} têm algum critério sem dado.`;
          if (met === 0) coverageText.textContent += ' Nenhuma célula amostrada atende nesta grade; isso não prova impossibilidade fora do domínio examinado.';
        }
      }
      const assumption = byId('mtm-surface-assumption');
      if (assumption) {
        const domain = currentSurface.coverage?.domain || {};
        if (model.mode === 'DATE_CURVE') {
          assumption.textContent = `Período: ${domain.requested_date_range?.start ? surfaceDateLabel(domain.requested_date_range.start) : surfaceDateLabel(model.dates[0])} a ${domain.requested_date_range?.end ? surfaceDateLabel(domain.requested_date_range.end) : surfaceDateLabel(model.dates.at(-1))}. Hipótese constante: ${model.points[0] ? surfaceCoordinateLabel(model.points[0]) : presentation().MISSING}.`;
        } else if (model.mode === 'RATE_CURVE' || isUnitPriceCurve) {
          const rates = model.points.map(point => point.coordinateNumber).filter(Number.isFinite);
          const date = model.points[0]?.order_date;
          const selected = model.points.find(point => point.selected);
          const selectionNote = selected
            ? `${isUnitPriceCurve ? 'Taxa de compra informada' : 'Seleção avaliada'}: ${surfaceCoordinateLabel(selected)}.`
            : 'A seleção avaliada está fora desta faixa ou não tem taxa registrada.';
          assumption.textContent = `${date ? `Data: ${surfaceDateLabel(date)} · ` : ''}Taxas calculadas: ${rates.length ? `${formatPtNumber(Math.min(...rates), 2)}% a ${formatPtNumber(Math.max(...rates), 2)}% a.a.` : 'sem taxas disponíveis'}. ${selectionNote} Alterar taxa só afeta o resultado após “Avaliar ponto”.`;
        } else {
          assumption.textContent = 'Mapa avançado: cada célula é um cenário condicional. Cores e quantidade de células não representam probabilidade.';
        }
      }
      const dateFilter = byId('mtm-surface-date-filter');
      const coordinateFilter = byId('mtm-surface-coordinate-filter');
      populateSurfaceFilter(dateFilter, model.dates, 'Todas as datas', surfaceDateLabel);
      populateSurfaceFilter(coordinateFilter, model.coordinates, 'Todos os valores', value => {
        const point = model.points.find(item => item.coordinateRaw === value);
        return point ? surfaceCoordinateLabel(point) : value;
      });
      const coordinateWrap = byId('mtm-surface-coordinate-wrap');
      if (coordinateWrap?.firstChild) coordinateWrap.firstChild.textContent = model.coordinateLabel;

      const selectedDate = dateFilter?.value || '';
      const selectedCoordinate = coordinateFilter?.value || '';
      const visiblePoints = model.points.filter(point =>
        (!selectedDate || point.order_date === selectedDate)
        && (!selectedCoordinate || point.coordinateRaw === selectedCoordinate),
      );
      const selectedPointId = pendingSurfacePoint?.pointId || pendingSurfacePoint?.identity;
      if (pendingSurfacePoint) {
        const currentMetricPoint = model.points.find(point => point.pointId === selectedPointId);
        if (currentMetricPoint) pendingSurfacePoint = { ...currentMetricPoint };
      }
      let tableModel = surfaceTablePageModel(visiblePoints, surfaceTableState);
      const selectedFilteredIndex = selectedPointId
        ? tableModel.sortedPoints.findIndex(point => point.pointId === selectedPointId) : -1;
      if (surfaceTableState.ensureSelectionPage) {
        if (selectedFilteredIndex >= 0) surfaceTableState.page = Math.floor(selectedFilteredIndex / surfaceTableState.pageSize);
        surfaceTableState.ensureSelectionPage = false;
      }
      tableModel = surfaceTablePageModel(visiblePoints, surfaceTableState);
      surfaceTableState.page = tableModel.page;
      const tableRoot = byId('mtm-unified-surface-table');
      if (tableRoot) {
        const toolbar = doc.createElement('div');
        toolbar.className = 'mtm-surface-table-toolbar';
        const controls = doc.createElement('div');
        controls.className = 'mtm-surface-table-controls';
        const pageSizeLabel = doc.createElement('label');
        pageSizeLabel.textContent = 'Linhas por página';
        const pageSizeSelect = doc.createElement('select');
        pageSizeSelect.id = 'mtm-surface-page-size';
        pageSizeSelect.setAttribute('aria-label', 'Linhas por página');
        for (const size of [10, 25, 50]) {
          const option = doc.createElement('option');
          option.value = String(size); option.textContent = String(size); option.selected = size === tableModel.pageSize;
          pageSizeSelect.append(option);
        }
        pageSizeSelect.addEventListener('change', () => {
          surfaceTableState.pageSize = Number(pageSizeSelect.value);
          surfaceTableState.page = 0;
          renderSurface(currentSurface, surfaceStale);
          byId('mtm-surface-page-size')?.focus();
        });
        pageSizeLabel.append(pageSizeSelect);
        const sortNames = {
          date: 'data solicitada',
          coordinate: model.coordinateLabel.toLocaleLowerCase('pt-BR'),
          metric: model.metricLabel.toLocaleLowerCase('pt-BR'),
        };
        const filterSummary = `Filtros: ${selectedDate ? `data ${surfaceDateLabel(selectedDate)}` : 'todas as datas'}; `
          + `${selectedCoordinate
            ? surfaceCoordinateLabel(model.points.find(point => point.coordinateRaw === selectedCoordinate) || { coordinateRaw: selectedCoordinate, coordinateUnit: model.coordinateUnit })
            : 'todos os valores'}`;
        const tableStatus = doc.createElement('p');
        tableStatus.className = 'mtm-surface-table-status';
        tableStatus.setAttribute('role', 'status'); tableStatus.setAttribute('aria-live', 'polite');
        tableStatus.textContent = `${tableModel.start}–${tableModel.end} de ${tableModel.total} pontos · ${filterSummary} · `
          + `ordenação: ${sortNames[tableModel.sortKey]} ${tableModel.sortDirection === 'asc' ? 'crescente' : 'decrescente'}; desempate por coordenada e data.`;
        const pager = doc.createElement('nav');
        pager.className = 'mtm-surface-table-pagination'; pager.setAttribute('aria-label', 'Paginação dos pontos');
        const previous = doc.createElement('button');
        previous.id = 'mtm-surface-page-previous'; previous.type = 'button'; previous.className = 'subtle';
        previous.textContent = 'Anterior'; previous.disabled = tableModel.page <= 0;
        previous.addEventListener('click', () => {
          surfaceTableState.page = Math.max(0, tableModel.page - 1);
          renderSurface(currentSurface, surfaceStale);
          byId('mtm-surface-page-previous')?.focus();
        });
        const pagePosition = doc.createElement('span');
        pagePosition.textContent = `Página ${tableModel.pageCount ? tableModel.page + 1 : 0} de ${tableModel.pageCount}`;
        const next = doc.createElement('button');
        next.id = 'mtm-surface-page-next'; next.type = 'button'; next.className = 'subtle';
        next.textContent = 'Próxima'; next.disabled = tableModel.page + 1 >= tableModel.pageCount;
        next.addEventListener('click', () => {
          surfaceTableState.page = Math.min(tableModel.pageCount - 1, tableModel.page + 1);
          renderSurface(currentSurface, surfaceStale);
          byId('mtm-surface-page-next')?.focus();
        });
        pager.append(previous, pagePosition, next);
        controls.append(pageSizeLabel, tableStatus, pager);
        toolbar.append(controls);

        const warningCounts = new Map();
        for (const point of visiblePoints) for (const warning of surfacePointWarningMessages(point)) {
          warningCounts.set(warning, (warningCounts.get(warning) || 0) + 1);
        }
        const commonWarnings = new Set([...warningCounts].filter(([, count]) => count > 1).map(([warning]) => warning));
        if (commonWarnings.size) {
          const common = doc.createElement('details'); common.className = 'mtm-surface-common-warnings';
          const commonSummary = doc.createElement('summary'); commonSummary.textContent = `Observações comuns (${commonWarnings.size})`;
          const commonList = doc.createElement('ul');
          for (const warning of commonWarnings) {
            const item = doc.createElement('li');
            item.textContent = `${warning} · em ${warningCounts.get(warning)} de ${visiblePoints.length} pontos.`;
            commonList.append(item);
          }
          common.append(commonSummary, commonList); toolbar.append(common);
        }

        if (!tableModel.total) {
          const empty = doc.createElement('p'); empty.className = 'mtm-surface-table-empty';
          empty.textContent = 'Nenhum ponto neste recorte. Limpe os filtros para restaurar o domínio.';
          tableRoot.replaceChildren(toolbar, empty);
        } else {
          const table = doc.createElement('table');
          const caption = doc.createElement('caption');
          caption.textContent = `${tableModel.start}–${tableModel.end} de ${tableModel.total} pontos; valores sem dado permanecem indisponíveis.`;
          const head = doc.createElement('thead'), headerRow = doc.createElement('tr');
          const criteriaConfigured = Boolean((snapshot()?.criteria || []).length);
          const g4Columns = isG4Frontier ? [
            { label: 'Equilíbrio nominal' },
            { label: 'Metas pessoais' },
            { label: 'Vender ou esperar' },
          ] : [];
          const columns = [
            { label: 'Data solicitada', key: 'date' },
            { label: model.coordinateLabel, key: 'coordinate' },
            { label: `${model.metricLabel} (${model.unitLabel})`, key: 'metric' },
            ...(criteriaConfigured && !isUnitPriceCurve ? [{ label: 'Metas combinadas' }] : []),
            ...g4Columns,
            { label: 'Detalhes' }, ...(readOnlyCurve ? [] : [{ label: 'Ação' }]),
          ];
          for (const column of columns) {
            const th = doc.createElement('th'); th.scope = 'col';
            if (column.key) {
              const isActive = tableModel.sortKey === column.key;
              th.setAttribute('aria-sort', isActive ? tableModel.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none');
              const sort = doc.createElement('button');
              sort.type = 'button'; sort.className = 'mtm-surface-sort-button'; sort.dataset.surfaceSort = column.key;
              sort.textContent = `${column.label}${isActive ? tableModel.sortDirection === 'asc' ? ' ↑' : ' ↓' : ''}`;
              sort.setAttribute('aria-label', `${column.label}. ${isActive
                ? `Ordenação ${tableModel.sortDirection === 'asc' ? 'crescente' : 'decrescente'}; ativar para inverter.`
                : 'Ativar para ordenar em ordem crescente.'}`);
              sort.addEventListener('click', () => {
                const sameSort = surfaceTableState.sortKey === column.key;
                surfaceTableState.sortKey = column.key;
                surfaceTableState.sortDirection = sameSort && surfaceTableState.sortDirection === 'asc' ? 'desc' : 'asc';
                surfaceTableState.page = 0;
                renderSurface(currentSurface, surfaceStale);
                tableRoot.querySelector(`[data-surface-sort="${column.key}"]`)?.focus();
              });
              th.append(sort);
            } else th.textContent = column.label;
            headerRow.append(th);
          }
          head.append(headerRow);
          const body = doc.createElement('tbody');
          for (const point of tableModel.pagePoints) {
            const row = doc.createElement('tr');
            const selected = Boolean(selectedPointId ? point.pointId === selectedPointId : point.selected);
            row.setAttribute('aria-selected', String(selected));
            if (selected) { row.tabIndex = -1; row.dataset.selectedPointRow = 'true'; }
            const fields = [
              surfaceDateLabel(point.order_date), surfaceCoordinateLabel(point), surfaceMetricValueLabel(point),
              ...(criteriaConfigured && !isUnitPriceCurve ? [surfaceConstraintLabel(point)] : []),
              ...(isG4Frontier ? [
                surfaceFrontierConditionText(point, 'nominal_equilibrium'),
                surfaceFrontierConditionText(point, 'personal_goals'),
                surfaceFrontierConditionText(point, 'sell_wait_indifference'),
              ] : []),
            ];
            for (let index = 0; index < fields.length; index += 1) {
              const cell = doc.createElement(index === 0 ? 'th' : 'td');
              if (index === 0) cell.scope = 'row';
              if (point.metricStatus !== 'ready' && index === 2) cell.className = 'mtm-surface-unavailable';
              if (criteriaConfigured && !isUnitPriceCurve && index === 3 && point.constraintStatus === 'MET') cell.className = 'mtm-goal-overlay';
              cell.textContent = fields[index]; row.append(cell);
            }
            const detailCell = doc.createElement('td');
            const details = doc.createElement('details'); details.className = 'mtm-surface-row-details';
            const detailSummary = doc.createElement('summary'); detailSummary.textContent = 'Ver detalhes';
            const detailList = doc.createElement('dl');
            const addDetail = (label, value) => {
              const term = doc.createElement('dt'); term.textContent = label;
              const description = doc.createElement('dd'); description.textContent = value || presentation().MISSING;
              detailList.append(term, description);
            };
            addDetail('Data financeira', surfaceDateLabel(point.settlement_date));
            addDetail('Estado da medida', `${surfaceStatusLabel(point.metricStatus)} · ${surfaceQualityLabel(point.quality)}${surfaceStale ? ' · desatualizado' : ''}`);
            if (criteriaConfigured && !isUnitPriceCurve) {
              addDetail('Atendimento das metas', surfaceConstraintLabel(point));
              const reasons = surfaceStale ? [] : (point.constraintEvaluation?.criteria || [])
                .filter(item => item.status === 'UNKNOWN' || item.status === 'NOT_MET')
                .map(item => localizeWarning(item.reason)).filter(Boolean);
              if (reasons.length) addDetail('Diferença neste ponto', [...new Set(reasons)].join('; '));
            }
            if (isG4Frontier) {
              addDetail('Equilíbrio nominal', surfaceFrontierConditionText(point, 'nominal_equilibrium', true));
              addDetail('Metas pessoais', surfaceFrontierConditionText(point, 'personal_goals', true));
              addDetail('Vender ou esperar', surfaceFrontierConditionText(point, 'sell_wait_indifference', true));
            }
            const specificWarnings = surfacePointWarningMessages(point).filter(warning => !commonWarnings.has(warning));
            if (specificWarnings.length) addDetail('Observações deste ponto', specificWarnings.join('; '));
            details.append(detailSummary, detailList); detailCell.append(details); row.append(detailCell);
            if (!readOnlyCurve) {
              const actionCell = doc.createElement('td');
              const choose = doc.createElement('button');
              choose.type = 'button'; choose.className = 'subtle'; choose.textContent = 'Escolher';
              choose.dataset.metricStatus = point.metricStatus;
              choose.disabled = surfaceStale || busy || point.metricStatus !== 'ready';
              choose.setAttribute('aria-label', `Escolher ${surfaceDateLabel(point.order_date)}, liquidação ${surfaceDateLabel(point.settlement_date)}, ${surfaceCoordinateLabel(point)}, ${surfaceMetricValueLabel(point)}, estado ${surfaceStatusLabel(point.metricStatus)}.`);
              choose.addEventListener('click', () => stageSurfacePoint(point.pointId));
              actionCell.append(choose); row.append(actionCell);
            }
            body.append(row);
          }
          table.append(caption, head, body);
          tableRoot.replaceChildren(toolbar, table);
        }

        if (pendingSurfacePoint) {
          const pointDescription = `${surfaceDateLabel(pendingSurfacePoint.order_date)} · ${surfaceCoordinateLabel(pendingSurfacePoint)} · ${surfaceMetricValueLabel(pendingSurfacePoint)}`;
          if (selectedFilteredIndex < 0) {
            const filters = [selectedDate ? `data ${surfaceDateLabel(selectedDate)}` : '', selectedCoordinate
              ? `coordenada ${surfaceCoordinateLabel(model.points.find(point => point.coordinateRaw === selectedCoordinate) || pendingSurfacePoint)}` : ''].filter(Boolean).join(' e ');
            setSurfaceSelectionNotice(`Ponto escolhido: ${pointDescription}. Ele não aparece nesta tabela porque o filtro ${filters || 'atual'} o exclui; os filtros permanecem ativos.`, { type: 'clear_filters' });
          } else if (selectedFilteredIndex < tableModel.page * tableModel.pageSize
              || selectedFilteredIndex >= (tableModel.page + 1) * tableModel.pageSize) {
            const targetPage = Math.floor(selectedFilteredIndex / tableModel.pageSize);
            setSurfaceSelectionNotice(`Ponto escolhido: ${pointDescription}. Está na página ${targetPage + 1} de ${tableModel.pageCount}; os filtros permanecem ativos.`, { type: 'go_to_page', page: targetPage });
          } else setSurfaceSelectionNotice(`Ponto escolhido: ${pointDescription}. Avalie para atualizar o resumo.`, null);
        }
      }
      renderSurfaceChart(model, visiblePoints);
      syncSurfaceAction();
    }

    function renderUnitPriceResult(result, stale = false) {
      unitPriceResult = result || null;
      unitPriceResultStale = Boolean(result && stale);
      const section = byId('mtm-unit-price-results');
      const values = byId('mtm-unit-price-values');
      if (!section || !values || !result) {
        if (section) section.hidden = true;
        return;
      }
      ensureGrossDv01Panel(section);
      renderGrossDv01Notice(stale
        ? 'As premissas mudaram. Atualize o pre\u00e7o unit\u00e1rio antes de calcular novamente.'
        : 'A consulta ainda n\u00e3o foi calculada. Aplique o choque de +1 bp explicitamente para ver o DV01 bruto.');
      section.hidden = selectedAnalysisModes().resultMode !== 'UNIT_PRICE';
      const quote = result.unit_price || result.reference_price || {};
      const context = byId('mtm-output-context');
      if (context) context.textContent = [
        quote.requested_date ? `Referência solicitada em ${surfaceDateLabel(quote.requested_date)}` : null,
        quote.financial_date ? `Data financeira: ${surfaceDateLabel(quote.financial_date)}` : null,
      ].filter(Boolean).join(' · ');
      const amount = quote.value ?? quote.unit_price;
      const status = String(quote.status || result.status || 'needs_input').toLowerCase();
      const quality = quote.quality ? presentation().label('quality', quote.quality) : presentation().MISSING;
      const rows = [];
      const append = (label, value) => {
        const row = doc.createElement('div');
        row.append(textElement('dt', label), textElement('dd', value == null || value === '' ? presentation().MISSING : value));
        rows.push(row);
      };
      append('Preço unitário', amount == null ? presentation().MISSING : `${formatCurrency(amount, 4)} por título`);
      append('Data solicitada', quote.requested_date ? surfaceDateLabel(quote.requested_date) : presentation().MISSING);
      append('Data financeira', quote.financial_date ? surfaceDateLabel(quote.financial_date) : presentation().MISSING);
      const statusLabel = status === 'available'
        ? presentation().label('status', 'ready')
        : presentation().labelWithCode('status', status);
      append('Estado e qualidade', `${statusLabel} · ${quality}${stale ? ' · desatualizado' : ''}`);
      if (quote.annual_real_rate != null) append('Taxa real aplicada', formatAnnualRate(quote.annual_real_rate, 4));
      const index = quote.index;
      if (index && (index.value != null || index.reference_date)) {
        append(index.kind || 'Índice', `${index.value == null ? presentation().MISSING : formatPtNumber(index.value, 6)}${index.reference_date ? ` · ${surfaceDateLabel(index.reference_date)}` : ''}`);
      }
      values.replaceChildren(...rows);
      const assumption = byId('mtm-unit-price-assumption');
      const selectedEntry = snapshot()?.draft?.ui_form?.entry_price_mode || 'RATE';
      if (assumption) {
        assumption.textContent = selectedEntry === 'PU'
          ? 'Modo ativo: PU informado para referência. O simulador não infere uma taxa real desse valor.'
          : quote.annual_real_rate != null
            ? 'Modo ativo: taxa real de referência; o PU foi calculado pelo motor para a data e a evidência indicadas.'
            : 'Modo ativo: taxa real selecionada. O PU aguarda a taxa, o IPCA mensal ou uma hipótese explícita de inflação compatível.';
        if (stale) assumption.textContent = `Este resultado pertence às premissas anteriores. ${assumption.textContent}`;
      }
      const source = byId('mtm-unit-price-source');
      const provenance = quote.provenance || quote.rate_provenance || {};
      if (source) {
        const sourceRef = quote.source || provenance.source_ref || provenance.source_id;
        source.textContent = sourceRef
          ? `Fonte/proveniência: ${sourceRef}${provenance.source_id === 'USER_INPUT' ? ' · referência declarada, não verificada pelo aplicativo.' : ''}`
          : 'Fonte do preço: não disponível.';
      }
      const hypothesis = byId('mtm-unit-price-hypothesis');
      const missing = result.capabilities?.unit_price?.missing_fields || [];
      if (hypothesis) hypothesis.textContent = missing.length
        ? `Pendências: ${[...new Set(missing)].map(explainField).join('; ')}.`
        : status === 'blocked_policy' && quote.reason_code
          ? unitPriceBlockedReasonMessage(quote.reason_code)
          : (result.hypotheses || ['PU unitário não representa resultado patrimonial de uma operação.']).join(' ');
      byId('mtm-output-title').textContent = stale ? 'Preço unitário anterior' : 'Preço por título';
      byId('mtm-workspace-quality').textContent = status === 'available' && result.status === 'ready'
        ? quality : presentation().labelWithCode('status', status);
      byId('mtm-workspace-summary').textContent = amount != null
        ? `${stale ? 'Resultado anterior · ' : ''}PU calculado pelo motor local, sem capital, quantidade, impostos ou patrimônio de operação.${quote.index_calculation ? ` ${quote.index?.kind || 'VNA/VNI'} calculado automaticamente do IPCA mensal, com dias corridos entre referências de dia 15.${quote.index_calculation.projected_months ? ' Inclui inflação projetada hipotética.' : ''}` : ''}${quote.financial_date ? ` Data financeira: ${surfaceDateLabel(quote.financial_date)}.` : ''}`
        : `${stale ? 'Resultado anterior · ' : ''}O preço unitário ainda não está disponível. ${missing.length ? `Complete: ${[...new Set(missing)].map(explainField).join('; ')}.` : 'Confira a qualidade e a pendência retornadas pelo motor.'}`;
      let conclusion = byId('mtm-unit-price-conclusion');
      if (!conclusion) {
        conclusion = doc.createElement('section');
        conclusion.id = 'mtm-unit-price-conclusion';
        conclusion.className = 'mtm-workspace-conclusion';
      }
      conclusion.replaceChildren(textElement('h3', 'Leitura deste preço'),
        textElement('p', workspaceConclusionViewModel(result, stale, true).text, 'mtm-conclusion-copy'));
      values.after(conclusion);
      renderAssumptionsUsed(result, null, stale, true);
      syncAnalysisModeVisibility();
      syncGrossDv01Action();
    }

    function ensureGrossDv01Panel(section) {
      let panel = byId('mtm-gross-dv01-panel');
      if (panel) return panel;
      panel = doc.createElement('section');
      panel.id = 'mtm-gross-dv01-panel';
      panel.className = 'mtm-workspace-conclusion';
      const heading = textElement('h3', 'DV01 bruto por reprecifica\u00e7\u00e3o');
      const description = textElement('p', 'Reprecifica o PU com a taxa real +1 bp. Informe uma quantidade positiva em cent\u00e9simos de t\u00edtulo para ver a varia\u00e7\u00e3o da posi\u00e7\u00e3o; em branco, o resultado \u00e9 unit\u00e1rio. Custos, cust\u00f3dia e impostos ficam exclu\u00eddos; n\u00e3o \u00e9 duration.');
      description.id = 'mtm-gross-dv01-description';
      const quantityLabel = doc.createElement('label');
      quantityLabel.textContent = 'Quantidade opcional (t\u00edtulos)';
      const quantityInput = doc.createElement('input');
      quantityInput.id = 'mtm-gross-dv01-quantity';
      quantityInput.type = 'text';
      quantityInput.inputMode = 'decimal';
      quantityInput.autocomplete = 'off';
      quantityInput.placeholder = 'Ex.: 2,37';
      quantityInput.setAttribute('aria-describedby', 'mtm-gross-dv01-description');
      quantityInput.addEventListener('input', invalidateGrossDv01Quantity);
      quantityLabel.append(quantityInput);
      const button = doc.createElement('button');
      button.id = 'mtm-gross-dv01-run';
      button.type = 'button';
      button.className = 'subtle';
      button.textContent = 'Calcular DV01 bruto';
      button.setAttribute('aria-describedby', 'mtm-gross-dv01-description');
      button.addEventListener('click', runGrossDv01);
      const output = doc.createElement('div');
      output.id = 'mtm-gross-dv01-output';
      output.setAttribute('aria-live', 'polite');
      output.setAttribute('aria-atomic', 'true');
      panel.append(heading, description, quantityLabel, button, output);
      section.append(panel);
      return panel;
    }

    function renderGrossDv01Notice(message) {
      const output = byId('mtm-gross-dv01-output');
      if (!output) return;
      output.replaceChildren(textElement('p', message, 'mtm-gross-dv01-notice'));
    }

    function invalidateGrossDv01Quantity() {
      if (activeIntent?.action === 'GROSS_DV01') cancelCurrentIntent();
      else cancelAction('GROSS_DV01');
      renderGrossDv01Notice('A quantidade mudou. O resultado DV01 anterior foi invalidado; calcule novamente.');
      syncGrossDv01Action();
    }

    function renderGrossDv01Result(model) {
      const output = byId('mtm-gross-dv01-output');
      if (!output) return;
      if (!model) {
        renderGrossDv01Notice('A resposta n\u00e3o trouxe um resultado DV01 utiliz\u00e1vel.');
        return;
      }
      const rows = [
        ['Estado', `${model.status}${model.reasonCode ? ` (${model.reasonCode})` : ''}`],
        ['T\u00edtulo', model.instrument],
        ['Data financeira', model.financialDate],
        ['Nominal', model.nominal],
        ['Choque', model.shock],
        ['Taxa real base \u2192 ap\u00f3s choque', `${model.baseRate} \u2192 ${model.shockedRate}`],
        ['PU base \u2192 ap\u00f3s choque', `${model.basePu} \u2192 ${model.shockedPu}`],
        ['DV01 bruto por t\u00edtulo', model.signedUnitDelta],
        ['Redu\u00e7\u00e3o se a taxa subir', model.reductionIfYieldUp],
        ['Quantidade', model.quantity === presentation().MISSING
          ? 'N\u00e3o aplicada; resultado unit\u00e1rio por t\u00edtulo.' : model.quantity],
        ['Varia\u00e7\u00e3o bruta da posi\u00e7\u00e3o', model.grossPositionDelta],
        ['Custos, cust\u00f3dia e impostos', 'Exclu\u00eddos'],
      ];
      const list = doc.createElement('dl');
      for (const [label, value] of rows) {
        const row = doc.createElement('div');
        row.append(textElement('dt', label), textElement('dd', value));
        list.append(row);
      }
      output.replaceChildren(list, textElement('p', model.explanation, 'mtm-gross-dv01-explanation'));
    }

    function syncGrossDv01Action() {
      const button = byId('mtm-gross-dv01-run');
      const panel = byId('mtm-gross-dv01-panel');
      if (panel) panel.hidden = !unitPriceResult || selectedAnalysisModes().resultMode !== 'UNIT_PRICE';
      if (button) button.disabled = busy || Boolean(grossDv01PendingIntent) || !unitPriceResult || unitPriceResultStale || !unitPriceInput;
    }

    async function runGrossDv01() {
      const button = byId('mtm-gross-dv01-run');
      if (!button || button.disabled) return;
      let intent = null;
      try {
        if (selectedAnalysisModes().resultMode !== 'UNIT_PRICE' || !unitPriceResult || unitPriceResultStale || !unitPriceInput) {
          renderGrossDv01Notice('Atualize o pre\u00e7o unit\u00e1rio antes de calcular o DV01 bruto.');
          return;
        }
        const currentInput = makeInput();
        if (JSON.stringify(unitPriceInputFrom(currentInput)) !== JSON.stringify(unitPriceInputFrom(unitPriceInput))) {
          unitPriceResultStale = true;
          cancelAction('GROSS_DV01');
          renderGrossDv01Notice('As premissas mudaram. Atualize o pre\u00e7o unit\u00e1rio antes de calcular novamente.');
          syncGrossDv01Action();
          return;
        }
        const quantity = byId('mtm-gross-dv01-quantity')?.value ?? '';
        const payload = grossDv01RequestFromInput(unitPriceInput, quantity);
        button.disabled = true;
        renderGrossDv01Notice('Calculando DV01 bruto por reprecifica\u00e7\u00e3o direta.');
        intent = { id: ++intentSequence, action: 'GROSS_DV01', cancelled: false, request: null };
        activeIntent = intent;
        grossDv01PendingIntent = intent;
        setBusy(true);
        const outcome = await request('GROSS_DV01', 'simulator/workspace', payload, identity => {
          intent.request = identity;
        });
        if (activeIntent !== intent || intent.cancelled) return;
        if (!outcome.accepted) {
          renderGrossDv01Notice('O resultado n\u00e3o corresponde mais a esta solicita\u00e7\u00e3o ou ficou desatualizado. Atualize o pre\u00e7o unit\u00e1rio e tente novamente.');
          return;
        }
        renderGrossDv01Result(presentation().grossDv01ViewModel(outcome.response?.result));
      } catch (error) {
        if (intent && (activeIntent !== intent || intent.cancelled)) return;
        renderGrossDv01Notice(`N\u00e3o foi poss\u00edvel calcular o DV01 bruto. ${error?.message || error}`);
      } finally {
        if (intent) {
          if (grossDv01PendingIntent === intent) grossDv01PendingIntent = null;
          if (activeIntent === intent) {
            activeIntent = null;
            setBusy(false);
          }
        }
        syncGrossDv01Action();
      }
    }

    function renderResolved(resolved, evaluationResponse = null, confirmedLocalExit = false, stale = false, inputOverride = null, goalsStale = stale) {
      currentResolution = resolved || null;
      currentEvaluation = evaluationResponse;
      setInstrumentSeriesOptions(resolved?.instrument_series_options);
      renderPendingItems(resolved?.pending_items);
      const title = byId('mtm-output-title');
      const summary = byId('mtm-workspace-summary');
      const quality = byId('mtm-workspace-quality');
      const detail = byId('mtm-workspace-result-detail');
      const evaluation = evaluationResponse;
      const result = evaluation?.result || {};
      const operation = result.operation || {};
      const instrument = resolved?.normalized_input?.instrument;
      const qualityCode = operation.quality || result.quality || '—';
      const qualityLabel = presentation().label('quality', qualityCode);
      if (title) title.textContent = evaluation
        ? `${stale ? 'Último resultado válido · ' : 'Resultado · '}${instrument?.instrument_id || 'operação'}`
        : 'O que falta para avaliar';
      if (quality) quality.textContent = evaluation
        ? (stale ? 'Resultado anterior' : result.presentation_summary?.status === 'partial' ? 'Resultado parcial'
          : operation.status === 'MARKED_ONLY' ? 'Valor marcado' : 'Resultado disponível')
        : (resolved?.status === 'ready' ? 'Pronto para avaliar' : 'Pendente');
      const pendingFields = capabilityMessages(resolved);
      const pendingItems = Array.isArray(resolved?.pending_items) ? resolved.pending_items : [];
      const blockingPendingCount = pendingItems.filter(item => item?.severity === 'BLOCKING').length;
      if (summary) {
        if (evaluation) summary.textContent = stale
          ? 'Este é o último resultado válido e pertence à revisão anterior. Os campos atuais ainda não foram avaliados; os valores abaixo continuam vinculados às premissas exibidas nos detalhes.'
          : operation.status === 'MARKED_ONLY'
            ? 'Valor marcado sem venda ou caixa. A qualidade e as premissas abaixo permanecem vinculadas a este resultado.'
            : `${confirmedLocalExit ? 'A cotação local foi confirmada como PU escolhido para a avaliação; a qualidade exibida permanece conservadora. ' : ''}Resultado estimado nas condições apresentadas abaixo.${(inputOverride?.exit_price?.mode || resolved?.normalized_input?.exit_price?.mode) === 'SAME_ENTRY_RATE' ? ' Hipótese de saída: taxa real igual à taxa de compra; o PU é recalculado na data de venda.' : ''}${inputOverride?.exit_price?.provenance?.source_id === 'SAME_ENTRY_PU_BASELINE' ? ' Hipótese de saída: PU de venda igual ao PU de compra; a taxa real de venda não foi inferida.' : ''}${operation.real_return == null ? ' Retorno real indisponível sem nível de índice; o retorno nominal continua calculado.' : ''}`;
        else if (blockingPendingCount) summary.textContent = 'Os dados exatos, as datas e as alternativas compatíveis estão listados nas pendências acima.';
        else if (pendingItems.length) summary.textContent = 'A operação está disponível; confira as saídas opcionais ainda indisponíveis acima.';
        else summary.textContent = pendingFields.length
          ? `Complete: ${pendingFields.join('; ')}.`
          : (resolved?.status === 'ready' ? 'Entradas resolvidas. Aguardando a avaliação do motor.' : 'A resolução ainda não permite calcular; consulte as capacidades e pendências detalhadas.');
        const constraintStatus = goalsStale ? null : result.constraint_evaluation?.status;
        const goalSummary = {
          MET: 'Todas as metas são atendidas nesta seleção.',
          NOT_MET: 'Uma ou mais metas não são atendidas nesta seleção.',
          UNKNOWN: 'Há metas sem dado suficiente nesta seleção.',
          NO_CONSTRAINTS: '',
        }[constraintStatus] || '';
        if (goalsStale && !stale) summary.textContent += ' Resultado financeiro mantido. Aplique as metas para atualizar o atendimento.';
        else if (goalsStale && stale) summary.textContent += ' O atendimento das metas pertence à avaliação anterior.';
        else if (goalSummary) summary.textContent += stale
          ? ` Na avaliação anterior, ${goalSummary.charAt(0).toLowerCase()}${goalSummary.slice(1)}`
          : ` ${goalSummary}`;
      }
      if (detail) {
        if (evaluation) {
          const selectedDate = inputOverride?.sale_date
            ? surfaceDateLabel(inputOverride.sale_date) : presentation().MISSING;
          detail.textContent = `Seleção avaliada: ${selectedDate} · PU ${formatPtNumber(result.exit_pu, 4)}. Compra: PU ${formatPtNumber(result.entry_pu, 4)} · qualidade: ${qualityLabel}.${stale ? ' Esta avaliação pertence à revisão anterior.' : ''}`;
        } else {
          const prices = resolved?.resolved_prices || {};
          const entry = prices.entry_price, exit = prices.exit_price;
          const normalized = resolved?.normalized_input || {};
          const entryValue = entry?.value || normalized.entry_price?.pu;
          const exitValue = exit?.value || normalized.exit_price?.pu;
          const entryStatus = entry?.status || (entryValue ? 'informado' : 'pendente');
          const exitStatus = exit?.status || (exitValue ? 'informado' : 'pendente');
          const entrySource = entry?.provenance?.source_ref || entry?.provenance?.source_id;
          const exitSource = exit?.provenance?.source_ref || exit?.provenance?.source_id;
        detail.textContent = `Preço de compra: ${entryValue ? `${formatCurrency(entryValue, 4)} (${entryStatus}${entrySource ? ` · ${entrySource}` : ''})` : explainField('entry_price.mode') + ' pendente'}. Preço de venda: ${exitValue ? `${formatCurrency(exitValue, 4)} (${exitStatus}${exitSource ? ` · ${exitSource}` : ''})` : explainField('exit_price.mode') + ' pendente'}.`;
        }
      }
      fillDetails(resolved, inputOverride);
      renderAssumptionsUsed(result, resolved, stale, false);
      fillCalculationMemory(result.steps, stale);
      renderMoney(evaluation, resolved, stale);
      const context = byId('mtm-output-context');
      const contextInput = inputOverride || resolved?.normalized_input || {};
      if (context) {
        const requestedPurchase = contextInput.purchase_date;
        const requestedSale = contextInput.sale_date;
        context.textContent = [
          requestedPurchase ? `Compra pedida em ${surfaceDateLabel(requestedPurchase)}` : null,
          requestedSale ? `Venda pedida em ${surfaceDateLabel(requestedSale)}` : null,
          resolved?.dates?.sale?.settlement_date ? `Liquidação da venda no cenário: ${surfaceDateLabel(resolved.dates.sale.settlement_date)}` : null,
        ].filter(Boolean).join(' · ');
      }
      renderConstraintEvaluation(result.constraint_evaluation, goalsStale, result.goal_gap);
      renderConstraintLimit();
      if (currentSurface) renderSurface(currentSurface, stale || goalsStale);
      if (resolved && !evaluation && pendingFields.length) {
        const assumptions = byId('mtm-workspace-assumptions');
        if (assumptions && pendingFields.some(field => /PU|custos|família|série|vencimento|RendA/.test(field))) assumptions.open = true;
        if (pendingFields.some(field => /PU|taxa/.test(field))) byId('mtm-workspace-price-details').open = true;
        if (pendingFields.some(field => /VNA|VNI|índice/.test(field))) byId('mtm-workspace-anchor-details').open = true;
        if (pendingFields.some(field => /custo/.test(field))) byId('mtm-workspace-cost-details').open = true;
      }
      syncActionState();
    }

    function renderTabs(active) {
      for (const button of workspaceRoot.querySelectorAll('[data-mtm-tab]')) {
        const selected = button.dataset.mtmTab === active;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      for (const panel of workspaceRoot.querySelectorAll('[data-mtm-panel]')) panel.hidden = panel.dataset.mtmPanel !== active;
      changeView(active);
      syncSnapshotControls();
    }

    function syncFormFromRaw(raw) {
      if (!raw || typeof raw !== 'object') return;
      if (byId('mtm-workspace-inflation-end-date')) byId('mtm-workspace-inflation-end-date').value = raw['mtm-workspace-inflation-end-date'] || '';
      lastDateResolution = null;
      for (const [id, value] of Object.entries(institutionalActualFormValues(raw))) if (byId(id)) byId(id).value = value;
      renderIndexLevelRows(Array.isArray(raw['mtm-workspace-index-levels']) ? raw['mtm-workspace-index-levels'] : []);
      for (const [id, value] of Object.entries(raw)) {
        if (id === 'entry_price_mode' || id === 'exit_price_mode' || id === 'result_mode' || id === 'timeline_mode') continue;
        const control = byId(id);
        if (!control) continue;
        if (control.type === 'checkbox') control.checked = Boolean(value);
        else if (control.type !== 'radio') control.value = value == null ? '' : String(value);
      }
      for (const radio of form.querySelectorAll('input[name="capital-mode"]')) radio.checked = radio.value === raw.capital_mode;
      const entryPriceMode = ['RATE', 'PU'].includes(raw.entry_price_mode)
        ? raw.entry_price_mode : String(raw['mtm-workspace-entry-pu'] || '').trim() ? 'PU' : 'RATE';
      for (const radio of form.querySelectorAll('input[name="entry-price-mode"]')) radio.checked = radio.value === entryPriceMode;
      const exitPriceMode = ['SAME_ENTRY', 'RATE', 'PU'].includes(raw.exit_price_mode)
        ? raw.exit_price_mode : String(raw['mtm-workspace-exit-pu'] || '').trim() ? 'PU'
          : String(raw['mtm-workspace-sell-rate'] || '').trim() ? 'RATE' : 'SAME_ENTRY';
      const exitPriceControl = byId('mtm-workspace-exit-price-mode');
      if (exitPriceControl) exitPriceControl.value = exitPriceMode;
      const resultMode = raw.result_mode === 'UNIT_PRICE' ? 'UNIT_PRICE' : 'OPERATION';
      const timelineMode = raw.timeline_mode === 'WINDOW' ? 'WINDOW' : 'POINT';
      for (const radio of form.querySelectorAll('input[name="result-mode"]')) radio.checked = radio.value === resultMode;
      for (const radio of form.querySelectorAll('input[name="timeline-mode"]')) radio.checked = radio.value === timelineMode;
      syncPriceModeVisibility();
      const isBudget = raw.capital_mode !== 'QUANTITY';
      const budgetWrap = byId('mtm-budget-wrap'), quantityWrap = byId('mtm-quantity-wrap');
      if (budgetWrap) budgetWrap.hidden = !isBudget;
      if (quantityWrap) quantityWrap.hidden = isBudget;
      syncTitleHint();
      updateRendaFields();
      syncCostSummary();
      if (raw['mtm-workspace-index-levels']?.length) byId('mtm-workspace-index-details').open = true;
      if (exitPriceMode !== 'SAME_ENTRY' || raw['mtm-workspace-exit-pu'] || raw['mtm-workspace-sell-rate']) {
        byId('mtm-workspace-price-details').open = true;
      }
      if (raw['mtm-workspace-buy-anchor'] || raw['mtm-workspace-sell-anchor'] || raw['mtm-workspace-inflation-rate'] || raw['mtm-workspace-future-inflation-rate']) byId('mtm-workspace-anchor-details').open = true;
      if (['mtm-workspace-entry-fee', 'mtm-workspace-entry-rate', 'mtm-workspace-exit-fee']
        .some(id => !/^0+(?:[,.]0+)?$/.test(String(raw[id] ?? '0')))) byId('mtm-workspace-cost-details').open = true;
      if (['mtm-workspace-custody-actual', 'mtm-workspace-institution-net']
        .some(id => String(raw[id] ?? '').trim())) byId('mtm-workspace-cost-details').open = true;
      syncDatesToLegacy();
      syncAnalysisModeVisibility();
      draftSignature = JSON.stringify(raw);
      latestDraft = { ...latestDraft, ui_form: raw };
    }

    function applyCurrentReference() {
      if (busy) return;
      if (!lastValidResult) {
        setPending('Avalie um cenário antes de fixá-lo como referência e criar a cópia de exploração.');
        return;
      }
      const stale = resultStaleness(lastValidResult);
      if (lastValidResult.identity !== resultIdentity() || stale.financial || stale.goals) {
        setPending(stale.financial
          ? 'Você alterou as premissas financeiras. Recalcule antes de fixar a referência e criar a cópia.'
          : 'Aplique as metas para atualizar o atendimento antes de fixar a referência e criar a cópia.');
        return;
      }
      const fingerprint = lastValidResult.response?.input_fingerprint;
      if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(fingerprint || ''))) {
        setPending('Fingerprint verificável indisponível; a referência e a cópia não foram criadas.');
        return;
      }
      const current = snapshot();
      const reference = {
        draft: current.draft,
        input: lastValidResult.input,
        source_versions: lastValidResult.input.source_versions || {},
        provenance: lastValidResult.resolved?.provenance || lastValidResult.response?.provenance || {},
        input_fingerprint: fingerprint,
        selection: current.selection,
      };
      dispatch({ type: 'APPLY_REFERENCE', resolution: { valid: true }, reference, confirmed: true });
      comparisonResult = null;
      setPending('Referência congelada e cópia independente pronta para exploração. Edite os campos; as diferenças aparecem em Comparar e testar.');
      renderCompareContexts();
      syncActionState();
    }

    function restoreReference() {
      if (!snapshot()?.reference) return;
      dispatch({ type: 'RESTORE_REFERENCE' });
      baseContext = null;
      const restored = snapshot();
      const reference = restored.reference;
      sourceVersionsOverride = reference.input?.source_versions || reference.source_versions || null;
      syncFormFromRaw(reference.draft?.ui_form || reference.draft || {});
      showError('');
      renderLastValidResult();
      comparisonResult = null;
      renderCompareContexts();
      setPending('Cópia da referência restaurada nos campos. As edições anteriores continuam disponíveis em Desfazer. Simule para validar esta revisão.');
      syncActionState();
    }

    function undoCurrent() {
      if (!snapshot()?.undo_depth || busy) return;
      const before = snapshot();
      dispatch({ type: 'UNDO' });
      const restored = snapshot();
      const beforeAlternatives = before.alternatives || [];
      const restoredAlternatives = restored.alternatives || [];
      const restoredAlternative = restoredAlternatives.find(item => !beforeAlternatives.some(previous => previous.id === item.id));
      const removedAlternative = beforeAlternatives.find(item => !restoredAlternatives.some(current => current.id === item.id));
      const renamedAlternative = beforeAlternatives.find(previous => {
        const current = restoredAlternatives.find(item => item.id === previous.id);
        return current && current.label !== previous.label;
      });
      const contextStatus = byId('mtm-compare-context-status');
      if (contextStatus) {
        if (restoredAlternative) contextStatus.textContent = 'Alternativa restaurada por Desfazer.';
        else if (removedAlternative) contextStatus.textContent = 'Alternativa removida por Desfazer.';
        else if (renamedAlternative) contextStatus.textContent = 'Nome da alternativa restaurado por Desfazer.';
        else if (JSON.stringify(before.reference) !== JSON.stringify(restored.reference)) {
          contextStatus.textContent = 'Referência atualizada para o estado restaurado.';
        }
      }
      const raw = restored.draft?.ui_form;
      if (raw) syncFormFromRaw(raw);
      showError('');
      renderCompareContexts();
      const criteriaChanged = JSON.stringify(before.criteria) !== JSON.stringify(restored.criteria);
      if (criteriaChanged) renderCriteria();
      renderLastValidResult();
      if (criteriaChanged) onCriteriaEdited();
      setPending('Última alteração reversível desfeita. Simule para atualizar o resultado.');
      syncActionState();
    }

    function cancelCurrentIntent() {
      if (!activeIntent) return;
      const intent = activeIntent;
      intent.cancelled = true;
      if (intent.action) cancelAction(intent.action);
      activeIntent = null;
      setBusy(false);
      showLastValidIfStale();
      setPending('Intenção cancelada; a resposta em trânsito será descartada no navegador, mas isso não garante interrupção do cálculo no servidor. Campos e último resultado válido preservados.');
    }

    function focusMissing(resolved) {
      const actionable = (root.MTMEase?.orderPending(resolved?.pending_items) || resolved?.pending_items || []).find(item =>
        item?.severity === 'BLOCKING' && Array.isArray(item.alternatives) && item.alternatives.length,
      );
      if (actionable) {
        focusPendingAlternative(actionable, actionable.alternatives[0]);
        return;
      }
      const fields = root.MTMEase ? root.MTMEase.orderPending((resolved?.missing_fields || []).map(field_path => ({field_path}))).map(item => item.field_path)
        : resolved?.missing_fields || [];
      const mapping = {
        'capital.value': 'mtm-budget-value', purchase_date: 'mtm-workspace-purchase-date', sale_date: 'mtm-workspace-sale-date',
        'analysis_context.timeline.start': 'mtm-workspace-window-start',
        'analysis_context.timeline.end': 'mtm-workspace-window-end',
        'dates.purchase.confirmation': 'mtm-workspace-purchase-date',
        'dates.sale.confirmation': 'mtm-workspace-sale-date',
        'instrument.family': 'mtm-workspace-instrument', 'instrument.series_year': 'mtm-workspace-series-year',
        'instrument.instrument_id': 'mtm-workspace-series-year',
        'instrument.maturity_date': 'mtm-workspace-series-year',
        'instrument.conversion_date': 'mtm-workspace-series-year',
        'instrument.first_income_date': 'mtm-workspace-series-year',
        'entry_price.mode': 'mtm-workspace-buy-rate', 'entry_price.annual_real_rate': 'mtm-workspace-buy-rate',
        'entry_price.pu': 'mtm-workspace-entry-pu',
        'exit_price.mode': 'mtm-workspace-exit-price-mode', 'exit_price.annual_real_rate': 'mtm-workspace-sell-rate',
        'exit_price.pu': 'mtm-workspace-exit-pu', 'assumptions.entry_fee': 'mtm-workspace-entry-fee',
        'assumptions.entry_fee.fixed_brl': 'mtm-workspace-entry-fee',
        'assumptions.entry_fee.proportional_rate': 'mtm-workspace-entry-rate',
        'assumptions.exit_fee_brl': 'mtm-workspace-exit-fee',
      };
      const missingIndex = fields.find(field => field.startsWith('data.index_anchors'));
      const missingPrice = fields.find(field => ['entry_price.mode', 'entry_price.annual_real_rate', 'entry_price.pu',
        'exit_price.mode', 'exit_price.annual_real_rate', 'exit_price.pu'].includes(field));
      let priceModeChanged = false;
      if (missingPrice === 'entry_price.pu') priceModeChanged = activatePriceMode('entry', 'PU');
      else if (missingPrice === 'entry_price.mode' || missingPrice === 'entry_price.annual_real_rate') priceModeChanged = activatePriceMode('entry', 'RATE');
      else if (missingPrice === 'exit_price.pu') priceModeChanged = activatePriceMode('exit', 'PU');
      else if (missingPrice === 'exit_price.annual_real_rate') priceModeChanged = activatePriceMode('exit', 'RATE');
      else if (missingPrice === 'exit_price.mode') byId('mtm-workspace-price-details').open = true;
      if (priceModeChanged) updateDraft();
      const indexTarget = missingIndex
        ? byId(lastDateResolution?.sale?.settlement_date
          && missingIndex.includes(lastDateResolution.sale.settlement_date)
          ? 'mtm-workspace-sell-anchor' : 'mtm-workspace-buy-anchor') : null;
      const fieldTarget = (fields[0]?.startsWith('data.index_anchors') ? indexTarget : null) || fields.map(field => byId(
        field === 'capital.value' && form.querySelector('input[name="capital-mode"]:checked')?.value === 'QUANTITY'
          ? 'mtm-quantity-value' : mapping[field],
      )).find(Boolean);
      const blockedDateSide = ['purchase', 'sale'].find(side => {
        const order = resolved?.dates?.[side];
        return order?.status === 'blocked_policy' || order?.status === 'needs_input' || order?.confirmation_required;
      });
      const target = fieldTarget || (blockedDateSide
        ? byId(blockedDateSide === 'sale' ? 'mtm-workspace-sale-date' : 'mtm-workspace-purchase-date')
        : null);
      if (target) {
        doc.dispatchEvent(new CustomEvent('mtm:focus-field', {detail:{id:target.id}}));
        for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        }
        target.focus();
      }
      if (fields.some(field => field.startsWith('analysis_context.timeline.'))) {
        const timeline = byId('mtm-timeline-mode');
        if (timeline) timeline.hidden = false;
        const windowFields = byId('mtm-window-fields');
        if (windowFields) windowFields.hidden = false;
      }
      if (indexTarget) byId('mtm-workspace-anchor-details').open = true;
    }

    async function evaluateInput(input, resolved, exitValue, saleDate, confirmedLocalExit, intent) {
      if (activeIntent !== intent) return;
      if (snapshot()?.selection) dispatch({ type: 'CLEAR_SELECTION', undo_group: 'evaluate_base' });
      baseContext = null;
      const selectedRate = input.exit_price?.mode === 'MANUAL_RATE'
        ? input.exit_price.annual_real_rate
        : input.exit_price?.mode === 'SAME_ENTRY_RATE' ? input.entry_price?.annual_real_rate : null;
      const selection = selectedRate != null
        ? { sale_date: saleDate, annual_real_rate: String(selectedRate) }
        : { sale_date: saleDate, exit_pu: String(exitValue) };
      const baseCandidate = { input: JSON.parse(JSON.stringify(input)), selection: JSON.parse(JSON.stringify(selection)), confirmedLocalExit };
      intent.action = 'EVALUATE';
      const evaluationIdentity = resultIdentityFields();
      renderLastValidResult();
      setPending('Entradas conferidas. Calculando o resultado…');
      const evaluated = await request('EVALUATE', 'simulator/workspace', {
        schema_version: 2, action: 'EVALUATE', input,
        selection,
      });
      if (activeIntent !== intent) return;
      if (!evaluated.accepted) {
        setPending('Os dados mudaram durante o cálculo. O resultado anterior continua identificado; simule novamente.');
        return;
      }
      const response = evaluated.response;
      const resolvedResult = response?.resolved || resolved;
      if (response?.result?.operation) {
        baseContext = baseCandidate;
        lastValidResult = {
          input: JSON.parse(JSON.stringify(input)),
          resolved: resolvedResult,
          response,
          confirmedLocalExit,
          ...evaluationIdentity,
          goals_evaluated: evaluated.goals_current !== false,
        };
        const goalsStale = evaluated.goals_current === false;
        renderResolved(resolvedResult, response, confirmedLocalExit, false, input, goalsStale);
        if (currentSurface) renderSurface(currentSurface, true);
        if (goalsStale) {
          setPending('Resultado financeiro atualizado. As metas mudaram durante o cálculo; aplique-as para atualizar o atendimento.');
          syncActionState();
          return;
        }
        setPending(response.status === 'ready' ? 'Análise atualizada com as condições informadas.' : 'Resultado válido com capacidades parciais; confira qualidade e limites.');
        const coordinate = selection;
        await loadConstraintLimit(input, coordinate, intent);
        if (isMapTabActive()) await loadSurface(input, coordinate, intent, 'RATE_CURVE');
      } else {
        if (!renderLastValidResult()) renderResolved(resolvedResult, response, confirmedLocalExit, false, input);
        setPending('A avaliação não produziu operação atual. O último resultado válido permanece identificado.');
      }
      syncActionState();
    }

    function selectionForCurrentResult() {
      const selected = snapshot()?.selection;
      if (selected?.sale_date && (selected.exit_pu !== undefined || selected.annual_real_rate !== undefined)) {
        return {
          sale_date: selected.sale_date,
          ...(selected.exit_pu !== undefined ? { exit_pu: String(selected.exit_pu) } : { annual_real_rate: String(selected.annual_real_rate) }),
        };
      }
      const input = lastValidResult?.input || {};
      const saleDate = input.sale_date || lastValidResult?.response?.result?.requested_order_date;
      const result = lastValidResult?.response?.result || {};
      if (!saleDate) return null;
      if (input.exit_price?.mode === 'MANUAL_RATE' && input.exit_price.annual_real_rate !== undefined) {
        return { sale_date: saleDate, annual_real_rate: String(input.exit_price.annual_real_rate) };
      }
      if (input.exit_price?.mode === 'SAME_ENTRY_RATE' && input.entry_price?.annual_real_rate !== undefined) {
        return { sale_date: saleDate, annual_real_rate: String(input.entry_price.annual_real_rate) };
      }
      if (input.exit_price?.mode === 'SAME_ENTRY' && input.entry_price?.pu !== undefined) {
        return { sale_date: saleDate, exit_pu: String(input.entry_price.pu) };
      }
      const pu = input.exit_price?.pu || result.exit_pu;
      return pu === undefined || pu === null ? null : { sale_date: saleDate, exit_pu: String(pu) };
    }

    async function restoreBaseScenario() {
      if (busy || snapshot()?.scenario_mode !== 'EXPLORANDO' || !baseContext) return;
      const input = JSON.parse(JSON.stringify(baseContext.input));
      const selection = JSON.parse(JSON.stringify(baseContext.selection));
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      clearErrorFeedback();
      setPending('Reavaliando a seleção original do cenário-base…');
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        if (!evaluated.accepted || evaluated.goals_current === false || !evaluated.response?.result?.operation) {
          setPending('Não foi possível retornar ao cenário-base. A exploração atual e a referência foram preservadas; tente novamente.');
          return;
        }
        dispatch({ type: 'CLEAR_SELECTION', undo_group: 'restore_base' });
        const response = evaluated.response;
        lastValidResult = {
          input, resolved: response.resolved || null, response,
          confirmedLocalExit: Boolean(baseContext.confirmedLocalExit),
          ...resultIdentityFields(), goals_evaluated: true,
        };
        renderResolved(lastValidResult.resolved, response, lastValidResult.confirmedLocalExit, false, input);
        if (currentSurface) renderSurface(currentSurface, true);
        setPending('Cenário-base restaurado e recalculado.');
        await loadConstraintLimit(input, selection, intent);
        if (isMapTabActive()) await loadSurface(input, selection, intent, 'RATE_CURVE');
      } catch (error) {
        if (activeIntent === intent) {
          setPending(`Não foi possível retornar ao cenário-base. A exploração foi preservada. ${error?.message || error}`);
        }
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          syncActionState();
        }
      }
    }

    function inputForSelection(input, selection) {
      return surfaceEvaluationInput(input, selection);
    }

    async function loadConstraintLimit(input, selection, intent) {
      if (!(snapshot()?.criteria || []).length) {
        currentConstraintLimit = null;
        renderConstraintLimit();
        return;
      }
      if (activeIntent !== intent) return;
      intent.action = 'CONSTRAINTS';
      renderConstraintLimit();
      try {
        const responseResult = await request('CONSTRAINTS', 'simulator/workspace', {
          schema_version: 2, action: 'CONSTRAINTS', input, selection,
        });
        if (activeIntent !== intent) return;
        if (!responseResult.accepted) {
          renderConstraintLimit();
          const message = byId('mtm-constraint-limit-status');
          if (message) message.textContent = 'O limite não foi atualizado porque os critérios ou a seleção mudaram durante o cálculo.';
          return;
        }
        currentConstraintLimit = { result: responseResult.response?.result || null, identity: resultIdentity() };
        renderConstraintLimit();
      } catch (error) {
        if (activeIntent !== intent) return;
        const message = byId('mtm-constraint-limit-status');
        if (message) message.textContent = `Não foi possível calcular o limite combinado. ${error?.message || ''}`.trim();
        const explore = byId('mtm-constraint-explore');
        if (explore) explore.hidden = true;
      }
    }

    async function applyCriteria({ refreshTechnical = true } = {}) {
      if (busy) return;
      if (!lastValidResult) {
        const message = byId('mtm-criteria-message');
        if (message) message.textContent = 'Simule a operação antes de aplicar metas.';
        return;
      }
      let constraints;
      try { constraints = serializeCriteria(snapshot()?.criteria || []); }
      catch (error) {
        const message = byId('mtm-criteria-message');
        if (message) message.textContent = error?.message || String(error);
        return;
      }
      const selection = selectionForCurrentResult();
      if (!selection) {
        const message = byId('mtm-criteria-message');
        if (message) message.textContent = 'A seleção avaliada não está disponível. Simule a operação novamente.';
        return;
      }
      const input = JSON.parse(JSON.stringify(lastValidResult.input));
      if (constraints.length) input.constraints = constraints;
      else delete input.constraints;
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      clearErrorFeedback();
      setPending('Aplicando as metas à seleção financeira atual…');
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        if (!evaluated.accepted || evaluated.goals_current === false || !evaluated.response?.result?.operation) {
          setPending('As metas ou a seleção mudaram durante a avaliação. O resultado anterior continua identificado.');
          return;
        }
        const response = evaluated.response;
        lastValidResult = { input, resolved: response.resolved || lastValidResult.resolved, response,
          confirmedLocalExit: false, ...resultIdentityFields(), goals_evaluated: true };
        if (baseContext) baseContext = { ...baseContext, input: JSON.parse(JSON.stringify(input)) };
        renderResolved(lastValidResult.resolved, response, false, false, inputForSelection(input, selection));
        if (currentSurface) renderSurface(currentSurface, true);
        const message = byId('mtm-criteria-message');
        // The guided flow needs the evaluated goal, not an automatic technical search.
        // Full constraints and curves remain available through the advanced actions.
        if (!refreshTechnical) {
          if (message) message.textContent = 'Metas avaliadas nesta operação. Use o mapa de combinações ou as buscas avançadas para explorar outras condições.';
          setPending('Resultado e metas atualizados. Escolha um caminho para explorar datas, taxas ou orçamento.');
          return;
        }
        if (message) message.textContent = constraints.length ? 'Metas aplicadas à mesma operação. Atualizando limite e região viável.' : 'Metas removidas da avaliação. Atualizando operação e mapa.';
        await loadConstraintLimit(input, selection, intent);
        await loadSurface(input, selection, intent, 'RATE_CURVE');
        if (activeIntent === intent && message) {
          const mapReady = Boolean(currentSurface && !surfaceStale);
          const limitReady = !constraints.length || currentConstraintLimit?.identity === resultIdentity();
          message.textContent = mapReady && limitReady
            ? (constraints.length ? 'Metas aplicadas. Avaliação, limite combinado e mapa atualizados.' : 'Metas removidas. Operação e mapa atualizados.')
            : 'Avaliação concluída com disponibilidade parcial. Confira o estado do limite e do mapa.';
        }
      } catch (error) {
        if (activeIntent === intent) {
          const message = byId('mtm-criteria-message');
          if (message) message.textContent = error?.message || String(error);
          setPending('Não foi possível aplicar as metas. A operação e as metas digitadas foram preservadas.');
        }
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          renderCriteria();
        }
      }
    }

    async function exploreConstraintLimit() {
      if (busy || currentConstraintLimit?.identity !== resultIdentity()) return;
      const result = currentConstraintLimit?.result;
      if (result?.status !== 'SOLVED' || !result.candidate_pu) return;
      const selection = { sale_date: result.requested_order_date, exit_pu: String(result.candidate_pu) };
      const input = JSON.parse(JSON.stringify(lastValidResult?.input || {}));
      if (!input.instrument) return;
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      setPending('Reavaliando o PU verificado antes de colocá-lo no mapa…');
      try {
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        if (!evaluated.accepted || evaluated.goals_current === false || !evaluated.response?.result?.operation) {
          setPending('O PU verificado não foi assumido; o resumo anterior permanece.');
          return;
        }
        const response = evaluated.response;
        dispatch({ type: 'SELECT_POINT', point: { ...selection, origin: 'combined-limit-confirmed' } });
        lastValidResult = { input, resolved: response.resolved || lastValidResult.resolved, response,
          confirmedLocalExit: false, ...resultIdentityFields(), goals_evaluated: true };
        renderResolved(lastValidResult.resolved, response, false, false, inputForSelection(input, selection));
        if (currentSurface) renderSurface(currentSurface, true);
        await loadConstraintLimit(input, selection, intent);
        await loadSurface(input, selection, intent, 'PRICE_DATE_MAP');
        changeView({ tab: 'map', metric: byId('mtm-surface-metric')?.value || 'net_redemption' });
        renderTabs('map');
        byId('mtm-surface-view')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        if (activeIntent === intent) setPending(`O PU verificado não foi assumido. ${error?.message || ''}`.trim());
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          syncActionState();
        }
      }
    }

    async function loadSurface(input, selection, intent, modeOverride = null) {
      if (activeIntent !== intent) return;
      const isRateCurve = modeOverride === 'RATE_CURVE';
      const rateDomain = isRateCurve ? rateDomainFromControls() : null;
      const isRate = isRateCurve || selection.annual_real_rate !== undefined;
      const matchedBaseRate = isRateCurve && selection.annual_real_rate !== undefined
        ? rateDomain.values.find(rate => sameDecimalValue(rate, selection.annual_real_rate)) || null : null;
      const mode = modeOverride || (isRate ? 'RATE_DATE_MAP' : 'PRICE_DATE_MAP');
      const surface = {
        mode,
        metric_id: byId('mtm-surface-metric')?.value || 'net_redemption',
        value_unit: isRate ? 'ratio' : 'BRL_PER_TITLE',
        selected: {
          order_date: selection.sale_date,
          value: isRateCurve
            ? matchedBaseRate || rateDomain.values[Math.floor(rateDomain.values.length / 2)]
            : isRate ? String(selection.annual_real_rate) : String(selection.exit_pu),
        },
        ...(isRateCurve ? { values: rateDomain.values } : {}),
      };
      intent.action = 'SURFACE';
      setPending(isRateCurve
        ? `Resultado calculado. Preparando a curva com ${rateDomain.points} taxas explícitas…`
        : 'Preparando o mapa avançado e a tabela de sensibilidade…');
      try {
        const responseResult = await request('SURFACE', 'simulator/workspace', {
          schema_version: 2, action: 'SURFACE', input, surface,
        });
        if (activeIntent !== intent) return;
        if (!responseResult.accepted) {
          surfaceStale = true;
          renderSurface(currentSurface, true);
          setPending('A revisão do mapa mudou durante o cálculo. O resultado financeiro permanece válido; simule novamente para atualizar o mapa.');
          return;
        }
        const response = responseResult.response;
        if (!response?.result || !Array.isArray(response.result.points)) {
          surfaceStale = true;
          renderSurface(currentSurface, true);
          setPending('Resultado calculado; o mapa não está disponível para esta seleção. Consulte as pendências e use o resultado financeiro acima.');
          return;
        }
        const curveResult = mode === 'RATE_CURVE' && !matchedBaseRate ? {
          ...response.result, points: response.result.points.map(point => ({ ...point, selected: false })),
        } : response.result;
        currentG4FrontierContext = null;
        currentSurface = { result: curveResult, coverage: response.coverage };
        const view = mode === 'RATE_CURVE' ? 'rate' : 'map';
        rememberSurfaceView(view, currentSurface);
        activeSurfaceView = view;
        surfaceStale = false;
        pendingSurfacePoint = null;
        renderPendingItems([]);
        renderSurface(currentSurface, false);
        const coverage = response.coverage || {};
        const quantity = coverage.requested_points || response.result.points.length;
        setPending(mode === 'RATE_CURVE'
          ? response.status === 'ready'
            ? `Curva por taxa pronta · ${quantity} taxas calculadas. Escolher uma taxa prepara uma seleção; o resultado só muda ao avaliá-la.`
            : `Curva por taxa parcial · ${quantity} taxas e estados indisponíveis identificados.`
          : response.status === 'ready'
            ? `Mapa avançado pronto · ${quantity} células.`
            : `Mapa avançado parcial · ${quantity} células e estados indisponíveis identificados.`);
      } catch (error) {
        surfaceStale = Boolean(currentSurface);
        renderSurface(currentSurface, surfaceStale);
        const pointOnly = error?.code === 'POINT_OVERRIDE_NOT_TRANSFERABLE'
          || /^POINT_OVERRIDE_NOT_TRANSFERABLE(?:\s*:|$)/.test(String(error?.message || ''));
        setPending(pointOnly
          ? 'Para explorar outras datas ou preços, em “Ajustar custos da instituição”, deixe em branco “Custódia efetivamente cobrada” e “Resgate líquido informado pela instituição” e analise novamente. Esses valores valem apenas para a operação conferida; o resultado financeiro dela continua disponível.'
          : `Resultado financeiro válido; não foi possível carregar o mapa. ${error?.message || ''}`.trim());
      }
    }

    function dateProbeInput(input, saleDate) {
      const assumptions = input?.assumptions || {};
      const probe = {
        ...(input?.instrument ? { instrument: cloneJson(input.instrument) } : {}),
        ...(input?.purchase_date ? { purchase_date: input.purchase_date } : {}),
        ...(saleDate ? { sale_date: saleDate } : {}),
        knowledge: cloneJson(input?.knowledge || { date: localISODate(), mode: 'CAUSAL' }),
        intent: 'HYPOTHETICAL',
        assumptions: {
          settlement_profile: assumptions.settlement_profile || 'SIMULATED_BUY_D1_SELL_D1',
          ...(assumptions.explicit_settlements ? { explicit_settlements: cloneJson(assumptions.explicit_settlements) } : {}),
        },
      };
      return probe;
    }

    async function resolveWindowStart(input, start, end, intent) {
      if (input?.assumptions?.settlement_profile === 'EXPLICIT') {
        throw new TypeError('O perfil de liquidação explícita cobre uma única data. Escolha uma data pontual ou um perfil de liquidação projetado para explorar um período.');
      }
      const purchaseSettlement = lastDateResolution?.purchase?.settlement_date;
      const afterPurchase = purchaseSettlement ? addIsoDays(purchaseSettlement, 1) : start;
      const requestedStart = afterPurchase > start ? afterPurchase : start;
      if (!requestedStart || requestedStart > end) return null;
      const resolveAt = async requestedDate => {
        const outcome = await request('RESOLVE', 'simulator/workspace', {
          schema_version: 2, action: 'RESOLVE', input: dateProbeInput(input, requestedDate),
        });
        if (activeIntent !== intent || !outcome.accepted) return null;
        return outcome.response?.resolved || null;
      };
      let resolved = await resolveAt(requestedStart);
      if (!resolved) return null;
      let candidate = firstEligibleDateFromResolution(resolved, requestedStart);
      if (!candidate || candidate.date > end) return null;
      if (candidate.requiresConfirmationProbe || candidate.saleStatus !== 'available') {
        resolved = await resolveAt(candidate.date);
        if (!resolved) return null;
        candidate = firstEligibleDateFromResolution(resolved, candidate.date);
        if (!candidate || candidate.saleStatus !== 'available' || candidate.date > end) return null;
      }
      if (candidate.saleStatus !== 'available') return null;
      lastDateResolution = resolved.dates || lastDateResolution;
      return {
        date: candidate.date,
        settlementDate: resolved.dates?.sale?.settlement_date || null,
      };
    }

    async function loadDateCurve(input, resolved, selectedDate, intent) {
      if (activeIntent !== intent) return false;
      const entry = input.entry_price || {};
      const rateSelection = entry.mode === 'MANUAL_RATE' && entry.annual_real_rate != null;
      const unit = rateSelection ? 'ratio' : 'BRL_PER_TITLE';
      const fixedPu = entry.pu ?? resolved?.resolved_prices?.entry_price?.value;
      if (!rateSelection && (fixedPu == null || Number(fixedPu) <= 0)) {
        const missing = resolved?.missing_fields || [];
        setPending(missing.length
          ? `O período ainda aguarda ${[...new Set(missing)].map(explainField).join('; ')}.`
          : 'O período precisa de um PU de compra disponível para manter essa hipótese ao longo do tempo.');
        focusMissing(resolved);
        return false;
      }
      const surface = {
        mode: 'DATE_CURVE',
        metric_id: byId('mtm-surface-metric')?.value || 'net_redemption',
        value_unit: unit,
        selected: {
          order_date: selectedDate,
          ...(!rateSelection ? { value: String(fixedPu) } : {}),
        },
      };
      intent.action = 'SURFACE';
      setPending('Resolução concluída. Calculando a trajetória do período com a hipótese de preço selecionada…');
      try {
        const outcome = await request('SURFACE', 'simulator/workspace', {
          schema_version: 2, action: 'SURFACE', input, surface,
        });
        if (activeIntent !== intent) return false;
        if (!outcome.accepted) {
          setPending('As premissas mudaram durante o cálculo. O período exibido não foi atualizado; execute novamente.');
          return false;
        }
        const response = outcome.response;
        if (!response?.result || !Array.isArray(response.result.points)) {
          setPending('O motor não retornou uma trajetória para este período. Confira as pendências e os limites do título.');
          return false;
        }
        currentSurface = { result: response.result, coverage: response.coverage };
        rememberSurfaceView('time', currentSurface);
        activeSurfaceView = 'time';
        surfaceStale = false;
        pendingSurfacePoint = null;
        renderPendingItems(pendingItemsAfterDateCurve(resolved?.pending_items));
        renderSurface(currentSurface, false);
        const start = input.analysis_context.timeline.start;
        const end = input.analysis_context.timeline.end;
        const hypothesis = rateSelection
          ? `mantendo a taxa real de compra (${formatAnnualRate(entry.annual_real_rate, 4)}) constante`
          : `mantendo o PU de compra (${formatCurrency(fixedPu, 4)} por título) constante`;
        byId('mtm-output-title').textContent = 'Resultado do período';
        if (byId('mtm-output-context')) byId('mtm-output-context').textContent = `Período: ${surfaceDateLabel(start)} a ${surfaceDateLabel(end)} · consulte a cobertura e selecione um ponto.`;
        byId('mtm-workspace-quality').textContent = response.status === 'ready' ? 'Cobertura disponível' : 'Cobertura parcial';
        byId('mtm-workspace-summary').textContent = `Período solicitado: ${surfaceDateLabel(start)} a ${surfaceDateLabel(end)}. Hipótese: ${hypothesis}; trajetória hipotética, não uma previsão. O calendário, as sessões elegíveis e os limites do título são resolvidos pelo motor.`;
        byId('mtm-workspace-result-detail').textContent = `Primeira data elegível selecionada pelo calendário do motor: ${surfaceDateLabel(selectedDate)}${lastDateResolution?.sale?.settlement_date ? ` · liquidação ${surfaceDateLabel(lastDateResolution.sale.settlement_date)}` : ''}.`;
        const coverage = response.coverage || {};
        const count = coverage.requested_points || response.result.points.length;
        setPending(response.status === 'ready'
          ? `Período calculado · ${count} datas avaliadas.`
          : `Período calculado com cobertura parcial · ${count} datas e estados indisponíveis identificados.`);
        return true;
      } catch (error) {
        if (activeIntent === intent) {
          setPending(`O período não pôde ser calculado. ${error?.message || ''}`.trim());
          const guidance = byId('mtm-window-guidance');
          if (guidance) guidance.textContent = `Revise o intervalo e as premissas. ${error?.message || ''}`.trim();
        }
        return false;
      }
    }

    async function suggestWindow(event) {
      event?.preventDefault();
      if (busy) return;
      const intent = { id: ++intentSequence, action: 'RESOLVE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      try {
        updateDraft();
        const input = makeInput();
        if (!input.purchase_date || !input.instrument?.series_year && !input.instrument?.instrument_id
            && !input.instrument?.maturity_date && !input.instrument?.conversion_date) {
          setPending('Para sugerir um período, informe título, ano e data da compra.');
          byId(!input.purchase_date ? 'mtm-workspace-purchase-date' : 'mtm-workspace-series-year')?.focus();
          return;
        }
        if (input.assumptions?.settlement_profile === 'EXPLICIT') {
          setPending('O perfil explícito cobre uma única data e não permite sugerir um período. Escolha um perfil de liquidação projetado.');
          byId('mtm-workspace-settlement')?.focus();
          return;
        }
        const initialSaleDate = addIsoDays(input.purchase_date, 1);
        const initial = await request('RESOLVE', 'simulator/workspace', {
          schema_version: 2, action: 'RESOLVE', input: dateProbeInput(input, initialSaleDate),
        });
        if (activeIntent !== intent) return;
        if (!initial.accepted) { setPending('Os dados mudaram durante a sugestão. Execute novamente.'); return; }
        let resolved = initial.response?.resolved;
        if (resolved?.dates) lastDateResolution = resolved.dates;
        const instrument = resolved?.normalized_input?.instrument;
        const purchaseSettlement = resolved?.dates?.purchase?.settlement_date;
        const horizon = instrument?.family === 'RENDA_PLUS' ? instrument.first_income_date : instrument?.maturity_date;
        if (!purchaseSettlement || !horizon) {
          setPending('O motor ainda não identificou uma liquidação de compra e um horizonte válido para este título. Confira título, ano e data.');
          focusMissing(resolved || {});
          return;
        }
        const enteredStart = byId('mtm-workspace-window-start')?.value || '';
        const lowerBound = addIsoDays(purchaseSettlement, 1);
        const startBasis = enteredStart || localISODate();
        const earliestRequested = [startBasis, lowerBound].filter(Boolean).sort().at(-1);
        const lastDay = addIsoDays(horizon, -1);
        if (!earliestRequested || !lastDay || earliestRequested > lastDay) {
          setPending('Não existe um intervalo elegível de até 12 meses para esta série e data de compra. Informe outro título, compra ou período.');
          byId('mtm-workspace-window-start')?.focus();
          return;
        }
        const eligible = await resolveWindowStart(input, earliestRequested, lastDay, intent);
        if (!eligible) {
          setPending('O motor não encontrou uma data de venda elegível dentro do horizonte do título. Informe um intervalo específico compatível.');
          byId('mtm-workspace-window-start')?.focus();
          return;
        }
        const suggestedEnd = suggestedWindowEndDate(eligible.date, horizon);
        if (!suggestedEnd) {
          setPending('Não existe um intervalo positivo entre a primeira data elegível e o horizonte do título. Informe outro período.');
          byId('mtm-workspace-window-start')?.focus();
          return;
        }
        byId('mtm-workspace-window-start').value = eligible.date;
        byId('mtm-workspace-window-end').value = suggestedEnd;
        const guidance = byId('mtm-window-guidance');
        if (guidance) guidance.textContent = `Sugestão limitada à primeira data elegível resolvida pelo motor, a até 12 meses, ao horizonte da série e ao calendário projetado (2000–2085). Revise ${surfaceDateLabel(eligible.date)} a ${surfaceDateLabel(suggestedEnd)} antes de explorar.`;
        updateDraft();
        setPending('Sugestão preenchida. Revise o intervalo e escolha “Explorar período” quando estiver pronto.');
      } catch (error) {
        if (activeIntent === intent) {
          showError(error?.message || String(error));
          setPending('Não foi possível sugerir um intervalo; os campos atuais foram preservados.');
        }
      } finally {
        if (activeIntent === intent) { activeIntent = null; setBusy(false); }
      }
    }

    function isMapTabActive() {
      return workspaceRoot.querySelector('[data-mtm-tab="map"]')?.getAttribute('aria-selected') === 'true';
    }

    function rememberSurfaceView(view, surface) {
      const identity = resultIdentity();
      if (surfaceViewCache.identity !== identity) surfaceViewCache = { identity, time: null, rate: null, map: null };
      surfaceViewCache[view] = surface;
    }

    function cachedSurfaceView(view) {
      return surfaceViewCache.identity === resultIdentity() ? surfaceViewCache[view] : null;
    }

    function rateDomainFromControls() {
      const input = makeInput();
      return rateCurveDomainFromPercentages(
        byId('mtm-surface-rate-min')?.value,
        byId('mtm-surface-rate-max')?.value,
        byId('mtm-surface-rate-step')?.value,
        input.instrument?.family || '',
        selectedAnalysisModes().resultMode === 'UNIT_PRICE' ? 101 : 15,
      );
    }

    function updateRateDomainFeedback() {
      const feedback = byId('mtm-surface-domain-feedback');
      const button = byId('mtm-surface-rate-update');
      try {
        const domain = rateDomainFromControls();
        const limit = selectedAnalysisModes().resultMode === 'UNIT_PRICE' ? 101 : 15;
        if (feedback) feedback.textContent = `${domain.points} pontos · máximo de ${limit} nesta consulta. Alterar estes campos não recalcula o resultado.`;
        if (button) button.disabled = busy;
        return domain;
      } catch (error) {
        if (feedback) feedback.textContent = `${error.message} Nenhuma consulta foi enviada.`;
        if (button) button.disabled = true;
        return null;
      }
    }

    async function loadUnitPriceRateCurve(input, intent, domain = rateDomainFromControls()) {
      if (activeIntent !== intent) return false;
      intent.action = 'UNIT_PRICE';
      setPending(`Calculando preço por taxa · ${domain.points} pontos solicitados ao motor…`);
      const outcome = await request('UNIT_PRICE', 'simulator/workspace', {
        schema_version: 2, action: 'UNIT_PRICE', input: unitPriceInputFrom(input),
        query: { kind: 'RATE_CURVE', rate_domain: {
          minimum: domain.minimum, maximum: domain.maximum, step: domain.step,
        } },
      });
      if (activeIntent !== intent) return false;
      if (!outcome.accepted) {
        setPending('A faixa de taxas mudou durante o cálculo. O preço unitário anterior foi preservado; atualize a exploração novamente.');
        return false;
      }
      const result = outcome.response?.result;
      if (!result || !Array.isArray(result.points)) {
        setPending('O motor não retornou a curva de preço por taxa. Revise data, taxa, âncoras e hipóteses do título.');
        return false;
      }
      const entryRate = input.entry_price?.mode === 'MANUAL_RATE'
        ? input.entry_price.annual_real_rate : null;
      const matchedEntryRate = entryRate == null ? null
        : domain.values.find(rate => sameDecimalValue(rate, entryRate)) || null;
      const curvePoints = result.points.map(point => ({
        ...point, selected: Boolean(matchedEntryRate && sameDecimalValue(point.annual_real_rate, matchedEntryRate)),
      }));
      const surface = { result: { ...result, mode: 'UNIT_PRICE_RATE_CURVE', points: curvePoints }, coverage: result.coverage };
      rememberSurfaceView('rate', surface);
      currentSurface = surface;
      surfaceStale = false;
      pendingSurfacePoint = null;
      renderSurface(surface, false);
      setPending(result.status === 'ready'
        ? `Curva unitária pronta · ${result.points.length} taxas calculadas; valores por título, sem capital ou operação.`
        : `Curva unitária parcial · ${result.points.length} taxas e estados indisponíveis identificados.`);
      return true;
    }

    async function updateRateExploration() {
      if (busy) return;
      const domain = updateRateDomainFeedback();
      if (!domain) return;
      const modes = selectedAnalysisModes();
      if (modes.resultMode === 'UNIT_PRICE' && unitPriceResultStale) {
        setPending('Atualize o preço unitário antes de atualizar a faixa de taxa.');
        return;
      }
      const windowMode = modes.resultMode === 'OPERATION' && modes.timelineMode === 'WINDOW';
      if (modes.resultMode === 'OPERATION' && (windowMode
          ? (!currentSurface || surfaceStale)
          : (!lastValidResult || lastValidResult.identity !== resultIdentity()))) {
        setPending('Avalie as premissas atuais antes de atualizar a curva por taxa.');
        return;
      }
      const input = modes.resultMode === 'UNIT_PRICE'
        ? makeInput() : windowMode ? makeInput() : cloneJson(lastValidResult.input);
      const intent = { id: ++intentSequence, action: 'SURFACE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      try {
        if (modes.resultMode === 'UNIT_PRICE') {
          await loadUnitPriceRateCurve(input, intent, domain);
          return;
        }
        const current = currentSurface?.result || {};
        const currentSelection = selectionForCurrentResult();
        const orderDate = byId('mtm-surface-date-filter')?.value
          || current.selected?.order_date || currentSelection?.sale_date || input.sale_date;
        if (!orderDate) {
          setPending('Escolha ou avalie uma data de saída antes de explorar taxas.');
          return;
        }
        const baseRate = surfaceBaseRateForExploration(input, currentSelection, windowMode);
        const matchedBaseRate = baseRate == null ? null
          : domain.values.find(rate => sameDecimalValue(rate, baseRate)) || null;
        const selectedRate = matchedBaseRate || domain.values[Math.floor(domain.values.length / 2)];
        const surface = {
          mode: 'RATE_CURVE', metric_id: byId('mtm-surface-metric')?.value || 'net_redemption',
          value_unit: 'ratio', selected: { order_date: orderDate, value: selectedRate },
          values: domain.values,
        };
        const outcome = await request('SURFACE', 'simulator/workspace', {
          schema_version: 2, action: 'SURFACE', input, surface,
        });
        if (activeIntent !== intent) return;
        if (!outcome.accepted) {
          setPending('A faixa ou a data mudaram durante o cálculo. A curva anterior foi preservada; atualize a exploração novamente.');
          return;
        }
        const response = outcome.response;
        if (!response?.result || !Array.isArray(response.result.points)) {
          setPending('O motor não retornou uma curva por taxa. Confira a data, o domínio e os limites do título.');
          return;
        }
        const curveResult = matchedBaseRate ? response.result : {
          ...response.result, points: response.result.points.map(point => ({ ...point, selected: false })),
        };
        const surfaceResponse = { result: curveResult, coverage: response.coverage };
        rememberSurfaceView('rate', surfaceResponse);
        currentG4FrontierContext = null;
        currentSurface = surfaceResponse;
        surfaceStale = false;
        const pendingIdentity = pendingSurfacePoint?.identity;
        if (pendingIdentity && !response.result.points.some(point => point.identity === pendingIdentity)) {
          pendingSurfacePoint = null;
          const status = byId('mtm-surface-selection-status');
          if (status) status.textContent = 'O ponto escolhido ficou fora da nova faixa; escolha outro ponto para avaliar.';
        }
        renderSurface(currentSurface, false);
        setPending(response.status === 'ready'
          ? `Curva por taxa pronta · ${response.result.points.length} pontos calculados. Escolher uma taxa prepara uma seleção; o resultado só muda ao avaliá-la.`
          : `Curva por taxa parcial · ${response.result.points.length} pontos e lacunas preservados.`);
      } catch (error) {
        setPending(`A curva por taxa não foi atualizada; o resultado financeiro anterior permanece. ${error?.message || error}`);
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          syncActionState();
          updateRateDomainFeedback();
        }
      }
    }

    async function activateSurfaceView(view) {
      if (busy) return;
      if (view === 'time' || view === 'rate') {
        const cached = cachedSurfaceView(view);
        if (cached) {
          activeSurfaceView = view;
          currentSurface = cached;
          pendingSurfacePoint = null;
          renderSurface(currentSurface, false);
          return;
        }
        if (view === 'time') {
          setPending('A curva temporal ainda não foi calculada para esta revisão. Avalie o período novamente.');
          return;
        }
        await updateRateExploration();
        return;
      }
      if (view !== 'map') return;
      const modes = selectedAnalysisModes();
      if (modes.resultMode === 'UNIT_PRICE') return;
      const cached = cachedSurfaceView('map');
      if (cached) {
        activeSurfaceView = 'map';
        currentSurface = cached;
        pendingSurfacePoint = null;
        renderSurface(currentSurface, false);
        return;
      }
      const current = currentSurface?.result || {};
      const chosenDate = byId('mtm-surface-date-filter')?.value || current.selected?.order_date;
      const selectedValue = current.selected?.value;
      const selectedUnit = current.selected?.unit;
      const selection = selectionForCurrentResult() || (chosenDate && selectedValue != null
        ? { sale_date: chosenDate,
          ...(selectedUnit === 'ratio' ? { annual_real_rate: String(selectedValue) } : { exit_pu: String(selectedValue) }) }
        : null);
      if (!selection) {
        setPending('O mapa avançado exige uma data e uma coordenada selecionadas na avaliação atual.');
        return;
      }
      const mapMode = selection.annual_real_rate !== undefined ? 'RATE_DATE_MAP' : 'PRICE_DATE_MAP';
      const input = selectedAnalysisModes().timelineMode === 'WINDOW'
        ? makeInput() : lastValidResult?.input;
      if (!input || surfaceStale) {
        setPending('Atualize a avaliação atual antes de abrir o mapa avançado.');
        return;
      }
      const intent = { id: ++intentSequence, action: 'SURFACE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      try { await loadSurface(input, selection, intent, mapMode); }
      finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          syncActionState();
        }
      }
    }

    async function applySurfacePoint() {
      if (busy || surfaceStale || !pendingSurfacePoint || pendingSurfacePoint.metricStatus !== 'ready') return;
      const point = pendingSurfacePoint;
      const coordinateUnit = point.coordinate?.unit;
      const selection = {
        sale_date: point.order_date,
        ...(coordinateUnit === 'ratio'
          ? { annual_real_rate: String(point.coordinate.value) }
          : { exit_pu: String(point.coordinate.value) }),
      };
      const statePoint = { ...selection, origin: 'surface-confirmed', identity: point.identity };
      dispatch({ type: 'SELECT_POINT', point: statePoint });
      const evaluationIdentity = resultIdentityFields();
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      clearErrorFeedback();
      try {
        const windowMode = selectedAnalysisModes().timelineMode === 'WINDOW';
        const g4Context = currentG4FrontierContext;
        if (g4Context && !g4FrontierSelectionContextIsCurrent(
          g4Context, currentG4FrontierContext, comparisonIdentity(),
        )) {
          surfaceStale = true;
          renderSurface(currentSurface, true);
          setPending('A comparação de posição mudou. Atualize a comparação e reabra a grade G4 antes de avaliar um ponto.');
          return;
        }
        const sourceInput = g4Context?.input || (windowMode ? makeInput() : (lastValidResult?.input || makeInput()));
        const input = surfaceEvaluationInput(
          JSON.parse(JSON.stringify(sourceInput)), selection, windowMode,
        );
        setPending('Avaliando diretamente a data e a coordenada escolhidas…');
        const evaluated = await request('EVALUATE', 'simulator/workspace', {
          schema_version: 2, action: 'EVALUATE', input, selection,
        });
        if (activeIntent !== intent) return;
        if (g4Context && !g4FrontierSelectionContextIsCurrent(
          g4Context, currentG4FrontierContext, comparisonIdentity(),
        )) {
          if (currentG4FrontierContext === g4Context) {
            surfaceStale = true;
            renderSurface(currentSurface, true);
          }
          setPending('A comparação ou a grade G4 mudou durante a avaliação. A resposta atrasada foi descartada; atualize a comparação antes de selecionar outro ponto.');
          return;
        }
        if (!evaluated.accepted) {
          setPending('A seleção mudou durante a avaliação. O resumo anterior permanece; escolha o ponto novamente.');
          return;
        }
        const response = evaluated.response;
        if (!response?.result?.operation) {
          setPending('A avaliação direta não produziu uma operação disponível. O resumo e a referência atuais foram preservados.');
          return;
        }
        const displayInput = {
          ...input,
          sale_date: selection.sale_date,
          exit_price: selection.annual_real_rate !== undefined
            ? { mode: 'MANUAL_RATE', annual_real_rate: selection.annual_real_rate }
            : { mode: 'MANUAL_PU', pu: selection.exit_pu },
        };
        lastValidResult = {
          input, resolved: response.resolved || currentResolution, response,
          confirmedLocalExit: false, ...evaluationIdentity,
          goals_evaluated: evaluated.goals_current !== false,
        };
        const goalsStale = evaluated.goals_current === false;
        renderResolved(lastValidResult.resolved, response, false, false, displayInput, goalsStale);
        if (currentSurface) renderSurface(currentSurface, true);
        if (goalsStale) {
          setPending('Preço e resultado financeiro atualizados para o ponto escolhido. As metas mudaram durante o cálculo; aplique-as para atualizar o atendimento.');
          syncActionState();
          return;
        }
        if (g4Context) {
          renderSurface(currentSurface, false);
          setPending('Ponto G4 avaliado diretamente com a quantidade, aquisição, base fiscal e custos da posição comparada. A grade continua limitada às taxas e datas declaradas.');
          syncActionState();
          return;
        }
        await loadConstraintLimit(input, selection, intent);
        await loadSurface(input, selection, intent, 'RATE_CURVE');
      } catch (error) {
        if (activeIntent === intent) {
          setPending(`A seleção não foi avaliada. O resumo anterior continua válido. ${error?.message || ''}`.trim());
        }
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          syncActionState();
        }
      }
    }

    async function runUnitPrice(input, intent) {
      const needsFinancialDateForEnteredAnchor = input.entry_price?.mode === 'MANUAL_RATE'
        && Boolean(byId('mtm-workspace-buy-anchor')?.value.trim()
          || byId('mtm-workspace-inflation-rate')?.value.trim());
      let outcome = null;
      if (needsFinancialDateForEnteredAnchor && !lastDateResolution?.purchase?.settlement_date) {
        intent.action = 'UNIT_PRICE';
        setPending('Resolvendo a data financeira para aplicar a âncora informada…');
        outcome = await request('UNIT_PRICE', 'simulator/workspace', {
          schema_version: 2, action: 'UNIT_PRICE', input, query: { kind: 'POINT' },
        });
        if (activeIntent !== intent) return;
        if (!outcome.accepted) {
          setPending('As premissas mudaram durante a resolução da data financeira. Execute novamente.');
          return;
        }
        const financialDate = outcome.response?.result?.unit_price?.financial_date;
        if (financialDate) {
          lastDateResolution = { purchase: { settlement_date: financialDate } };
          const anchoredInput = makeInput();
          if (JSON.stringify(anchoredInput) !== JSON.stringify(input)) {
            input = anchoredInput;
            outcome = null;
          }
        }
      }
      intent.action = 'UNIT_PRICE';
      if (!outcome) {
        setPending('Calculando o preço unitário sem capital ou operação…');
        outcome = await request('UNIT_PRICE', 'simulator/workspace', {
          schema_version: 2, action: 'UNIT_PRICE', input,
          query: { kind: 'POINT' },
        });
      }
      if (activeIntent !== intent) return;
      if (!outcome.accepted) {
        setPending('As premissas mudaram durante o cálculo. O preço unitário não foi atualizado; execute novamente.');
        return;
      }
      const result = outcome.response?.result;
      if (!result) {
        setPending('O motor não retornou um preço unitário. Revise as pendências e execute novamente.');
        return;
      }
      renderPendingItems([]);
      unitPriceInput = cloneJson(input);
      renderUnitPriceResult(result, false);
      const missing = result.capabilities?.unit_price?.missing_fields || [];
      if (result.status !== 'ready') {
        setPending(missing.length
          ? `Preço unitário parcial. Complete: ${[...new Set(missing)].map(explainField).join('; ')}.`
          : 'Preço unitário parcial. Confira estado, qualidade e evidências retornados pelo motor.');
        focusMissing({ missing_fields: missing });
      } else {
        setPending('Preço unitário calculado. Nenhum resultado patrimonial foi criado.');
      }
      syncActionState();
      try {
        await loadUnitPriceRateCurve(input, intent);
      } catch (error) {
        if (activeIntent === intent) {
          setPending(`Preço unitário calculado; a curva por taxa não foi carregada. ${error?.message || error}`);
        }
      }
    }

    async function runWindow(input, intent) {
      if (input.assumptions?.settlement_profile === 'EXPLICIT') {
        setPending('O perfil de liquidação explícita cobre uma única data. Escolha uma data pontual ou um perfil projetado para explorar um período.');
        byId('mtm-workspace-settlement')?.focus();
        return;
      }
      intent.action = 'RESOLVE';
      let outcome = await request('RESOLVE', 'simulator/workspace', {
        schema_version: 2, action: 'RESOLVE', input,
      });
      if (activeIntent !== intent) return;
      if (!outcome.accepted) { setPending('As premissas mudaram durante a resolução. Execute novamente.'); return; }
      let response = outcome.response;
      let resolved = response?.resolved;
      if (resolved?.dates) lastDateResolution = resolved.dates;
      const followupInput = makeInput();
      if (JSON.stringify(followupInput) !== JSON.stringify(input)) {
        input = followupInput;
        outcome = await request('RESOLVE', 'simulator/workspace', {
          schema_version: 2, action: 'RESOLVE', input,
        });
        if (activeIntent !== intent) return;
        if (!outcome.accepted) { setPending('As premissas mudaram durante a resolução. Execute novamente.'); return; }
        response = outcome.response;
        resolved = response?.resolved;
        if (resolved?.dates) lastDateResolution = resolved.dates;
      }
      pendingResolution = resolved;
      renderResolved(resolved);
      const timeline = input.analysis_context?.timeline || {};
      if (!timeline.start || !timeline.end) {
        const missing = resolved?.missing_fields || [];
        setPending(missing.length
          ? `Informe um início e um fim para explorar o período. ${[...new Set(missing)].map(explainField).join('; ')}.`
          : 'Informe as datas de início e fim do período.');
        focusMissing({ ...resolved, missing_fields: [...new Set([...missing,
          ...(!timeline.start ? ['analysis_context.timeline.start'] : []),
          ...(!timeline.end ? ['analysis_context.timeline.end'] : []),
        ])] });
        return;
      }
      if (timeline.end < timeline.start) {
        setPending('O fim do período precisa ser igual ou posterior ao início. Revise as duas datas.');
        byId('mtm-workspace-window-end')?.focus();
        return;
      }
      const required = ['input_resolution', 'date_resolution', 'purchase_sizing'];
      const ready = required.every(key => response?.capabilities?.[key]?.status === 'available');
      if (!ready) {
        const missing = resolved?.missing_fields || [];
        setPending(missing.length
          ? `O período aguarda dados concretos: ${[...new Set(missing)].map(explainField).join('; ')}.`
          : 'O período aguarda título, compra, capital, preço e liquidação compatíveis. Confira as pendências.');
        focusMissing(resolved);
        return;
      }
      const start = await resolveWindowStart(input, timeline.start, timeline.end, intent);
      if (activeIntent !== intent) return;
      if (!start) {
        setPending('Não há uma data de venda elegível dentro deste intervalo, após a liquidação da compra e as regras do título. Ajuste o período.');
        byId('mtm-workspace-window-start')?.focus();
        return;
      }
      await loadDateCurve(input, resolved, start.date, intent);
    }

    async function run(event) {
      event?.preventDefault();
      if (busy) return;
      const focusOrigin = doc.activeElement;
      const previousOutput = currentEvaluation || unitPriceResult || currentSurface;
      const focusAfterSubmit = event?.type === 'submit';
      const intent = { id: ++intentSequence, action: 'RESOLVE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      clearErrorFeedback();
      if (confirmResolved) confirmResolved.hidden = true;
      resolvedInputJson = null;
      resolvedExitValue = null;
      resolvedSaleDate = null;
      pendingResolution = null;
      setPending('Preparando RESOLVE…');
      try {
        syncDatesToLegacy();
        updateDraft();
        renderLastValidResult();
        const missingBasics = root.MTMEase?.missingBasics(latestDraft.ui_form || {}) || [];
        if (missingBasics.length) {
          showError(`Preencha ${missingBasics[0].label}.`);
          setPending('Dados essenciais a preencher: ' + missingBasics.map(item => item.label).join(', ') + '. Comece pelo primeiro campo indicado.');
          doc.dispatchEvent(new CustomEvent('mtm:focus-field', { detail: { id: missingBasics[0].id } }));
          byId(missingBasics[0].id)?.focus();
          return;
        }
        if(chosenTitle()==='RENDA_PLUS'&&!instrumentSeriesOptions.RENDA_PLUS?.length)await refreshInstrumentSeriesOptions('RENDA_PLUS');
        const yearError=unsupportedRendaYearMessage(chosenTitle(),byId('mtm-workspace-series-year')?.value,instrumentSeriesOptions.RENDA_PLUS);
        if(yearError)throw new TypeError(yearError);
        let input = makeInput();
        if (input.analysis_context?.kind === 'UNIT_PRICE') {
          await runUnitPrice(input, intent);
          return;
        }
        if (input.analysis_context?.timeline?.mode === 'WINDOW') {
          await runWindow(input, intent);
          return;
        }
        intent.action = 'RESOLVE';
        let resolvedRequest = await request('RESOLVE', 'simulator/workspace', {
          schema_version: 2, action: 'RESOLVE', input,
        });
        if (activeIntent !== intent) return;
        if (!resolvedRequest.accepted) {
          setPending('Os dados mudaram durante a resolução. Confira as alterações e simule novamente.');
          return;
        }
        let resolvedResponse = resolvedRequest.response;
        let resolved = resolvedResponse?.resolved;
        if (resolved?.dates) lastDateResolution = resolved.dates;
        const followupInput = makeInput();
        const noSaleQuote = (byId('mtm-workspace-exit-price-mode')?.value || 'SAME_ENTRY') === 'SAME_ENTRY';
        const autoEntryPu = resolved?.resolved_prices?.entry_price?.value;
        if (noSaleQuote && input.entry_price?.mode === 'AUTO_LOCAL' && autoEntryPu) {
          followupInput.exit_price = sameEntryPu(autoEntryPu);
        }
        if (JSON.stringify(followupInput) !== JSON.stringify(input)) {
          input = followupInput;
          resolvedRequest = await request('RESOLVE', 'simulator/workspace', {
            schema_version: 2, action: 'RESOLVE', input,
          });
          if (activeIntent !== intent) return;
          if (!resolvedRequest.accepted) {
            setPending('Os dados mudaram durante a resolução. Confira as alterações e simule novamente.');
            return;
          }
          resolvedResponse = resolvedRequest.response;
          resolved = resolvedResponse?.resolved;
        }
        pendingResolution = resolved;
        if (resolved?.dates) lastDateResolution = resolved.dates;
        const hasPreviousResult = renderLastValidResult();
        if (!hasPreviousResult) renderResolved(resolved);
        else renderPendingItems(resolved?.pending_items);
        const required = ['input_resolution', 'date_resolution', 'price_resolution', 'nominal_evaluation', 'purchase_sizing'];
        const ready = required.every(key => resolvedResponse?.capabilities?.[key]?.status === 'available');
        if (!ready) {
          setPending(partialResolutionStatusMessage(
            resolvedResponse?.capabilities,
            resolved,
            hasPreviousResult,
            capabilityMessages(resolved),
          ));
          focusMissing(resolved);
          return;
        }
        const exitPrice = resolved?.resolved_prices?.exit_price;
        const exitValue = exitPrice?.value || input.exit_price?.pu;
        if (!exitValue) {
          setPending('A resolução não forneceu um PU de saída utilizável. Confira a premissa de saída.');
          return;
        }
        const saleDate = byId('mtm-workspace-sale-date')?.value;
        if (input.exit_price?.mode === 'AUTO_LOCAL') {
          resolvedInputJson = JSON.stringify(input);
          resolvedExitValue = String(exitValue);
          resolvedSaleDate = saleDate;
          if (confirmResolved) confirmResolved.hidden = false;
          syncActionState();
          setPending('Confira o PU de venda resolvido e confirme para avaliar com essa seleção.');
          return;
        }
        await evaluateInput(input, resolved, exitValue, saleDate, false, intent);
      } catch (error) {
        if (activeIntent === intent) {
          showLastValidIfStale();
          showError(error?.message || String(error));
          setPending('A solicitação não foi concluída. Os dados digitados e o último resultado válido foram preservados.');
        }
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          if (confirmResolved && !confirmResolved.hidden) confirmResolved.disabled = false;
          const nextOutput = selectedAnalysisModes().resultMode === 'UNIT_PRICE'
            ? unitPriceResult || currentSurface : currentEvaluation || currentSurface;
          if (focusAfterSubmit && nextOutput && nextOutput !== previousOutput && errorBox?.hidden
              && (doc.activeElement === focusOrigin || doc.activeElement === doc.body)) {
            byId('mtm-output-title')?.focus();
          }
        }
      }
    }

    async function confirmResolvedAndEvaluate() {
      if (busy || !resolvedInputJson || !confirmResolved) return;
      const intent = { id: ++intentSequence, action: 'EVALUATE', cancelled: false };
      activeIntent = intent;
      setBusy(true);
      clearErrorFeedback();
      try {
        updateDraft();
        const input = makeInput();
        if (JSON.stringify(input) !== resolvedInputJson) {
          resolvedInputJson = null;
          confirmResolved.hidden = true;
          setPending('As premissas mudaram depois da resolução. Simule novamente para obter preços compatíveis.');
          return;
        }
        confirmResolved.hidden = true;
        await evaluateInput(input, pendingResolution, resolvedExitValue, resolvedSaleDate, true, intent);
      } catch (error) {
        if (activeIntent === intent) {
          showLastValidIfStale();
          showError(error?.message || String(error));
          setPending('A seleção não foi avaliada. Os dados digitados e o último resultado válido foram preservados.');
        }
      } finally {
        if (activeIntent === intent) {
          activeIntent = null;
          setBusy(false);
          if (confirmResolved && !confirmResolved.hidden) confirmResolved.disabled = false;
        }
      }
    }

    workspaceMount = { run, syncActionState, openSaved: openSelectedSnapshot,
      captureRecovery: () => {
        const current = snapshot();
        const editable = item => item == null ? null : Object.fromEntries(
          ['id','label','input','normalized_input','draft','source_versions','provenance','input_fingerprint','fingerprint','selection']
            .filter(key => item[key] !== undefined).map(key => [key, cloneJson(item[key])]));
        const decision = decisionController?.capture({includeResult:false});
        if (decision) decision.result = null;
        const view = cloneJson(current.view); delete view.decision;
        return { form: cloneJson(current.draft.ui_form || {}), criteria: cloneJson(current.criteria),
          reference: editable(current.reference), alternatives: current.alternatives.map(editable), view,
          decision, source_versions: cloneJson(sourceVersionsOverride), name: byId('mtm-snapshot-name')?.value || '',
          comparison: {included: [...comparisonIncludedIds], mode: analysisMode,
            fields: Object.fromEntries(['mtm-compare-position-mode','mtm-compare-horizon','mtm-compare-cash-rate','mtm-compare-cash-origin','mtm-compare-highlight'].map(id => [id, byId(id)?.value || '']))},
          stress: {source: stressSource, shocks: cloneJson(stressShockDrafts), margins: cloneJson(stressMarginDrafts)} };
      },
      restoreRecovery: recovered => {
        if (busy || snapshotBusy) throw new Error('Aguarde o cálculo ou a gravação atual antes de recuperar.');
        if (!recovered?.form || !Array.isArray(recovered.criteria) || !Array.isArray(recovered.alternatives)) throw new Error('Rascunho incompatível; seus campos atuais foram preservados.');
        openingSnapshot = true;
        try {
          const fresh = requireState().createState();
          dispatch({type:'OPEN_SNAPSHOT', workspace:{draft:{ui_form:recovered.form}, criteria:recovered.criteria,
            alternatives:recovered.alternatives, reference:recovered.reference, selection:null, view:recovered.view || {}}, metadata:fresh.persistence});
          openedRecord = null; openedWorkspaceInput = null; openedFormTouched = false;
          sourceVersionsOverride = recovered.source_versions || null;
          lastValidResult = null; currentEvaluation = null; currentSurface = null; unitPriceResult = null;
          baseContext = null; pendingResolution = null; resolvedInputJson = null;
          currentConstraintLimit = null; currentFirstDateSearch = null; currentEntryBoundarySearch = null;
          currentRateBoundarySearch = {ENTRY:null, EXIT:null}; comparisonResult = null; currentStressResult = null;
          if (recovered.comparison) {
            comparisonIncludedIds = new Set(recovered.comparison.included || []);
            analysisMode = recovered.comparison.mode === 'stress' ? 'stress' : 'compare';
            for (const [id,value] of Object.entries(recovered.comparison.fields || {})) if (id.startsWith('mtm-compare-') && byId(id)) byId(id).value = value;
          }
          if (recovered.stress) { stressSource = recovered.stress.source || 'current'; stressShockDrafts = recovered.stress.shocks || []; stressMarginDrafts = recovered.stress.margins || []; }
          latestDraft = {...latestDraft, ui_form:cloneJson(recovered.form)};
          syncFormFromRaw(recovered.form); renderCriteria(); renderCompareContexts();
          renderStressShockEditors(); renderStressMarginEditors();
          byId('mtm-snapshot-name').value = recovered.name || '';
          byId('mtm-snapshot-consent').checked = false;
          byId('mtm-snapshot-review').hidden = true;
          byId('mtm-workspace-money').hidden = true;
          byId('mtm-surface-view').hidden = true;
          byId('mtm-unit-price-results').hidden = true;
          invalidateSnapshotRecalculation();
          decisionController?.restore(recovered.decision || null);
          byId('mtm-output-title').textContent = 'Rascunho recuperado · falta calcular';
          byId('mtm-workspace-quality').textContent = 'Sem novo cálculo';
          byId('mtm-workspace-summary').textContent = 'Confira os campos recuperados e clique em Analisar investimento. Nenhum resultado antigo foi apresentado como atual.';
          clearErrorFeedback(); renderPendingItems([]);
          setPending('Rascunho recuperado. Confira as hipóteses antes de calcular.');
        } finally { openingSnapshot = false; syncActionState(); }
      }
    };
    copyCatalog();
    renderIndexLevelRows([]);
    if (byId('mtm-workspace-knowledge-date') && !byId('mtm-workspace-knowledge-date').value) byId('mtm-workspace-knowledge-date').value = localISODate();
    if (byId('mtm-workspace-purchase-date') && !byId('mtm-workspace-purchase-date').value) byId('mtm-workspace-purchase-date').value = localISODate();
    if (byId('mtm-workspace-purchase-date') && byId('mtm-entry-order')?.value) byId('mtm-workspace-purchase-date').value = byId('mtm-entry-order').value;
    if (byId('mtm-workspace-sale-date') && byId('mtm-exit-order')?.value) byId('mtm-workspace-sale-date').value = byId('mtm-exit-order').value;
    syncTitleHint();
    updateRendaFields();
    updateDraft();
    suggestSnapshotName();
    renderCriteria();
    const initialView = snapshot()?.view || {};
    const metricSelect = byId('mtm-surface-metric');
    if (metricSelect && SURFACE_METRICS[initialView.metric]) metricSelect.value = initialView.metric;
    syncConstraintMode();
    for (const button of doc.querySelectorAll('[data-mtm-open-saved]')) button.addEventListener('click', () => {
      if (root.MTMEase) { doc.querySelector('[data-page="saved"]')?.click(); byId('ease-saved-query')?.focus(); return; }
      const section = byId('mtm-saved-analysis');
      if (section) { section.open = true; byId('mtm-snapshot-name')?.focus(); }
    });
    byId('mtm-edit-input')?.addEventListener('click', () => visibleSelect?.focus());
    undoButton.addEventListener('click', undoCurrent);
    cancelButton.addEventListener('click', cancelCurrentIntent);
    applyReferenceButton.addEventListener('click', applyCurrentReference);
    restoreReferenceButton.addEventListener('click', restoreReference);
    restoreBaseButton.addEventListener('click', () => restoreBaseScenario());
    for (const button of doc.querySelectorAll('[data-mtm-pin-alternative]')) button.addEventListener('click', pinCurrentAlternative);
    byId('mtm-compare-focus')?.addEventListener('change', event => {
      focusedAlternativeId = event.currentTarget.value;
      renderCompareContexts();
      invalidateSnapshotRecalculation(); syncActionState();
    });
    byId('mtm-compare-remove-alternative')?.addEventListener('click', removeFocusedAlternative);
    byId('mtm-compare-copy-alternative')?.addEventListener('click', copyFocusedAlternativeToExploration);
    byId('mtm-compare-result-summary')?.addEventListener('click', event => {
      if (event.target?.closest?.('[data-mtm-g4-frontier]')) exploreG4Frontier();
    });
    syncComparisonModeControls();
    byId('mtm-compare-position-mode')?.addEventListener('change', () => {
      syncComparisonModeControls();
      comparisonResult = null;
      renderComparisonResult();
      invalidateSnapshotRecalculation(); syncActionState();
    });
    byId('mtm-compare-run')?.addEventListener('click', runComparison);
    for (const id of ['mtm-compare-horizon', 'mtm-compare-cash-rate', 'mtm-compare-cash-origin']) {
      byId(id)?.addEventListener('input', () => {
        const status = byId('mtm-compare-status');
        if (status && comparisonResult) status.textContent = 'O horizonte ou a hipótese de caixa mudou. Execute novamente a comparação.';
        renderComparisonResult();
        invalidateSnapshotRecalculation(); syncActionState();
      });
      byId(id)?.addEventListener('change', () => { renderComparisonResult(); invalidateSnapshotRecalculation(); syncActionState(); });
    }
    byId('mtm-compare-highlight')?.addEventListener('change', event => {
      comparisonHighlight = event.currentTarget.value;
      renderComparisonResult();
      invalidateSnapshotRecalculation(); syncActionState();
    });
    for (const button of doc.querySelectorAll('[data-mtm-analysis-mode]')) {
      button.addEventListener('click', () => {
        analysisMode = button.dataset.mtmAnalysisMode;
        const comparePanel = byId('mtm-compare-mode'), stressPanel = byId('mtm-stress-mode');
        if (comparePanel) comparePanel.hidden = analysisMode !== 'compare';
        if (stressPanel) stressPanel.hidden = analysisMode !== 'stress';
        for (const item of doc.querySelectorAll('[data-mtm-analysis-mode]')) item.setAttribute('aria-pressed', String(item === button));
        invalidateSnapshotRecalculation(); syncActionState();
      });
    }
    byId('mtm-stress-source')?.addEventListener('change', event => {
      stressSource = event.currentTarget.value;
      stressMarginDrafts = [];
      renderStressMarginEditors();
      markStressEdited('Contexto alterado. Recalcule os estresses para essa fotografia.');
    });
    byId('mtm-stress-add-shock')?.addEventListener('click', () => {
      if (stressShockDrafts.length >= 25) return;
      stressShockDrafts.push({ label: `Estresse ${++stressSequence}`, rate: '', inflation: '', entryCost: '', exitCost: '' });
      renderStressShockEditors(); markStressEdited();
    });
    byId('mtm-stress-add-margin')?.addEventListener('click', () => {
      const criteria = stressConstraintRows(stressSourceInput(stressSource)?.input);
      if (!criteria.length || stressMarginDrafts.length >= 4) return;
      stressMarginDrafts.push({
        id: `margin-${++marginSequence}`, criterion_id: criteria[0].id,
        dimension: 'exit_expense_delta_brl', direction: 'INCREASE', maximum: '100', resolution: '10',
      });
      renderStressMarginEditors(); markStressEdited();
    });
    byId('mtm-snapshot-refresh')?.addEventListener('click', () => refreshSnapshots());
    byId('mtm-snapshot-select')?.addEventListener('change', () => {
      syncSnapshotControls();
      try {
        if (byId('mtm-snapshot-reopen')?.checked && byId('mtm-snapshot-select').value) {
          root.localStorage?.setItem(SNAPSHOT_REOPEN_KEY, byId('mtm-snapshot-select').value);
        }
      } catch (_) { /* Optional browser preference. */ }
    });
    byId('mtm-snapshot-open')?.addEventListener('click', () => openSelectedSnapshot().catch(error => setSnapshotMessage(error?.message || String(error), true)));
    byId('mtm-snapshot-save')?.addEventListener('click', () => saveSnapshot().catch(error => setSnapshotMessage(error?.message || String(error), true)));
    byId('mtm-snapshot-copy')?.addEventListener('click', () => saveSnapshot({ asCopy: true }).catch(error => setSnapshotMessage(error?.message || String(error), true)));
    byId('mtm-snapshot-recalculate')?.addEventListener('click', () => recalculateOpenedSnapshot().catch(error => setSnapshotMessage(error?.message || String(error), true)));
    byId('mtm-snapshot-save-revision')?.addEventListener('click', () => saveRecalculatedRevision().catch(error => setSnapshotMessage(error?.message || String(error), true)));
    byId('mtm-snapshot-name')?.addEventListener('input', syncSnapshotControls);
    byId('mtm-snapshot-consent')?.addEventListener('change', syncSnapshotControls);
    for (const id of ['mtm-workspace-instrument', 'mtm-workspace-series-year', 'mtm-workspace-purchase-date']) {
      byId(id)?.addEventListener('change', () => { suggestSnapshotName(); syncSnapshotControls(); });
    }
    byId('mtm-snapshot-reopen')?.addEventListener('change', event => {
      try {
        if (event.currentTarget.checked) {
          root.localStorage?.setItem('mtm.unified.reopenEnabled', '1');
          const id = snapshot()?.persistence?.id || byId('mtm-snapshot-select')?.value;
          if (id) root.localStorage?.setItem(SNAPSHOT_REOPEN_KEY, id);
        } else {
          root.localStorage?.removeItem('mtm.unified.reopenEnabled');
          root.localStorage?.removeItem(SNAPSHOT_REOPEN_KEY);
        }
      } catch (_) {
        event.currentTarget.checked = false;
        setSnapshotMessage('O navegador não permitiu guardar a preferência de reabertura. A fotografia segue disponível na lista local.', true);
      }
      syncSnapshotControls();
    });
    try { byId('mtm-snapshot-reopen').checked = root.localStorage?.getItem('mtm.unified.reopenEnabled') === '1'; }
    catch (_) { byId('mtm-snapshot-reopen').checked = false; }
    byId('mtm-stress-run')?.addEventListener('click', runStress);
    renderStressShockEditors();
    renderStressMarginEditors();
    renderCompareContexts();
    syncActionState();
    if (legacySelect) legacySelect.addEventListener('change', copyCatalog);
    visibleSelect?.addEventListener('change', syncLegacyTitle);
    for (const id of ['mtm-workspace-purchase-date', 'mtm-workspace-sale-date']) byId(id)?.addEventListener('change', syncDatesToLegacy);
    for (const name of ['capital-mode', 'entry-price-mode']) {
      for (const radio of form.querySelectorAll(`input[name="${name}"]`)) radio.addEventListener('change', () => {
        if (name === 'entry-price-mode') syncPriceModeVisibility();
        if (name !== 'capital-mode') { updateDraft(); return; }
        const budget = byId('mtm-budget-wrap'), quantity = byId('mtm-quantity-wrap');
        const isBudget = form.querySelector('input[name="capital-mode"]:checked')?.value !== 'QUANTITY';
        if (budget) budget.hidden = !isBudget;
        if (quantity) quantity.hidden = isBudget;
        updateDraft();
      });
    }
    for (const name of ['result-mode', 'timeline-mode']) {
      for (const radio of form.querySelectorAll(`input[name="${name}"]`)) radio.addEventListener('change', () => {
        syncAnalysisModeVisibility();
        updateDraft();
      });
    }
    byId('mtm-unit-price-link')?.addEventListener('click', () => {
      const radio = form.querySelector('input[name="result-mode"][value="UNIT_PRICE"]');
      if (radio) radio.checked = true;
      syncAnalysisModeVisibility(); updateDraft();
      const entryMode = form.querySelector('input[name="entry-price-mode"]:checked')?.value || 'RATE';
      byId(entryMode === 'PU' ? 'mtm-workspace-entry-pu' : 'mtm-workspace-buy-rate')?.focus();
    });
    for (const id of ['mtm-workspace-window-start', 'mtm-workspace-window-end']) {
      byId(id)?.addEventListener('input', updateDraft);
      byId(id)?.addEventListener('change', updateDraft);
    }
    byId('mtm-window-suggest')?.addEventListener('click', suggestWindow);
    byId('mtm-workspace-exit-price-mode')?.addEventListener('change', () => {
      syncPriceModeVisibility(); updateDraft();
    });
    for (const id of ['mtm-workspace-series-year']) {
      byId(id)?.addEventListener('input', () => { updateRendaFields(); updateDraft(); });
      byId(id)?.addEventListener('change', () => { updateRendaFields(); updateDraft(); });
    }
    for (const id of [
      'mtm-budget-value', 'mtm-quantity-value', 'mtm-workspace-buy-rate', 'mtm-workspace-sell-rate',
      'mtm-workspace-entry-pu', 'mtm-workspace-exit-pu',
      'mtm-workspace-entry-pu-source', 'mtm-workspace-exit-pu-source',
      'mtm-workspace-buy-anchor', 'mtm-workspace-sell-anchor',
      'mtm-workspace-inflation-rate', 'mtm-workspace-future-inflation-rate', 'mtm-workspace-inflation-end-date', 'mtm-workspace-anchor-source',
      'mtm-workspace-settlement', 'mtm-workspace-entry-fee',
      'mtm-workspace-entry-rate', 'mtm-workspace-exit-fee', 'mtm-workspace-knowledge-date', 'mtm-workspace-evidence-mode',
      'mtm-workspace-custody-actual', 'mtm-workspace-institution-net',
    ]) {
      byId(id)?.addEventListener('input', updateDraft);
      byId(id)?.addEventListener('change', updateDraft);
    }
    byId('mtm-workspace-index-level-add')?.addEventListener('click', () => {
      const current = indexLevelRowsFromForm();
      if (current.length >= 256) {
        setPending('O limite de 256 níveis do índice por operação foi atingido.');
        return;
      }
      current.push({ date: '', value: '', source_ref: '' });
      renderIndexLevelRows(current);
      byId('mtm-workspace-index-levels')?.querySelector('[data-mtm-index-level-row] [data-index-level-field="date"]')?.focus();
      updateDraft();
    });
    form.addEventListener('submit', run);
    for (const eventName of ['input', 'change']) {
      form.addEventListener(eventName, event => {
        const actualIds = ['mtm-workspace-custody-actual', 'mtm-workspace-institution-net'];
        if (!openingSnapshot && event.target.matches('input, select, textarea')
            && !actualIds.includes(event.target.id)) {
          const hadEffectiveValues = actualIds.some(id => byId(id)?.value.trim());
          for (const id of actualIds) if (byId(id)) byId(id).value = '';
          if (hadEffectiveValues && byId('mtm-effective-values-note')) byId('mtm-effective-values-note').hidden = false;
        } else if (actualIds.includes(event.target.id) && byId('mtm-effective-values-note')) {
          byId('mtm-effective-values-note').hidden = true;
        }
      }, true);
      form.addEventListener(eventName, event => {
        if (event.target === invalidField) clearErrorFeedback();
      });
    }
    confirmResolved?.addEventListener('click', confirmResolvedAndEvaluate);
    byId('mtm-criteria-add')?.addEventListener('click', () => {
      if ((snapshot()?.criteria || []).length >= 8) return;
      let id;
      do { id = `goal-${++criteriaSequence}`; }
      while ((snapshot()?.criteria || []).some(item => item.id === id));
      const criteria = [...(snapshot()?.criteria || []), {
        id, goal_type: 'PROFIT_MINIMUM', metric: 'NOMINAL_PROFIT', operator: 'AT_LEAST', value: '',
      }];
      dispatch({ type: 'UPDATE_CONSTRAINTS', criteria });
      renderCriteria({ id, field: 'metric' });
      onCriteriaEdited();
    });
    byId('mtm-criteria-apply')?.addEventListener('click', applyCriteria);
    byId('mtm-constraint-explore')?.addEventListener('click', exploreConstraintLimit);
    for (const button of doc.querySelectorAll('[data-mtm-limit-mode-button]')) {
      button.addEventListener('click', () => chooseConstraintMode(button.dataset.mtmLimitModeButton));
    }
    byId('mtm-entry-boundary-run')?.addEventListener('click', runEntryBoundarySearch);
    byId('mtm-entry-boundary-explore')?.addEventListener('click', exploreEntryBoundary);
    byId('mtm-surface-apply')?.addEventListener('click', applySurfacePoint);
    byId('mtm-surface-rate-update')?.addEventListener('click', updateRateExploration);
    for (const id of ['mtm-surface-rate-min', 'mtm-surface-rate-max', 'mtm-surface-rate-step']) {
      byId(id)?.addEventListener('input', updateRateDomainFeedback);
    }
    for (const button of doc.querySelectorAll('[data-mtm-surface-view]')) {
      button.addEventListener('click', () => activateSurfaceView(button.dataset.mtmSurfaceView));
    }
    for (const id of ['mtm-surface-metric', 'mtm-surface-date-filter', 'mtm-surface-coordinate-filter']) {
      byId(id)?.addEventListener('change', () => {
        if (id === 'mtm-surface-metric') changeView({ metric: byId(id).value });
        else surfaceTableState.page = 0;
        if (currentSurface) renderSurface(currentSurface, surfaceStale);
      });
    }
    byId('mtm-surface-reset')?.addEventListener('click', () => {
      const dateFilter = byId('mtm-surface-date-filter');
      const coordinateFilter = byId('mtm-surface-coordinate-filter');
      if (dateFilter) dateFilter.value = '';
      if (coordinateFilter) coordinateFilter.value = '';
      surfaceTableState.page = 0;
      if (currentSurface) renderSurface(currentSurface, surfaceStale);
    });
    const tabs = [...workspaceRoot.querySelectorAll('[data-mtm-tab]')];
    for (const tab of tabs) {
      tab.addEventListener('click', () => renderTabs(tab.dataset.mtmTab));
      tab.addEventListener('keydown', event => {
        const index = tabs.indexOf(tab);
        let next = null;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        if (next) { event.preventDefault(); renderTabs(next.dataset.mtmTab); next.focus(); }
      });
    }
    let surfaceResizeFramePending = false;
    window.addEventListener('resize', () => {
      if (surfaceResizeFramePending) return;
      surfaceResizeFramePending = true;
      window.requestAnimationFrame(() => {
        surfaceResizeFramePending = false;
        const plot = byId('mtm-surface-plot');
        if (!plot || plot.hidden || !currentSurface?.result) return;
        const metricId = byId('mtm-surface-metric')?.value || 'net_redemption';
        const model = surfaceViewModel(currentSurface, metricId);
        const nextTickCount = Math.min(model.dates.length, Math.max(2, Math.floor(plot.clientWidth / 100)));
        const nextNarrowLayout = plot.clientWidth < 480;
        if (nextTickCount === surfaceChartTickCount && nextNarrowLayout === surfaceChartNarrowLayout) return;
        const selectedDate = byId('mtm-surface-date-filter')?.value || '';
        const selectedCoordinate = byId('mtm-surface-coordinate-filter')?.value || '';
        const visiblePoints = model.points.filter(point =>
          (!selectedDate || point.order_date === selectedDate)
          && (!selectedCoordinate || point.coordinateRaw === selectedCoordinate),
        );
        renderSurfaceChart(model, visiblePoints);
      });
    });
    const savedTab = ['map', 'limits', 'compare'].includes(initialView.tab) ? initialView.tab : 'map';
    renderTabs(savedTab);
    updateRateDomainFeedback();
    decisionController = root.MTMDecision?.mount({
      doc,
      context: () => ({
        identity: resultIdentity(), busy, mode: selectedAnalysisModes().resultMode,
        draft: cloneJson(snapshot()?.draft?.ui_form || {}),
        instrumentYears: cloneJson(instrumentSeriesOptions.RENDA_PLUS || []),
        constraints: cloneJson(lastValidResult?.input?.constraints || []),
        fresh: Boolean(lastValidResult && !resultStaleness(lastValidResult).financial
          && !resultStaleness(lastValidResult).goals && selectedAnalysisModes().resultMode === 'OPERATION'),
        record: lastValidResult ? cloneJson(lastValidResult) : null,
        selection: selectionForCurrentResult(),
      }),
      run,
      changed: () => { invalidateSnapshotRecalculation(); syncSnapshotControls(); },
      readDocument: (kind, body) => {
        if (!['paste', 'document'].includes(kind)) throw new Error('Leitura de documento não suportada.');
        return http('studio/' + kind, body);
      },
      view: renderTabs,
      explore: activateSurfaceView,
      goal: async (goalId, value) => {
        if (busy) throw new Error('Aguarde o cálculo atual.');
        const goal = CONSTRAINT_GOALS.find(item => item.id === goalId);
        if (!goal) throw new Error('Escolha uma meta válida.');
        constraintThresholdForGoal(goalId, value);
        const criteria = snapshot()?.criteria || [];
        if (criteria.length >= 8) throw new Error('Oito metas já estão definidas. Edite-as em Metas e limites.');
        dispatch({ type: 'UPDATE_CONSTRAINTS', criteria: [...criteria, {
          id: `decision-${Date.now()}`, goal_type: goal.id, metric: goal.metric,
          operator: goal.operator, value,
        }] });
        renderCriteria(); onCriteriaEdited(); renderTabs('limits');
        if (lastValidResult && !resultStaleness(lastValidResult).financial) await applyCriteria({ refreshTechnical: false });
      },
      query: async (action, body, identity) => {
        if (!['RESOLVE', 'EVALUATE', 'STRESS', 'SURFACE', 'COMPARE'].includes(action)) throw new Error('Consulta exploratória não suportada.');
        if (busy || !lastValidResult || identity !== resultIdentity()) {
          throw new Error('Atualize a análise antes de explorar cenários.');
        }
        const intent = { id: ++intentSequence, action, cancelled: false };
        const previousResult = state.results[action];
        let completedRequestId = null;
        activeIntent = intent; setBusy(true);
        try {
          const outcome = await request(action, 'simulator/workspace', { ...body, schema_version: 2, action });
          completedRequestId = outcome.request?.request_id || null;
          if (activeIntent !== intent || !outcome.accepted || identity !== resultIdentity()) {
            throw new Error('As entradas mudaram. Atualize a análise e execute novamente.');
          }
          return outcome.response;
        } finally {
          // Exploratory results have their own receipt; the shared result slot
          // must continue to represent the base used by existing tools.
          if (completedRequestId && state.results[action]?.request_id === completedRequestId) {
            const results = { ...state.results };
            if (previousResult === undefined) delete results[action];
            else results[action] = previousResult;
            state = { ...state, results };
          }
          if (activeIntent === intent) { activeIntent = null; setBusy(false); }
        }
      },
    }) || null;
    decisionController?.update();
    workspaceMount.ready = http('bootstrap').then(async value => {
      catalog = value; copyCatalog();
      await refreshSnapshots();
      let preference = false, savedId = '';
      try {
        preference = root.localStorage?.getItem('mtm.unified.reopenEnabled') === '1';
        savedId = root.localStorage?.getItem(SNAPSHOT_REOPEN_KEY) || '';
      } catch (_) { /* Reopening is optional when browser storage is unavailable. */ }
      if (preference && savedId) {
        if (snapshotList.some(item => item.id === savedId)) await openSelectedSnapshot(savedId, true);
        else setSnapshotMessage('A fotografia escolhida para reabertura não está mais disponível neste computador. O rascunho atual foi preservado.');
      }
    }).catch(async () => { catalog = null; await refreshSnapshots(); });
  }

  function dispatch(event) {
    if (!state) throw new Error('MTM workspace is not initialized.');
    state = requireState().reduce(state, event);
    return snapshot();
  }

  function observeDraft(field, value, undoGroup = null) {
    if (!state || typeof field !== 'string' || !field) return snapshot();
    if (Object.is(latestDraft[field], value)) return state;
    latestDraft = { ...latestDraft, [field]: value };
    return dispatch({ type: 'EDIT_DRAFT', path: [field], value, ...(undoGroup ? { undo_group: undoGroup } : {}) });
  }

  function selectPoint(point) {
    return dispatch({ type: 'SELECT_POINT', point });
  }

  function changeView(view, undoGroup = null) {
    const next = dispatch({ type: 'CHANGE_VIEW', view: typeof view === 'string' ? { tab: view } : view, ...(undoGroup ? { undo_group: undoGroup } : {}) });
    workspaceMount?.syncActionState?.();
    return next;
  }

  function cancelAction(action) {
    if (!state || !action) return null;
    const requestId = state.active_requests[action];
    if (requestId) dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
    return requestId || null;
  }

  const HEAVY_REQUEST_ACTIONS = new Set(['RESOLVE', 'EVALUATE', 'UNIT_PRICE', 'GROSS_DV01', 'SURFACE', 'CONSTRAINTS', 'COMPARE', 'STRESS']);

  async function request(action, route, payload, onStart) {
    if (!state || !http) throw new Error('MTM workspace is not initialized.');
    const requestAction = String(action || '').toUpperCase();
    dispatch({
      type: 'REQUEST', action: requestAction,
      schema_version: payload && typeof payload === 'object' ? payload.schema_version : null,
      fingerprint: payload && typeof payload === 'object'
        ? (payload.fingerprint || payload.input_fingerprint) : null,
    });
    const requestId = state.active_requests[requestAction];
    const identity = state.requests[requestId];
    let body;
    try {
      body = typeof payload === 'function' ? payload(identity) : payload;
      if (body && body.schema_version === 2) {
        body = { ...body, request_id: identity.request_id, revision: identity.revision };
      }
    } catch (error) {
      dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
      throw error;
    }
    const execute = async () => {
      if (!requireState().currentRequest(state, requestId)) {
        dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
        return { accepted: false, stale: true, request: identity };
      }
      try {
        if (typeof onStart === 'function') onStart(identity);
        if (!requireState().currentRequest(state, requestId)) {
          dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
          return { accepted: false, stale: true, request: identity };
        }
        const response = await http(route, body);
        const outcome = requireState().acceptResponse(state, requestId, response);
        state = outcome.state;
        return { ...outcome, request: identity, response: outcome.response || response };
      } catch (error) {
        const stale = !requireState().currentRequest(state, requestId);
        dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
        if (stale) return { accepted: false, stale: true, request: identity };
        throw error;
      }
    };
    if (HEAVY_REQUEST_ACTIONS.has(requestAction)) {
      const outcome = await heavyRequestQueue.run(execute);
      if (outcome?.coalesced) dispatch({ type: 'CANCEL_REQUEST', request_id: requestId });
      return { ...outcome, request: identity };
    }
    return execute();
  }

  function unsupportedRendaYearMessage(family,year,supportedYears) {
    if(family!=='RENDA_PLUS'||!String(year||'').trim()||!Array.isArray(supportedYears)||!supportedYears.length||supportedYears.includes(Number(year)))return null;
    return `RendA+ ${year} ainda não é suportado neste aplicativo. Escolha uma das séries validadas: ${supportedYears.join(' ou ')}.`;
  }

  function snapshot() {
    if (!state) return null;
    return typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  }

  return Object.freeze({
    whenReady: () => workspaceMount?.ready || Promise.resolve(),
    captureRecovery: () => workspaceMount?.captureRecovery(),
    restoreRecovery: value => workspaceMount?.restoreRecovery(value),
    openSaved: id => workspaceMount?.openSaved(id),
    init,
    mountLegacy,
    dispatch,
    observeDraft,
    selectPoint,
    changeView,
    cancelAction,
    request,
    saveOperationForPayload,
    saveAcknowledgementForDraft,
    comparisonSnapshotConfig,
    g5StressRequestFromComparison,
    g5StressContextIdentity,
    handleStressResponse,
    g5DecisionMarginsViewModel,
    g5MarginStatusLabel,
    renderG5MarginReading,
    fixedPositionComparisonViewModel,
    commonShockRequests,
    commonShockViewModel,
    g4FrontierConditionLabel,
    g4FrontierViewModel,
    g4FrontierRequestFromComparison,
    g4FrontierSelectionContextIsCurrent,
    resolutionCapabilityMessages,
    partialResolutionStatusMessage,
    pendingItemPanelModel,
    pendingDateSuggestion,
    formatCriterionValue,
    criterionGoalGapLabel,
    parsePtDecimal,
    rateCurveDomainFromPercentages,
    priceFormModesFromInput,
    priceFieldVisibility,
    serializePriceChoice,
    analysisFormModesFromInput,
    analysisFieldVisibility,
    analysisContextForForm,
    unitPriceInputFrom,
    grossDv01RequestFromInput,
    unitPriceBlockedReasonMessage,
    workspaceMoneyViewModel,
    workspaceAssumptionsViewModel,
    firstDateSearchViewModel,
    firstDateCandidateSelection,
    firstDateAssumptionsViewModel,
    workspaceConclusionViewModel,
    workspaceCashBridgeViewModel,
    snapshotStoredFactsViewModel,
    constraintGoalDefinitions: CONSTRAINT_GOALS,
    constraintGoalForCriterion,
    constraintThresholdForGoal,
    criterionGoalTitle,
    unitPriceGoalGuidance,
    workspaceResultActionLabel,
    pendingItemsAfterDateCurve,
    addIsoDays,
    addIsoMonthsClamped,
    suggestedWindowEndDate,
    firstEligibleDateFromResolution,
    normalizePriceIndexLevelRows,
    shiftDecimal,
    formatPtNumber,
    entryBoundaryDomainDefaults,
    rateBoundaryQueryFromPercentages,
    exactDecimalDifference,
    stressQuickPresetModel,
    surfaceViewModel,
    surfaceBaseRateForExploration,
    surfaceEvaluationInput,
    withoutInstitutionalPointOverrides,
    institutionalActualFormValues,
    surfaceSelectionForScenario,
    surfaceContextMarkers,
    surfaceGoalOverlayModel,
    compareSurfaceDecimal,
    surfaceTablePageModel,
    surfaceSourceReferenceLabel,
    surfaceChartFallbackMessage,
    deduplicateSurfaceMessage,
    surfaceHoverGoalSummary,
    comparisonContextLabel,
    surfaceMetricDefinitions: SURFACE_METRICS,
    localizeWarning,
    snapshot,
    unsupportedRendaYearMessage,
    get mounted() { return legacyMounted; },
  });
});
