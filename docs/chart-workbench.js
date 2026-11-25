/* Presentation only: consumes calculated Plotly traces, never prices a security. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TesouroChartWorkbench = api;
})(typeof globalThis === 'object' ? globalThis : this, function chartWorkbench() {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : '—';
  const rateText = value => 'IPCA + ' + (Number(value) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  const measures = {net_redemption:'Valor a receber',nominal_profit:'Lucro estimado',nominal_return:'Rendimento total',real_return:'Acima da inflação'};
  const simulations = traces => traces.filter(t => t.meta?.kind === 'simulation');
  const styles = `.chart-workbench{margin:18px 0 4px}.chart-view-tabs{display:flex;gap:20px;border-bottom:1px solid var(--line,#dce4dd)}.chart-view-tabs button{border:0;border-radius:0;background:none;color:var(--muted,#5d6f68);font-size:13px;padding:10px 0;border-bottom:2px solid transparent}.chart-view-tabs button[aria-pressed=true]{color:#206c50;border-bottom-color:#206c50;font-weight:650}.chart-view-tabs .chart-table-toggle{margin-left:auto}.chart-workbench-filters{display:flex;justify-content:space-between;align-items:end;gap:14px;margin:18px 0}.chart-control-label{display:block;font-size:11px;color:var(--muted,#5d6f68)}.chart-rate-buttons{display:flex;gap:7px;margin-top:6px;flex-wrap:wrap}.chart-rate-buttons button{min-height:36px;border:1px solid #dce4dd;border-radius:5px;background:transparent;padding:6px 12px;color:var(--rate-color);font-size:12px}.chart-rate-buttons button:before{content:'';display:inline-block;width:14px;border-top:3px solid var(--rate-color);margin-right:6px;vertical-align:middle}.chart-rate-buttons button[aria-pressed=true]{border-color:var(--rate-color);background:#eff3ed;font-weight:650}.chart-workbench-filters select{margin-top:6px;min-height:36px;max-width:300px}.chart-workbench-filters .check{font-size:11px;min-height:36px;display:flex;align-items:center;gap:6px}.chart-date-control{display:flex;align-items:center;gap:12px;border-block:1px solid #dce4dd;padding:10px 0;font-size:11px;color:#5d6f68}.chart-date-control button{border:0;background:transparent;min-height:32px;padding:0 6px;font-size:22px}.chart-date-control output{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:#203a32;white-space:nowrap}.chart-date-control input[type=range]{accent-color:#206c50;max-width:260px;flex:1;min-width:60px;min-height:24px;padding:0;border:0;background:none}.chart-title-key{font-size:11px;color:#5d6f68;white-space:pre-wrap;margin:17px 0 12px}.chart-selected-values{display:flex;gap:30px;flex-wrap:wrap;margin:12px 0}.chart-selected-values>div{display:grid;gap:4px;min-width:155px}.chart-selected-values span{font-size:12px;color:#5d6f68}.chart-selected-values strong{font-size:25px;letter-spacing:-.4px;font-variant-numeric:tabular-nums}.chart-selected-values small{font-size:10px;color:#5d6f68}.chart-selected-values button{justify-self:start;border:0;background:none;color:#206c50;font-size:10px;padding:3px 0;min-height:23px}.chart-history-selected{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:15px 0}.chart-history-item h4{margin:0 0 10px;font-size:12px;color:#5d6f68}.chart-history-numbers{display:grid;grid-template-columns:1fr 1fr;gap:14px}.chart-history-numbers strong{display:block;font-size:24px;letter-spacing:-.3px;color:#203a32}.chart-history-numbers span{display:block;font-size:11px;line-height:1.5;margin-top:3px}.chart-history-numbers small{display:block;font-size:10px;line-height:1.5;margin-top:3px;color:#5d6f68}.chart-history-item>p{font-size:10px;color:#5d6f68;margin:10px 0 0!important}#export-workbench button{cursor:pointer}#export-workbench [hidden],[hidden].chart-history-selected{display:none!important}@media(max-width:760px){.chart-view-tabs{gap:14px}.chart-view-tabs button{font-size:11px;min-height:40px}.chart-selected-values{gap:20px}.chart-selected-values>div{min-width:130px;flex:1}.chart-selected-values strong{font-size:21px}.chart-date-control{gap:6px}.chart-date-control>span{display:none}.chart-date-control button{min-width:32px;min-height:40px}.chart-workbench-filters{align-items:start}.chart-workbench-filters .check{max-width:105px;line-height:1.5}.chart-rate-buttons button{min-height:40px;padding:6px 9px}.chart-history-selected{grid-template-columns:1fr;gap:18px}.chart-history-item+.chart-history-item{border-top:1px solid #dce4dd;padding-top:15px}}
.chart-workbench{container-type:inline-size;margin-top:12px}.chart-view-tabs{align-items:center;gap:18px}.chart-view-tabs .chart-overlay-trigger{margin-left:auto;min-height:34px;padding:6px 10px;border:1px solid #c8d0c3;border-radius:5px;color:#206c50;font-weight:600}.chart-view-tabs .chart-overlay-trigger:hover{background:#eff3ed}
.chart-workbench-filters{display:grid;grid-template-columns:minmax(250px,1fr) minmax(270px,340px);align-items:start;gap:24px;margin:14px 0 12px}.chart-rate-heading{display:flex;align-items:center;justify-content:flex-start;gap:16px;min-height:20px}.chart-workbench-filters .check{min-height:20px;max-width:none;white-space:nowrap;font-weight:400}.chart-date-box{background:#eef3ec;border:1px solid #d6e2d7;border-radius:6px;padding:8px 12px;margin:-8px 0}.chart-date-box>.chart-control-label{min-height:20px;font-size:12px;font-weight:650;color:#206c50}.chart-date-control{gap:8px;border:0;padding:0;margin-top:6px;min-height:36px}.chart-date-control input[type=range]{max-width:none;width:100%;min-width:45px}.chart-date-control button{min-width:28px;min-height:36px}.chart-date-control output{font-size:13px}.chart-accessible-key{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.chart-scenario-name{display:flex;align-items:center;gap:7px;min-height:24px}.chart-scenario-name span{font-size:12px;font-weight:650;color:#293d32;line-height:1.4}.chart-scenario-badge{display:inline-flex;align-items:center;justify-content:center;flex:0 0 22px;height:22px;border-radius:4px;background:#eaf0e6;color:#206c50;font-size:11px;font-weight:700;border:1px solid #8fa799}.chart-scenario-name:after{content:'';width:22px;flex:0 0 22px;border-top:2px solid #627067;margin-left:auto}[data-scenario=B] .chart-scenario-badge{background:transparent;border-style:dashed;color:#293d32}[data-scenario=B] .chart-scenario-name:after{border-top-style:dashed}.chart-history-item{min-width:0}.chart-history-item+.chart-history-item{border-left:1px solid #dce4dd;padding-left:16px}
@container(max-width:640px){.chart-workbench-filters{grid-template-columns:1fr;gap:12px}.chart-date-control{margin-top:3px}.chart-date-control input[type=range]{min-height:32px}.chart-history-item+.chart-history-item{border-left:0;border-top:1px dashed #a1afa4;padding:12px 0 0}.chart-history-selected{grid-template-columns:1fr}}
@media(max-width:760px){.chart-view-tabs{gap:10px}.chart-view-tabs button{font-size:11px}.chart-view-tabs .chart-overlay-trigger{font-size:11px;padding:6px 8px;min-height:40px}.chart-rate-buttons button{min-height:40px}}
.chart-history-heading{display:flex;align-items:center;justify-content:space-between;gap:4px 10px;flex-wrap:wrap;margin-bottom:8px}.chart-history-heading h4{flex:1 1 auto;margin:0!important;min-width:125px}.chart-history-heading .chart-history-period{margin:0;font-size:10px;font-weight:400;line-height:1.5;color:#627067;white-space:nowrap}

`;
  function normalize(raw = {}) {
    return { view: raw.view === 'separate' ? 'separate' : 'overlay',
      rate: typeof raw.rate === 'string' && raw.rate.length <= 100 && Number.isFinite(Number(raw.rate)) ? raw.rate : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : null,
      context: raw.context !== false };
  }
  function selection(traces, raw) {
    const state = normalize(raw), lines = simulations(traces);
    const rates = [...new Set(lines.map(t => t.meta.rate))].sort((a,b) => Number(a)-Number(b));
    if (!rates.includes(state.rate)) state.rate = rates[Math.floor(rates.length / 2)] || null;
    const dates = [...new Set(lines.filter(t => t.meta.rate === state.rate && t.visible !== 'legendonly').flatMap(t => t.x.filter((d,i) => t.y[i] != null)))].sort();
    if (!dates.includes(state.date)) state.date = dates.at(-1) || null;
    return { state, rates, dates };
  }
  function prepare(baseTraces, baseLayout, raw, width = 1000) {
    const {state,rates,dates} = selection(baseTraces, raw), traces = copy(baseTraces), layout = copy(baseLayout);
    const lines = simulations(traces), ids = [...new Set(lines.map(t => t.meta.scenario))];
    const separate = state.view === 'separate' && ids.length > 1;
    const mobile = width < 520, range = layout.yaxis?.range;
    layout.showlegend = false;
    layout.height = separate ? (mobile ? 590 : 650) : (mobile ? 370 : 470);
    layout.margin = { ...layout.margin, t: separate ? 45 : 28, b: 54, l: mobile ? 57 : 78, r: mobile ? 82 : 112 };
    layout.font = { ...layout.font, size: 12 };
    layout.meta = { ...layout.meta, chart_controls: state };
    layout.xaxis = { ...layout.xaxis, title: { text: 'Data de saída', standoff: 12 }, nticks: mobile ? 3 : 5, showgrid:false, tickfont: {size:12} };
    layout.yaxis = { ...layout.yaxis, domain: separate ? [.56,1] : [0,1], title: {text: baseLayout.yaxis?.title?.text || 'Valor (R$)',standoff:8}, nticks:6, tickfont:{size:12}, gridcolor:'#e5ebe5' };
    if (separate) layout.yaxis2 = { ...copy(layout.yaxis), domain:[0,.44], anchor:'x', matches:'y' };
    else delete layout.yaxis2;
    const annotations = [...(layout.annotations || [])], extra = [];
    for (const trace of traces) {
      const kind = trace.meta?.kind, active = trace.meta?.rate === state.rate;
      if (kind === 'simulation') {
        trace.name = trace.meta.history_base_name || trace.name;
        trace.line.width = active ? 3 : 1.7;
        trace.line.dash = trace.meta.scenario === 'B' ? 'dash' : 'solid';
        trace.opacity = active ? 1 : .5;
        if (!active && !state.context) trace.visible = 'legendonly';
        trace.marker = { ...trace.marker, color:trace.line.color, symbol:trace.meta.scenario==='B'?'diamond':'circle-open',
          size:trace.x.map(d => active ? d===state.date?9:4 : 2.5) };
        trace.hovertemplate = '%{customdata[1]}<br>%{customdata[2]}<extra>%{customdata[4]}</extra>';
      }
      trace.yaxis = separate && trace.meta?.scenario === ids[1] ? 'y2' : 'y';
      if (separate && (kind === 'goal' || kind === 'overlay_fill' && trace.meta.owner === 'goal')) extra.push({...copy(trace),yaxis:'y2',showlegend:false});
    }
    traces.push(...extra);
    if (state.date) layout.shapes = [...(layout.shapes || []), {type:'line',xref:'x',yref:'paper',x0:state.date,x1:state.date,y0:0,y1:1,line:{color:'#b5c8ba',width:1,dash:'dot'},layer:'below'}];
    if (separate) for (const [i,id] of ids.entries()) annotations.push({xref:'paper',yref:'paper',x:0,y:i? .47:1.02,text:escape(id),showarrow:false,xanchor:'left',font:{size:13,color:'#203a32'}});
    // Reposition labels only. Every point, date, y value, and axis range stays intact.
    if (Array.isArray(range) && range[1] > range[0]) for (const axis of separate?['y','y2']:['y']) {
      const available = Math.max(100,(layout.height-layout.margin.t-layout.margin.b)*(separate?.44:1));
      const ends = lines.filter(t=>t.visible!=='legendonly'&&t.yaxis===axis&&(rates.length<=7||t.meta.rate===state.rate)).flatMap(t=>{
        let i=t.y.length-1;while(i>=0&&t.y[i]==null)i--;if(i<0)return [];
        return [{t,i,py:(range[1]-t.y[i])/(range[1]-range[0])*available}];
      }).sort((a,b)=>a.py-b.py);
      let prev=-18;for(const e of ends){e.label=Math.max(e.py,prev+18);prev=e.label;}
      const shift=Math.max(0,(ends.at(-1)?.label||0)-available);for(const e of ends){e.label-=shift;
        const full=rateText(e.t.meta.rate), brief=full.length>22?full.slice(0,21)+'…':full;
        annotations.push({xref:'x',yref:axis,x:e.t.x[e.i],y:e.t.y[e.i],text:escape(e.t.meta.scenario+' · '+brief.replace('IPCA + ','')),
          showarrow:true,arrowhead:0,arrowwidth:1,arrowcolor:e.t.line.color,ax:23,ay:e.label-e.py,xanchor:'left',
          font:{size:mobile?10:12,color:e.t.line.color},bgcolor:'rgba(252,251,247,.88)',borderpad:1});
      }
    }
    layout.annotations = annotations;
    return {traces,layout,state,rates,dates};
  }
  function create(options) {
    const {doc,host,plot}=options;
    if (!host || !plot) return null;
    if(!doc.getElementById('chart-workbench-style')){const style=doc.createElement('style');style.id='chart-workbench-style';style.textContent=styles;doc.head.append(style);}
    let state=normalize(options.state), model=null, prepared=null, rateKey='', datesKey='', pending=false;
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text!=null)n.textContent=text;return n;};
    const button=(text,label)=>{const b=node('button',text);b.type='button';if(label)b.setAttribute('aria-label',label);return b;};
    host.className='chart-workbench';host.hidden=true;
    const views=node('div');views.className='chart-view-tabs';views.setAttribute('role','group');views.setAttribute('aria-label','Comparação no gráfico');
    const overlay=button('Mesmo gráfico'),separate=button('Gráficos separados');views.append(overlay,separate);
    const filters=node('div');filters.className='chart-workbench-filters';
    const rateBox=node('div'),caption=node('span','Taxa de saída · IPCA +');caption.className='chart-control-label';
    const rateButtons=node('div');rateButtons.className='chart-rate-buttons';rateButtons.setAttribute('role','group');rateButtons.setAttribute('aria-label','Taxa destacada');
    const rateSelect=node('select');rateSelect.setAttribute('aria-label','Taxa destacada');
    const contextLabel=node('label'),context=node('input');context.type='checkbox';contextLabel.className='check';contextLabel.append(context,node('span','Outras taxas'));
    const rateHeading=node('div');rateHeading.className='chart-rate-heading';rateHeading.append(caption,contextLabel);rateBox.append(rateHeading,rateButtons,rateSelect);
    const dateBox=node('div');dateBox.className='chart-date-box';dateBox.setAttribute('role','group');dateBox.setAttribute('aria-label','Data de saída');dateBox.append(node('span','Data de saída'));dateBox.firstChild.className='chart-control-label';filters.append(rateBox,dateBox);
    const dateBar=node('div');dateBar.className='chart-date-control';
    const prev=button('‹','Data anterior'),next=button('›','Próxima data'),dateLabel=node('output'),slider=node('input');slider.type='range';slider.min='0';slider.step='1';slider.setAttribute('aria-label','Selecionar data calculada');
    dateBar.append(prev,dateLabel,next,slider);dateBox.append(dateBar);
    if(options.overlaysButton){options.overlaysButton.classList.add('chart-overlay-trigger');views.append(options.overlaysButton);}
    const key=node('p');key.className='chart-title-key chart-accessible-key';key.textContent='A: linha contínua · círculo     B: tracejada · losango';
    const values=node('div');values.className='chart-selected-values';values.setAttribute('aria-live','polite');
    const currentTitle=node('strong');currentTitle.className='chart-summary-heading';
    const currentSummary=node('section');currentSummary.className='chart-current-summary';currentSummary.append(currentTitle,values);
    const summary=node('div');summary.className=options.historySection?'chart-data-summary':'chart-current-only';
    summary.append(currentSummary);if(options.historySection)summary.append(options.historySection);
    host.replaceChildren(views,filters,key,summary);
    function identity(id,label){const heading=node('div');heading.className='chart-scenario-name';const badge=node('b',id);badge.className='chart-scenario-badge';const name=node('span',String(label||id).replace(/^[AB]\s*·\s*/,''));heading.append(badge,name);return heading;}
    const enabled=()=>options.enabled?.()!==false;
    function change(patch) {if(!enabled())return;state=normalize({...state,...patch});options.onChange?.(copy(state));if(!pending){pending=true;Promise.resolve().then(()=>{pending=false;options.onRender?.();});}}
    overlay.onclick=()=>change({view:'overlay'});separate.onclick=()=>change({view:'separate'});
    context.onchange=()=>change({context:context.checked});rateSelect.onchange=()=>change({rate:rateSelect.value});
    slider.oninput=()=>change({date:prepared?.dates[Number(slider.value)]});
    const move=step=>{if(prepared?.dates.length){const i=prepared.dates.indexOf(state.date);change({date:prepared.dates[Math.max(0,Math.min(prepared.dates.length-1,i+step))]});}};
    prev.onclick=()=>move(-1);next.onclick=()=>move(1);
    plot.addEventListener('keydown',event=>{
      if(event.target!==plot||event.defaultPrevented||!enabled()||options.canConsult?.()===false)return;
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowLeft'?-1:1);}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();change({date:event.key==='Home'?prepared?.dates[0]:prepared?.dates.at(-1)});}
    });
    function refresh() {
      if(!prepared)return;host.hidden=false;
      const formatRate=options.formatRate||rateText;
      const currentKey=JSON.stringify(prepared.rates);
      if(currentKey!==rateKey){rateKey=currentKey;rateButtons.replaceChildren();rateSelect.replaceChildren();for(const rate of prepared.rates){
        const b=button(formatRate(rate).replace('IPCA + ','')),o=node('option',formatRate(rate));o.value=rate;
        b.dataset.rate=rate;b.onclick=()=>change({rate});const line=simulations(model.traces).find(t=>t.meta.rate===rate);b.style.setProperty('--rate-color',line?.line?.color||'#206c50');rateButtons.append(b);rateSelect.append(o);
      }}
      rateButtons.hidden=prepared.rates.length>7;rateSelect.hidden=!rateButtons.hidden;rateSelect.value=state.rate||'';
      for(const b of rateButtons.children)b.setAttribute('aria-pressed',String(b.dataset.rate===state.rate));
      separate.hidden=new Set(simulations(model.traces).map(t=>t.meta.scenario)).size<2;
      overlay.setAttribute('aria-pressed',String(state.view==='overlay'||separate.hidden));separate.setAttribute('aria-pressed',String(state.view==='separate'&&!separate.hidden));
      context.checked=state.context;
      const index=prepared.dates.indexOf(state.date);dateLabel.textContent=day(state.date);slider.max=String(Math.max(0,prepared.dates.length-1));slider.value=String(Math.max(0,index));slider.setAttribute('aria-valuetext',day(state.date));
      for(const b of host.querySelectorAll('button,input,select'))b.disabled=!enabled();
      prev.disabled=!enabled()||index<=0;next.disabled=!enabled()||index>=prepared.dates.length-1;slider.disabled=!enabled()||!prepared.dates.length;
      currentTitle.textContent=measures[model.metric]||model.metric;currentTitle.hidden=!options.historySection;
      const labels=options.labels?.()||{},selected=simulations(model.traces).filter(t=>t.meta.rate===state.rate);
      key.hidden=selected.length<2;
      values.replaceChildren();
      for(const trace of selected){
        const id=trace.meta.scenario,i=trace.x.indexOf(state.date),data=i>=0?trace.customdata?.[i]:null;
        const box=node('div'),title=identity(id,labels[id]),value=node('strong',trace.visible==='legendonly'?'Linha oculta':data?.[2]||'Sem valor nesta data');box.dataset.scenario=id;box.append(title,value);
        value.style.color=trace.line.color;
        box.append(node('small',measures[model.metric]||model.metric));
        if(data?.[0]&&trace.visible!=='legendonly'&&options.onPoint){const inspect=button('Ver detalhes');inspect.className='text-action';inspect.disabled=!enabled();inspect.onclick=()=>{if(enabled())options.onPoint(data,id);};box.append(inspect);}
        values.append(box);
      }
      const historyHost=options.historyHost;
      if(historyHost){historyHost.replaceChildren();for(const trace of selected){const h=trace.meta.history;if(!h)continue;
        const box=node('article');box.className='chart-history-item';box.dataset.scenario=trace.meta.scenario;const heading=node('h4');heading.append(identity(trace.meta.scenario,labels[trace.meta.scenario]));const header=node('header');header.className='chart-history-heading';const period=node('p','Período: '+day(h.start)+'–'+day(h.end));period.className='chart-history-period';header.append(heading,period);box.append(header);
        const row=node('div');row.className='chart-history-numbers';const frequency=node('div'),run=node('div'),a=h.longest_above;
        const pct=node('strong',Number(h.percentage).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%');pct.style.color=trace.line.color;
        frequency.append(pct,node('span','dos dias com taxa até '+formatRate(state.rate).replace('IPCA + ','')),node('small',h.count+' de '+h.total+' dias com dados'));
        run.append(node('strong',(a?.span_days||0)+' dias'),node('span','maior período acima de '+formatRate(state.rate).replace('IPCA + ','')));
        if(a)run.append(node('small',day(a.start)+'–'+day(a.end)),...(a.left==='window'||a.right==='window'?[]:a.left==='missing'||a.right==='missing'?[node('small','Há dados ausentes no limite')]:[]));
        row.append(frequency,run);box.append(row);historyHost.append(box);
      }historyHost.hidden=!historyHost.children.length;if(options.coverage)options.coverage.hidden=Boolean(historyHost.children.length);if(options.historyTitle)options.historyTitle.textContent='Histórico da taxa · '+formatRate(state.rate);}
    }
    return {
      prepare(traces,layout,metric){model={traces,layout,metric};prepared=prepare(traces,layout,state,plot.clientWidth||1000);state=prepared.state;refresh();return prepared;},
      clear(){model=null;prepared=null;host.hidden=true;},
      snapshot:()=>copy(state), restore(raw){state=normalize(raw);},
      exportModel:()=>model?{data:copy(model.traces),layout:copy(model.layout)}:null,
      selectPoint(point){if(point?.data?.meta?.kind==='simulation'&&enabled())change({date:String(point.x).slice(0,10),rate:point.data.meta.rate});},
      invalidate(){for(const b of host.querySelectorAll('button,input,select'))b.disabled=true;if(options.historyHost)options.historyHost.replaceChildren();},
      refresh,
    };
  }
  return {normalize,selection,prepare,create,source:()=> '('+chartWorkbench.toString()+')()'};
});
