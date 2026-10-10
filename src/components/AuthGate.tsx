import { useCallback, useEffect, useRef, useState } from 'react';
import type { Member, SessionView } from '../../shared/auth';
import App from '../App';
import { setApiIdentity } from '../api';
import { MembersPanel } from './MembersPanel';
import { MemberCabinet } from './MemberCabinet';

export function AuthGate() {
 const [session,setSession]=useState<SessionView|null>(null),[error,setError]=useState(''),[admin,setAdmin]=useState(false);
 const generation=useRef(0),signingOut=useRef(false);
 const refresh=useCallback(async()=>{
  if(signingOut.current)return;
  const current=++generation.current;
  try {const response=await fetch('/api/auth/session',{cache:'no-store'});if(!response.ok)throw Error('Sign-in is temporarily unavailable. Try again.');
   const next=await response.json() as SessionView;
   if(current!==generation.current)return;
   if(!['local','deployed'].includes(next.mode))throw Error('Sign-in configuration is unavailable.');
   setApiIdentity(next.mode,next.user?.id);setSession(next);setError('');
  }catch(e){if(current!==generation.current)return;setSession(null);setApiIdentity('deployed');setError(e instanceof Error?e.message:'Could not verify access.');}
 },[]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),15000);window.addEventListener('racing-auth-change',refresh);return()=>{clearInterval(timer);window.removeEventListener('racing-auth-change',refresh);};},[refresh]);
 async function logout() {
  signingOut.current=true;++generation.current;
  try {
  const response=await fetch('/api/auth/logout',{method:'POST'});
  if(!response.ok){setError('Could not sign out. Please try again.');return;}
  setApiIdentity('deployed');setSession({mode:'deployed'});setAdmin(false);
  }catch{setError('Could not sign out. Please try again.');}finally{++generation.current;signingOut.current=false;}
 }
 if(session?.mode==='local')return <>{session.reviewPreview && <div className="review-preview-banner" role="status">Design preview · Sample inventory · Changes are not saved</div>}<App /></>;
 const user=session?.user;
 if(!session||!user||user.status!=='approved')return <main className="auth-screen"><section className="auth-card" aria-label="BYU Racing login"><div className="auth-logo"><img src="/byu-racing-logo.jpg" alt="BYU Racing team logo" width="335" height="595" /></div>{user&&<p>{user.status==='revoked'?'Your access has been removed. Contact the club administrator.':'Your access is awaiting approval.'}</p>}{error&&<p role="alert">{error}</p>}{!session?<button className="button primary" onClick={()=>void refresh()}>{error?'Try again':'Checking access…'}</button>:user?<><p className="muted">{user.email}</p><button className="button primary" onClick={()=>void refresh()}>Check access</button><button className="button secondary" onClick={()=>void logout()}>Sign out</button></>:<a className="button primary google-login" href="/api/auth/google"><GoogleMark />Login</a>}<p className="auth-footnote">Access is limited to approved club members.</p></section></main>;
 return <><div className="account-bar"><span>{user.email} <strong>{user.role}</strong></span><div>{user.role==='admin'&&<button onClick={()=>setAdmin(!admin)}>{admin?'Back to inventory':'Manage members'}</button>}<button onClick={()=>void logout()}>Sign out</button></div></div>{error&&<p role="alert">{error}</p>}{admin&&user.role==='admin'?<MembersPanel current={user} />:user.role==='member'?<MemberCabinet key={user.id} />:<App key={user.id} deployed />}</>;
}
function GoogleMark(){return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36ZM12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22ZM6.4 13.91A6 6 0 0 1 6.08 12c0-.66.11-1.3.32-1.91V7.5H3.06A10 10 0 0 0 2 12c0 1.61.38 3.14 1.06 4.5l3.34-2.59ZM12 5.97c1.47 0 2.79.5 3.83 1.5L18.7 4.6A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.94 5.5l3.34 2.59C7.19 7.73 9.4 5.97 12 5.97Z"/></svg>;}
