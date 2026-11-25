import { createHash } from 'node:crypto';

export const METADATA_URL = 'https://servicodados.ibge.gov.br/api/v3/agregados/1737/metadados';
export const VARIABLE = 'IPCA - Número-índice (base: dezembro de 1993 = 100)';
const UNIT = 'Número-índice';
const START = '2000-06-01';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MONTHS = 1200;

// JSON.parse alone silently accepts conflicting duplicate month keys.
export function strictJSON(raw) {
  const bytes = Buffer.from(raw);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Tamanho do JSON inválido.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let cursor = 0;
  const space = () => { while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++; };
  function string() {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') return JSON.parse(text.slice(start, cursor));
    }
    throw new Error('String JSON incompleta.');
  }
  function value(depth = 0) {
    if (depth > 32) throw new Error('JSON excedeu profundidade máxima.');
    space();
    if (text[cursor] === '"') return string();
    const opening = text[cursor];
    if (opening === '{' || opening === '[') {
      cursor++; space();
      const object = opening === '{', closing = object ? '}' : ']';
      const result = object ? Object.create(null) : [];
      if (text[cursor] === closing) { cursor++; return result; }
      while (cursor < text.length) {
        space();
        if (object && text[cursor] !== '"') throw new Error('Chave JSON inválida.');
        const key = object ? string() : result.length;
        if (object) {
          if (Object.hasOwn(result, key)) throw new Error('Chave JSON duplicada.');
          space(); if (text[cursor++] !== ':') throw new Error('JSON inválido.');
        }
        result[key] = value(depth + 1); space();
        const char = text[cursor++];
        if (char === closing) return result;
        if (char !== ',') throw new Error('JSON incompleto ou inválido.');
      }
      throw new Error('JSON incompleto.');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
    if (!token) throw new Error('JSON inválido.');
    cursor += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('Número JSON inválido.');
    return result;
  }
  const result = value(); space();
  if (cursor !== text.length) throw new Error('JSON inválido.');
  return result;
}

function month(value) {
  const text = String(value);
  if (!/^\d{6}$/.test(text) || text < '197912' || +text.slice(4) < 1 || +text.slice(4) > 12) throw new Error('Mês inválido.');
  return text.slice(0, 4) + '-' + text.slice(4) + '-01';
}
function months(first, last) {
  const from = +first.slice(0, 4) * 12 + +first.slice(5, 7) - 1;
  const to = +last.slice(0, 4) * 12 + +last.slice(5, 7) - 1;
  if (to < from || to - from >= MAX_MONTHS) throw new Error('Cobertura mensal fora do limite.');
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const index = from + i;
    return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0') + '-01';
  });
}
function decimal(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) throw new Error('Índice deve ser decimal positivo.');
  const [whole, fraction = ''] = value.split('.');
  const tail = fraction.replace(/0+$/, '');
  return whole.replace(/^0+(?=\d)/, '') + (tail ? '.' + tail : '');
}
export function metadataMonths(metadata, retrievedAt) {
  const period = metadata?.periodicidade;
  const variable = metadata?.variaveis?.filter(item => String(item.id) === '2266');
  if (String(metadata?.id) !== '1737' || period?.frequencia !== 'mensal'
    || !Array.isArray(metadata?.nivelTerritorial?.Administrativo) || !metadata.nivelTerritorial.Administrativo.includes('N1')
    || !Array.isArray(metadata.classificacoes) || metadata.classificacoes.length
    || variable?.length !== 1 || variable[0].nome !== VARIABLE || variable[0].unidade !== UNIT) throw new Error('Metadados do IPCA divergentes.');
  const first = month(period.inicio), last = month(period.fim);
  const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(retrievedAt)).slice(0, 7) + '-01';
  if (last >= current) throw new Error('Metadados contêm mês futuro ou ainda não encerrado.');
  return months(first, last);
}
export function parseIPCA(raw, { metadata, retrievedAt = new Date().toISOString(), url } = {}) {
  const expected = metadataMonths(metadata, retrievedAt);
  const payload = strictJSON(raw);
  const variable = Array.isArray(payload) && payload.length === 1 && payload[0];
  const result = variable?.resultados?.length === 1 && variable.resultados[0];
  const series = result?.series?.length === 1 && result.series[0];
  const locality = series?.localidade;
  if (String(variable?.id) !== '2266' || variable.variavel !== VARIABLE || variable.unidade !== UNIT
    || !Array.isArray(result.classificacoes) || result.classificacoes.length
    || locality?.id !== '1' || locality.nome !== 'Brasil' || locality.nivel?.id !== 'N1' || locality.nivel.nome !== 'Brasil'
    || Object.keys(locality.nivel).length !== 2 || !series.serie || Array.isArray(series.serie) || typeof series.serie !== 'object') throw new Error('Série IPCA ou localidade divergente.');
  const entries = Object.entries(series.serie).map(([date, value]) => [month(date), decimal(value)]).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length !== expected.length || entries.some((row, i) => row[0] !== expected[i])) throw new Error('Cobertura IPCA incompleta ou com lacuna.');
  const observations = entries.filter(row => row[0] >= START);
  if (observations[0]?.[0] !== START || observations[0][1] !== '1614.62') throw new Error('Âncora IPCA de junho de 2000 divergente.');
  return { schema_version: 1, kind: 'IPCA_MONTHLY_INDEX', retrieved_at: retrievedAt, as_of: observations.at(-1)[0],
    source: { publisher: 'IBGE', url, metadata_url: METADATA_URL, sha256: createHash('sha256').update(Buffer.from(raw)).digest('hex') }, observations };
}
export function ensureNoLoss(next, previous) {
  if (!previous) return next;
  const dates = new Set(next.observations.map(row => row[0]));
  if (previous.observations.some(row => !dates.has(row[0]))) throw new Error('Atualização removeria índices IPCA existentes.');
  return next;
}
async function get(url, fetcher, deadline) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'servicodados.ibge.gov.br' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443') || url.length > 10000) throw new Error('URL fora da fonte oficial IBGE.');
  const response = await fetcher(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error', headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } });
  if (response.status !== 200 || /html/i.test(response.headers.get('content-type') || '')) throw new Error('Resposta oficial IBGE inválida.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || +length > MAX_BYTES)) throw new Error('Tamanho IBGE inválido.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES || Date.now() > deadline) throw new Error('Resposta IBGE excedeu o limite.');
    chunks.push(Buffer.from(chunk));
  }
  if (length !== null && (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity') && size !== +length) throw new Error('Resposta IBGE incompleta.');
  return Buffer.concat(chunks);
}
export async function collectIPCA({ fetcher = fetch, previous = null, now = new Date() } = {}) {
  const deadline = Date.now() + 23000;
  const retrievedAt = now.toISOString();
  const metadata = strictJSON(await get(METADATA_URL, fetcher, deadline));
  const requested = metadataMonths(metadata, retrievedAt);
  const url = 'https://servicodados.ibge.gov.br/api/v3/agregados/1737/periodos/' + requested.map(date => date.replaceAll('-', '').slice(0, 6)).join('|') + '/variaveis/2266?localidades=N1[1]';
  return ensureNoLoss(parseIPCA(await get(url, fetcher, deadline), { metadata, retrievedAt, url }), previous);
}

export function toCSV(snapshot, knownOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(snapshot.retrieved_at))) {
  const source = 'IBGE API agregados 1737/2266 — IPCA número-índice, base dezembro de 1993 = 100, Brasil';
  return 'Data;Conhecido em;Tipo;Valor;Fonte\n' + snapshot.observations.map(([date, value]) => `${date};${knownOn};IPCA_MONTHLY_INDEX;${value};${source}\n`).join('');
}
