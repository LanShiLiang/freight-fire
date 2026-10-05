const $=id=>document.getElementById(id);
const size=bytes=>(Math.max(0,bytes)/1048576).toFixed(1)+' MB';
const phases={download:'下载',parse:'解析',decode:'解码',ready:'完成',prepare:'准备'};

class LoadingScreen {
  constructor(){
    document.body.dataset.loadingController='true';this.started=false;this.finished=false;this.failed=false;this.latest=null;this.since=performance.now();
    this.retry=()=>location.reload();$('loading-retry').onclick=()=>this.retry();
    this.timer=setInterval(()=>this.paint(),500);this.paint();
  }
  markStarted(){this.started=true;}
  begin(){this.finished=false;this.failed=false;this.since=performance.now();$('loading').hidden=false;$('loading-retry').hidden=true;$('loading').classList.remove('is-error');$('loading-title').textContent='准备登船';$('loading-help').textContent='首次进入需要下载模型，已完成的资源会保留。';this.paint();}
  onRetry(fn){this.retry=fn;}
  update(snapshot){this.latest=snapshot;this.paint();}
  stage(message){this.stageLabel=message;this.paint();}
  paint(){
    if(this.finished||this.failed)return;
    const s=this.latest;$('loading-elapsed').textContent=Math.floor((performance.now()-this.since)/1000)+' 秒';
    if(!s?.totalBytes){$('loading-progress').removeAttribute('value');$('loading-percent').textContent='连接中';$('loading-stage').textContent=this.stageLabel||'连接战场脚本…';return;}
    const percent=Math.floor(s.ratio*100);$('loading-progress').value=percent;$('loading-percent').textContent=percent+'%';
    $('loading-bytes').textContent=size(s.loadedBytes)+' / '+size(s.totalBytes);$('loading-count').textContent=s.completed+' / '+s.total;
    $('loading-progress').setAttribute('aria-valuetext',`资源下载 ${percent}%，${s.completed} 项资源已就绪`);
    const current=s.current;
    $('loading-stage').textContent=current?(current.status==='retrying'?`重新连接 · ${current.label}`:`${phases[current.phase]||'准备'} · ${current.label}`):this.stageLabel||'等待资源队列…';
    const attempts=s.active.filter(a=>a.critical&&a.attempt>1),stalled=s.active.filter(a=>a.critical&&a.status==='downloading'&&performance.now()-a.updatedAt>5000);
    $('loading-help').textContent=attempts.length?`网络正在重试（第 ${attempts[0].attempt} / 3 次），已完成的资源不会重复下载。`:stalled.length?'正在等待服务器数据；连接停滞后会自动重试。':s.ratio===1&&s.completed<s.total?'文件下载完成，正在解析模型与准备画面。':'首次进入需要下载模型，已完成的资源会保留。';
    $('loading-details').textContent=s.assets.filter(a=>a.critical).map(a=>`${a.label} · ${a.status} · ${size(a.loadedBytes)} / ${size(a.totalBytes)}${a.attempt>1?' · 第 '+a.attempt+' 次':''}${a.error?'\n  '+a.error:''}`).join('\n');
  }
  fail(error,{reload=false,webgl=false}={}){
    this.failed=true;$('loading').hidden=false;$('loading').classList.add('is-error');$('loading-title').textContent=webgl?'无法创建 3D 画面':'加载中断';
    const label=error?.label||'',message=error?.message||String(error);
    $('loading-stage').textContent=label?`${label} 未能载入`:webgl?'浏览器未能创建 WebGL 画面':'战场资源未能载入';
    $('loading-help').textContent=webgl?'请检查浏览器的硬件加速设置，启用后重新载入。':reload?'战场脚本未能载入，请重新连接。':'下载失败或处理超时。可以重试，已完成的资源会保留。';
    $('loading-details').textContent=[message,error?.url&&'资源：'+error.url,error?.phase&&'阶段：'+error.phase].filter(Boolean).join('\n');
    $('loading-diagnostics').open=true;$('loading-retry').hidden=false;$('loading-retry').disabled=false;
    $('loading-retry').textContent=reload||webgl?'重新载入页面 ↗':'重试未完成资源 ↗';if(reload||webgl)this.retry=()=>location.reload();
  }
  complete(){this.finished=true;this.failed=false;$('loading-progress').value=100;$('loading-percent').textContent='100%';$('loading').hidden=true;clearInterval(this.timer);}
}
export const loadingScreen=new LoadingScreen();
