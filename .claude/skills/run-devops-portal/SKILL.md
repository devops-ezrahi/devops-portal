---
name: run-devops-portal
description: Run, start, launch, screenshot, or drive the devops-portal web app. Use when asked to start the portal, verify a UI change, take a screenshot, or test a feature in the browser.
---

DevOps Customer Portal is an Express + React + Vite web app. The agent path is a Playwright driver at `.claude/skills/run-devops-portal/driver.mjs` that launches a headless Chromium browser, navigates every module, creates a ticket, and saves screenshots. The dev server (`npm run dev`) must already be running.

## Prerequisites

Playwright's Chromium browser must be installed once:

```bash
node_modules/.bin/playwright install chromium
```

No additional OS packages are needed — Playwright Chromium Shell runs headless without a display.

## Build

```bash
npm install
npm run build   # type-check + vite bundle (catches TS errors before launch)
```

## Run (agent path)

Start the dev server (Express on :3001, Vite on :5174 — or :5173 if free):

```bash
npm run dev > /tmp/devops-portal-dev.log 2>&1 &
```

Wait ~3 s for both services to start, then run the driver:

```bash
node .claude/skills/run-devops-portal/driver.mjs [base-url] [screenshot-dir]
# defaults: http://localhost:5174  /tmp/portal-screenshots
```

The driver:
1. Walks every button in `nav.app-nav` — whatever modules are registered in
   `src/client/App.tsx` (currently Tickets, Artifactory, Whitening, AI).
   It reads the labels off the page, so adding a module needs no driver change.
2. Opens the "New" ticket modal, fills Name + Description, submits
3. Switches to Admin role and captures the queue view
4. Saves numbered PNGs to `screenshot-dir` and exits 0

Typical run: ~10 s, one screenshot per module plus four (home, modal, filled,
submitted) and a fifth if the Admin toggle is present.

Check which port Vite chose before running the driver:

```bash
grep "Local:" /tmp/devops-portal-dev.log
# → http://localhost:5174/
```

## Run (human path)

```bash
npm run dev
# Express → :3001, Vite → :5173 (or :5174)
# Open http://localhost:5173 in a browser
# Ctrl-C to stop
```

## Test

```bash
npm test       # vitest run — unit/integration tests, ~2 s
npm run build  # tsc --noEmit + vite build — catches type errors
```

## Gotchas

- **Playwright is CJS, not ESM.** `import { chromium } from 'playwright-core'` fails with "named export not found." The driver uses `createRequire` to load it as CommonJS. Don't change the import style.

- **Vite port collides to 5174.** If port 5173 is already in use, Vite silently increments to 5174. Always read the port from the log before pointing the driver at it.

- **Ticket form inputs have no `name` or `type` attributes.** Select them with bare `page.locator('input').first()` and `page.locator('textarea').first()`. Don't use `input[type="text"]` or `input[name="..."]`.

- **Submit button has no `type="submit"`.** It's `<button class="primary">Submit</button>`. Use `page.locator('button.primary', { hasText: /submit/i })`.

- **The ticket list starts empty.** Without Jira configured the server falls back to `InMemoryTicketingApi`, which seeds nothing — fixtures live in `modules/ticketing/__tests__/seedTickets.ts` and are only injected by tests. State is in-memory, so each `npm run dev` restart clears whatever the driver created.

- **The Test button on Artifactory / Whitening only exists in dev.** Both routers mount `POST /api/<module>/jobs/simulate` only when `SSO_REQUIRED` is not `true`, and the client renders the button only for the `dev` user. Job lists start empty; a run exists only once you press it.

- **`curl` is not available** in this environment. Use `node` + Playwright, or `fetch` via Node 20+ (`node -e "fetch(...).then(r => r.json()).then(console.log)"`), to probe the API.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chromium executable not found` | Run `node_modules/.bin/playwright install chromium` |
| `Cannot find module 'playwright-core'` | Run `npm install` from the project root |
| `Nav failed to render` | Dev server not ready — wait another 2–3 s and retry |
| Port 5173 refused | Vite chose 5174; check log and pass the correct URL to the driver |
