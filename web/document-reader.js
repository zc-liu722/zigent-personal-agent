import { assetUrl, loadStyle } from './lazy-assets.js';
let library,worker,workerIdle;
function pdfWorker(pdf) {
  clearTimeout(workerIdle);
  if(!worker || worker.destroyed) {
    const current=worker=new pdf.PDFWorker();
    current.promise.catch(()=>{current.destroy();if(worker===current)worker=undefined;});
  }
  return worker;
}
function releaseWorkerLater() {
  clearTimeout(workerIdle);
  workerIdle=setTimeout(()=>{worker?.destroy();worker=undefined;},60_000);
}
function libraries() {
  if (!library) library=(async()=>{
    const styles=loadStyle('./vendor/pdfjs/web/pdf_viewer.css');styles.catch(()=>{});
    // The compatibility builds include browser API polyfills needed on mobile Safari.
    const pdf=await import(assetUrl('./vendor/pdfjs/legacy/build/pdf.mjs'));
    pdf.GlobalWorkerOptions.workerSrc=assetUrl('./vendor/pdfjs/legacy/build/pdf.worker.mjs');
    // Worker startup overlaps viewer loading and the server-side Office conversion.
    pdfWorker(pdf);
    const [viewer]=await Promise.all([import(assetUrl('./vendor/pdfjs/legacy/web/pdf_viewer.mjs')),styles]);
    return {pdf,...viewer};
  })().catch(error=>{library=undefined;throw error;});
  return library;
}
const node=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;};
const icon=(name)=>{
  const paths={close:'m6 6 12 12M6 18 18 6',download:'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',previous:'m14 6-6 6 6 6',next:'m10 6 6 6-6 6'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',paths[name]);svg.append(path);return svg;
};
const control=(label,name)=>{const item=node('button','dr-icon');item.type='button';item.title=label;item.setAttribute('aria-label',label);item.append(icon(name));return item;};
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});
let reader;
export async function openDocumentPreview(source) {
  const modules=libraries();modules.catch(()=>{});
  await loadStyle('./document-reader.css');
  reader ||= createReader();
  await reader.open(source);
}
function createReader() {
  const base=new URL('./',location.href), endpoint=path=>new URL('api/workbench/'+path,base).href;
  const dialog=node('dialog','document-reader'), head=node('header','dr-heading'), title=node('h2','dr-title'), close=control('关闭预览','close');
  title.id='document-reader-title';dialog.setAttribute('aria-labelledby',title.id);close.classList.add('dr-close');
  const download=node('a','dr-icon dr-download');download.title='下载原件';download.setAttribute('aria-label','下载原件');download.append(icon('download'));
  const toggleSearch=control('搜索文档','search'),headActions=node('div','dr-head-actions');toggleSearch.setAttribute('aria-expanded','false');
  headActions.append(toggleSearch,download,close);head.append(title,headActions);
  const toolbar=node('footer','dr-toolbar'),navigation=node('div','dr-navigation'),zoom=node('div','dr-zoom');
  const previous=control('上一页','previous'), next=control('下一页','next'), page=node('input','dr-page'), count=node('span','dr-count','/ 0');
  page.type='number';page.min='1';page.value='1';page.setAttribute('aria-label','跳转到页');
  const minus=node('button','dr-icon','−'),plus=node('button','dr-icon','+'),scale=node('select','dr-scale');minus.type=plus.type='button';
  minus.setAttribute('aria-label','缩小');plus.setAttribute('aria-label','放大');scale.setAttribute('aria-label','缩放');
  for(const [value,label] of [['page-width','适合宽度'],['page-fit','整页'],['0.75','75%'],['1','100%'],['1.5','150%'],['2','200%']])scale.append(new Option(label,value));
  navigation.append(previous,page,count,next);zoom.append(minus,scale,plus);toolbar.append(navigation,zoom);
  const searchBar=node('div','dr-search-bar'),search=node('input','dr-search'),matches=node('span','dr-matches');
  const findPrevious=control('上一个匹配','previous'),findNext=control('下一个匹配','next');
  searchBar.id='document-reader-search';searchBar.hidden=true;toggleSearch.setAttribute('aria-controls',searchBar.id);
  search.type='search';search.placeholder='搜索文档';search.setAttribute('aria-label','搜索文档');searchBar.append(search,matches,findPrevious,findNext);
  const stage=node('div','dr-stage'),container=node('div','dr-container'),pages=node('div','pdfViewer'),status=node('div','dr-status');
  const spinner=node('span','dr-spinner'),statusText=node('span','dr-status-text'),retry=node('button','dr-retry','重新加载');retry.type='button';spinner.setAttribute('aria-hidden','true');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.append(spinner,statusText,retry);
  container.append(pages);stage.append(container,status);dialog.append(head,searchBar,stage,toolbar);document.body.append(dialog);
  let controller,generation=0,viewer,linkService,findController,loadingTask,returnFocus,pinnedSource,resize,renderTimer;
  async function request(path,method,body,signal) {
    const response=await fetch(endpoint(path),{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal});
    if(response.status===401)throw new Error('登录已过期，请重新登录后预览。');
    const value=await response.json().catch(()=>{throw new Error('暂时无法连接，请重试。');});
    if(!response.ok)throw new Error(value.error||'预览加载失败，请重试。');return value;
  }
  function feedback(text,failed=false){
    clearTimeout(renderTimer);status.hidden=false;statusText.textContent=text;retry.hidden=!failed;spinner.hidden=failed;
    dialog.dataset.state=failed?'failed':'loading';container.hidden=true;toolbar.hidden=true;toggleSearch.disabled=true;
    searchBar.hidden=true;toggleSearch.setAttribute('aria-expanded','false');stage.setAttribute('aria-busy',String(!failed));
  }
  function clear() {
    controller?.abort();resize?.disconnect();resize=undefined;clearTimeout(renderTimer);
    viewer?.setDocument(null);linkService?.setDocument(null);findController?.setDocument(null);viewer=linkService=findController=undefined;
    const task=loadingTask;loadingTask=undefined;pages.replaceChildren();
    return Promise.resolve(task?.destroy()).catch(()=>{});
  }
  function find(backwards=false,again=false) {
    if(!viewer)return;
    viewer.eventBus.dispatch('find',{source:search,type:again?'again':'',query:search.value,phraseSearch:true,caseSensitive:false,entireWord:false,highlightAll:true,findPrevious:backwards,matchDiacritics:false});
  }
  function showSearch(show){searchBar.hidden=!show;toggleSearch.setAttribute('aria-expanded',String(show));if(show){search.focus();search.select();}}
  toggleSearch.onclick=()=>showSearch(searchBar.hidden);
  const changeScale=()=>{if(viewer)viewer.currentScaleValue=scale.value;};
  previous.onclick=()=>{if(viewer)viewer.currentPageNumber=Math.max(1,viewer.currentPageNumber-1);};
  next.onclick=()=>{if(viewer)viewer.currentPageNumber=Math.min(viewer.pagesCount,viewer.currentPageNumber+1);};
  page.onchange=()=>{if(viewer)viewer.currentPageNumber=Math.max(1,Math.min(viewer.pagesCount,Number(page.value)||1));};
  scale.onchange=changeScale;
  minus.onclick=()=>{if(viewer)viewer.currentScale=Math.max(.25,viewer.currentScale/1.2);};
  plus.onclick=()=>{if(viewer)viewer.currentScale=Math.min(4,viewer.currentScale*1.2);};
  search.oninput=()=>find();findPrevious.onclick=()=>find(true,true);findNext.onclick=()=>find(false,true);
  search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();find(event.shiftKey,true);}};
  dialog.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!toggleSearch.disabled){event.preventDefault();showSearch(true);}});
  close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{const token=++generation;void clear().finally(()=>{if(token===generation)releaseWorkerLater();});returnFocus?.focus?.({preventScroll:true});});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  retry.onclick=()=>void open(pinnedSource,true);
  function original(source) {
    if(source.versionId)return endpoint(`versions/${encodeURIComponent(source.versionId)}/download`);
    if(source.uploadId)return new URL(`api/assets/${encodeURIComponent(source.uploadId)}`,base).href;
    if(source.workspaceId&&source.path)return endpoint(`workspaces/${encodeURIComponent(source.workspaceId)}/download?${new URLSearchParams({path:source.path})}`);
  }
  async function open(source,retrying=false) {
    clearTimeout(workerIdle);
    const token=++generation;await clear();if(token!==generation)return;
    controller=new AbortController();const signal=controller.signal;
    pinnedSource=source;search.value='';matches.textContent='';
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    title.textContent=source.name||'文件预览';title.title=title.textContent;
    const originalUrl=original(source);download.hidden=!originalUrl;if(originalUrl)download.href=originalUrl;else download.removeAttribute('href');download.download=source.name||'';
    feedback('正在准备预览…');
    // Bound the whole chain, including the initial conversion-service discovery.
    const deadline=setTimeout(()=>{if(token!==generation)return;signal.aborted||controller.abort();void loadingTask?.destroy().catch(()=>{});feedback('预览超时，请重试或下载原件。',true);},360_000);
    try {
      const modules=libraries();modules.catch(()=>{});
      const {name:_,...input}=source;
      let preview=await request('previews','POST',{...input,retry:retrying},signal);
      if(token!==generation||signal.aborted)return;
      pinnedSource={versionId:preview.versionId,name:preview.name};title.textContent=preview.name;title.title=preview.name;
      download.href=endpoint(`previews/${preview.id}/download`);download.download=preview.name;download.hidden=false;
      let polls=0;
      while(['queued','generating'].includes(preview.state)) {
        statusText.textContent=preview.state==='queued'?'正在排队…':'正在生成预览…';
        await pause(Math.min(1000,200*2**polls++),signal);preview=await request(`previews/${preview.id}`,'GET',undefined,signal);
        if(token!==generation||signal.aborted)return;
      }
      if(preview.state!=='ready')throw new Error(preview.error||'预览生成失败，请重试。');
      statusText.textContent='正在加载页面…';
      const {pdf,EventBus,PDFLinkService,PDFFindController,PDFViewer}=await modules;if(token!==generation||signal.aborted)return;
      const documentWorker=pdfWorker(pdf);
      // Leave the loading state visible until a canvas has actually been drawn.
      container.hidden=false;
      const eventBus=new EventBus();linkService=new PDFLinkService({eventBus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
      findController=new PDFFindController({eventBus,linkService});
      viewer=new PDFViewer({container,viewer:pages,eventBus,linkService,findController,textLayerMode:1,annotationMode:1,enableScripting:false,imageResourcesPath:new URL('./vendor/pdfjs/web/images/',import.meta.url).href,maxCanvasPixels:8_000_000});
      linkService.setViewer(viewer);
      const current=()=>token===generation&&!signal.aborted;
      const updatePage=()=>{page.value=String(viewer.currentPageNumber);previous.disabled=viewer.currentPageNumber<=1;next.disabled=viewer.currentPageNumber>=viewer.pagesCount;};
      eventBus.on('pagesinit',()=>{if(!current())return;viewer.currentScaleValue='page-width';scale.value='page-width';count.textContent='/ '+viewer.pagesCount;page.max=String(viewer.pagesCount);updatePage();});
      eventBus.on('pagechanging',()=>{if(current())updatePage();});
      eventBus.on('updatefindmatchescount',event=>{if(current())matches.textContent=search.value?`${event.matchesCount.current}/${event.matchesCount.total}`:'';});
      eventBus.on('updatefindcontrolstate',event=>{if(current()&&event.state===1)matches.textContent='0/0';});
      const failRender=message=>{if(!current())return;controller.abort();void loadingTask?.destroy().catch(()=>{});feedback(message,true);};
      renderTimer=setTimeout(()=>failRender('页面加载超时，请重试或下载原件。'),45_000);
      const firstPaint=new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
        eventBus.on('pagerendered',event=>{
          if(!current())return;
          if(event.error){failRender('页面显示失败，请重试或下载原件。');return;}
          if(event.cssTransform)return;
          clearTimeout(renderTimer);status.hidden=true;toolbar.hidden=false;toggleSearch.disabled=false;dialog.dataset.state='ready';stage.setAttribute('aria-busy','false');resolve();
        });
      });
      firstPaint.catch(()=>{});
      loadingTask=pdf.getDocument({url:endpoint(`previews/${preview.id}/pdf`),worker:documentWorker,rangeChunkSize:262144,withCredentials:true,isEvalSupported:false,enableXfa:false,
        cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,disableAutoFetch:true,disableStream:true});
      const pdfDocument=await loadingTask.promise;if(!current())return;
      viewer.setDocument(pdfDocument);linkService.setDocument(pdfDocument);findController.setDocument(pdfDocument);
      viewer.firstPagePromise?.catch(()=>failRender('文件无法读取，请重试或下载原件。'));
      resize=new ResizeObserver(()=>{if(current()&&viewer&&['page-width','page-fit'].includes(viewer.currentScaleValue))viewer.currentScaleValue=viewer.currentScaleValue;});resize.observe(container);
      await firstPaint;
    } catch(error) {
      if(token===generation&&!signal.aborted&&error.name!=='AbortError'){
        controller.abort();void loadingTask?.destroy().catch(()=>{});
        feedback(error.name==='PasswordException'?'文件已加密，请下载原件。':error.message||'预览加载失败，请重试。',true);
      }
    } finally {clearTimeout(deadline);}
  }
  return {open};
}
