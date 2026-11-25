import {readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {collectHistory} from './history/core.mjs';
import {collectIPCA} from './ipca/core.mjs';

const [directory, kind] = process.argv.slice(2);
const collectors = new Map([['market-history', collectHistory], ['ipca-history', collectIPCA]]);
if (!directory || !collectors.has(kind)) throw Error('Expected snapshot directory and collection name.');
const file = join(directory, kind + '.json');
const previous = JSON.parse(await readFile(file, 'utf8'));
const next = await collectors.get(kind)({previous});
await writeFile(file + '.tmp', JSON.stringify(next) + '\n');
await rename(file + '.tmp', file);
console.log(kind, next.as_of, next.source.sha256);
