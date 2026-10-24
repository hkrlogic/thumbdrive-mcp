/**
 * Static assets for the admin UI, kept as strings so the compiled dist/ needs
 * no extra files. Served from /assets/* with a strict CSP (no inline script
 * or style anywhere).
 */

export const THEME_JS = `(function(){try{var t=localStorage.getItem("td-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}document.documentElement.classList.add("js")})();`;

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="9" y="2" width="14" height="9" rx="1.5" fill="#94a3b8"/><rect x="12" y="5" width="3" height="3" fill="#fff"/><rect x="17" y="5" width="3" height="3" fill="#fff"/><rect x="5" y="10" width="22" height="20" rx="4" fill="#4f46e5"/><circle cx="16" cy="20" r="3.5" fill="#fff"/></svg>`;

export const APP_CSS = `
:root{
  --bg:#f6f7fb;--surface:#fff;--surface-2:#f1f3f9;--border:#e3e6ef;--text:#151826;--muted:#5d6479;
  --accent:#4f46e5;--accent-2:#4338ca;--accent-soft:#eef0ff;--on-accent:#fff;
  --danger:#c62828;--danger-soft:#fdecec;--ok:#1b7f4c;--ok-soft:#e6f6ee;--warn:#9a6700;--warn-soft:#fff6db;
  --radius:12px;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0e1017;--surface:#161925;--surface-2:#1d2130;--border:#2a2f42;--text:#e8eaf2;--muted:#9aa1b8;
  --accent:#8b8cff;--accent-2:#a5a6ff;--accent-soft:#23254a;--on-accent:#0e1017;
  --danger:#ff7b7b;--danger-soft:#3a1d22;--ok:#5fd39a;--ok-soft:#163327;--warn:#f2c14e;--warn-soft:#352c12;
  --shadow:none;color-scheme:dark;}}
:root[data-theme=dark]{
  --bg:#0e1017;--surface:#161925;--surface-2:#1d2130;--border:#2a2f42;--text:#e8eaf2;--muted:#9aa1b8;
  --accent:#8b8cff;--accent-2:#a5a6ff;--accent-soft:#23254a;--on-accent:#0e1017;
  --danger:#ff7b7b;--danger-soft:#3a1d22;--ok:#5fd39a;--ok-soft:#163327;--warn:#f2c14e;--warn-soft:#352c12;
  --shadow:none;color-scheme:dark;}
*{box-sizing:border-box}
html,body{margin:0}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
a:hover{color:var(--accent-2)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
h1{font-size:1.55rem;line-height:1.25;margin:0}
h2{font-size:1.1rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:0 0 .5rem}
p{margin:.25rem 0 .75rem}
code,pre,.mono{font-family:var(--mono);font-size:.86em}
.muted{color:var(--muted)}
.small{font-size:.86rem}
.skip{position:absolute;left:-999px;top:0;background:var(--accent);color:var(--on-accent);padding:.5rem 1rem;z-index:10}
.skip:focus{left:1rem}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* layout */
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh;background:linear-gradient(to right,var(--surface) 231px,var(--border) 231px,var(--border) 232px,transparent 232px)}
.nav{background:var(--surface);border-right:1px solid var(--border);padding:1.1rem .8rem;display:flex;flex-direction:column;gap:1rem;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:1.05rem;color:var(--text);text-decoration:none;padding:.2rem .5rem}
.brand img{width:28px;height:28px}
.brand small{display:block;font-weight:500;font-size:.72rem;color:var(--muted)}
.nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.nav a.item{display:flex;align-items:center;gap:.65rem;padding:.55rem .7rem;border-radius:9px;color:var(--muted);text-decoration:none;font-weight:500}
.nav a.item:hover{background:var(--surface-2);color:var(--text)}
.nav a.item[aria-current=page]{background:var(--accent-soft);color:var(--accent)}
.nav .foot{margin-top:auto;display:flex;flex-direction:column;gap:.35rem}
.nav .foot .btn{justify-content:flex-start}
main{padding:1.6rem clamp(1rem,3vw,2.4rem) 3rem;min-width:0;max-width:1180px;width:100%}
.page-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:1.2rem}
.page-head p{margin:.2rem 0 0}
.stack{display:flex;flex-direction:column;gap:1rem}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.spacer{flex:1}
@media (max-width:820px){
  .shell{grid-template-columns:1fr;background:none}
  .nav{position:sticky;top:0;z-index:5;height:auto;flex-direction:row;align-items:center;padding:.5rem .6rem;border-right:0;border-bottom:1px solid var(--border);gap:.4rem;overflow-x:auto}
  .brand small{display:none}
  .brand span.name{display:none}
  .nav ul{flex-direction:row}
  .nav a.item{padding:.5rem .6rem}
  .nav a.item span.label{display:none}
  .nav .foot{margin:0 0 0 auto;flex-direction:row}
  .nav .foot .label{display:none}
  main{padding-top:1rem}
}

/* surfaces */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.2rem;box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.card.flush > .card-head{padding:1rem 1.2rem .25rem}
.card.highlight{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.grid{display:grid;gap:1rem}
.grid.stats{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.stat{display:flex;flex-direction:column;gap:.15rem}
.stat .value{font-size:1.6rem;font-weight:700;letter-spacing:-.01em}
.stat .label{color:var(--muted);font-size:.85rem}
.empty{text-align:center;color:var(--muted);padding:2rem 1rem}

/* buttons and inputs */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:9px;padding:.5rem .85rem;font:inherit;font-weight:550;cursor:pointer;text-decoration:none;line-height:1.2;white-space:nowrap}
.btn:hover{background:var(--surface-2);color:var(--text)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover{background:var(--accent-2);border-color:var(--accent-2);color:var(--on-accent)}
.btn.danger{color:var(--danger)}
.btn.danger:hover{background:var(--danger-soft)}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--surface-2);color:var(--text)}
.btn.sm{padding:.32rem .6rem;font-size:.86rem}
.btn svg,.item svg{width:18px;height:18px;flex:none}
.btn.sm svg{width:16px;height:16px}
label{font-weight:550;font-size:.9rem}
.field{display:flex;flex-direction:column;gap:.3rem;margin-bottom:.8rem}
.field .hint{color:var(--muted);font-size:.82rem;font-weight:400}
input[type=text],input[type=password],input[type=search],select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:.5rem .7rem;min-width:0;width:100%}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
input[type=checkbox]{width:1.05rem;height:1.05rem;accent-color:var(--accent)}
.inline-form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end}
.inline-form .field{margin:0;flex:1 1 180px}
form.plain{display:inline}
.checks{margin:0;min-width:0;border:1px solid var(--border);border-radius:9px;max-height:260px;overflow:auto;padding:.35rem}
.checks label{display:flex;align-items:center;gap:.55rem;font-weight:450;padding:.3rem .45rem;border-radius:7px;cursor:pointer}
.checks label:hover{background:var(--surface-2)}
.d1{padding-left:1.4rem!important}.d2{padding-left:2.4rem!important}.d3{padding-left:3.4rem!important}.d4{padding-left:4.4rem!important}.d5{padding-left:5.4rem!important}

/* flash and badges */
.flash{border-radius:10px;padding:.7rem .9rem;margin-bottom:1rem;border:1px solid transparent}
.flash.ok{background:var(--ok-soft);color:var(--ok)}
.flash.error{background:var(--danger-soft);color:var(--danger)}
.flash.warn{background:var(--warn-soft);color:var(--warn)}
.badge{display:inline-flex;align-items:center;gap:.25rem;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.05rem .55rem;font-size:.8rem;font-weight:550;white-space:nowrap}
.badge.accent{background:var(--accent-soft);border-color:transparent;color:var(--accent)}
.badge.ok{background:var(--ok-soft);border-color:transparent;color:var(--ok)}
.badge.warn{background:var(--warn-soft);border-color:transparent;color:var(--warn)}
.badge.danger{background:var(--danger-soft);border-color:transparent;color:var(--danger)}

/* copy fields and code */
.copy{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);overflow:hidden}
.copy code{flex:1;padding:.6rem .8rem;overflow-x:auto;white-space:nowrap;font-size:.9rem;align-self:center}
.copy .btn{border:0;border-left:1px solid var(--border);border-radius:0}
.copy.big code{font-size:1rem}
pre.code{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:.8rem .9rem;overflow:auto;margin:0;font-size:.84rem;line-height:1.45}
.code-wrap{position:relative}
.code-wrap .btn{position:absolute;top:.45rem;right:.45rem}

/* tabs */
.tabs [role=tablist]{display:flex;gap:.25rem;border-bottom:1px solid var(--border);margin-bottom:.75rem;overflow-x:auto}
.tabs [role=tab]{border:0;background:none;font:inherit;font-weight:550;color:var(--muted);padding:.5rem .75rem;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
.tabs [role=tab][aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}
html:not(.js) .tabs [role=tablist]{display:none}
html:not(.js) .tabs [role=tabpanel]{display:block!important;margin-bottom:1rem}

/* tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.6rem 1.2rem;border-top:1px solid var(--border);vertical-align:middle}
thead th{border-top:0;color:var(--muted);font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:var(--surface)}
tbody tr:hover{background:var(--surface-2)}
td.name a{display:inline-flex;align-items:center;gap:.55rem;color:var(--text);text-decoration:none;font-weight:550;word-break:break-all}
td.name a:hover{color:var(--accent)}
td.name svg{width:20px;height:20px;flex:none;color:var(--muted)}
td.name svg.folder{color:var(--accent)}
td.num,th.num{text-align:right;white-space:nowrap}
td.actions{text-align:right;white-space:nowrap}
@media (max-width:820px){.hide-sm{display:none}th,td{padding:.55rem .8rem}}

/* menus built on <details> */
details.menu{position:relative;display:inline-block;text-align:left}
details.menu > summary{list-style:none}
details.menu > summary::-webkit-details-marker{display:none}
details.menu > .pop{position:absolute;right:0;top:calc(100% + 4px);z-index:4;background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 24px rgba(16,24,40,.16);padding:.7rem;min-width:270px;display:flex;flex-direction:column;gap:.5rem;white-space:normal}
details.menu > .pop.left{left:0;right:auto}
details.menu > .pop .btn{justify-content:flex-start}
details.menu > .pop hr{border:0;border-top:1px solid var(--border);margin:.2rem 0;width:100%}
details.section > summary{cursor:pointer;color:var(--muted);font-weight:550;padding:.4rem 0}

/* breadcrumbs */
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;font-size:1.25rem;font-weight:650}
.crumbs a{text-decoration:none;color:var(--muted)}
.crumbs a:hover{color:var(--accent)}
.crumbs .sep{color:var(--border)}
.crumbs [aria-current]{color:var(--text)}

/* upload */
.dropzone{border:2px dashed var(--border);border-radius:var(--radius);padding:1.1rem;text-align:center;color:var(--muted);transition:background .15s,border-color .15s}
.dropzone.over{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.dropzone .row{justify-content:center}
.dropzone .row > svg{width:22px;height:22px;flex:none}
.file-input{position:absolute;width:1px;height:1px;opacity:0}
.file-input:focus-visible + .btn{outline:2px solid var(--accent);outline-offset:2px}
html.js .no-js{display:none}
.uploads{list-style:none;margin:.75rem 0 0;padding:0;text-align:left;display:flex;flex-direction:column;gap:.35rem}
.uploads li{display:grid;grid-template-columns:1fr auto;gap:.15rem .75rem;font-size:.88rem;background:var(--surface-2);border-radius:8px;padding:.45rem .65rem}
.uploads progress{grid-column:1/-1;width:100%;height:6px;accent-color:var(--accent)}
.uploads .bad{color:var(--danger)}
.uploads .good{color:var(--ok)}

/* auth pages */
.auth{min-height:100vh;display:grid;place-items:center;padding:1.5rem}
.auth .card{width:min(420px,100%);padding:1.6rem}
.auth .brand{justify-content:center;margin-bottom:1rem;font-size:1.2rem}
.auth .btn.primary{width:100%;padding:.65rem}
.share-page{max-width:880px;margin:0 auto;padding:1.5rem 1rem 3rem}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;margin:0}
.kv dt{color:var(--muted)}
.kv dd{margin:0;min-width:0;word-break:break-all}
.steps{margin:.25rem 0 0;padding-left:1.2rem}
.steps li{margin:.3rem 0}
.steps li.done{color:var(--muted);text-decoration:line-through}
`;

export const APP_JS = `(function(){
"use strict";
var csrf=(document.querySelector('meta[name="csrf"]')||{}).content||"";

function copyText(text){
  if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(text);
  return new Promise(function(resolve,reject){
    var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.className="sr-only";
    document.body.appendChild(ta);ta.select();
    try{document.execCommand("copy")?resolve():reject(new Error("copy failed"))}catch(e){reject(e)}finally{ta.remove()}
  });
}

document.addEventListener("click",function(e){
  var b=e.target.closest("[data-copy]");if(!b)return;
  var sel=b.getAttribute("data-copy");var el=document.getElementById(sel);var text=el?el.textContent:sel;
  var label=b.querySelector(".label")||b;var old=label.textContent;
  copyText(text).then(function(){label.textContent="Copied";b.setAttribute("aria-live","polite")},function(){label.textContent="Press Ctrl+C";if(el){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)}})
  .then(function(){setTimeout(function(){label.textContent=old},1600)});
});

document.addEventListener("submit",function(e){
  var msg=e.target.getAttribute("data-confirm");
  if(msg&&!confirm(msg))e.preventDefault();
});

document.querySelectorAll("[data-autosubmit]").forEach(function(form){
  form.addEventListener("change",function(){form.requestSubmit?form.requestSubmit():form.submit()});
});

/* close other open menus */
document.addEventListener("click",function(e){
  document.querySelectorAll("details.menu[open]").forEach(function(d){if(!d.contains(e.target))d.removeAttribute("open")});
});
document.addEventListener("keydown",function(e){
  if(e.key==="Escape")document.querySelectorAll("details.menu[open]").forEach(function(d){d.removeAttribute("open");var s=d.querySelector("summary");if(s)s.focus()});
});
document.querySelectorAll("details.menu").forEach(function(d){
  d.addEventListener("toggle",function(){if(d.open){var f=d.querySelector(".pop input[type=text]");if(f){f.focus();var v=f.value,i=v.lastIndexOf("/")+1,j=v.lastIndexOf(".");f.setSelectionRange(i,j>i?j:v.length)}}});
});

/* tabs */
document.querySelectorAll(".tabs").forEach(function(box){
  var tabs=[].slice.call(box.querySelectorAll('[role="tab"]'));
  function select(t){tabs.forEach(function(x){var on=x===t;x.setAttribute("aria-selected",on?"true":"false");x.tabIndex=on?0:-1;document.getElementById(x.getAttribute("aria-controls")).hidden=!on});}
  tabs.forEach(function(t,i){
    t.addEventListener("click",function(){select(t)});
    t.addEventListener("keydown",function(e){var n=e.key==="ArrowRight"?1:e.key==="ArrowLeft"?-1:0;if(n){var x=tabs[(i+n+tabs.length)%tabs.length];select(x);x.focus()}});
  });
});

/* theme */
document.querySelectorAll("[data-theme-toggle]").forEach(function(b){
  b.addEventListener("click",function(){
    var root=document.documentElement;var cur=root.dataset.theme||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
    var next=cur==="dark"?"light":"dark";root.dataset.theme=next;try{localStorage.setItem("td-theme",next)}catch(e){}
  });
});

/* times */
var rtf=window.Intl&&Intl.RelativeTimeFormat?new Intl.RelativeTimeFormat(undefined,{numeric:"auto"}):null;
document.querySelectorAll("time[datetime]").forEach(function(t){
  var d=new Date(t.getAttribute("datetime"));if(isNaN(d))return;
  t.title=d.toLocaleString();
  if(t.hasAttribute("data-abs")){t.textContent=d.toLocaleString();return}
  var s=(d.getTime()-Date.now())/1000,a=Math.abs(s);
  if(!rtf||a>60*60*24*45){t.textContent=d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});return}
  var u=a<60?["second",1]:a<3600?["minute",60]:a<86400?["hour",3600]:["day",86400];
  t.textContent=rtf.format(Math.round(s/u[1]),u[0]);
});

/* uploads */
var dz=document.getElementById("dropzone");
if(dz){
  var dir=dz.getAttribute("data-dir"),max=Number(dz.getAttribute("data-max")),list=document.getElementById("upload-list");
  var fmt=function(n){var u=["B","KB","MB","GB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (i?n.toFixed(1):n)+" "+u[i]};
  dz.querySelectorAll("input[type=file]").forEach(function(input){
    input.addEventListener("change",function(){
      run([].slice.call(input.files).map(function(f){return{file:f,rel:f.webkitRelativePath||f.name}}));input.value="";
    });
  });
  ["dragenter","dragover"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();dz.classList.add("over")})});
  ["dragleave","drop"].forEach(function(ev){dz.addEventListener(ev,function(){dz.classList.remove("over")})});
  document.addEventListener("dragover",function(e){e.preventDefault()});
  document.addEventListener("drop",function(e){if(!dz.contains(e.target))e.preventDefault()});
  dz.addEventListener("drop",function(e){
    e.preventDefault();
    var items=[].slice.call(e.dataTransfer.items||[]),entries=items.map(function(i){return i.webkitGetAsEntry&&i.webkitGetAsEntry()}).filter(Boolean);
    if(!entries.length){run([].slice.call(e.dataTransfer.files).map(function(f){return{file:f,rel:f.name}}));return}
    var out=[];entries.reduce(function(p,en){return p.then(function(){return walk(en,"",out)})},Promise.resolve()).then(function(){run(out)});
  });
  function walk(entry,prefix,out){
    if(entry.isFile)return new Promise(function(res,rej){entry.file(function(f){out.push({file:f,rel:prefix+entry.name});res()},rej)});
    if(!entry.isDirectory)return Promise.resolve();
    var reader=entry.createReader();
    return new Promise(function(res,rej){
      (function more(){reader.readEntries(function(batch){
        if(!batch.length)return res();
        batch.reduce(function(p,c){return p.then(function(){return walk(c,prefix+entry.name+"/",out)})},Promise.resolve()).then(more,rej);
      },rej)})();
    });
  }
  function row(name){
    var li=document.createElement("li"),n=document.createElement("span"),s=document.createElement("span"),p=document.createElement("progress");
    n.textContent=name;s.textContent="Waiting";p.max=1;p.value=0;li.append(n,s,p);list.append(li);list.hidden=false;return{s:s,p:p};
  }
  function send(item,r){
    return new Promise(function(resolve,reject){
      var fd=new FormData();fd.append("_csrf",csrf);fd.append("dir",dir);fd.append("relpath",item.rel);fd.append("file",item.file,item.file.name);
      var x=new XMLHttpRequest();x.open("POST","/files/upload");x.setRequestHeader("Accept","application/json");x.setRequestHeader("X-CSRF-Token",csrf);
      x.upload.onprogress=function(e){if(e.lengthComputable){r.p.value=e.loaded/e.total;r.s.textContent=Math.round(100*e.loaded/e.total)+"%"}};
      x.onload=function(){var body={};try{body=JSON.parse(x.responseText)}catch(e){}x.status<300?resolve(body):reject(new Error(body.error||("Upload failed ("+x.status+")")))};
      x.onerror=function(){reject(new Error("Network error"))};x.send(fd);
    });
  }
  function run(items){
    if(!items.length)return;var failed=0;
    items.reduce(function(p,item){
      return p.then(function(){
        var r=row(item.rel);
        if(item.file.size>max){r.s.textContent="Too large (limit "+fmt(max)+")";r.s.className="bad";r.p.remove();failed++;return}
        r.s.textContent="Uploading";
        return send(item,r).then(function(body){r.p.value=1;r.s.textContent=body.version?"Saved as v"+body.version:"Saved";r.s.className="good"},function(err){r.s.textContent=err.message;r.s.className="bad";failed++});
      });
    },Promise.resolve()).then(function(){
      if(!failed){setTimeout(function(){location.reload()},500);return}
      var b=document.createElement("button");b.type="button";b.className="btn sm";b.textContent="Refresh list";b.onclick=function(){location.reload()};
      var li=document.createElement("li");li.append(b);list.append(li);
    });
  }
}
})();`;
