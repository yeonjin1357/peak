// Deployment diagnostic only: no application DB, Orca, credentials, saved profiles,
// proxies, browser fingerprint changes, or TLS-verification overrides.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import https from 'node:https';
import {resolve4,resolve6} from 'node:dns/promises';
const origin='https://fin.land.naver.com';
const endpoint='/front-api/v1/article/legalDivisionArticleList';
const mode=process.argv.find(a=>a.startsWith('--mode='))?.split('=')[1] || 'browser';
if(!['http','browser','connectivity'].includes(mode)) throw Error('Use --mode=http, --mode=browser or --mode=connectivity');
const headed=process.argv.includes('--headed');
const reportPath=process.env.PEAK_PROBE_REPORT || `artifacts/deployment-validation/${process.platform}-${mode}${headed?'-headed':''}.json`;
const report={startedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,mode,headed,networkScope:process.env.GITHUB_ACTIONS==='true'?'GitHub-hosted runner':'local machine network; NOT cloud IP verification',checks:[]};
const payload=(code,cursor)=>({
 filter:{tradeTypes:['B1'],realEstateTypes:['A01','A04','B01'],roomCount:[],bathRoomCount:[],optionTypes:[],oneRoomShapeTypes:[],moveInTypes:[],filtersExclusiveSpace:true,floorTypes:[],directionTypes:[],hasArticlePhoto:false,isAuthorizedByOwner:false,parkingTypes:[],entranceTypes:[],hasArticle:false,legalDivisionNumbers:[code],legalDivisionType:'GUN',space:{min:60},warrantyPrice:{min:0,max:300000000}},
 articlePagingRequest:{size:30,userChannelType:'PC',articleSortType:'RANKING_DESC',lastInfo:cursor?.lastInfo||[],...(cursor?.seed?{seed:cursor.seed}:{})},
});
function errorInfo(e){return {name:e.name,message:String(e.message).split('\n')[0].slice(0,250),code:e.cause?.code||e.code||null};}
function inspectResponse(status,data){
 if(status!==200||data?.isSuccess!==true) throw Object.assign(Error(`Source unavailable: HTTP ${status}, success=${data?.isSuccess??'unknown'}`),{code:`HTTP_${status}`});
 const r=data.result;
 if(!Array.isArray(r?.list)||!Number.isInteger(r.totalCount)||typeof r.hasNextPage!=='boolean')throw Error('Unexpected listing response');
 return r;
}
async function collect(fetchPage,session){
 for(const [code,name] of [['1168000000','강남구'],['1150000000','강서구']]){
  const check={session,district:name,startedAt:new Date().toISOString(),pages:0,total:null,received:0,conditionViolations:0,complete:false};report.checks.push(check);
  let cursor;const seen=new Set();
  do{
   if(check.pages>=3)throw Error('Diagnostic page limit reached (3); no exhaustive success claimed');
   await delay(2000);
   const {status,data}=await fetchPage(payload(code,cursor));
   const r=inspectResponse(status,data);
   check.status=status;
   if(check.total===null)check.total=r.totalCount;
   if(check.total!==r.totalCount)throw Error('Listing total changed during pagination');
   for(const group of r.list){
    const a=group.representativeArticleInfo;
    if(!a?.articleNumber||seen.has(a.articleNumber))throw Error('Missing or repeated article ID');
    seen.add(a.articleNumber);
    if(a.address?.city!=='서울시'||a.address?.division!==name||a.tradeType!=='B1'||!['A01','A04','B01'].includes(a.realEstateType)||!Number.isFinite(a.priceInfo?.warrantyPrice)||a.priceInfo.warrantyPrice>300000000||!Number.isFinite(a.spaceInfo?.exclusiveSpace)||a.spaceInfo.exclusiveSpace<60)check.conditionViolations++;
   }
   check.pages++;check.received=seen.size;
   if(!r.hasNextPage){check.complete=seen.size===r.totalCount&&check.conditionViolations===0;break;}
   if(!r.list.length||!r.lastInfo?.length||JSON.stringify(r.lastInfo)===JSON.stringify(cursor?.lastInfo))throw Error('Pagination did not advance');
   cursor={lastInfo:r.lastInfo,seed:r.seed};
  }while(true);
  check.finishedAt=new Date().toISOString();
  if(!check.complete)throw Error('Incomplete or mismatching results');
 }
}
try{
 if(mode==='connectivity'){
  report.dns={};
  for(const [family,resolve] of [['ipv4',resolve4],['ipv6',resolve6]]){
   try{report.dns[family]=await resolve('fin.land.naver.com');}catch(e){report.dns[family]=errorInfo(e);}
  }
  for(const url of ['https://example.com/','https://www.naver.com/',origin+'/']){
   const check={url,family:'IPv4',events:[],status:null};report.checks.push(check);
   await new Promise(done=>{
    const start=Date.now();
    const event=(name)=>check.events.push({name,elapsedMs:Date.now()-start});
    const request=https.get(url,{family:4},response=>{check.status=response.statusCode;event('http-response');response.resume();});
    const timeout=setTimeout(()=>request.destroy(Error('HTTPS diagnostic timed out after 15000ms')),15000);
    request.on('socket',socket=>{
     socket.on('lookup',(error,address)=>{event('dns-resolved');check.address=address;});
     socket.on('connect',()=>event('tcp-connected'));
     socket.on('secureConnect',()=>event('tls-established'));
    });
    request.on('error',e=>{check.error=errorInfo(e);});
    request.on('close',()=>{clearTimeout(timeout);check.elapsedMs=Date.now()-start;done();});
   });
  }
  report.success=report.checks.every(c=>c.status===200);
 }else if(mode==='http'){
  await collect(async body=>{
   const r=await fetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
   const data=await r.json().catch(()=>null);return {status:r.status,data};
  },1);
 }else{
  const {chromium}=await import('playwright');
  // A new browser process and temporary profile on every round.
  for(let session=1;session<=2;session++){
   const browser=await chromium.launch({channel:'chromium',headless:!headed,timeout:20000});
   try{
    report.browserVersion=browser.version();
    const context=await browser.newContext({locale:'ko-KR',viewport:{width:1280,height:900}});
    const page=await context.newPage();
    const response=await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:20000});
    report.checks.push({session,stage:'home',status:response?.status()??null,url:page.url()});
    if(!response?.ok())throw Error(`Home page unavailable: HTTP ${response?.status()}`);
    const challenge=/captcha|자동입력|비정상적인 접근|접근이 제한|access denied/i.test(await page.locator('body').innerText());
    if(challenge)throw Error('Site requested verification or denied access; diagnostic stopped');
    await collect(async body=>page.evaluate(async({endpoint,body})=>{
     const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
     return {status:r.status,data:await r.json().catch(()=>null)};
    },{endpoint,body}),session);
   }finally{await browser.close();}
  }
 }
 if(mode!=='connectivity')report.success=report.checks.some(c=>c.received>0)&&report.checks.filter(c=>c.district).every(c=>c.complete);
 if(!report.success)report.error={message:'No nonempty complete query observed'};
}catch(e){report.success=false;report.error=errorInfo(e);}
report.finishedAt=new Date().toISOString();
mkdirSync(dirname(reportPath),{recursive:true});
writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.success)process.exitCode=2;
