(() => {
  'use strict';
  const pending = new Map();
  let sequence = 0, fatal = null;
  let worker;
  function fail(message, duringStartup = false) {
    if (duringStartup) {
      worker.terminate();
      worker = undefined;
    } else {
      fatal = message;
    }
    for (const job of pending.values()) job.reject(Error(message));
    pending.clear();
  }
  function receive({data}) {
    if (data.stage) {
      const status = document.getElementById('form-status');
      if (status && !document.body.classList.contains('historical-page')) status.textContent = data.stage;
      return;
    }
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(Error(data.error)); else job.resolve(data.result);
  }
  function rpc(message) {
    if (fatal) return Promise.reject(Error(fatal));
    return new Promise((resolve,reject) => {
      if (!worker) {
        const instance = worker = new Worker('/tesouro-marcado/browser-worker.mjs',{type:'module'});
        let ready = false;
        instance.addEventListener('error', () => {
          if (worker !== instance) return;
          if (ready) fail('O motor foi interrompido. Recarregue a página e confira suas simulações salvas.');
          else fail('Não foi possível iniciar o motor. Tente novamente.', true);
        });
        instance.addEventListener('message', event => {
          if (worker !== instance) return;
          if (event.data.fatal) return fail(`${event.data.fatal} Tente novamente.`, true);
          if (event.data.ready) { ready = true; return; }
          if (event.data.result) ready = true;
          receive(event);
        });
      }
      const id = ++sequence;
      pending.set(id,{resolve,reject});
      worker.postMessage({id,message});
    });
  }
  async function request(path,options={}) {
    if (!navigator.locks) throw Error('Use um navegador atualizado em uma conexão HTTPS para guardar as simulações com segurança.');
    const url = new URL(path,location.href), method = options.method || 'GET';
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw Error('Destino de cálculo inválido.');
    if (options.signal?.aborted) throw new DOMException('Operação cancelada.','AbortError');
    const message = {path:url.pathname,method,query:Object.fromEntries(url.searchParams),body:options.body ? JSON.parse(options.body) : null};
    // The lock spans load, calculation, transaction and sync; all tabs share it.
    const result = await navigator.locks.request('tesouro-marcado-store-v1',async () => {
      if (options.signal?.aborted) throw new DOMException('Operação cancelada.','AbortError');
      return rpc(message);
    });
    if (options.signal?.aborted) throw new DOMException('Operação cancelada.','AbortError');
    return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json'}});
  }
  window.TesouroTransport = Object.freeze({fetch:request});
})();
