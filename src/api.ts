import type { AlertSettings, Part, PartInput, PartStatus, Role, Team, Cabinet, User, ViewState } from '../shared/types';

/** Demo sign-in: which sample account this browser is using. */
const USER_KEY = 'demo-user';
export function currentUserId() { try { return localStorage.getItem(USER_KEY) ?? ''; } catch { return ''; } }
export function switchUser(id: string) { try { localStorage.setItem(USER_KEY, id); } catch { /* private mode */ } }
export interface Account { id: string; name: string; role: Role; teamId: string }
export interface Session { mode: 'demo' | 'live'; status: 'active' | 'signed_out' | 'new' | 'pending'; email?: string; name?: string; teams?: Team[]; providers?: { google: boolean; microsoft: boolean; email: boolean } }
/** The secret code on a live label (?k=...), passed along with scans. */
const withKey = (path: string, k?: string | null) => k ? `${path}?k=${encodeURIComponent(k)}` : path;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = { 'x-user-id': currentUserId() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('Can\'t reach the server. Check the connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
  return data as T;
}

export const api = {
  session: () => call<Session>('GET', '/session'),
  logout: () => call('POST', '/auth/logout'),
  signUp: (email: string, password: string) => call('POST', '/auth/signup', { email, password }),
  signIn: (email: string, password: string) => call('POST', '/auth/password', { email, password }),
  forgotPassword: (email: string) => call('POST', '/auth/forgot', { email }),
  newPassword: (password: string) => call('POST', '/auth/new-password', { password }),
  state: () => call<ViewState>('GET', '/state'),
  directory: () => call<{ teams: Team[]; accounts: Account[] }>('GET', '/directory'),
  join: (input: { name: string; email?: string; teamId: string }) => call<User>('POST', '/join', input),
  approve: (id: string, patch: { role?: Role; teamId?: string } = {}) => call<User>('POST', `/users/${id}/approve`, patch),
  decline: (id: string) => call('POST', `/users/${id}/decline`),
  updateUser: (id: string, patch: { role?: Role; teamId?: string }) => call<User>('PUT', `/users/${id}`, patch),
  removeUser: (id: string) => call('DELETE', `/users/${id}`),
  saveAlerts: (patch: Partial<Pick<AlertSettings, 'enabled' | 'recipients' | 'timing'>>) => call<AlertSettings>('PUT', '/alerts', patch),
  testAlert: () => call<AlertSettings>('POST', '/alerts/test'),
  config: () => call<{ scanOrigin: string }>('GET', '/config'),
  addPart: (input: PartInput) => call<Part>('POST', '/parts', input),
  editPart: (id: string, input: PartInput) => call<Part>('PUT', `/parts/${id}`, input),
  deletePart: (id: string) => call('DELETE', `/parts/${id}`),
  setStatus: (id: string, status: PartStatus, note?: string) => call<{ part: Part; changed: boolean; event: { id: string } | null }>('POST', `/parts/${id}/status`, { status, note }),
  scanInfo: (id: string, k?: string | null) => call<{ part: Part }>('GET', withKey(`/scan/${id}`, k)),
  scan: (id: string, k?: string | null) => call<{ part: Part; changed: boolean; eventId: string | null }>('POST', withKey(`/scan/${id}`, k)),
  undo: (eventId: string, k?: string | null) => call<Part>('POST', withKey(`/undo/${eventId}`, k)),
  addGroup: (kind: 'teams' | 'cabinets', name: string) => call<Team | Cabinet>('POST', `/${kind}`, { name }),
  editGroup: (kind: 'teams' | 'cabinets', id: string, patch: { name?: string; color?: string }) => call<Team | Cabinet>('PUT', `/${kind}/${id}`, patch),
  deleteGroup: (kind: 'teams' | 'cabinets', id: string) => call('DELETE', `/${kind}/${id}`),
  reset: () => call('POST', '/reset'),
};

/** Shrink a chosen photo to a small square-ish JPEG data URL so storage stays light. */
export function shrinkPhoto(file: File, max = 480): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('That file isn\'t a photo we can read.'));
    img.src = URL.createObjectURL(file);
  });
}
