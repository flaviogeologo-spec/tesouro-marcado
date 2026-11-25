import {loadPyodide} from './vendor/pyodide-314.0.7/pyodide.mjs';
import './public-data.js';

let py, failed = false;
const stage = text => self.postMessage({stage:text});
const sync = populate => new Promise((resolve,reject) => py.FS.syncfs(populate,error => error ? reject(error) : resolve()));
const initialized = (async () => {
  stage('Preparando o motor de cálculo no navegador…');
  py = await loadPyodide({indexURL:new URL('./vendor/pyodide-314.0.7/',self.location.href).href});
  await py.loadPackage(['numpy','python-dateutil']);
  stage('Carregando as regras e as fontes de referência…');
  const manifest = await (await fetch('./release.json',{cache:'no-cache'})).json();
  const response = await fetch('./'+manifest.engine);
  if (!response.ok) throw Error('Não foi possível carregar o pacote do motor.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  if (digest !== manifest.engine_sha256) throw Error('O pacote de cálculo está incompleto. Recarregue a página.');
  py.unpackArchive(bytes,'zip',{extractDir:'/app'});
  py.runPython("import sys; sys.path.insert(0, '/app')");
  py.FS.mkdirTree('/persist');
  py.FS.mount(py.FS.filesystems.IDBFS,{},'/persist');
  py.runPython('from renda2065.browser_service import handle');
  self.postMessage({ready:true});
})();
async function refreshPublicIPCA() {
  try {
    stage('Consultando a atualização pública do IPCA…');
    const update = await self.TesouroPublicData.load('ipca-history', self.TesouroPublicData.validateIPCA);
    py.FS.writeFile('/app/data/ipca_monthly_ibge.csv', self.TesouroPublicData.ipcaCSV(update.data));
    py.FS.writeFile('/app/data/ipca_public_status.json', JSON.stringify({ mode: update.mode,
      as_of: update.data.as_of, retrieved_at: update.data.retrieved_at, sha256: update.data.source.sha256 }));
  } catch (_) {
    // The packaged official snapshot remains available when both endpoints fail.
    py.FS.writeFile('/app/data/ipca_public_status.json', JSON.stringify({ mode: 'bundled' }));
  }
}
let publicIPCA;
const historyRoutes = new Set(['/api/simulator/historical', '/api/simulator/position-risk', '/api/simulator/position-change', '/api/simulator/positions']);
// Even when multiple requests arrive, only one Python/SQLite operation runs at a time.
let queue = Promise.resolve();
self.onmessage = event => {
  const {id,message} = event.data;
  queue = queue.then(async () => {
    try {
      await initialized;
      if (failed) throw Error('Recarregue a página antes de tentar salvar novamente.');
      // History requests carry their own validated public snapshots.
      if (!historyRoutes.has(message.path) && !(message.path === '/api/bootstrap' && message.query?.scope === 'historical')) {
        await (publicIPCA ??= refreshPublicIPCA());
      }
      await sync(true);
      py.globals.set('_browser_request',JSON.stringify(message));
      const result = JSON.parse(py.runPython('handle(_browser_request)'));
      // Acknowledge save only after IndexedDB confirms durable synchronization.
      if (result.status >= 200 && result.status < 300 && message.method === 'POST'
          && !['/api/simulator/workspace','/api/simulator/dates','/api/simulator/historical','/api/simulator/position-risk','/api/simulator/position-change'].includes(message.path)) {
        try { await sync(false); }
        catch (_) {
          failed = true;
          throw Error('Não foi possível confirmar a gravação no navegador. Recarregue a página e confira a lista de simulações antes de tentar novamente.');
        }
      }
      self.postMessage({id,result});
    } catch (error) {
      self.postMessage({id,error:String(error.message||error)});
    }
  });
};
initialized.catch(error => self.postMessage({fatal:String(error.message||error)}));
