(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TesouroPublicData = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  const decimalOK = value => typeof value === 'string' && /^\d{1,12}(?:\.\d{1,30})?$/.test(value) && Number(value) > 0;
  function validateIPCA(data) {
    if (data?.schema_version !== 1 || data.kind !== 'IPCA_MONTHLY_INDEX' || !Number.isFinite(Date.parse(data.retrieved_at))
      || !/^[a-f0-9]{64}$/.test(data.source?.sha256 || '') || !Array.isArray(data.observations)
      || !data.observations.length || data.observations.length > 1020) throw Error('Base de IPCA inválida.');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(data.retrieved_at));
    let next = '2000-06-01';
    for (const row of data.observations) {
      if (!Array.isArray(row) || row.length !== 2 || !dateOK(row[0]) || row[0] !== next || row[0] >= today.slice(0, 7) + '-01'
        || !decimalOK(row[1])) throw Error('IPCA com mês ausente, futuro ou inválido.');
      const month = new Date(row[0] + 'T12:00:00Z'); month.setUTCMonth(month.getUTCMonth() + 1); next = month.toISOString().slice(0, 10);
    }
    if (data.observations[0][1].replace(/0+$/, '') !== '1614.62' || data.as_of !== data.observations.at(-1)[0]) throw Error('Base ou cobertura do IPCA inconsistente.');
    return data;
  }
  function validatePrices(data) {
    if (data?.price_unit !== 'BRL') throw Error('Histórico ainda sem preços.');
    for (const series of data.series) {
      if (!Array.isArray(series.prices) || series.prices.length !== series.observations.length) throw Error('Preços históricos incompletos.');
      for (let i = 0; i < series.prices.length; i++) {
        const row = series.prices[i];
        if (!Array.isArray(row) || row.length !== 4 || row[0] !== series.observations[i][0]
          || !row.slice(1).every(value => value === null || decimalOK(value))) throw Error('Preço histórico inválido.');
      }
    }
    return data;
  }
  function newer(current, candidate) {
    return !current || candidate.as_of > current.as_of || candidate.as_of === current.as_of
      && Date.parse(candidate.retrieved_at) >= Date.parse(current.retrieved_at);
  }
  function candidates(kind, validate, fetcher) {
    async function read(url, source) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetcher(url, { signal: controller.signal, cache: 'no-cache' });
        if (!response.ok) throw Error('Fonte indisponível.');
        return { data: validate(await response.json()), mode: source };
      } finally { clearTimeout(timer); }
    }
    return [read('/tesouro-marcado/' + kind + '.json', 'snapshot'), read('https://raw.githubusercontent.com/flaviogeologo-spec/tesouro-marcado/dados/' + kind + '.json', 'live')];
  }
  function unavailable(kind) {
    return Error(kind === 'ipca-history' ? 'Não foi possível carregar o IPCA. Tente novamente.' : 'Não foi possível carregar os preços históricos. Tente novamente.');
  }
  async function latest(kind, sources) {
    const [snapshot, live] = (await Promise.allSettled(sources)).map(result => result.status === 'fulfilled' ? result.value : null);
    if (live && newer(snapshot?.data, live.data)) return live;
    if (snapshot) return snapshot;
    throw unavailable(kind);
  }
  function load(kind, validate, fetcher = fetch) {
    return latest(kind, candidates(kind, validate, fetcher));
  }
  function progressive(kind, validate, fetcher = fetch) {
    const sources = candidates(kind, validate, fetcher);
    return {
      first: Promise.any(sources).catch(() => { throw unavailable(kind); }),
      latest: latest(kind, sources),
    };
  }
  function ipcaCSV(data) {
    validateIPCA(data);
    // Collection date is conservative knowledge metadata, never a fabricated publication date.
    const known = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(data.retrieved_at));
    return 'Data;Conhecido em;Tipo;Valor;Fonte\n' + data.observations.map(row => `${row[0]};${known};IPCA_MONTHLY_INDEX;${row[1]};IBGE 1737 v2266 SHA256 ${data.source.sha256}\n`).join('');
  }
  return { dateOK, decimalOK, validateIPCA, validatePrices, newer, load, progressive, ipcaCSV };
});
