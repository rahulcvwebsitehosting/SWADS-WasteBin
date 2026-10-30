// Dependency-free perspective 3D renderer. Real 3D vertices, orbit camera,
// depth-sorted shaded faces, projected labels and mesh picking; no remote CDN.
const palette={bin:'#50786b',mint:'#bcf394',pcb:'#255f52',blue:'#326a91',black:'#20272b',silver:'#afc1c6',wire:'#81baf0'};
const parts=[
 {id:'sensor',name:'HC-SR04 ultrasonic sensor',color:'#36749c',description:'Mounted under the lid, facing the waste. Five distance readings form one median-filtered window. Keep the sound path clear.',pins:['VCC → regulated 5 V','GND → protected load-side ground','TRIG → GPIO5','ECHO → 20 kΩ → GPIO18; 40 kΩ below junction'],p:[0,5.25,0],size:[1.4,.18,.65]},
 {id:'esp',name:'SmartElex ESP32-WROOM-32E',color:'#327462',description:'Wi-Fi controller running the sensing and alert state machine. Robu reference R150542 confirms the PCB antenna and two supplied male headers. Delivered pin count, dimensions and board revision still need unpacked verification.',pins:['VIN → verified regulated 5 V','GND → common load ground','GPIO5 / 18 → TRIG / divided ECHO','GPIO2 / 4 → LED / buzzer'],p:[2.65,3.6,0],size:[.95,.16,1.65]},
 {id:'battery',name:'18650 cell + holder',color:'#d292b4',description:'One rechargeable cell supplies the protected charger. Holder is modeled with the cell; capacity and runtime are not estimated.',pins:['Cell + → TP4056 B+','Cell − → TP4056 B−','Keep exposed cell contacts insulated'],p:[2.65,1.4,.1],size:[.72,.65,1.7]},
 {id:'charger',name:'Protected TP4056 · SKU 53264',color:'#3674aa',description:'Robu SKU 53264 has a Mini-USB socket, TP4056 / DW01 protection and separate B / OUT pads. Robu notes that layouts may vary. A basic TP4056 has no load-sharing power path; turn off the load while charging.',pins:['B+ / B− → battery only','OUT+ → switch → boost IN+','OUT− → boost IN− / load ground','USB input → charger only'],p:[2.65,2.4,-.7],size:[.7,.12,.8]},
 {id:'boost',name:'Regulated 5 V boost · R261487',color:'#487e87',description:'Raises the battery supply to regulated 5 V. Set and measure 5.0 V before connecting the ESP32. Current capacity and heat need physical testing.',pins:['IN+ → switch from protected OUT+','IN− → protected OUT−','OUT+ → ESP32 VIN / HC-SR04 VCC','OUT− → common load ground'],p:[2.65,2.5,.75],size:[.7,.17,.85]},
 {id:'switch',name:'Load power switch',color:'#a3b6af',description:'Disconnects the load from the protected battery output. Operate this switch from Live controls.',pins:['Protected OUT+ → switch → boost IN+','Switch load OFF during charging'],p:[2.7,1.9,1],size:[.4,.35,.35]},
 {id:'divider',name:'Echo divider · 3 × 20 kΩ',color:'#c8b191',description:'The three purchased resistors form 20 kΩ above the GPIO junction and 40 kΩ below it. Nominal output is 5 × 40 / 60 = 3.33 V. This is a nominal calculation only.',pins:['HC-SR04 ECHO → 20 kΩ → GPIO18 junction','Junction → 20 kΩ → 20 kΩ → GND'],p:[2.65,4.5,.8],size:[.7,.12,.75]},
 {id:'led',name:'Red LED + 330 Ω resistor',color:'#eb806e',description:'External visible alert. On after a confirmed critical event, off after a confirmed empty event. A disconnected LED does not stop the controller.',pins:['GPIO2 → 330 Ω → LED anode (+)','LED cathode (−) → common ground'],p:[1.6,4.2,1.45],size:[.3,.3,.3]},
 {id:'buzzer',name:'Active buzzer module',color:'#9baeb4',description:'Three-pin logic-input module. Critical state pulses for 400 ms, then stays silent for 1600 ms. Confirm required VCC and active-high/low polarity on the delivered module.',pins:['SIG / IN → GPIO4','VCC → voltage specified on module','GND → common load ground'],p:[1.6,3.55,1.45],size:[.55,.35,.55]},
 {id:'capacitor',name:'1000 µF bulk capacitors',color:'#7e9baa',description:'Bulk decoupling on the appropriate supply rails. Observe polarity and rated voltage. Not a substitute for a suitable regulator or battery protection.',pins:['+ → applicable positive supply rail','− → corresponding ground','Exact placement / count must follow physical circuit'],p:[2.65,2.2,0],size:[.5,.7,.4]},
 {id:'pcb',name:'Perfboard / prototype circuit board',color:'#b09967',description:'Mounts the final electronics inside the enclosure. Breadboard and jumper wires are for bench testing before soldered assembly.',pins:['Route signal and power nets as listed','Keep battery and power connections insulated'],p:[2.65,3,0],size:[1.35,.12,3.5]},
 {id:'enclosure',name:'Electronics enclosure',color:'#637e82',description:'Concept side enclosure protecting the electronics from waste. Delivered box dimensions and mounting holes have not been measured; this is not a manufacturing drawing.',pins:['Sensor below lid; electronics outside waste volume','Seal modified holes and cable entries','Keep the ESP32 antenna clear'],p:[2.65,3,-.1],size:[1.7,.8,4.1]},
 {id:'sim',name:'SIM800L · optional, disconnected',color:'#a16a64',description:'Shown on the spare-parts bench, not connected. The existing Wi-Fi/Firebase firmware has no cellular support. Requires a separate high-current power design.',pins:['NO CONNECTION in current firmware'],p:[-3.5,.6,.3],size:[.8,.12,1]},
 {id:'spare',name:'Unprotected Type-C TP4056 · spare',color:'#507cad',description:'Shown as a spare only. Do not attach two chargers to the same cell. Use the protected TP4056 in the active circuit.',pins:['NO CONNECTION in active battery chain'],p:[-3.5,.6,1.6],size:[.65,.12,.8]}
];
export {parts};
export class Scene{
 constructor(canvas,onPick){this.canvas=canvas;this.ctx=canvas.getContext('2d');this.yaw=-.56;this.pitch=.27;this.zoom=1;this.view='product';this.cut=false;this.wires=false;this.selected='sensor';this.fill=.35;this.led=false;this.power=true;this.nets={};this.hits=[];this.onPick=onPick;this.drag=null;
 canvas.addEventListener('pointerdown',e=>{this.drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY};canvas.setPointerCapture(e.pointerId);});
 canvas.addEventListener('pointermove',e=>{if(!this.drag)return;this.yaw+=(e.clientX-this.drag.x)*.008;this.pitch=Math.max(-.18,Math.min(1.05,this.pitch+(e.clientY-this.drag.y)*.006));this.drag.x=e.clientX;this.drag.y=e.clientY;});
 canvas.addEventListener('pointerup',e=>{if(this.drag&&Math.hypot(e.clientX-this.drag.startX,e.clientY-this.drag.startY)<5){const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;const hit=this.hits.filter(h=>Math.hypot(x-h.x,y-h.y)<h.r).sort((a,b)=>b.z-a.z)[0];if(hit)this.onPick(hit.id);}this.drag=null;});
 canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom=Math.max(.6,Math.min(1.9,this.zoom-e.deltaY*.001));},{passive:false});
 canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft')this.yaw-=.1;if(e.key==='ArrowRight')this.yaw+=.1;if(e.key==='ArrowUp')this.pitch=Math.min(1,this.pitch+.1);if(e.key==='ArrowDown')this.pitch=Math.max(-.18,this.pitch-.1);if(e.key==='+')this.zoom=Math.min(1.9,this.zoom+.1);if(e.key==='-')this.zoom=Math.max(.6,this.zoom-.1);}});
 new ResizeObserver(()=>this.resize()).observe(canvas);this.resize();this.render=()=>{this.draw();requestAnimationFrame(this.render);};requestAnimationFrame(this.render);
 }
 resize(){const r=this.canvas.getBoundingClientRect();this.w=r.width;this.h=r.height;const d=Math.min(devicePixelRatio||1,2);this.canvas.width=r.width*d;this.canvas.height=r.height*d;this.ctx.setTransform(d,0,0,d,0,0);}
 project(p){let [x,y,z]=p;y-=2.6;let a=x*Math.cos(this.yaw)+z*Math.sin(this.yaw),b=-x*Math.sin(this.yaw)+z*Math.cos(this.yaw);let c=y*Math.cos(this.pitch)-b*Math.sin(this.pitch),d=y*Math.sin(this.pitch)+b*Math.cos(this.pitch);const perspective=15/(15-d),scale=Math.min(this.w/10.8,this.h/8.8)*this.zoom*perspective;return {x:this.w*.51+a*scale,y:this.h*.57-c*scale,z:d,scale};}
 face(points,color,alpha=1,id){this.faces.push({points,color,alpha,id,z:points.reduce((sum,p)=>sum+this.project(p).z,0)/points.length});}
 box(p,s,color,id,alpha=1){const [x,y,z]=p,[a,b,c]=s.map(v=>v/2),v=[[-a,-b,-c],[a,-b,-c],[a,b,-c],[-a,b,-c],[-a,-b,c],[a,-b,c],[a,b,c],[-a,b,c]].map(q=>[q[0]+x,q[1]+y,q[2]+z]);[[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[1,5,6,2],[0,3,7,4]].forEach((f,i)=>this.face(f.map(n=>v[n]),shade(color,[.72,.9,.6,1.17,.84,.7][i]),alpha,id));}
 cylinder(p,r,h,color,id,axis='y',n=16){const t=q=>axis==='y'?[q[0]+p[0],q[1]+p[1],q[2]+p[2]]:[q[0]+p[0],q[2]+p[1],q[1]+p[2]];const top=[],bot=[];for(let i=0;i<n;i++){let a=i/n*Math.PI*2;top.push(t([r*Math.cos(a),h/2,r*Math.sin(a)]));bot.push(t([r*Math.cos(a),-h/2,r*Math.sin(a)]));}for(let i=0;i<n;i++){let j=(i+1)%n;this.face([bot[i],top[i],top[j],bot[j]],shade(color,.7+.3*Math.cos(i/n*Math.PI*2)),1,id);}this.face(top,shade(color,1.15),1,id);this.face(bot,color,1,id);}
 line(points,color,width=1,dash=[]){this.lines.push({points,color,width,dash});}
 pos(part,index){if(this.view==='circuit'){const col=index%4,row=Math.floor(index/4);return [(col-1.5)*2.2,4.8-row*1.8,0];}const p=[...part.p];if(this.view==='exploded'){if(part.id==='sensor')p[1]+=1.1;else if(['sim','spare'].includes(part.id))p[0]-=.5;else{p[0]+=1.2;p[1]+=(index%3-1)*.75;p[2]+=(index%2?1:-1)*.7;}}return p;}
 part(part,p){const {id,size:s,color}=part,[x,y,z]=p;
 if(id==='enclosure'){if(this.view==='circuit')this.box(p,[1.4,.14,1],color,id);else{this.box([x,y-.2,z-.95],[1.65,3.8,.1],color,id);if(!this.cut){this.box([x+.78,y-.2,z],[.1,3.8,2],color,id);this.box([x,y-.2,z+1],[1.6,3.8,.1],color,id,.35);}}return;}
 if(id==='pcb'){this.box(p,s,color,id);for(let i=0;i<6;i++)for(let j=0;j<12;j++)this.box([x-.5+i*.2,y+.08,z-1.5+j*.27],[.045,.018,.045],'#cdbb8a',id);return;}
 if(id==='battery'){this.box([x,y-.1,z],[.85,.2,1.95],'#1b2429',id);this.cylinder([x,y+.2,z],.29,1.65,color,id,'z');this.cylinder([x,y+.2,z+.85],.16,.035,palette.silver,id,'z');return;}
 if(id==='capacitor'){for(const dx of [-.16,.16]){this.cylinder([x+dx,y+.15,z],.13,.55,color,id);this.box([x+dx,y+.44,z],[.17,.015,.04],palette.silver,id);}return;}
 if(id==='sensor'){this.box(p,s,color,id);for(const dx of [-.39,.39]){this.cylinder([x+dx,y-.2,z],.235,.28,'#b9c9ca',id);this.cylinder([x+dx,y-.35,z],.18,.025,'#34494f',id);for(let a=-2;a<=2;a++)for(let b=-2;b<=2;b++)if(a*a+b*b<7)this.cylinder([x+dx+a*.057,y-.367,z+b*.057],.012,.008,'#b8c5c8',id,'y',6);}for(let i=0;i<4;i++)this.box([x-.24+i*.16,y+.12,z+.31],[.035,.18,.035],'#d4b770',id);return;}
 if(id==='led'){this.cylinder(p,.15,.22,this.led?'#ff5b42':'#8d3933',id);this.box([x,y-.2,z],[.35,.08,.4],'#4a6551',id);return;}
 if(id==='buzzer'){this.box([x,y-.12,z],[.7,.1,.7],palette.pcb,id);this.cylinder(p,.24,.32,'#222b30',id);this.cylinder([x,y+.17,z],.08,.02,'#0c1517',id);return;}
 if(id==='divider'){this.box(p,[.8,.06,.9],palette.pcb,id);for(let i=0;i<3;i++){const a=x+(i-1)*.23;this.box([a,y+.1,z],[.14,.12,.53],color,id);this.box([a,y+.17,z],[.15,.01,.055],'#b5714a',id);}return;}
 if(id==='switch'){this.box(p,s,'#262e31',id);this.box([x,y+.22,z],[.23,.13,.25],this.power?'#a3cb89':'#ca7560',id);return;}
 this.box(p,s,color,id);
 if(id==='esp'){this.box([x,y+.14,z-.2],[.67,.15,.67],'#aebdbb',id);this.box([x,y+.1,z+.65],[.6,.08,.36],'#191f24',id);for(let i=0;i<5;i++){this.box([x-.23+i*.11,y+.145,z+.65],[.025,.008,.25],'#c8ae63',id);this.box([x-.18+i*.11,y+.145,z+(i%2?.53:.77)],[.11,.008,.025],'#c8ae63',id);}for(const dx of [-.43,.43])for(let i=0;i<19;i++)this.box([x+dx,y+.11,z-.76+i*.084],[.09,.08,.04],'#c7b371',id);this.box([x,y+.1,z-.85],[.36,.13,.19],'#a4b8bf',id);}
 else{this.box([x,y+.11,z],[.28,.12,.28],'#222c31',id);this.box([x,y+.12,z+.29],id==='charger'?[.36,.22,.29]:[.28,.15,.15],'#afc4c5',id);if(id==='charger'){this.box([x,y+.12,z+.445],[.26,.12,.012],'#20252b',id);this.box([x+.17,y+.13,z-.25],[.16,.08,.2],'#171c22',id);for(const dx of [-.22,.22])for(const dz of [-.32,-.18])this.cylinder([x+dx,y+.075,z+dz],.045,.018,'#d3b86e',id);}if(id==='boost')this.cylinder([x+.17,y+.18,z-.13],.17,.12,'#9d987c',id);}
 }
 draw(){const ctx=this.ctx;if(!this.w||!this.h)return;ctx.clearRect(0,0,this.w,this.h);this.faces=[];this.lines=[];this.hits=[];
 this.buildHousing();
 const positions={};parts.forEach((part,i)=>{const p=this.pos(part,i);positions[part.id]=p;this.part(part,p);const pr=this.project(p);this.hits.push({...pr,id:part.id,r:Math.max(18,Math.max(...part.size)*pr.scale*.4)});});
 if(this.wires){const routes=[['battery','charger','battery','#ef9467'],['charger','switch','load','#ef9467'],['switch','boost','load','#ef9467'],['boost','esp','supply','#ef9467'],['boost','sensor','supply','#ef9467'],['esp','sensor','trigger','#81baf0'],['sensor','divider','echo','#e9ce85'],['divider','esp','echo','#e9ce85'],['esp','led','led','#d8abf0'],['esp','buzzer','buzzer','#81baf0'],['charger','esp','ground','#82918f']];routes.forEach(([a,b,net,c],i)=>{const p=positions[a],q=positions[b],off=.15+(i%4)*.13;this.line([[p[0],p[1]+.18,p[2]],[p[0]+off,p[1]+.4,p[2]],[q[0]+off,q[1]+.4,q[2]],[q[0],q[1]+.18,q[2]]],this.nets[net]===false?'#de6c6c':c,1.5,this.nets[net]===false?[3,5]:[]);});}
 this.faces.sort((a,b)=>a.z-b.z);for(const f of this.faces){const v=f.points.map(p=>this.project(p));ctx.beginPath();v.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.globalAlpha=f.alpha;ctx.fillStyle=f.color;ctx.fill();ctx.strokeStyle=f.id===this.selected?'#c6f3a577':'#07171833';ctx.lineWidth=f.id===this.selected?1:.5;ctx.stroke();}ctx.globalAlpha=1;
 for(const l of this.lines){ctx.beginPath();l.points.forEach((p,i)=>{let q=this.project(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.strokeStyle=l.color;ctx.lineWidth=l.width;ctx.setLineDash(l.dash);ctx.stroke();}ctx.setLineDash([]);
 // Labels remain screen aligned and are interactive via component centers.
 const labelIds=this.view==='circuit'?parts.map(p=>p.id):this.view==='exploded'?['sensor','esp','battery','charger','boost','sim','spare']:this.cut?['sensor','esp','battery']:[];
 for(const id of labelIds){const part=parts.find(p=>p.id===id),p=this.project(positions[id]);const title={sensor:'HC-SR04',esp:'ESP32',battery:'18650',charger:'Protected TP4056',boost:'5 V boost',divider:'Echo divider',led:'LED + 330 Ω',buzzer:'Buzzer',capacitor:'1000 µF',pcb:'Perfboard',enclosure:'Enclosure',sim:'SIM800L · SPARE',spare:'Type-C charger · SPARE',switch:'Power switch'}[id];ctx.font='9px Segoe UI, Arial';const width=ctx.measureText(title).width+14;const ly=p.y-(this.view==='circuit'?26:22);ctx.fillStyle='#102124ec';ctx.fillRect(p.x-width/2,ly-12,width,18);ctx.fillStyle=id===this.selected?'#bcf394':'#d4e1db';ctx.fillText(title,p.x-width/2+7,ly);}
 if(this.led&&this.view!=='circuit'){const p=this.project(positions.led);const grad=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,24);grad.addColorStop(0,'#ff765b99');grad.addColorStop(1,'#ff765b00');ctx.fillStyle=grad;ctx.fillRect(p.x-24,p.y-24,48,48);}
 }
}
function shade(hex,m){const n=parseInt(hex.slice(1),16);return '#'+[n>>16,(n>>8)&255,n&255].map(c=>Math.min(255,Math.round(c*m)).toString(16).padStart(2,'0')).join('');}


// SWADS FIELD / 01 — original serviceable enclosure concept.
// Form and assembly are design proposals, not measured production CAD.
const designPositions={sensor:[0,5.25,.25],esp:[2.55,4.12,.12],battery:[2.55,1.75,.23],charger:[2.22,2.8,.12],boost:[2.88,2.8,.12],switch:[2.55,1.05,.65],divider:[2.55,3.23,.12],led:[2.25,4.82,.65],buzzer:[2.85,4.72,.43],capacitor:[2.95,2.02,.2],pcb:[2.55,3.3,-.04],enclosure:[2.55,3,-.2],sim:[-3.1,.2,.1],spare:[-3.1,.2,1.4]};
const oldPos=Scene.prototype.pos, oldPart=Scene.prototype.part;
Scene.prototype.pos=function(part,index){
 if(this.view==='circuit')return oldPos.call(this,part,index);
 const p=[...designPositions[part.id]];
 if(this.view==='exploded'){
  if(part.id==='sensor')p[1]+=1.15;
  else if(!['sim','spare'].includes(part.id)){p[0]+=1.05;p[2]+=part.id==='enclosure'?-1.2:part.id==='pcb'?-.5:.9;}
 }
 return p;
};
Scene.prototype.roundRing=function(w,d,r,y,cx=0,cz=0){const ring=[];for(let corner=0;corner<4;corner++){const a=corner*Math.PI/2;const sx=corner===0||corner===3?1:-1,sz=corner<2?1:-1;for(let j=0;j<=5;j++){const angle=a+j*Math.PI/10;ring.push([cx+sx*(w/2-r)+r*Math.cos(angle),y,cz+sz*(d/2-r)+r*Math.sin(angle)]);}}return ring;};
Scene.prototype.shell=function(w,d,h,r,p,color,options={}){
 const bottom=this.roundRing(w*(options.taper||1),d*(options.taper||1),r,p[1]-h/2,p[0],p[2]),top=this.roundRing(w,d,r,p[1]+h/2,p[0],p[2]);
 for(let i=0;i<top.length;i++){const j=(i+1)%top.length;if(options.cut&&top[i][2]>p[2]+.1)continue;const light=.8+.22*Math.cos(i/top.length*Math.PI*2-.7);this.face([bottom[i],bottom[j],top[j],top[i]],shade(color,light),1,options.id);}
 if(!options.open)this.face(top,shade(color,1.1),1,options.id);this.face(bottom,shade(color,.65),1,options.id);
};
Scene.prototype.buildHousing=function(){
 const cut=this.cut||this.view==='exploded';
 // Studio plinth and a quiet ground reference.
 this.shell(8.4,6,.14,.8,[.2,-.18,0],'#213439');
 if(this.view==='circuit')return;
 this.shell(3.85,3.4,.28,.3,[0,.18,0],'#182e30');
 this.shell(4,3.5,4.8,.32,[0,2.7,0],'#41786b',{taper:.86,open:true,cut});
 // Inner liner is inset so the cutaway reads as a double wall.
 this.shell(3.7,3.19,4.65,.27,[0,2.71,0],'#284d46',{taper:.86,open:true,cut});
 for(const y of [.55,4.9])this.shell(y<1?3.58:4.06,y<1?3.12:3.55,.14,.27,[0,y,0],'#254f48',{open:true,cut});
 // Ribbed rear reinforcement and front foot pedal.
 for(const x of [-1.3,-.88,.88,1.3])this.box([x,2.55,-1.72],[.075,3.8,.08],'#336557');
 this.shell(1.18,.55,.13,.1,[0,.24,1.85],'#9aa9a4');
 for(let x=-.46;x<.5;x+=.13)this.box([x,.315,1.86],[.045,.02,.39],'#566c67');
 for(const x of [-1.55,1.55]){this.cylinder([x,.36,-1.42],.37,.28,'#122226',undefined,'z',24);this.cylinder([x,.36,-1.58],.15,.03,'#8c9d98',undefined,'z',20);}
 const ly=this.view==='exploded'?6.65:5.26;
 this.shell(4.27,3.74,.14,.32,[0,ly,0],'#142c2a');
 this.shell(4.3,3.76,.23,.34,[0,ly+.16,0],'#659785');
 this.shell(3.86,3.31,.09,.28,[0,ly+.32,0],'#75a58f');
 this.shell(1.1,.42,.19,.12,[0,ly+.43,.9],'#203f38');
 for(const x of [-1.15,1.15]){this.box([x,ly,-1.87],[.5,.24,.24],'#304d44');this.cylinder([x,ly+.12,-1.87],.08,.35,'#a2b8ad',undefined,'z');}
 if(cut){
 const fh=Math.max(.06,this.fill*4.55);this.shell(3.2,2.75,fh,.2,[0,.38+fh/2,0],'#8b9b7d');
 for(let i=0;i<22;i++){let x=Math.sin(i*7.1)*1.22,z=Math.cos(i*4.3)*1.04,y=.42+fh+(i%3)*.035;if(i%3===0){this.cylinder([x,y,z],.13,.36,'#b7c9b8',undefined,'z',12);this.cylinder([x,y,z+.21],.055,.07,'#527b68',undefined,'z',8);}else this.box([x,y,z],[.24+(i%4)*.08,.08,.27],i%2?'#c3b48f':'#abb7a0');}
 this.line([[0,5.02,.25],[0,.45+fh,.25]],'#c7edaa',1.5,[5,6]);
 }
 // External removable carrier rail and vibration isolators.
 for(const y of [1.1,4.7]){this.box([2.05,y,-.28],[.48,.17,.8],'#233e3d');for(const z of [-.55,.05])this.cylinder([2.15,y+.12,z],.075,.07,'#a5b7af');}
};
Scene.prototype.part=function(part,p){
 const [x,y,z]=p,id=part.id,cut=this.cut||this.view==='exploded'||this.view==='circuit';
 if(!cut&&['sim','spare'].includes(id))return;
 if(id==='enclosure'&&this.view!=='circuit'){
 this.shell(1.65,1.12,4.15,.16,[x,y,z],'#d3d9cc',{id,open:true,cut:true});
 this.box([x,y,z-.5],[1.37,3.9,.06],'#5b6d63',id);
 if(!cut){this.shell(1.71,.16,4.18,.075,[x,y,z+.6],'#e0e5d7',{id});for(let i=0;i<5;i++)this.box([x,y-1.18+i*.13,z+.69],[.85,.045,.02],'#899e90',id);}
 for(const dx of [-.66,.66])for(const dy of [-1.8,1.8]){this.cylinder([x+dx,y+dy,z+.7],.065,.035,'#8b9a92',id,'z',12);this.box([x+dx,y+dy,z+.72],[.07,.015,.008],'#2d4941',id);}
 return;}
 if(!cut&&!['sensor','led','buzzer','switch','sim','spare'].includes(id))return;
 if(id==='pcb'&&this.view!=='circuit'){
 this.box(p,[1.35,3.6,.08],'#287245',id);for(let i=0;i<6;i++)for(let j=0;j<17;j++)this.box([x-.52+i*.21,y-1.6+j*.2,z+.045],[.035,.035,.012],'#d8c998',id);return;}
 const begin=this.faces.length,oldLines=this.lines.length;
 oldPart.call(this,part,[0,0,0]);
 const vertical=this.view!=='circuit'&&!['sensor','led','sim','spare'].includes(id);
 for(const f of this.faces.slice(begin)){f.points=f.points.map(q=>vertical?[q[0]+x,q[2]+y,q[1]+z]:[q[0]+x,q[1]+y,q[2]+z]);f.z=f.points.reduce((sum,q)=>sum+this.project(q).z,0)/f.points.length;}
 // Board mounting hardware, solder pads and copper tracks.
 if(['esp','charger','boost','divider','sensor'].includes(id)){
 const w=part.size[0],d=part.size[2];
 const transform=q=>vertical?[x+q[0],y+q[2],z+q[1]]:[x+q[0],y+q[1],z+q[2]];
 for(const a of [-1,1])for(const b of [-1,1])this.box(transform([a*(w/2-.09),.1,b*(d/2-.08)]),[.06,.06,.06],'#d6c996',id);
 for(let i=0;i<4;i++){const q=transform([-.23+i*.15,.17,0]);this.box(q,vertical?[.07,.14,.035]:[.07,.035,.14],'#b6aa88',id);}
 }
};
const originalDraw=Scene.prototype.draw;
Scene.prototype.draw=function(){originalDraw.call(this);if(this.view==='circuit')return;const ctx=this.ctx;
 const brand=this.project([0,3.55,1.81]);if(!this.cut&&this.view==='product'&&Math.cos(this.yaw)>.3){ctx.save();ctx.translate(brand.x,brand.y);ctx.font='600 '+Math.max(12,brand.scale*.38)+'px Segoe UI';ctx.textAlign='center';ctx.fillStyle='#e0edda';ctx.fillText('SWADS',0,0);ctx.font=Math.max(7,brand.scale*.115)+'px Segoe UI';ctx.fillStyle='#b5d3bc';ctx.fillText('FIELD / 01',0,19);ctx.restore();}
 ctx.fillStyle='#a7b9b4';ctx.font='9px Segoe UI';ctx.fillText('ORIGINAL ENCLOSURE CONCEPT / REV 02',26,this.h-106);
};
