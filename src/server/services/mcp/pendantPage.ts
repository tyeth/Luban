export function pendantPage(token: string): string {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>USB joystick — Luban</title><style>
body{font:17px system-ui;max-width:850px;margin:32px auto;padding:0 20px;background:#151b24;color:#eaf2ff}
button,input,select{font:inherit;padding:8px;margin:5px}input[type=number]{width:100px}
button{cursor:pointer}pre{white-space:pre-wrap;background:#222e3e;padding:16px}#stop{background:#ba2637;color:white}
</style><h1>USB joystick</h1><p>Connect the Feather's <b>USB data</b> port. This page must remain open while jogging.</p>
<select id="port" aria-label="USB data port"></select><button id="connect">Connect</button>
<p>Review the permitted envelope in <b>machine millimetres</b> (maximum span 100 mm per axis). Defaults allow 5 mm either side of the current position, within machine travel.</p>
<form id="envelope"><div id="bounds"></div><label><input id="clear" type="checkbox" required>I am supervising, the toolhead is off, and the entire envelope clears the fitted tool and obstacles.</label>
<p>Button on joystick: switch twist between feed and Z; feed resets to 60 mm/min. Hold Feather <b>D1</b> to jog. Feather <b>D2</b> stops and disarms.</p>
<button>Arm reviewed envelope (10 minutes)</button></form><button id="stop">Stop / disarm</button><pre id="status">Connecting to Luban…</pre>
<script>
const token=${JSON.stringify(token)},status=document.getElementById('status');
async function post(action,body={}){const r=await fetch('/pendant/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Pendant-Token':token},body:JSON.stringify(body)});const p=await r.json();if(!r.ok)throw Error(p.error);return p;}
for(const a of ['x','y','z']){const row=document.createElement('div');row.textContent=a.toUpperCase()+' min / max ';for(const end of ['Min','Max']){const e=document.createElement('input');e.type='number';e.step='0.001';e.required=true;e.id=a+end;e.setAttribute('aria-label',a.toUpperCase()+' '+end);row.appendChild(e);}document.getElementById('bounds').appendChild(row);}
async function refresh(initial=false){try{const r=await fetch('/pendant/status');if(!r.ok)throw Error('Pendant status unavailable');const s=await r.json();status.textContent=JSON.stringify(s,null,2);if(initial){for(const p of s.ports){const e=document.createElement('option');e.value=p.path;e.textContent=p.path+' '+(p.serialNumber||'');document.getElementById('port').appendChild(e);}if(s.defaultBounds)for(const [k,v]of Object.entries(s.defaultBounds))document.getElementById(k).value=v;}if(s.armed)await post('keepalive');}catch(e){status.textContent=e.message;}}
document.getElementById('connect').onclick=async()=>{try{await post('connect',{path:document.getElementById('port').value});await refresh();}catch(e){status.textContent=e.message;}};
document.getElementById('envelope').onsubmit=async(e)=>{e.preventDefault();const bounds={};for(const a of ['x','y','z'])for(const end of ['Min','Max'])bounds[a+end]=Number(document.getElementById(a+end).value);try{await post('arm',{bounds,clearanceConfirmed:document.getElementById('clear').checked});await refresh();}catch(err){status.textContent=err.message;}};
document.getElementById('stop').onclick=()=>post('disarm').then(()=>refresh()).catch(e=>{status.textContent=e.message;});
document.addEventListener('visibilitychange',()=>{if(document.hidden)post('disarm').catch(()=>{});});
refresh(true);setInterval(()=>refresh(),500);
</script></html>`;
}
