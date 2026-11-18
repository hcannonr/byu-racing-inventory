# BYU Racing Shop Inventory (v2, one bin)

Demo-ready rebuild, November 4, 2026. One bin per part. When a bin drops to its low line, someone scans the label with any phone camera. The part shows up on the Restock board. Buyer marks it ordered, then restocked.

Stocked → **scan** → Low → **Mark ordered** → Ordered → **Restocked** → Stocked

Parts belong to a **team** (General, Electrical, Suspension, Powertrain, Chassis) and a **storage spot** (Blue cabinet, Gray cabinet, Wiring wall, plus a drawer). General holds parts every team uses. Teams and storage are editable on Setup.

## Who can do what

| Role | Sees | Can do |
| --- | --- | --- |
| Admin | Every team | Everything: parts, People, Buyer alerts, Setup |
| Team lead | Their team + General | Add and update parts there. Approve people who ask to join their team |
| Member | Their team + General | Add and update parts there |

New people open `/join` (the Invite link on People), pick their team, and land in **Waiting for approval**. The server enforces every rule, not just the screen.

**Buyer alerts** (admin): the business team's emails, Right away or Morning summary, pause, and a test email. A low scan creates the email. This demo build shows emails in Recent emails instead of sending them; the live app sends them.

**Demo sign-in:** the account menu (top right) switches between sample accounts so the video can show each role. The live app uses Google sign-in instead. Sample emails end in `.example` on purpose.

## Run it

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:4330. Data lives in `data/inventory.json`. Teams & storage → **Reset demo** puts the sample shop back.

**Real phone scanning:** run `npm.cmd run dev:phone` instead. Labels then point at this computer's Wi-Fi address, so a phone on the same Wi-Fi can scan them. Windows may ask to allow Node through the firewall. This exposes the app to your local network with no sign-in, so only use it for the demo.

Checks: `npm.cmd test`, `npm.cmd run check`, `npm.cmd run build`.

## Live mode

`api/index.ts` runs the same app on Vercel with Google sign-in (Supabase), Postgres (`racing.app_state`), signed label links, and Resend email. The demo account switcher, Try a scan, and Reset demo are hidden there. Setup on the club Vercel account: [DEPLOY.md](DEPLOY.md).

## What's different from `../app`

`../app` is the live two-bin version (Google sign-in, Supabase, Vercel). It is untouched. v2 is a clean, much smaller build for the team-lead demo: no sign-in, local JSON storage, no email, no AI order import, no shipment tracking. If the leads like it, the next step is moving v2 onto the existing sign-in and database.

## Demo video script (about 3 minutes)

1. **Restock board (30s).** "This is what the buyer sees. Five bins are low, three orders are on the way." Click a team chip to show the board filtered to just Electrical.
2. **The scan (40s).** Open Parts, click **Hex bolts**, click **Try a scan**. "An engineer sees the bin hit the red line, points their phone at the label, done. No app, no login." Close the phone. The card flashes onto Restock and a red "scanned low" banner pops up.
3. **Ordering (30s).** On Hex bolts, click **Mark ordered**, type "arrives Tuesday", confirm. It moves to On the way. Then click **Restocked** on another part to close the loop.
4. **Adding a part (40s).** Click **Add part**. Name, size, pick the team, pick the cabinet, type the drawer, Save. Show the label preview, click **Print label**. "Tape it on the bin right at the low line."
5. **Buyer alerts (20s).** Open Alerts, expand the newest email. "The business team gets this the second a bin is scanned."
6. **People (30s).** Open People. Approve Tyler. Then account menu → Maya Chen: "A team lead only sees Electrical and General, and can approve her own team."
7. **Close (10s).** "Two seconds for an engineer, one list for the buyer, nothing runs out."

Before recording: switch back to Rylek Staker, Setup → Reset demo, then refresh the page.
