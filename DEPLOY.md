# Deploy on the BYU Racing Vercel account

If the login screen says **"Sign-in is temporarily unavailable"** or the API returns 503, the Vercel project is missing settings. Vercel → Logs shows which one: `Inventory setup incomplete: <NAME> is required.`

## 1. Import the repo

Vercel (team account) → Add New → Project → import `hcannonr/byu-racing-inventory`. Framework: Vite (picked up from `vercel.json`). Node 22. Leave build settings alone.

## 2. Add environment variables (Production only)

Names and notes are in [.env.example](.env.example). Copy values from the club admin's private settings. Do not add them to Preview.

| Name | Where it comes from |
| --- | --- |
| `INVENTORY_APP_ORIGIN` | The team project's URL, e.g. `https://byu-racing-inventory-team.vercel.app`. No trailing slash. |
| `INVENTORY_DATABASE_URL` | Supabase restricted `racing_app` connection string |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API |
| `INVENTORY_BOOTSTRAP_ADMIN_EMAIL` | First admin's email |
| `INVENTORY_JOB_SECRET` | Same value as the current live site, so printed labels keep working |
| `RESEND_API_KEY`, `INVENTORY_EMAIL_FROM` | Optional, buyer emails |

Then **Redeploy** (env changes only apply to new deployments).

## 3. Tell Supabase about the new address

Supabase → Authentication → URL Configuration:
- **Site URL**: the new origin.
- **Redirect URLs**: add `https://<new-origin>/api/auth/callback`.

Google and Microsoft sign-in don't need changes. They redirect to Supabase's own callback, not the app.

## 4. Point the scheduled job at the new site

Supabase → SQL editor, as admin: update the `racing-worker` cron job so it calls `https://<new-origin>/api/jobs/run` instead of the old URL. It sends the morning email summary and retries.

## 5. Check it

- Open the new URL, sign in with Google, land in the app.
- Scan one printed QR label. Labels point at the old address. Reprint labels from the new site once it's the main one.

## Database setup (new Supabase project only)

Skip if reusing the existing Supabase project. Otherwise create the `racing_app` role, then run `node --env-file=<admin env> --import tsx scripts/create-live-table.ts` with `INVENTORY_ADMIN_DATABASE_URL` set.
