import { createHash } from 'node:crypto';

export const CATALOG = 'https://www.tesourotransparente.gov.br/ckan/api/3/action/package_show?id=taxas-dos-titulos-ofertados-pelo-tesouro-direto';
export const RESOURCE_ID = '796d2059-14e9-44e3-80c9-2d9e30b405c1';
export const SOURCE = 'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv';
const HEADER = 'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha';
const MAX_BYTES = 60 * 1024 * 1024;
const TITLES = [
  { id: 'IPCA_PRINCIPAL_2050', label: 'IPCA+ 2050', type: 'Tesouro IPCA+', maturity: '2050-08-15' },
  { id: 'RENDA_PLUS_2065', label: 'RendA+ 2065', type: 'Tesouro Renda+ Aposentadoria Extra', maturity: '2084-12-15' },
];

function iso(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error('Data inválida no histórico.');
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  if (new Date(result + 'T12:00:00Z').toISOString().slice(0, 10) !== result) throw new Error('Data inválida.');
  return result;
}

function basisPoints(value) {
  if (!value.trim()) return null;
  if (!/^-?\d{1,3},\d{2}$/.test(value)) throw new Error('Taxa fora do formato oficial.');
  const result = Number(value.replace(',', ''));
  if (!Number.isSafeInteger(result) || result <= -10000) throw new Error('Taxa inválida.');
  return result;
}

function price(value) {
  if (!value.trim()) return null;
  if (!/^\d{1,12},\d{2,12}$/.test(value)) throw new Error('PU fora do formato oficial.');
  const [whole, fraction] = value.split(',');
  const canonical = whole.replace(/^0+(?=\d)/, '') + '.' + fraction;
  if (!/[1-9]/.test(canonical)) throw new Error('PU deve ser positivo.');
  return canonical.replace(/0+$/, '').replace(/\.$/, '');
}

// The official file uses semicolons; quoted fields and CRLF are supported.
function* csvRows(text) {
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ';' || char === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (char === '\n') { yield row; row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('CSV incompleto.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); yield row; }
}

export function parseHistory(raw, { retrievedAt = new Date().toISOString(), url = SOURCE } = {}) {
  const bytes = Buffer.from(raw);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Tamanho do histórico inválido.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  const rows = csvRows(text), header = rows.next().value;
  if (header?.join(';') !== HEADER) throw new Error('Cabeçalho do histórico alterado.');
  const maps = TITLES.map(() => new Map()), priceMaps = TITLES.map(() => new Map()), marketDates = new Set();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(retrievedAt));
  let total = 0;
  for (const row of rows) {
    if (row.every(value => !value)) continue;
    if (++total > 1000000 || row.length !== 8) throw new Error('CSV incompleto ou fora do limite.');
    const date = iso(row[2]);
    if (date > today) throw new Error('Histórico contém data futura.');
    marketDates.add(date);
    const index = TITLES.findIndex(title => title.type === row[0]);
    if (index < 0) continue;
    const maturity = iso(row[1]);
    if (maturity !== TITLES[index].maturity) continue;
    const quote = [date, basisPoints(row[3]), basisPoints(row[4])];
    const prices = [date, ...row.slice(5).map(price)];
    if (prices.slice(1).every(value => value === null)) throw new Error('Cotação sem PU.');
    if (quote[1] === null && quote[2] === null) throw new Error('Cotação sem taxa.');
    const previous = maps[index].get(date);
    if (previous && JSON.stringify(previous) !== JSON.stringify(quote)) throw new Error('Cotações conflitantes na mesma data.');
    if (priceMaps[index].has(date) && JSON.stringify(priceMaps[index].get(date)) !== JSON.stringify(prices)) throw new Error('PUs conflitantes na mesma data.');
    maps[index].set(date, quote);
    priceMaps[index].set(date, prices);
  }
  const series = TITLES.map((title, i) => {
    const observations = [...maps[i].values()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!observations.length) throw new Error('Título ausente do histórico oficial.');
    return { ...title, observations, prices: [...priceMaps[i].values()].sort((a, b) => a[0].localeCompare(b[0])) };
  });
  return { schema_version: 1, rate_unit: 'basis_points', price_unit: 'BRL', observation: 'morning', retrieved_at: retrievedAt,
    source: { publisher: 'Tesouro Nacional / Tesouro Transparente', url, catalog: CATALOG,
      license: 'ODbL-1.0', sha256: createHash('sha256').update(bytes).digest('hex') },
    as_of: series.map(title => title.observations.at(-1)[0]).sort()[0],
    market_dates: [...marketDates].filter(day => day >= series.map(title => title.observations[0][0]).sort()[0]).sort(), series };
}

export function ensureNoLoss(next, previous) {
  if (!previous) return next;
  if (previous.market_dates) {
    const currentDates = new Set(next.market_dates || []);
    if (previous.market_dates.some(day => !currentDates.has(day))) throw new Error('Atualização removeria datas do calendário observado.');
  }
  for (const old of previous.series) {
    const current = next.series.find(title => title.id === old.id);
    if (!current) throw new Error('Atualização removeria um título.');
    const byDate = new Map(current.observations.map(row => [row[0], row]));
    for (const row of old.observations) {
      const value = byDate.get(row[0]);
      if (!value || row.some((field, i) => i > 0 && field !== null && value[i] === null)) throw new Error('Atualização removeria cotações existentes.');
    }
    const prices = new Map((current.prices || []).map(row => [row[0], row]));
    for (const row of old.prices || []) {
      const value = prices.get(row[0]);
      if (!value || row.some((field, i) => i > 0 && field !== null && value[i] == null)) throw new Error('Atualização removeria PUs existentes.');
    }
  }
  return next;
}

async function officialFetch(url, fetcher, deadline) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.tesourotransparente.gov.br', 'tesourotransparente.gov.br'].includes(parsed.hostname)) throw new Error('Fonte fora do domínio oficial.');
  const response = await fetcher(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error', headers: { 'User-Agent': 'Tesouro-Marcado/1.0 (public historical rates)' } });
  if (!response.ok) throw new Error('Fonte oficial indisponível: ' + response.status);
  return response;
}

export async function collectHistory({ fetcher = fetch, previous = null, now = new Date() } = {}) {
  const deadline = Date.now() + 23000;
  const catalog = await (await officialFetch(CATALOG, fetcher, deadline)).json();
  const resource = catalog.success && catalog.result?.resources?.find(item => item.id === RESOURCE_ID && item.format?.toUpperCase() === 'CSV');
  if (!resource?.url) throw new Error('Recurso oficial não encontrado.');
  const response = await officialFetch(resource.url, fetcher, deadline);
  if (/html/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Resposta inválida.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('Histórico excedeu o limite.');
    chunks.push(Buffer.from(chunk));
  }
  return ensureNoLoss(parseHistory(Buffer.concat(chunks), { retrievedAt: now.toISOString(), url: resource.url }), previous);
}
