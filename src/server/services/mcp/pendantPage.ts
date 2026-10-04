export function pendantPage(token: string): string {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>USB joystick — Luban</title><style>
body{font:17px system-ui;max-width:850px;margin:32px auto;padding:0 20px;background:#151b24;color:#eaf2ff}
button,input,select{font:inherit;padding:8px;margin:5px}input[type=number]{width:110px}
button{cursor:pointer}pre{white-space:pre-wrap;background:#222e3e;padding:16px}#stop{background:#ba2637;color:white}
#action{color:#ffcf70;white-space:pre-wrap;border-left:4px solid #ffcf70;padding:12px;background:#302a1b}#action:empty{display:none}#exclusions{white-space:pre-wrap}#state{font-size:1.3em;font-weight:bold}
</style><h1>USB joystick</h1><p>Connect the Feather's <b>USB data</b> port. Keep this page visible while jogging.</p>
<select id="port" aria-label="USB data port"></select><button id="connect">Connect / reconnect</button>
<p id="state" role="status">Connecting to Luban…</p>
<p>Review the permitted envelope in <b>machine millimetres</b>. X/Y start at ±5 mm around the current position. Z defaults to 280–329 mm. Machine fill adds 1 mm at each end of the known X/Y travel.</p>
<form id="envelope"><fieldset id="review"><legend>Review jog bounds</legend><div id="bounds"></div>
<button type="button" id="fill-x">Fill machine X (±1 mm)</button><button type="button" id="fill-y">Fill machine Y (±1 mm)</button><button type="button" id="fill-xy">Fill both X/Y (±1 mm)</button>
<p id="effective">Known travel unavailable.</p>
<p>Jogging is restricted to the requested bounds within known travel. The obstacle regions below remain excluded below their required machine Z. Every jog segment is checked; approval does not permit entering an excluded region.</p><p id="exclusions">Loading obstacle exclusions…</p>
<label><input id="clear" type="checkbox" required>I am supervising, the toolhead is off, I have reviewed the bounds and obstacle exclusions, and the remaining space clears the fitted tool and any unlisted obstacles.</label>
<p>Joystick button: switch twist between feed and Z. Twist adjusts feed while connected, even disarmed; a new arm resets it to 60 mm/min. Hold Feather <b>D1</b> to jog. Feather <b>D2</b> stops and disarms.</p>
<button>Arm reviewed envelope (10 minutes)</button></fieldset></form><p id="action" role="alert" aria-live="assertive" tabindex="-1"></p><button id="stop">Stop / disarm</button>
<p>Stop prevents further jog segments; an accepted segment of at most 0.5 mm may finish. DRO and raw joystick diagnostics continue while disarmed.</p>
<details><summary>USB and machine diagnostics</summary><pre id="status"></pre></details>
<script>
const token=${JSON.stringify(token)},status=document.getElementById('status');
const action=document.getElementById('action'),state=document.getElementById('state');
let travel=null,lastServerError=null;
function feedback(message,reveal=false){action.textContent=message;if(reveal){action.focus({preventScroll:true});action.scrollIntoView({block:'nearest'});}}
async function post(action,body={}){const r=await fetch('/pendant/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Pendant-Token':token},body:JSON.stringify(body)});const p=await r.json();if(!r.ok)throw Error(p.error);return p;}
function requested(){const b={};for(const a of ['x','y','z'])for(const end of ['Min','Max'])b[a+end]=Number(document.getElementById(a+end).value);return b;}
function preview(){const b=requested();document.getElementById('effective').textContent=travel?'Usable machine bounds: '+['x','y','z'].map(a=>a.toUpperCase()+' '+Math.max(b[a+'Min'],travel[a+'Min']).toFixed(3)+' to '+Math.min(b[a+'Max'],travel[a+'Max']).toFixed(3)+' mm').join('; '):'Known travel unavailable. Arming is blocked.';for(const id of ['fill-x','fill-y','fill-xy'])document.getElementById(id).disabled=!travel;}
for(const a of ['x','y','z']){const row=document.createElement('div');row.textContent=a.toUpperCase()+' min / max ';for(const end of ['Min','Max']){const e=document.createElement('input');e.type='number';e.step='any';e.required=true;e.id=a+end;e.setAttribute('aria-label',a.toUpperCase()+' '+end);e.oninput=()=>{document.getElementById('clear').checked=false;preview();};row.appendChild(e);}document.getElementById('bounds').appendChild(row);}
function fill(axes){if(!travel)return;for(const a of axes){document.getElementById(a+'Min').value=travel[a+'Min']-1;document.getElementById(a+'Max').value=travel[a+'Max']+1;}document.getElementById('clear').checked=false;preview();}
document.getElementById('fill-x').onclick=()=>fill(['x']);document.getElementById('fill-y').onclick=()=>fill(['y']);document.getElementById('fill-xy').onclick=()=>fill(['x','y']);
function renderExclusions(boxes){document.getElementById('exclusions').textContent=boxes.length?'Obstacle exclusions (machine mm, including 5 mm XY margin):\\n'+boxes.map(b=>b.name+': X '+b.machine.x0+' to '+b.machine.x1+', Y '+b.machine.y0+' to '+b.machine.y1+'; '+(b.requiredZ===null?'all Z excluded until tool clearance is known':'requires Z ≥ '+b.requiredZ.toFixed(3))).join('\\n'):'No stored obstacle exclusions.';}
async function refresh(initial=false){try{const r=await fetch('/pendant/status');if(!r.ok)throw Error('Pendant status unavailable');const s=await r.json();status.textContent=JSON.stringify(s,null,2);if(s.error&&s.error!==lastServerError)feedback(s.error,true);lastServerError=s.error;document.getElementById('review').disabled=s.armed;state.textContent=s.armed?(s.neutral?'ARMED — hold D1 to jog':'ARMED — centre axes and release D1'):'DISARMED'+(s.busy?' — last accepted segment settling':'');if(s.error)state.textContent+=': '+s.error;travel=s.travelBounds;renderExclusions(s.obstacleExclusions||[]);if(initial){for(const p of s.ports){const e=document.createElement('option');e.value=p.path;e.textContent=p.path+' '+(p.serialNumber||'');document.getElementById('port').appendChild(e);}if(s.defaultBounds)for(const [k,v]of Object.entries(s.defaultBounds))document.getElementById(k).value=Number(v.toFixed(3));}preview();if(s.armed&&!document.hidden)await post('keepalive');}catch(e){state.textContent='Status unavailable — '+e.message;}}
document.getElementById('connect').onclick=async()=>{try{await post('connect',{path:document.getElementById('port').value});feedback('USB connected. Centre axes, review bounds, then Arm.');await refresh();}catch(e){feedback(e.message,true);}};
document.getElementById('envelope').addEventListener('invalid',()=>{feedback('Enter all six bounds and tick the clearance confirmation before arming.',true);},true);
document.getElementById('envelope').onsubmit=async(e)=>{e.preventDefault();try{await post('arm',{bounds:requested(),clearanceConfirmed:document.getElementById('clear').checked});feedback('Arm accepted. Centre all axes and release D1 before jogging.');await refresh();}catch(err){await refresh();feedback(err.message,true);}};
document.getElementById('stop').onclick=async()=>{try{await post('disarm');await refresh();feedback('Stop accepted. Disarmed; live DRO and joystick diagnostics continue.',true);}catch(e){feedback('Stop request failed: '+e.message,true);}};
document.addEventListener('visibilitychange',()=>{if(document.hidden)post('disarm').catch(e=>{feedback('Disarm request failed: '+e.message,true);});});
refresh(true);setInterval(()=>refresh(),500);
</script></html>`;
}
