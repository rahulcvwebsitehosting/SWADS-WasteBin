import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Scene,parts} from './dist/scene.mjs';
const noop=()=>{};
const ctx=new Proxy({measureText:t=>({width:t.length*6}),createRadialGradient:()=>({addColorStop:noop})},{get:(t,k)=>t[k]||noop,set:()=>true});
for(const view of ['product','exploded','circuit'])for(const cut of [false,true])for(const fill of [0,.35,.85,1])test(`${view} cut=${cut} fill=${fill}: finite geometry across orbit`,()=>{
 const b=Object.assign(Object.create(Scene.prototype),{ctx,w:1000,h:700,yaw:0,pitch:.3,zoom:1,view,cut,wires:true,selected:null,fill,led:true,power:true,nets:{}});b.draw();assert.ok(b.faces.length>0);
 for(const f of b.faces){assert.ok(f.points.length>=3);for(const p of f.points)assert.ok(p.every(Number.isFinite));}
 for(const yaw of [-Math.PI,-1.5,0,1.5,Math.PI])for(const pitch of [-.3,.3,1.25]){b.yaw=yaw;b.pitch=pitch;for(const f of b.faces)for(const p of f.points){const q=b.project(p);assert.ok([q.x,q.y,q.z,q.scale].every(Number.isFinite));}}
 const ids=b.faces.map(f=>f.id);if(view==='product'&&!cut){assert.ok(!ids.includes('esp'));assert.ok(!ids.includes('sim'));}else for(const p of parts)assert.ok(ids.includes(p.id),p.id+' missing');
});
