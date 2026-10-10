import './dom-setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { AuthGate } from '../src/components/AuthGate.tsx';
import { setApiIdentity, persistPendingCommand, readPendingCommand } from '../src/api.ts';
import { photoHash, ApiError } from '../src/api.ts';
import { MemberCabinet } from '../src/components/MemberCabinet.tsx';
import { seedState } from '../server/seed.ts';
import userEvent from '@testing-library/user-event';
test('Google login and pending approval never mount the inventory app',async()=>{
 const old=globalThis.fetch;
 try {
  globalThis.fetch=async()=>Response.json({mode:'deployed'});
  render(React.createElement(AuthGate));
  await screen.findByRole('link',{name:'Login'});
  assert.equal(screen.queryByRole('region',{name:'Needs attention today'}),null);cleanup();
  globalThis.fetch=async()=>Response.json({mode:'deployed',user:{id:'pending',email:'pending@example.org',role:'member',status:'pending',revision:0}});
  render(React.createElement(AuthGate));await screen.findByText('Your access is awaiting approval.');
  assert.equal(screen.queryByRole('region',{name:'Needs attention today'}),null);
 }finally{cleanup();globalThis.fetch=old;}
});
test('pending retries are isolated by signed-in account',()=>{
 setApiIdentity('deployed','user-a');persistPendingCommand({eventId:'test',action:{type:'scan',binId:'A',cycle:0}});
 assert.ok(readPendingCommand());setApiIdentity('deployed','user-b');assert.equal(readPendingCommand(),null);setApiIdentity('local');
});
test('photo hashing cannot continue after an account switch',async()=>{
 setApiIdentity('deployed','user-a');let resolve!:(v:ArrayBuffer)=>void;
 const hash=photoHash({arrayBuffer:()=>new Promise<ArrayBuffer>(r=>{resolve=r;})} as File);
 setApiIdentity('deployed','user-b');resolve(new ArrayBuffer(1));
 await assert.rejects(hash,/Account changed/);setApiIdentity('local');
});
test('a definitive scan conflict releases the member retry lock',async()=>{
 const old=globalThis.fetch;setApiIdentity('local');window.sessionStorage.clear();
 try{globalThis.fetch=async(path)=>String(path)==='/api/state'?Response.json(seedState()):Response.json({error:'Inventory changed'},{status:409});
 render(React.createElement(MemberCabinet));const buttons=await screen.findAllByRole('button',{name:'Practice empty-bin scan'});
 await userEvent.setup().click(buttons[0]);await screen.findByText('Inventory changed');
 await waitFor(()=>assert.equal((buttons[0] as HTMLButtonElement).disabled,false));assert.equal(readPendingCommand(),null);
 }finally{cleanup();globalThis.fetch=old;window.sessionStorage.clear();}
});

test('a session refresh finishing after logout cannot restore the old account',async()=>{
 const old=globalThis.fetch;let resolve!:(r:Response)=>void;let calls=0;
 const pending={mode:'deployed',user:{id:'pending',email:'pending@example.org',role:'member',status:'pending',revision:0}};
 try{globalThis.fetch=async(path)=>String(path).endsWith('logout')?Response.json({ok:true}):++calls===1?Response.json(pending):new Promise<Response>(r=>{resolve=r;});
 render(React.createElement(AuthGate));await screen.findByText('Your access is awaiting approval.');
 await userEvent.setup().click(screen.getByRole('button',{name:'Check access'}));
 await userEvent.setup().click(screen.getByRole('button',{name:'Sign out'}));
 await screen.findByRole('link',{name:'Login'});resolve(Response.json(pending));
 await new Promise(r=>setTimeout(r,20));assert.ok(screen.queryByRole('link',{name:'Login'}));
 }finally{cleanup();globalThis.fetch=old;}
});
