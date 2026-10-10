import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import type { Request, Response } from 'express';
import type { User } from '@supabase/supabase-js';
import type { DeployedConfig } from './config.ts';
import type { Member } from '../shared/auth.ts';
import { Memberships } from './memberships.ts';
import { DomainError } from './domain.ts';
export interface Authentication {
  session(req:Request,res:Response):Promise<Member|undefined>;
  login(req:Request,res:Response):Promise<void>;
  callback(req:Request,res:Response):Promise<void>;
  logout(req:Request,res:Response):Promise<void>;
}
export function verifiedGoogleEmail(user:User):string {
  const email=user.email?.toLowerCase();
  const google=user.identities?.find(identity=>identity.provider==='google' && identity.identity_data?.email?.toLowerCase()===email && identity.identity_data?.email_verified===true);
  if(!email||!user.email_confirmed_at||!google)throw new DomainError('Use a verified Google account to sign in.',403);
  return email;
}
export function createAuthentication(config:DeployedConfig,members:Memberships):Authentication {
  const client=(req:Request,res:Response)=>createServerClient(config.supabaseUrl,config.publishableKey,{
    cookieOptions:{httpOnly:true,secure:true,sameSite:'lax',path:'/'},
    cookies:{getAll:()=>parseCookieHeader(req.headers.cookie??'').map(c=>({name:c.name,value:c.value??''})),setAll:cookies=>{
      const old=res.getHeader('Set-Cookie');const values=old?(Array.isArray(old)?old.map(String):[String(old)]):[];
      res.setHeader('Set-Cookie',[...values,...cookies.map(c=>serializeCookieHeader(c.name,c.value,{...c.options,httpOnly:true,secure:true,sameSite:'lax',path:'/'}))]);
    }}
  });
  return {
    async session(req,res) { const {data,error}=await client(req,res).auth.getUser(); if(error||!data.user)return; return members.resolve(data.user.id,verifiedGoogleEmail(data.user)); },
    async login(req,res) {
      const {data,error}=await client(req,res).auth.signInWithOAuth({provider:'google',options:{redirectTo:`${config.origin}/api/auth/callback`,skipBrowserRedirect:true,queryParams:{prompt:'select_account'}}});
      if(error||!data.url)throw new DomainError('Google sign-in is unavailable. Contact the administrator.',503);
      res.redirect(data.url);
    },
    async callback(req,res) {
      if(typeof req.query.code!=='string'||req.query.code.length>2048)throw new DomainError('Sign-in link is invalid. Try Google sign-in again.',400);
      const {error}=await client(req,res).auth.exchangeCodeForSession(req.query.code);
      if(error)throw new DomainError('Sign-in expired or could not be verified. Try again.',401);
      res.redirect(config.origin);
    },
    async logout(req,res) { await client(req,res).auth.signOut({scope:'local'});res.json({ok:true}); }
  };
}
