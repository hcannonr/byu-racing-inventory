import './dom-setup.ts';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {render,screen,cleanup,act,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AuthGate} from '../src/components/AuthGate.tsx';
import {InventoryStore} from '../server/store.ts';
import {createPublicScanning} from '../server/publicScan.ts';

const originalFetch=globalThis.fetch;
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;window.sessionStorage.clear();window.history.replaceState(null,'','/');});
async function fixture(){
 const store=new InventoryStore(':memory:',false), service=createPublicScanning(store,'test-secret'.repeat(4));
 const links=await service.links(window.location.origin);window.history.replaceState(null,'',links['BLUE-A01-1']);
 const calls:string[]=[],cycles:number[]=[];
 globalThis.fetch=async(path,init)=>{
  calls.push(String(path));const body=JSON.parse(String(init?.body??'{}'));
  try{
   if(String(path)==='/api/public-scan/prepare')return Response.json(await service.prepare(body));
   if(String(path)==='/api/public-scan/complete'){cycles.push(body.cycle);return Response.json(await service.complete(body));}
   return Response.json({mode:'deployed'});
  }catch(e){return Response.json({error:(e as Error).message},{status:(e as any).status??400});}
 };
 return {store,calls,cycles,links};
}
test('public QR automatically saves while signed out and never calls auth or full inventory APIs',async()=>{
 const f=await fixture();try{
  render(React.createElement(React.StrictMode,null,React.createElement(AuthGate)));
  await screen.findByRole('heading',{name:'Bin marked empty'});
  assert.equal(f.cycles.length,1);assert.equal(f.store.read().parts[0].bins[0].status,'empty');
  assert.equal(f.calls.some(path=>path.includes('/auth/')||path==='/api/state'),false);
  assert.equal(window.location.hash,'');
  assert.equal(screen.queryByRole('link',{name:'Login'}),null);
 }finally{f.store.close();}
});
test('public scan lost-response retry preserves its original refill cycle',async()=>{
 const f=await fixture();const api=globalThis.fetch;let lose=true;
 globalThis.fetch=async(path,init)=>{const response=await api(path,init);if(String(path)==='/api/public-scan/complete'&&lose){lose=false;throw Error('Connection lost');}return response;};
 try{render(React.createElement(AuthGate));await userEvent.setup().click(await screen.findByRole('button',{name:'Retry save safely'}));
  await screen.findByRole('heading',{name:'Bin marked empty'});assert.deepEqual(f.cycles,[0,0]);assert.equal(f.store.read().requests.length,1);
 }finally{f.store.close();}
});
test('invalid public label does not save or redirect people to login',async()=>{
 const f=await fixture();window.history.replaceState(null,'','/#binId=BLUE-A01-1&key='+'z'.repeat(43));
 try{render(React.createElement(AuthGate));await screen.findByRole('alert');assert.equal(f.cycles.length,0);assert.equal(f.store.read().parts[0].bins[0].status,'in_use');assert.equal(screen.queryByRole('link',{name:'Login'}),null);}
 finally{f.store.close();}
});
test('a second QR opened in the same browser tab scans the newly selected bin',async()=>{
 const f=await fixture();try{
  render(React.createElement(AuthGate));await screen.findByRole('heading',{name:'Bin marked empty'});
  await act(async()=>{window.history.replaceState(null,'',f.links['BLUE-A01-2']);window.dispatchEvent(new window.Event('hashchange'));});
  await waitFor(()=>assert.equal(f.cycles.length,2));await screen.findByText('BLUE-A01-2');
  assert.equal(f.store.read().parts[0].bins[1].status,'empty');
 }finally{f.store.close();}
});
test('a rejected stale cycle is released so a later fresh scan can use the current bin cycle',async()=>{
 const f=await fixture();const label=Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
 const key=`racing-public-scan:${label.binId}:${label.key}`;window.sessionStorage.setItem(key,'9');
 try{
  render(React.createElement(AuthGate));await screen.findByRole('alert');assert.equal(window.sessionStorage.getItem(key),null);
  assert.equal(window.location.hash,'');
  await act(async()=>{window.history.replaceState(null,'',f.links['BLUE-A01-1']);window.dispatchEvent(new window.Event('hashchange'));});
  await screen.findByRole('heading',{name:'Bin marked empty'});
  assert.deepEqual(f.cycles,[9,0]);
 }finally{f.store.close();}
});
