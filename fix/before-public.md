# Before Going Public — Known Issues / Polish

Items that are known but deferred. Address before a public launch.

---

## Network Map

### Node sizing at extremes
- **Status:** Shipped a working fix (log2 absolute scale, canvas-relative %)
- **Remaining concern:** At very high audit counts (500+) nodes hit the 15% cap and stop growing. Fine for now, but consider a secondary visual cue (e.g. glow, badge count) for outlier hubs so the cap doesn't hide real differences.
- **File:** `docs/network.js` — `baseR`, `stepR`, `capR` constants

### Live dot (SSE)
- **Status:** Fix committed, not yet deployed at time of writing
- **Issue:** `sse.py` used `str | None` (Python 3.10+ syntax) — crashes on Railway's Python 3.9. Fixed with `Optional[str]`.
- **File:** `agentid-pro/sse.py`

---

## Dashboard

### Audit log / network graph "error" state
- **Status:** Fixed (deployed)
- **Root causes fixed:**
  1. `exports.py` SELECT missing `al.` alias → Postgres rejected every query
  2. `audit_log.owner` backfill may have timed out → fallback OR JOIN added
  3. `db.py` Python 3.9 `|` union syntax crashed the whole app on startup

### Auto-logout on page reload
- **Status:** Mitigated (session cache added — 30s TTL)
- **Remaining concern:** If the DB is slow for >30s on startup, users can still be logged out. A more robust fix would be to extend TTL or persist session state differently.
- **File:** `agentid-pro/accounts.py` — `_SESSION_CACHE_TTL`

### isPro() / dashboard pro sections
- **Status:** Fix planned, not yet applied
- **Issue:** `GET /auth/me` returns `users.tier` which defaults to `"free"` even when the user has a pro API key. `isPro()` returns false, so all pro dashboard sections stay on "Loading..." forever for session-auth users.
- **Fix:** Update `/auth/me` to return the effective best tier across `users.tier` and all `api_keys` owned by that user.
- **File:** `agentid-pro/accounts.py` — `me()` endpoint (~line 403)
- **Plan:** `.claude/plans/cryptic-singing-gray.md`

---

## Infrastructure

### Health check
- **Status:** Fixed (returns 503 on DB failure so Railway fails bad deploys)
- **Note:** Endpoint intentionally does NOT crash the process — only fails the deploy gate.

### Python 3.9 compatibility
- **Status:** Ongoing — Railway runs Python 3.9, code was written with 3.10+ syntax in several places
- **Fixed files:** `db.py`, `sse.py`, `accounts.py`
- **Action:** Before adding new endpoints, always use `Optional[X]` from `typing` instead of `X | None`
