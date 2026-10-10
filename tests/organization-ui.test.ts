import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CabinetSetup, CategorySetup } from '../src/components/InventorySetup.tsx';
import { PartForm } from '../src/components/PartForm.tsx';
import { seedState } from '../server/seed.ts';
import type { Action } from '../shared/types.ts';

afterEach(cleanup);
test('cabinet setup renames section headings and moves parts while preserving existing compartments and bin codes', async () => {
  const state=seedState(), user=userEvent.setup(); let saved: Action | undefined;
  render(React.createElement(CabinetSetup,{state,busy:false,onSave:async action=>{saved=action;return true;},onClose:()=>{}}));
  await user.clear(screen.getByRole('textbox',{name:'Section 1',exact:true}));
  await user.type(screen.getByRole('textbox',{name:'Section 1',exact:true}),'Top drawer');
  await user.click(screen.getByRole('button',{name:'Add section',exact:true}));
  await user.type(screen.getByRole('textbox',{name:'Section 4',exact:true}),'Tool cart');
  await user.selectOptions(screen.getByRole('combobox',{name:'Section for Hex bolts'}),screen.getAllByRole('option',{name:'Tool cart'})[0]);
  await user.click(screen.getByRole('button',{name:'Save cabinet',exact:true}));
  assert.equal(saved?.type,'save_cabinet_map');
  if(saved?.type!=='save_cabinet_map')return;
  assert.equal(saved.map.drawers[0].label,'Top drawer');
  assert.deepEqual(saved.map.drawers[3].compartments[0].locations,['BLUE-A01']);
  assert.equal(saved.map.drawers[0].compartments[0].locations.includes('BLUE-A01'),false);
});
test('category setup adds an empty category, renames a used category, and assigns a part',async()=>{
  const state=seedState(),user=userEvent.setup();let saved:Action|undefined;
  render(React.createElement(CategorySetup,{state,busy:false,onSave:async action=>{saved=action;return true;},onClose:()=>{}}));
  await user.clear(screen.getByRole('textbox',{name:'Category 1',exact:true}));await user.type(screen.getByRole('textbox',{name:'Category 1',exact:true}),'Hardware');
  await user.click(screen.getByRole('button',{name:'Add category',exact:true}));await user.type(screen.getByRole('textbox',{name:'Category 4',exact:true}),'Safety');
  await user.selectOptions(screen.getByRole('combobox',{name:'Category for Cable ties'}),'3');
  await user.click(screen.getByRole('button',{name:'Save categories',exact:true}));
  assert.equal(saved?.type,'save_categories');if(saved?.type!=='save_categories')return;
  assert.deepEqual(saved.categories,['Hardware','Electrical','Workshop','Safety']);
  assert.equal(saved.assignments.find(a=>a.partId===state.parts[0].id)!.category,'Hardware');
  assert.equal(saved.assignments.find(a=>a.partId===state.parts[6].id)!.category,'Safety');
});
test('existing part can be assigned a new category from its edit form',async()=>{
  const state=seedState(),user=userEvent.setup();let saved:Action|undefined;
  render(React.createElement(PartForm,{part:state.parts[0],categories:['Fasteners','Electrical','Workshop'],busy:false,run:async action=>{saved=action;return true;},onClose:()=>{}}));
  await user.selectOptions(screen.getByRole('combobox',{name:'Category',exact:true}),'');
  await user.type(screen.getByRole('textbox',{name:'New category name'}),'Suspension');
  await user.click(screen.getByRole('button',{name:'Save changes'}));
  assert.equal(saved?.type,'edit_part');if(saved?.type==='edit_part')assert.equal(saved.part.category,'Suspension');
});
