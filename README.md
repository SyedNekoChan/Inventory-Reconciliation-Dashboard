# Inventory Reconciliation Dashboard

Internal tool for reconciling the **Sonic** master inventory against Amazon and
Newegg marketplace listings.

It is a static, browser-only application. There is no backend, no account
system and no marketplace API integration: all data arrives through manual
Excel/CSV uploads and is stored locally in the browser using IndexedDB.

---

## How it works

1. **Settings** — add the marketplace accounts you import for (Amazon, Newegg;
   several accounts/platforms per marketplace are supported).
2. **Imports** — upload the Sonic master inventory file, then each marketplace
   export. Choose the worksheet, header row and the exact columns to use, review
   the preview, then commit.
3. **SKU Mapping** — link marketplace listings to Sonic master SKUs. One master
   SKU can carry many listings. Only exact matches are approved automatically;
   everything else waits for your approval.
4. **Reconciliation** — compare Sonic quantities against the mapped listings and
   review the discrepancies it finds.
5. **Overview** — current inventory health, the highest-priority discrepancies,
   per-account health, and the discrepancy trend over time.

---

## Data handling rules

These are enforced by the application, not just conventions:

| Rule | Behaviour |
|---|---|
| Repeated imports never duplicate | Sonic records key on the master SKU; listings key on `marketplace + account + complete marketplace SKU`. Re-importing the same file updates in place. |
| Missing rows are never deletions | A **full snapshot** flags absent records as out-of-snapshot and keeps their last known quantity. An **incremental** import leaves absent records completely untouched. Nothing is ever hard-deleted by an import. |
| Missing data is never zero | An empty or unreadable quantity is stored as *unknown* and displayed as such. It is never silently converted to 0. |
| Marketplace SKUs stay intact | Suffixes (`_1`, `_02`, `_2A`, …) are preserved exactly. Normalization is used only to *find* matches, never to rewrite a stored value. |
| Approved mappings are never overwritten | Re-running match generation skips any listing you have approved or rejected. |
| Fulfillment is never guessed | Unrecognized fulfillment values are flagged for review rather than assumed. |
| Pools are not mixed | Marketplace-fulfilled stock (FBA, Shipped by Newegg) is tracked separately and never compared against Sonic warehouse stock. |

### Quantity column selection

Marketplace exports carry several non-interchangeable quantity columns
(available, reserved, inbound, unfulfillable, total). The importer ranks them,
explicitly demotes reserved/inbound/unfulfillable so they are never
auto-selected, shows which column it chose, lists the alternatives, and lets you
override. The chosen column is recorded with the import and shown on each
listing.

---

## Discrepancy priorities

**Priority 0 (critical)** — the oversell cases:

- A master SKU is absent from the latest completed **full** Sonic snapshot while
  a mapped seller-fulfilled listing still shows positive quantity.
- Sonic quantity is **0** while a mapped seller-fulfilled listing still shows
  positive quantity.

Also detected: quantity mismatch against the allocation policy, listing at zero
while Sonic has stock, unmapped listings, inactive listings, allocation
exceeding available stock, possible duplicate listings, missing quantity data,
and unknown fulfillment.

Discrepancies are **historical records**. Each keeps its first-seen date, last
seen date, resolution date and reopen count. A new reconciliation run updates
them — it does not wipe the history.

### Allocation policies

How Sonic stock is expected to be spread across the seller-fulfilled listings of
one master SKU: full quantity on every listing (default), split evenly, a fixed
quantity, or a percentage. Configurable globally, per account, and per mapping.

---

## Local data, backups and limits

All data lives in **this browser on this computer**. It is not synchronized
between machines, and each computer has its own independent dataset.

- **Export Backup** writes the whole dataset to a JSON file with a schema
  version. Use it regularly.
- **Restore Backup** validates structure and version, previews the record
  counts, and asks whether to replace or merge. A malformed backup is rejected
  without touching existing data.
- **Clear All Data** permanently deletes every stored record. It requires an
  acknowledgement *and* typing `DELETE ALL DATA`.

Clearing your browser's site data for this origin deletes the dataset. Export a
backup first.

---

## Development

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

```bash
npx tsc -b
```

By default the build targets the GitHub Pages path
`/Inventory-Reconciliation-Dashboard/`. To build for a different path:

```bash
BASE_PATH=/ npm run build
```

### Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Enable it once under **Settings → Pages →
Source → GitHub Actions**.

Routing uses `HashRouter`, because GitHub Pages serves static files only and
cannot rewrite deep links to `index.html`.

### Project layout

```
src/db/          Dexie schema, versioning, repositories
src/services/    workbook parsing, column detection, import engine,
                 mapping engine, reconciliation engine, backup
src/features/    per-area query layers (inventory, reconciliation,
                 mappings, dashboard)
src/components/  layout, UI primitives, icons, providers
src/pages/       one component per route
src/types/       domain models
src/utils/       SKU normalization and matching, formatting, hooks
```

Business logic lives in `src/services` and `src/db` and is independent of React,
so a shared backend could later be added behind the same interfaces.

### Performance

Verified in a headless browser with **98,000 Sonic SKUs**: ~34 s to commit the
import, ~30 MB JS heap, 50 table rows in the DOM at a time, sub-second indexed
SKU search. Inventory is paged from IndexedDB; the full dataset is never loaded
into React state.

### Privacy

The application makes **no network requests at runtime** — no CDN, no webfont,
no API. It works offline. Operational data never leaves the computer, and
uploaded spreadsheets and backups are excluded from version control via
`.gitignore`.

---

## Not implemented (deliberately)

Amazon SP-API / Newegg API integration, automatic marketplace synchronization,
inventory writeback, a shared backend or database, user accounts and role-based
permissions. The architecture leaves room for these; none of them are stubbed,
mocked or faked anywhere in the UI.
