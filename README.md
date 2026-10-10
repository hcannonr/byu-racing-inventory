# BYU Racing workshop inventory

A working local prototype for testing the two-bin replenishment workflow. Buyer dashboard, catalog, scan simulator, purchasing, partial deliveries, refill confirmation, activity log, and configurable buyer email. Sample and simulator data remain practice. The app records purchases locally. Email is off until a server sender and recipient are configured and a buyer explicitly enables it; a test email also requires its own explicit action.

## Run on Windows

Requires Node.js 22.16 or newer (tested with 22.23.1). From PowerShell:

```powershell
Set-Location 'C:\Users\Rylek\OneDrive\Desktop\RylekSecondBrain\projects\byu-racing-inventory\app'
npm.cmd ci
npm.cmd run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Keep the terminal running; Ctrl+C stops the app. If dependencies are already installed, only `npm.cmd run dev` is needed.

To run the built version:

```powershell
npm.cmd run build
npm.cmd start
```

The server listens only on this computer. The workshop's automatic Windows scanner service is not installed by these commands. Do not expose this unauthenticated test server to the internet.

## Dashboard

**Today** is the home screen. **Needs attention today** lists one row per part with any applicable reasons: both bins empty, uncovered purchasing quantity, overdue purchases, carrier-delivered purchases needing receipt confirmation, and received stock ready for physical refill. Completely empty parts appear first. Its next-action button opens the existing purchase, receipt, refill, or review flow. The count is affected parts, not duplicate tasks.

Overdue means outstanding units remain after the expected calendar date. A valid carrier ETA takes precedence over the buyer's saved date; missing or invalid carrier dates fall back to that saved date. Due-today purchases are not overdue. Carrier delivery creates a receipt-confirmation task and never records received units or refills a bin. Partial receipts become refill-ready only when enough unallocated stock is physically received for one full bin. Undone purchases are excluded. Tasks update after saves and the existing 2.5-second refresh.

**Inventory** remains a separate tab with visual two-bin cards and one next-action button. Filters show parts to order, on the way, ready to refill, or completely empty. Order hub has To buy, Purchased, and Ready to refill views. **More** contains history, buyer alerts, export, help, and reset. Optional order details and part history expand only when needed.

Each part overview has a visible **Edit part** button for its name and catalog details, plus **Edit supplier** beside the supplier information. The supplier editor saves the name and exact product link, accepts unknown/blank fields, and preserves inventory/bin state. Saves retain the existing stale-revision and safe-retry protections.

## Part photos and cabinet diagram

- Open a part to **Choose a photo**. One JPEG, PNG or WebP can be uploaded, replaced or removed. The inventory thumbnail uses the uploaded photo; parts without one keep their category illustration. Sample parts remain marked sample even after a photo upload.
- Photos must be at most 5 MB, 24 megapixels and 8192 pixels per side. The server checks the actual type, rejects animation and malformed pixels, fully decodes the photo, normalizes orientation, strips metadata including GPS, and saves a WebP up to 1600 pixels per side. Exact errors appear beside the upload control.
- An unconfirmed upload keeps its original event ID, source hash and inventory revision for **Retry photo safely**. After a browser reload, an already attached photo is reconciled from saved state; otherwise **Reselect photo** requires the same bytes. Resolve the pending save before other inventory changes. Stale uploads cannot overwrite newer work.
- Open **More → Cabinet map**, then **Configure diagram**. The diagram starts unconfigured. Enter the actual drawer and compartment labels, assign existing location codes, and use the arrows to arrange them. No physical arrangement is inferred from the sample codes.
- Click an inventory location to highlight its drawer and compartment. Selecting a compartment shows its parts. On a phone, selection brings those parts into view; **Back to diagram** returns to the selected compartment. Unplaced locations remain accessible.
- Saving, moving or removing map assignments never changes stock, permanent bin IDs or practice status. A location can appear in only one compartment. Removing a drawer unplaces its locations.
- New photos and diagrams persist across restarts without resetting older databases. JSON export includes media IDs and map data, but excludes image bytes. A complete SQLite database backup includes the separate `part_media` table. Removed/replaced image bytes remain in that table for local recovery; only currently attached photos are served. Reset demo clears map/photo attachments with the sample catalog, but does not purge retained media bytes.

## Buyer order hub

1. Open **Order hub → To buy**. Shopping lists group parts by supplier; completely empty parts appear first. Needed units subtract received parts and outstanding purchases from the empty-bin refill target. Supplier names group without case or surrounding-space differences; missing suppliers appear under **Supplier needed**.
2. Use **Add supplier link** or its edit button to save the verified product page, optional units per pack, and estimated USD price per pack. **Open supplier** opens that link in a new tab and does not record a purchase. Pack suggestions round upward: 60 needed in packs of 25 suggests three packs, 75 units, and 15 extra. Unknown pack sizes/prices stay visible; merchandise estimates exclude shipping and tax.
3. After external checkout, return and click the supplier's **Confirm checkout**. Select the purchased parts, confirm actual individual-unit quantities, and record the actual supplier, optional arrival date, and order number. **Record checkout** saves every selected part together; a conflict or invalid line saves none. You can also use a part's **Mark purchased** for a single purchase. Neither action submits an order to the supplier.
4. Use **Purchased → Track delivery** for shipment and receipt updates. Purchase history remains visible after a request closes.
5. Use **Ready to refill** after recording delivery. Confirm the physical refill to restore bin availability.

Sample parts have no verified product links. Add real product URLs after the engineering team confirms their specifications. An additional empty bin or an insufficient purchase can leave a remaining quantity in To buy; the app never makes a second purchase automatically. Purchase and supplier forms capture the inventory revision when opened, preventing an older form from overwriting a newer buyer action. Uncertain saves use the same command ID on retry.

Shopping subtotals include only known pack prices and are labeled incomplete when any price is missing. Searching limits groups, subtotals, and checkout review to matching parts. The checkout can use an alternate supplier without changing catalog supplier details. Historical orders retain their pack/price snapshots and a shared checkout ID; later catalog edits cannot rewrite them. Old databases and single-part purchases remain supported without reset. Clearing units per pack removes that part's pack settings; other catalog edits preserve them.

## AI-assisted order entry

**Order hub → Import order** accepts PDF, JPEG/PNG/WebP, or pasted confirmation text. Extraction creates an uncommitted draft. The buyer selects exact existing parts, reviews packs-to-units and invoice price/currency, excludes unrelated lines, and explicitly confirms one atomic purchase. Repeated source rows for the same part need a deliberate combination check. Original documents/text are transient; confirmed purchases retain reviewed fields and source provenance.

The server-only OpenAI Responses adapter defaults to `gpt-5-mini`; set `OPENAI_API_KEY` and optionally `OPENAI_ORDER_MODEL`, then restart. Missing configuration is shown explicitly. All provider verification so far is mocked; no real document was sent. Durable source/reference checks prevent duplicate imports, including after undo/reset/restart. Actual decimal invoice prices remain separate from estimated USD catalog prices. See [setup, review, duplicate handling and retention details](../order-import-setup-2026-10-05.md).

## Purchase corrections and package tracking

- **Purchased → Undo purchase** asks for confirmation and marks the purchase undone without deleting its history. It recalculates the amount to buy and preserves bin states. It does not cancel a supplier order. Any received quantity blocks undo. Old command retries cannot reactivate an undone purchase.
- **Add tracking** saves a carrier, tracking number, and optional tracking URL. UPS, FedEx, USPS, and DHL get a carrier link automatically; Other requires a link. A supplied http/https URL can override the default. Tracking is also accessible from the part dialog. Each purchase currently supports one tracking number; split-package tracking is a later enhancement.
- Tracking details are saved locally and **Track package** opens the carrier page. **Enable live delivery updates** opts a shipment into Ship24 registration and polling. Carrier status, an available ETA, recent events, and last checked time appear in the Order Hub. Received quantities and bins remain unchanged.
- Existing databases remain compatible: `voidedAt` and `tracking` are optional fields on purchase records. No reset or data migration is required.

### Ship24 live tracking

The server reads `SHIP24_API_KEY` from its environment, the app `.env`, or the workspace `.env`. Restart after editing the key. Enable live updates only for actual incoming shipments; registration uses the provider's shipment allowance. Existing practice records remain manual. A read-only authenticated request verified the key, without creating a tracker.

The running server polls every five minutes and caches results in a separate SQLite table. Matching carrier/number pairs share a tracker; retries preserve the registration payload. Manual checks are limited to once per minute. Carrier status never updates received units or refills bins. Production webhooks and a real-shipment comparison remain pending. See [setup and operating details](../tracking-setup-2026-10-05.md).

## Safe inventory corrections

Open **More → Activity log**, or a part's **Part details & history**. Review **Correct scan**, **Correct receipt**, or **Undo refill**, enter a reason, and confirm the physical check. The original activity remains unchanged and a linked correction is added.

- An accidental scan restores the recorded prior bin roles. Independent later purchases, receipts and tracking remain recorded. A later scan, refill, correction, or capacity/unit/specification change requires a physical recount.
- A receipt correction replaces that delivery's quantity, including zero for a delivery that never arrived. It respects purchase limits and part-wide loose stock. A newer receipt on the same purchase or a later physical refill blocks correction. Independent other-purchase receipts and scans can remain when the accounting is valid.
- Undo refill returns its recorded allocation to loose stock and marks the bin empty. Confirm that the physical refill never happened, or every part was returned unused. Used, lost or mixed stock requires a recount. Reopened requests remain actionable.
- Legacy activity without structured stock evidence cannot be reversed automatically. A full physical-recount workflow remains future work. The blocked dialog explains which dependent activity prevents reversal.

Bin cycles advance after scan/refill reversal so old scanner retries and refill confirmations cannot reapply. Review dialogs preserve typed fields when inventory changes, require an explicit review of the current state, and retry uncertain saves with the original command ID. Polling-confirmed corrections explain that the correction is already recorded.

Practice clears only after an operational physical confirmation with recorded prior clean stock and no intervening practice contamination. Sample and unknown stock remain practice. Obsolete unsent emails cancel transactionally; accepted or in-flight email cannot be recalled. Remaining operational demand gets a fresh reminder schedule after the configured interval, preserving accepted-email cooldown even across delayed acceptance or purchase undo. Corrections never replay old previews or immediately send email. Original previews show **Superseded by correction** and no longer contribute to the unread badge.

New part events carry versioned before/after stock evidence, original command/revision/provenance, quantities and entity IDs. Closed-request snapshots retain their allocations and closing time. Corrections link to the original event. This supports analytics without parsing messages or treating practice as actual workshop use. See the exact shared contract in [the coordination ledger](../expansion-coordination-2026-10-05.md).

## Evidence-based bin targets

Open a part to see **Bin-size suggestions**. The panel shows eligible cycle/purchase/timeline counts, missing evidence, observed ranges and exclusions. Sample, simulator, practice, unknown-origin and legacy records never support a stock recommendation. The existing local practice catalog will stay in Learning until real eligible records exist. Synthetic tests and the disposable screenshot fixture demonstrate the proposal flow; they are not workshop measurements.

A consumption cycle starts when a bin with a recorded physical refill becomes in use, and ends at its empty scan. Its quantity comes from that refill allocation. Reserve waiting, unknown initial fills, both-empty gaps and incomplete cycles do not count. Corrections invalidate affected request periods and active spans. Capacity, unit or specification edits start a fresh learning period; later unstructured catalog edits also censor older evidence.

At least **three full active cycles**, **three purchases with complete physical receipts**, and a usable complete request timeline are required. A complete timeline links its first empty scan, first purchase, final receipts and a subsequent physical refill. Missing links, backward receipt timestamps, incomplete orders and refills before final receipts are excluded. Carrier-delivered status and buyer ETA do not supply actual receipt timing.

The proposed amount is `ceil(fastest observed cycle use per day × slowest complete replenishment days × 1.25)`. Purchasing, receipt and refill delays appear separately in **Evidence & calculation**. **Limited history** describes observed records, not a confidence percentage or a guarantee about future use. The feature suggests increases and leaves adequate current targets unchanged.

**Review new target** is available only after the active request closes. Confirm that the physical bins can hold the proposed amount, then choose **Apply future target**. The existing edit command saves only the future refill target, preserving bin states, photo/practice flags and pack metadata. Existing contents remain unchanged. The review captures its inventory revision; concurrent changes reject the save, and an uncertain reply retries the same command safely. New verified refills begin the next learning period.

## Try the workflow

1. Open **Test a scan** or **Simulate a scan**.
2. Select **Hex bolts** and scan bin 1. Bin 1 becomes Empty and bin 2 becomes In use. Scan again to verify no duplicate request.
3. Click **Manage this part**, then **Record order**. This records a purchase you are simulating; it does not place an order with a supplier.
4. Mark the order in transit, then **Record arrival**. Receive 20 of the 50 example units. The bin remains empty and cannot yet be confirmed full.
5. Record the remaining 30. Click **Confirm refill**, then **Yes, bin is refilled**. Bin 1 becomes reserve and the request closes.
6. Open **More** for **Activity log** and **Buyer alerts**. Practice previews remain separate from delivery history.

Other useful tests:

- Empty both bins: the same request escalates to out of stock.
- Receive more than one bin's target: unallocated receipts remain available for subsequent cycles of that part.
- Open two tabs: saved changes refresh every 2.5 seconds. Old catalog forms cannot overwrite newer edits.
- Enter an unknown bin code: no stock changes.
- Add a part: confirm both bins begin stocked, then test its two new codes. Use only sample data until an engineer verifies the catalog.
- Export records before using **Reset demo**. Reset returns all eight example parts to stocked status and clears this app's added parts and workflow records. It does not restore the initial mix of demonstration orders.

Browser sound is best effort and begins only after a user gesture. A green saved message always accompanies success. This does not verify that a physical scanner can emit a server-confirmed beep.

## Printable bin labels

Open **More → Print bin labels**. Choose Letter or A4 paper, then QR (default) or Code 128. Select either bin individually or **Select shown** to select both bins for every visible part. Filtering keeps earlier selections; the paper preview includes all selected bins. **Clear selection** clears the complete selection.

Labels display **Bin A / Bin 1** and **Bin B / Bin 2**, while encoding the exact existing permanent ID ending in `-1` or `-2`. QR and Code 128 contain the same plain ID. Neither includes a URL, mutable stock status, nor cycle number. Labels show the full part name/specification, location, readable ID, and **Scan when empty**. Example catalog records retain a **SAMPLE** mark.

QR labels are 89 mm wide, two per row. Code 128 uses a 184 mm wide label to accommodate long IDs. Label height grows for full specifications. The preview measures actual rows and places complete rows on Letter/A4 sheets with 10 mm internal margins; print uses the same label markup and geometry. Print at **100% scale**, choose the matching paper size, and disable browser headers/footers. Cut along the outlines. Selecting, previewing, and printing never changes inventory.

The SVG encoder is `@bwip-js/generic`; independent `zxing-wasm` tests decode its rasterized output at 300 dpi, including 32-character IDs, and check quiet borders. This proves encoding and software geometry. Native print-dialog output, physical paper dimensions, adhesion, dirty-workshop durability, and the selected scanner still require a real printer/scanner pilot. Use the printed label's readable ID to recover if a code cannot be scanned.

## Saved data

SQLite database: `data/inventory.sqlite` (ignored by Git). The initial launch seeds eight example parts, four open requests, and sample orders at different stages. Refreshing or restarting does not reset data. Fonts are bundled locally.

The app uses a typed aggregate in a transactionally updated SQLite row plus an idempotency table. This keeps the local prototype simple while protecting command/event uniqueness. Closing the server before copying its database is the simplest complete local backup; while running, SQLite may also have WAL/SHM files. JSON export is a readable snapshot; an import/restore UI has not been built.

The containing workspace is inside OneDrive. For a real workshop installation, move the live database to a non-synced local path via `INVENTORY_DB` or use the intended hosted database. Do not run simultaneous instances against a OneDrive-synced copy.

## Buyer email

Open **More → Buyer alerts** for email status, recipient and enable/pause controls. Email settings, delivery history, scan previews and alert rules start collapsed. Expand **Email settings** to change the recipient or reminder frequency, or preview a test email. API keys, sender identity and the dashboard link belong in administrator setup and are absent from the buyer page; saving buyer settings preserves the configured dashboard link. No sender or buyer address is assumed. Changing the recipient disables automatic delivery and cancels unsent operational messages to the old address; old previews are never backfilled.

The SQLite outbox commits with the scan. The running server processes it every 15 seconds. Retry payloads and provider idempotency keys remain unchanged once attempted. Temporary outages do not block stock saves. Uncertain attempts stop for review after 23 hours, before Resend's 24-hour deduplication window ends. **Accepted for sending** does not prove inbox delivery. Explicit test emails work while automatic delivery is paused, but require setup and their own send action.

Reminders run no more often than the chosen 24–168-hour interval, measured from the latest accepted notice. Acknowledgement snoozes the current attention episode for one day. Partial purchases leave demand active; sufficient purchases stop buying reminders. Both bins empty creates a fresh urgent episode, including a one-time notice when purchases already cover demand. Missed intervals do not create a catch-up burst.

Practice/seed/simulator/sample activity is ineligible for automatic email. Practice stock remains marked after request closure; old stock with unknown provenance also remains ineligible. A test scan of a real catalog part requires a safe physically verified correction with prior clean evidence, or a physical recount before operational email can resume. A full recount UI remains pending. Newly added parts confirmed stocked by a buyer start operationally eligible; scans still must come from an operational scanner/buyer source. The simulator always marks its scans as practice.

See [email setup and operating details](../notification-setup-2026-10-05.md). No credentials or real deliveries were used during verification. The provider adapter and reliability checks use mocked responses. Cloud scheduling, authenticated station provenance, and actual inbox verification remain rollout work. The JSON inventory export excludes email settings/outbox history; a complete SQLite backup includes them.

## Code map

| Location | Responsibility |
|---|---|
| `shared/types.ts` | Data contracts, request status, received-stock availability |
| `shared/attention.ts` | Today's buyer work, overdue calendar dates, actionable priority |
| `server/domain.ts` | Inventory transitions and invariants |
| `shared/corrections.ts` | Structured event evidence, correction eligibility and superseded alert derivation |
| `server/validation.ts` | Input validation |
| `server/store.ts` | SQLite transactions, deduplication, initial seed |
| `shared/notifications.ts` | Email settings, job and transport contracts |
| `server/notificationQueue.ts` | Durable outbox, settings, claims, reminders and revalidation |
| `server/notifications.ts`, `server/emailTransport.ts` | Worker and server-only Resend adapter |
| `src/components/NotificationsView.tsx` | Setup, explicit test, delivery history and review controls |
| `server/http.ts` | Local HTTP API and request checks |
| `server/index.ts` | Server and frontend startup |
| `src/App.tsx` | Buyer views, simulator, polling, safe retries |
| `src/components/` | Forms, part drawer, bin illustrations, dialogs |
| `tests/` | Domain, persistence, HTTP, and jsdom UI integration tests |

API: `GET /api/state`, `POST /api/commands`, `GET /api/export`, `GET /api/health`, `GET /api/notifications`, `POST /api/notifications/commands`. Inventory commands have a UUID `eventId`, an action, optional provenance and optional `expectedRevision`. Missing provenance defaults to demo. Scan and refill actions include the bin's `cycle`. Native hardware integration must preserve the event ID, provenance and captured cycle on retries. Do not fetch a new cycle for a queued old scan. Email settings/test/retry commands use a separate UUID and required email-settings revision; uncertain retries reuse the same complete command.

## Verification

October 8 production update: [the live club app](https://byu-racing-inventory.vercel.app) uses Google sign-in, approved-member roles, private PostgreSQL storage and scheduled workers. All 165 tests pass. Real Google administrator login, cloud transactions, private uploads and scheduled worker calls were verified. The [production runbook](../deployment-runbook.md) supersedes the older deployment checklist below. Real scanner and provider delivery still require setup.

```powershell
npm.cmd test
npm.cmd run build
```

October 5 final integration: **147/147 tests passed** in both the feature owner's and coordinator's independent full-suite runs. TypeScript and the Vite production build passed. The build reports a non-blocking bundle-size warning.

Coverage includes the complete scan-to-purchase-to-partial-receipt-to-physical-refill workflow; supplier batching and pack quantities; stale revisions, atomic rejection, persistence and same-ID recovery; email practice isolation and reminder scheduling; validated photos and cabinet mapping; independently decoded QR/Code 128 labels; audited corrections; conservative sizing evidence; and reviewed PDF/image/text import with persistent duplicate protection. A separate reviewer also exercised mixed operational/practice grouped purchases, corrected receipts, retained shipment history, refill closure and surplus reuse against an isolated database. No material review findings remain.

Every feature received desktop/390px phone screenshot inspection and revision where needed. The final import loop fixed native dialog scrolling and validation visibility; a held-save regression verifies closing a submitted review preserves safe retry. Evidence, individual review records and screenshots are linked from the [coordination ledger](../expansion-coordination-2026-10-05.md).

The local server was restarted after a complete SQLite/WAL/SHM backup. Revision 20, all 9 parts, 7 requests, 5 orders, events and alert records match the pre-restart inventory exactly. Email and AI extraction correctly report missing setup. Provider tests used mocked responses; actual email delivery, live AI extraction, physical printing/scanning and production rollout remain unverified.

## Before workshop rollout

See the [shipment tracking setup guide](../tracking-setup-2026-10-05.md) for Ship24's free pilot and EasyPost setup. Ship24 now supports opt-in live updates through server polling every five minutes while running. The API key was authenticated; registration and delivery behavior were verified with mocked responses, not a real shipment. Public webhooks and production deployment remain pending.

The bin and part illustrations are generated Higgsfield assets, displayed from a shared local image sheet. See [asset provenance](public/icons/README.md). Generation used the existing API key with $0.29 in total quotes; no credential or image-generation service is included in the running app.

- Confirm actual parts, units, bin targets, suppliers, and buyer ownership.
- Select and verify the wireless scanner and Windows receiver/service, including real sound, startup, reconnect, sleep, and cabinet range.
- Add production authentication/roles and station credentials. Local buyer access is not authentication.
- Select hosted database and deployable API architecture. SQLite on a local filesystem is not the production storage design for Vercel.
- Configure a club-owned verified email sender and recipient, explicitly test inbox delivery, and choose hosted scheduling/receipt monitoring. The durable local email adapter is implemented and tested with mocked responses; SMS is not connected.
- Add full physical-recount reconciliation and real supplier cancellation handling, partial physical refills, backup restoration, and operational handover before relying on the system for real stock.
- Perform a workshop pilot and verify sound, keyboard focus, and hardware timing. No two-second hardware result has been measured.
