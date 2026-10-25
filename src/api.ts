import type { Action, Command, CommandResult, InventoryState } from '../shared/types';
import type { NotificationCommand, NotificationSnapshot } from '../shared/notifications';
import type { OrderImportConfiguration, OrderImportDraft } from '../shared/orderImport';

let apiMode: 'local' | 'deployed' = 'local';
let identity = 'local';
let generation=0;
export function setApiIdentity(mode: 'local' | 'deployed', userId?: string) { const next=mode==='local'?'local':userId??'anonymous';if(next!==identity||mode!==apiMode)generation++;apiMode = mode; identity = next; }
export function accountFence(){const started=generation;return()=>{if(started!==generation)throw new ApiError('Account changed. Reload before continuing.',401);};}
export function accountHeaders():Record<string,string>{return apiMode==='deployed'?{'X-Racing-User-ID':identity}:{};}
const storageKey = (key: string) => identity === 'local' ? key : key + ':' + identity;
export type TodayLayout = 'groups' | 'focus';
export function readTodayLayout(): TodayLayout {
  try { return window.localStorage.getItem(storageKey('racing-today-layout')) === 'focus' ? 'focus' : 'groups'; }
  catch { return 'groups'; }
}
export function persistTodayLayout(layout: TodayLayout) {
  try { window.localStorage.setItem(storageKey('racing-today-layout'), layout); }
  catch { /* Layout switching still works when browser storage is unavailable. */ }
}
export type InventoryLayout = 'cards' | 'cabinet' | 'category';
export function readInventoryLayout(): InventoryLayout {
  try { const value = window.localStorage.getItem(storageKey('racing-inventory-layout')); return value === 'cabinet' || value === 'category' ? value : 'cards'; }
  catch { return 'cards'; }
}
export function persistInventoryLayout(layout: InventoryLayout) {
  try { window.localStorage.setItem(storageKey('racing-inventory-layout'), layout); }
  catch { /* Keep the current view usable when browser storage is unavailable. */ }
}
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export function readPendingCommand(): Command | null {
  try { return JSON.parse(window.sessionStorage.getItem(storageKey('racing-pending-command')) || 'null'); } catch { return null; }
}
export function persistPendingCommand(command: Command | null) {
  try {
    if (command) window.sessionStorage.setItem(storageKey('racing-pending-command'), JSON.stringify(command));
    else window.sessionStorage.removeItem(storageKey('racing-pending-command'));
  } catch { /* The in-memory retry token still protects this page session. */ }
}

async function request<T>(path: string, options?: RequestInit, timeout = 10000): Promise<T> {
  const startedAs = identity;
  const fence=accountFence();
  const response = await fetch(path, { ...options, headers:{...options?.headers,...accountHeaders()}, signal: AbortSignal.timeout(timeout) });
  fence();
  if (startedAs !== identity) throw new ApiError('Account changed. Reload before continuing.', 401);
  if (response.status === 401 || response.status === 403) window.dispatchEvent(new window.Event('racing-auth-change'));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Could not reach the inventory server.' }));
    throw new ApiError(error.error || 'The change could not be saved.', response.status);
  }
  const result=await response.json();fence();return result;
}
export const getState = () => request<InventoryState>('/api/state');
export const getScanLinks = () => request<Record<string,string>>('/api/labels/scan-links');
export const getOrderImportConfiguration = () => request<OrderImportConfiguration>('/api/order-import/configuration');
const extractLocal = (source: File | string) => request<OrderImportDraft>('/api/order-import/extract', {
  method: 'POST', headers: { 'Content-Type': typeof source === 'string' ? 'text/plain; charset=utf-8' : source.type || (/\.pdf$/i.test(source.name) ? 'application/pdf' : 'application/octet-stream') }, body: source,
}, 90000);
export const newCommand = (action: Action, revision?: number): Command => ({ eventId: crypto.randomUUID(), expectedRevision: revision, action, provenance: { source: action.type === 'scan' ? 'simulator' : action.type === 'reset' ? 'demo' : 'buyer' } });
export const sendCommand = (command: Command) => request<CommandResult>('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });

export interface PhotoUploadToken { eventId: string; partId: string; revision: number; hash: string }
export function readPendingPhoto(): PhotoUploadToken | null {
  try {
    const token = JSON.parse(window.sessionStorage.getItem(storageKey('racing-pending-photo')) || 'null');
    return token && typeof token.eventId === 'string' && typeof token.partId === 'string' && Number.isSafeInteger(token.revision) && typeof token.hash === 'string' ? token : null;
  } catch { return null; }
}
export function persistPendingPhoto(token: PhotoUploadToken | null) {
  try { if (token) window.sessionStorage.setItem(storageKey('racing-pending-photo'), JSON.stringify(token)); else window.sessionStorage.removeItem(storageKey('racing-pending-photo')); } catch { /* In-memory token still protects retries. */ }
}
export async function photoHash(file: File) {
  const fence=accountFence();const bytes=await file.arrayBuffer();fence();const digest=await crypto.subtle.digest('SHA-256',bytes);fence();
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const sendLocalPhoto = (token: PhotoUploadToken, file: File) => request<CommandResult>(`/api/parts/${encodeURIComponent(token.partId)}/photo`, {
  method: 'POST', headers: { 'Content-Type': file.type, 'X-Event-ID': token.eventId, 'X-Inventory-Revision': String(token.revision) }, body: file,
});
export const sendNotificationCommand = (command: NotificationCommand) => request<{ notifications: NotificationSnapshot; message: string }>('/api/notifications/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
export const getNotifications = () => request<NotificationSnapshot>('/api/notifications');
export function readPendingEmailCommand(): NotificationCommand | null {
  try { return JSON.parse(window.sessionStorage.getItem(storageKey('racing-pending-email-command')) || 'null'); } catch { return null; }
}
export function persistPendingEmailCommand(command: NotificationCommand | null) {
  try { if (command) window.sessionStorage.setItem(storageKey('racing-pending-email-command'), JSON.stringify(command)); else window.sessionStorage.removeItem(storageKey('racing-pending-email-command')); } catch { /* In-memory token still protects retries. */ }
}

let audioContext: AudioContext | undefined;
export function prepareSound() {
  try { audioContext ??= new AudioContext(); void audioContext.resume(); } catch { /* Visual confirmation remains available. */ }
}
export function playSavedSound() {
  if (!audioContext || audioContext.state !== 'running') return;
  const ctx = audioContext;
  for (const [offset, frequency] of [[0, 880], [0.12, 1174]]) {
    const tone = ctx.createOscillator(); const gain = ctx.createGain();
    tone.frequency.value = frequency; tone.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.10, ctx.currentTime + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
    tone.start(ctx.currentTime + offset); tone.stop(ctx.currentTime + offset + 0.2);
  }
}

async function stageFile(file: File, purpose: 'photo' | 'order') {
 const fence=accountFence();
 const upload = await request<{uploadId: string; signedUrl: string}>('/api/uploads', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose,size:file.size,mime:file.type || (/\.pdf$/i.test(file.name)?'application/pdf':'application/octet-stream')})});
 const response = await fetch(upload.signedUrl,{method:'PUT',headers:{'Content-Type':file.type || 'application/pdf'},body:file,signal:AbortSignal.timeout(60000)});
 fence();
 if(!response.ok)throw new ApiError('File upload failed. Choose the file and try again.',response.status);
 return upload.uploadId;
}
export async function extractOrderDocument(source:File|string):Promise<OrderImportDraft> {
 const fence=accountFence();
 if(apiMode==='local')return extractLocal(source);
 const body=typeof source==='string'?{text:source}:{uploadId:await stageFile(source,'order')};
 fence();
 return request('/api/order-import/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},90000);
}
const photoUploads=new Map<string,{id:string;at:number}>();
export async function sendPhoto(token:PhotoUploadToken,file:File):Promise<CommandResult> {
 const fence=accountFence();
 if(apiMode==='local')return sendLocalPhoto(token,file);
 const key=identity+':'+token.eventId;
 let upload=photoUploads.get(key);
 if(!upload || Date.now()-upload.at>14*60000){upload={id:await stageFile(file,'photo'),at:Date.now()};photoUploads.set(key,upload);}
 fence();
 return request('/api/parts/'+encodeURIComponent(token.partId)+'/photo',{method:'POST',headers:{'Content-Type':'application/json','X-Event-ID':token.eventId,'X-Inventory-Revision':String(token.revision)},body:JSON.stringify({uploadId:upload.id})});
}
