export interface DeployedConfig { mode: 'deployed'; origin: string; databaseUrl: string; supabaseUrl: string; publishableKey: string; secretKey: string; adminEmail: string; jobSecret: string }
export function readRuntimeConfig(env: NodeJS.ProcessEnv): { mode: 'local' } | DeployedConfig {
  if (env.VERCEL && env.INVENTORY_MODE === 'local') throw new Error('Vercel cannot run in local mode.');
  if (!env.VERCEL && env.INVENTORY_MODE !== 'deployed') return { mode: 'local' };
  const get = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required.`); return value; };
  const origin = new URL(get('INVENTORY_APP_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('An exact HTTPS origin is required.');
  const jobSecret = get('INVENTORY_JOB_SECRET');
  if (jobSecret.length < 32) throw new Error('A job secret of at least 32 characters is required.');
  const supabaseUrl = new URL(get('SUPABASE_URL'));
  if (supabaseUrl.protocol !== 'https:') throw new Error('HTTPS Supabase URL required.');
  return { mode: 'deployed', origin: origin.origin, databaseUrl: get('INVENTORY_DATABASE_URL'), supabaseUrl: supabaseUrl.origin, publishableKey: get('SUPABASE_PUBLISHABLE_KEY'), secretKey: get('SUPABASE_SECRET_KEY'), adminEmail: get('INVENTORY_BOOTSTRAP_ADMIN_EMAIL').toLowerCase(), jobSecret };
}
