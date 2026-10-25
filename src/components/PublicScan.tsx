import {useEffect,useRef,useState} from 'react';
import type {PublicScanLabel,PublicBinView,PublicScanResult} from '../../shared/publicScan';
import {TeamLogo} from './TeamLogo';

export function readPublicScanLabel(): PublicScanLabel | null {
 const hash=new URLSearchParams(window.location.hash.slice(1));
 return hash.has('binId')||hash.has('key')?{binId:(hash.get('binId')??'').slice(0,100),key:(hash.get('key')??'').slice(0,100)}:null;
}
class ScanError extends Error {constructor(message:string,public status:number){super(message);}}
export function PublicScan({label}:{label:PublicScanLabel}){
 const [bin,setBin]=useState<PublicBinView|null>(null),[saved,setSaved]=useState(false),[earlier,setEarlier]=useState(false),[error,setError]=useState(''),[retryable,setRetryable]=useState(true),[busy,setBusy]=useState(true);
 const storageKey=`racing-public-scan:${label.binId}:${label.key}`;
 const cycle=useRef<number|null>(null),inFlight=useRef(false),mounted=useRef(false);
 async function request<T>(path:string,body:unknown):Promise<T>{
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok)throw new ScanError(result.error??'The scan could not be saved.',response.status);return result;
 }
 function finish(){
  try{window.sessionStorage.removeItem(storageKey);}catch{/* In-memory receipt remains visible. */}
  window.history.replaceState(null,'',window.location.pathname);
 }
 async function scan(active:()=>boolean){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
  try{
   if(cycle.current===null){try{const stored=window.sessionStorage.getItem(storageKey);if(stored!==null){const parsed=Number(stored);if(Number.isSafeInteger(parsed)&&parsed>=0)cycle.current=parsed;}}catch{/* Continue in memory. */}}
   if(cycle.current===null){
    const current=await request<PublicBinView>('/api/public-scan/prepare',label);if(!active())return;setBin(current);
    if(current.status==='empty'){setSaved(true);finish();return;}
    cycle.current=current.cycle;
   }
   if(!active())return;
   try{window.sessionStorage.setItem(storageKey,String(cycle.current));}catch{/* Retry in this page still uses the same cycle. */}
   const result=await request<PublicScanResult>('/api/public-scan/complete',{...label,cycle:cycle.current});if(!active())return;
   setBin(result.bin);setEarlier(result.bin.cycle!==cycle.current||result.bin.status!=='empty');setSaved(true);finish();
  }catch(e){if(active()){
   const definitive=e instanceof ScanError&&e.status<500&&e.status!==429;
   if(definitive){finish();cycle.current=null;}
   setError(e instanceof ScanError&&e.status===409?'The bin changed during this scan. Scan its label again only if it is empty.':(e as Error).message);setRetryable(!definitive);
  }}
  finally{inFlight.current=false;if(active())setBusy(false);}
 }
 useEffect(()=>{
  let active=true;mounted.current=true;
  // Defer until StrictMode has finished its setup/cleanup probe, without delaying a real scan.
  void Promise.resolve().then(()=>{if(active)void scan(()=>active);});
  return()=>{active=false;mounted.current=false;};
 },[]);
 return <main className="phone-scan"><section className="phone-scan-card" aria-label="Empty-bin scan">
  <TeamLogo/><p className="eyebrow">BYU RACING / BIN SCAN</p>
  <h1>{saved?earlier?'Earlier scan confirmed':'Bin marked empty':error?'Scan not saved':'Saving your scan…'}</h1>
  {bin&&<div className="phone-scan-part"><h2>{bin.name}</h2><p>{bin.specification}</p><strong>Bin {bin.letter} · {bin.location}</strong><code>{bin.binId}</code></div>}
  {saved?<div role="status" className="phone-scan-result">{earlier?<><strong>The bin has changed since your earlier scan.</strong><p>Current status: {bin?.status==='ready'?'ready':bin?.status==='in_use'?'in use':'empty'}. No new empty-bin scan was recorded.</p></>:<><strong>{bin?.otherEmpty?'Both bins are empty.':'Switch to the other bin.'}</strong><p>Supply status is saved. You can close this page.</p></>}</div>:!error&&<p>Recording the empty bin. No sign-in needed.</p>}
  {bin?.practice&&<p className="phone-scan-note">Sample / practice inventory. No buyer email will be sent.</p>}
  {error&&<p className="inline-error" role="alert">{error}{!retryable&&' Ask a buyer to check the bin or print a new label.'}</p>}
  {error&&retryable&&<button className="button primary" disabled={busy} onClick={()=>void scan(()=>mounted.current)}>Retry save safely</button>}
 </section></main>;
}
