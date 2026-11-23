import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mt5Snapshot } from "../mt5-bridge.js";

const folder=await mkdtemp(path.join(tmpdir(),"signalstart-benchmark-"));
const helper=fileURLToPath(new URL("../mt5/SignalStartNativeHost.exe",import.meta.url));
const child=spawn(helper,[`--data-dir=${folder}`],{windowsHide:true});
let buffer=Buffer.alloc(0), pending=null;
const closed=new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(`Helper exit ${code}`)));});
child.stderr.on("data",chunk=>process.stderr.write(chunk));
child.stdout.on("data",chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4){
    const length=buffer.readUInt32LE(0),reply=JSON.parse(buffer.subarray(4,4+length).toString("utf8"));
    buffer=buffer.subarray(4+length);
    if(reply.error) pending?.reject(new Error(reply.error));else pending?.resolve();
    pending=null;
  }
});
function send(message){return new Promise((resolve,reject)=>{
  pending={resolve,reject};const body=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header,body]));
});}
try {
  const times=[];
  for(let i=0;i<320;i++){
    const now=Date.now();
    const message={...mt5Snapshot({settings:{mt5SignalId:"123",mt5CheckSeconds:5},signals:{"123":{
      id:"123",name:"Benchmark",floatingValue:i/10,floatingDisplay:`$${i/10}`,openTrades:1,
      sampleAt:now,lastSource:"live",tradeDetails:{status:"ready",symbol:"US30",lots:.1,sl:0,tp:0,side:1,identity:"one"}
    }}}),requestId:String(i)};
    const start=performance.now();await send(message);if(i>=20)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);
  const report={scope:"Warm persistent native helper: framed request to acknowledged atomic file write. Does not measure Chrome DOM, MT5 timer, broker or phone delivery.",samples:times.length,
    medianMs:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1),
    configuredReceiverSeconds:5,configuredBrowserSeconds:5};
  await writeFile(new URL("mt5-performance.json",import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  child.stdin.end();await closed;
  const resolved=path.resolve(folder),root=path.resolve(tmpdir())+path.sep+"signalstart-benchmark-";
  if(!resolved.startsWith(root))throw new Error("Unexpected benchmark directory");
  await rm(resolved,{recursive:true,force:true});
}
