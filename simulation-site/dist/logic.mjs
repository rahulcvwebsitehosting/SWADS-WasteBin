export const NETS = [
 ['battery','18650 → TP4056 B+ / B−','Battery terminals only; do not bridge B− to OUT−.'],
 ['load','TP4056 OUT+ → switch → boost IN+','OUT− → boost IN−. Load off during charging.'],
 ['supply','Boost 5 V → ESP32 VIN / sensor VCC','Common load-side ground; never boosted 5 V to 3V3.'],
 ['ground','Common ground → ESP32 / sensor / alerts','Use protected OUT− as load-side reference.'],
 ['trigger','ESP32 GPIO5 → HC-SR04 TRIG','Digital trigger pulse.'],
 ['echo','HC-SR04 ECHO → divider → GPIO18','20 kΩ top; 20 kΩ + 20 kΩ bottom to ground.'],
 ['led','GPIO2 → 330 Ω → LED anode','LED cathode → common ground.'],
 ['buzzer','GPIO4 → active buzzer SIG','Buzzer VCC per delivered module; GND common.']
];
export function createState(){return {time:0,fill:35,height:50,power:true,wifi:true,calibrated:true,fault:false,contact:true,nets:Object.fromEntries(NETS.map(([id])=>[id,true])),critical:false,up:0,down:0,pending:[],lost:0,events:[],last:null,valid:false,reason:'Monitoring. Next sample at 5 seconds.'};}
export function powered(s){return s.power&&['battery','load','supply','ground'].every(n=>s.nets[n]);}
export function log(s,text){s.events.unshift({time:s.time,text});s.events.length=Math.min(s.events.length,100);}
export function distance(s){return s.height*(1-s.fill/100);}
export function sample(s){s.time+=5;
 if(!powered(s)){s.up=s.down=0;s.valid=false;s.reason='Device off: power switch or power connection is open.';return;}
 if(s.wifi&&s.pending.length){log(s,`SIM cloud: ${s.pending.length} offline events synchronized; current state published first.`);s.pending=[];}
 if(!s.calibrated){s.up=s.down=0;s.valid=false;s.reason='Awaiting registered calibration. Local alert evaluation is paused.';return;}
 const d=distance(s);
 if(s.fault||!s.nets.trigger||!s.nets.echo||d<2||d>400){s.up=s.down=0;s.valid=false;s.reason=d<2?'Sensor blind zone: distance below 2 cm. Last alert state is retained.':'No valid sensor window. Last alert state is retained.';log(s,'SENSOR_INVALID · confirmation counters cleared');return;}
 s.valid=true;s.last=s.fill;
 if(!s.critical){s.down=0;s.up=s.fill>=80?s.up+1:0;if(s.up>=3)transition(s,true);}
 else{s.up=0;s.down=s.fill<=20?s.down+1:0;if(s.down>=3)transition(s,false);}
 s.reason=s.critical?(s.down?`Empty confirmation ${s.down}/3. Alert retained until confirmed.`:'Critical fill confirmed. LED on; buzzer pulses 400 ms on / 1600 ms off.'):(s.up?`High fill confirmation ${s.up}/3. Waiting for three consecutive windows.`:'Monitoring. Fill is below the alert threshold.');
 if(!s.wifi)s.reason+=' Wi-Fi offline; local sensing continues.';
}
function transition(s,critical){s.critical=critical;s.up=s.down=0;const type=critical?'ALERT_80':'RESET';log(s,`${type} · ${s.fill}% · local state ${critical?'CRITICAL':'NORMAL'}`);
 if(s.wifi){log(s,`SIM Firebase: ${type} and current device state uploaded.`);if(critical)log(s,s.contact?'SIM collection request queued to verified contact. Delivery / acceptance not proven.':'SIM dispatch blocked: no verified collection contact.');}
 else{if(s.pending.length===12){s.pending.shift();s.lost++;log(s,'Offline history overflow: oldest event dropped.');}s.pending.push({type,time:s.time});log(s,`${type} queued offline (${s.pending.length}/12).`);}
}
export function issues(s){const out=[];for(const [id,name] of NETS)if(!s.nets[id])out.push(`Open: ${name}`);if(!s.power)out.push('Load switch off');if(!s.calibrated)out.push('Calibration missing');if(s.fault)out.push('Sensor timeout injected');if(distance(s)<2)out.push('Waste is inside the sensor’s 2 cm blind zone');return out;}
export function selfTests(){let s;const results=[];const test=(name,fn)=>{try{fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});}};const check=(v)=>{if(!v)throw Error('Unexpected state');};const ticks=(n)=>{for(let i=0;i<n;i++)sample(s);};
 test('Three ≥80% windows trigger',()=>{s=createState();s.fill=80;ticks(2);check(!s.critical&&s.up===2);ticks(1);check(s.critical);});
 test('Mid-level retains critical state',()=>{s.fill=50;ticks(3);check(s.critical);});
 test('Three ≤20% windows reset',()=>{s.fill=20;ticks(2);check(s.critical);ticks(1);check(!s.critical);});
 test('Transient high fill clears counter',()=>{s=createState();s.fill=85;ticks(2);s.fill=79;ticks(1);check(s.up===0&&!s.critical);});
 test('Offline local alert + reconnect',()=>{s=createState();s.wifi=false;s.fill=85;ticks(3);check(s.critical&&s.pending.length===1);s.wifi=true;ticks(1);check(s.pending.length===0);});
 test('Invalid echo retains state',()=>{s=createState();s.fill=85;ticks(3);s.fault=true;s.fill=10;ticks(3);check(s.critical&&!s.valid);});
 test('Missing calibration inhibits alert',()=>{s=createState();s.calibrated=false;s.fill=90;ticks(4);check(!s.critical);});
 test('Power open inhibits sensing',()=>{s=createState();s.nets.load=false;s.fill=90;ticks(4);check(!s.critical&&!s.valid);});
 test('Sensor open clears confirmation',()=>{s=createState();s.fill=85;ticks(2);s.nets.echo=false;ticks(1);check(s.up===0&&!s.valid);});
 test('Blind zone never reports a valid full reading',()=>{s=createState();s.fill=100;ticks(3);check(!s.valid&&!s.critical);});
 test('Offline queue bounded at 12',()=>{s=createState();s.wifi=false;for(let i=0;i<14;i++){s.fill=i%2?10:85;ticks(3);}check(s.pending.length===12&&s.lost===2);});
 test('No verified contact blocks modeled request',()=>{s=createState();s.contact=false;s.fill=85;ticks(3);check(s.events.some(e=>e.text.includes('dispatch blocked')));});return results;}
