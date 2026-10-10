import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttentionHome } from '../src/components/AttentionHome.tsx';
import { setApiIdentity } from '../src/api.ts';
import { seedState } from '../server/seed.ts';
import type { AttentionTask } from '../shared/attention.ts';

afterEach(() => { cleanup(); window.localStorage.clear(); setApiIdentity('local'); });
function sampleTasks(): AttentionTask[] {
  const [bolts, nuts] = seedState().parts;
  bolts.bins.forEach(bin => { bin.status = 'empty'; });
  nuts.bins[0].status = 'empty';
  return [
    { part: bolts, action: {kind:'purchase'}, critical:true, received:0, toBuy:100, reasons:[{kind:'out'},{kind:'purchase',quantity:100}] },
    { part: nuts, action: {kind:'refill',binId:nuts.bins[0].id,cycle:0}, critical:false, received:50, toBuy:0, reasons:[{kind:'refill',quantity:1}] },
  ];
}
const base = {busy:false,onAction:(_task:AttentionTask)=>{},onInventory:()=>{}};

test('Buy Here opens the saved supplier in both layouts before the purchase action', async () => {
  const tasks=sampleTasks(),user=userEvent.setup();
  tasks[0].part.supplierUrl='https://supplier.example/bolts-m6';
  render(React.createElement(AttentionHome,{...base,tasks}));
  for(const mode of ['By action','Focus']) {
    await user.click(screen.getByRole('button',{name:mode,exact:true}));
    const link=screen.getByRole('link',{name:'Buy Here',exact:true});
    assert.equal(link.getAttribute('href'),tasks[0].part.supplierUrl);
    assert.equal(link.getAttribute('target'),'_blank');
    assert.match(link.getAttribute('rel')??'',/noopener/);
    assert.ok(link.compareDocumentPosition(screen.getByRole('button',{name:'Mark purchased'})) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
});

test('missing supplier link opens supplier editing, and refill cards have no shopping link', async () => {
  const tasks=sampleTasks(),user=userEvent.setup();let edited:string|undefined;
  render(React.createElement(AttentionHome,{...base,tasks,onSupplier:(task:AttentionTask)=>{edited=task.part.id;}}));
  await user.click(screen.getByRole('button',{name:'Add supplier link',exact:true}));
  assert.equal(edited,tasks[0].part.id);
  assert.equal(screen.queryByRole('link',{name:'Buy Here'}),null);
  assert.equal(within(screen.getByRole('article',{name:'Attention for Nyloc nuts'})).queryByRole('button',{name:'Add supplier link'}),null);
});

test('Today defaults to action groups and remembers layout per account', async () => {
  const tasks=sampleTasks(), user=userEvent.setup(); setApiIdentity('deployed','alice');
  render(React.createElement(AttentionHome,{...base,tasks}));
  assert.equal(screen.getByRole('button',{name:'By action',exact:true}).getAttribute('aria-pressed'),'true');
  await user.click(screen.getByRole('button',{name:'Focus',exact:true})); cleanup();
  render(React.createElement(AttentionHome,{...base,tasks}));
  assert.equal(screen.getByRole('button',{name:'Focus',exact:true}).getAttribute('aria-pressed'),'true'); cleanup();
  setApiIdentity('deployed','bob'); render(React.createElement(AttentionHome,{...base,tasks}));
  assert.equal(screen.getByRole('button',{name:'By action',exact:true}).getAttribute('aria-pressed'),'true');
});

test('both layouts invoke the existing action with the latest task and preserve focus across polling', async () => {
  const tasks=sampleTasks(), calls:AttentionTask[]=[], user=userEvent.setup();
  const props={...base,tasks,onAction:(task:AttentionTask)=>calls.push(task)};
  const view=render(React.createElement(AttentionHome,props));
  await user.click(screen.getByRole('button',{name:'Mark purchased',exact:true})); assert.equal(calls.at(-1),tasks[0]);
  await user.click(screen.getByRole('button',{name:'Focus',exact:true}));
  await user.click(screen.getByRole('button',{name:'Show Nyloc nuts',exact:true}));
  const refreshed=structuredClone(tasks); refreshed[1].action={kind:'refill',binId:'BLUE-A02-1',cycle:3};
  view.rerender(React.createElement(AttentionHome,{...props,tasks:refreshed}));
  await user.click(screen.getByRole('button',{name:'Refill bin',exact:true})); assert.equal(calls.at(-1),refreshed[1]);
  view.rerender(React.createElement(AttentionHome,{...props,tasks:[refreshed[0]]}));
  assert.ok(screen.getByRole('button',{name:'Mark purchased',exact:true}));
});

test('both layouts keep mutations disabled while busy and keep all attention reasons', async () => {
  const tasks=sampleTasks(), user=userEvent.setup();
  render(React.createElement(AttentionHome,{...base,tasks,busy:true}));
  for(const mode of ['By action','Focus']) {
    await user.click(screen.getByRole('button',{name:mode,exact:true}));
    const part=within(screen.getByRole('article',{name:'Attention for Hex bolts'}));
    assert.ok(part.getByText('Both bins empty')); assert.ok(part.getByText('Needs purchase'));
    assert.equal((part.getByRole('button',{name:'Mark purchased',exact:true}) as HTMLButtonElement).disabled,true);
  }
});

test('empty Today retains navigation and changing layout does not create inventory actions', async () => {
  const user=userEvent.setup();let inventory=0,actions=0;
  render(React.createElement(AttentionHome,{...base,tasks:[],onInventory:()=>inventory++,onAction:()=>actions++}));
  await user.click(screen.getByRole('button',{name:'Focus',exact:true}));
  assert.ok(screen.getByText('Nothing needs attention today.'));
  await user.click(screen.getByRole('button',{name:'View inventory',exact:true}));
  assert.equal(screen.queryByRole('button',{name:'Try a scan',exact:true}),null);
  assert.deepEqual([inventory,actions],[1,0]);
});
