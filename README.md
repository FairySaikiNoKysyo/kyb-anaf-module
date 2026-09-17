# KYB module — Romanian company lookup via ANAF

Looks up a Romanian company by its tax number (CUI) through the public ANAF web service,
stores the result, and records every call as append-only audit evidence.

The assignment was a short brief: NestJS + TypeORM + PostgreSQL, look up a company by
CUI via ANAF, store it, handle "not found" and "service unavailable", at least one test,
backend only. Alongside it the client shared a broader KYB document — his research into
the domain, not the assignment. Where a choice below follows that document it is cited
as "KYB document §n"; this module is what its §12 calls Stage 1, item 1. It is written
with production concerns in mind (audit trail, rate limit, failure handling), and the
"Known limitations" section says where it still falls short of production.

---

## Quick start

Developed and verified on Node 24; Docker is used for PostgreSQL. Nothing Node-24-specific
is used and Node 20 LTS should work, but it has not been run.

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL 16
npm ci
npm run migration:run
npm run start:dev             # http://localhost:3000  (or: npm run build && npm run start:prod)
```

Run the tests — no database or network required:

```bash
npm test
```

### Check a company

```bash
curl -X POST http://localhost:3000/verifications \
  -H 'Content-Type: application/json' \
  -d '{"cui":"RO 14399840"}'
```

```json
{
  "id": "…",
  "status": "COMPLETED",
  "requestedCui": 14399840,
  "startedAt": "…",
  "finishedAt": "…",
  "message": null,
  "company": { "cui": 14399840, "name": "…", "isInactive": false, "…": "…" }
}
```

### Retrieve a verification with its audit trail

```bash
curl http://localhost:3000/verifications/<id>
```

Returns the case, the company if one was found, and snapshot **metadata**. Raw external
payloads stay in the database: they are evidence, not something to hand out over the API
by default.

```json
{
  "verification": { "id": "…", "requestedCui": 14399840, "companyId": "…", "status": "COMPLETED", "startedAt": "…", "finishedAt": "…", "note": null },
  "company": { "cui": 14399840, "name": "…", "isInactive": false, "…": "…" },
  "snapshots": [
    { "id": "…", "source": "ANAF", "requestedAt": "…", "success": true, "httpStatus": 200, "durationMs": 141, "queueWaitMs": 0, "attempt": 1 }
  ]
}
```

### Verification statuses

| Status | Meaning | HTTP on `POST` |
|---|---|---|
| `PENDING` | Inserted before the ANAF call starts; a case is only in this state while the lookup is in flight | — |
| `COMPLETED` | ANAF returned the company; the `Company` row is created or updated | 201 |
| `NOT_FOUND` | ANAF listed the CUI in `notFound`; no company row; operator message in `message` | 201 |
| `SOURCE_UNAVAILABLE` | Every attempt failed (timeout, network error, 5xx, 429, or a 404 without the ANAF envelope) | 201 |
| `INVALID_RESPONSE` | ANAF answered with a body that is not about this CUI or has an unexpected shape; not retried, a human must look | 201 |
| `INTERRUPTED` | Was still `PENDING` after `PENDING_TIMEOUT_MS`: the process died mid-check. Set by the reaper, never by the request path | — |

A malformed CUI is the only 400; nothing is persisted for it.

### Configuration

All values come from the environment (`.env` locally, see `.env.example`) and are
validated with zod at startup — the process refuses to boot on a bad value.

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `5432`, `kyb`, `kyb`, `kyb` | PostgreSQL (matches `docker-compose.yml`) |
| `ANAF_BASE_URL` | `https://webservicesp.anaf.ro/api/PlatitorTvaRest` | Service root |
| `ANAF_API_VERSION` | `v9` | Path segment; verified current on 2026-09-17 (`v10` does not exist) |
| `ANAF_TIMEOUT_MS` | `10000` | Per-attempt HTTP timeout |
| `ANAF_USER_AGENT` | `KYB-Module/1.0` | ANAF rejects empty or suspicious agents |
| `ANAF_MIN_INTERVAL_MS` | `1000` | Global spacing between outbound calls |
| `ANAF_MAX_RETRIES` | `3` | Attempts per lookup (1–10) |
| `PENDING_TIMEOUT_MS` | `300000` | A case still `PENDING` after this is marked `INTERRUPTED` |
| `REAPER_INTERVAL_MS` | `60000` | How often the reaper sweeps |
| `PORT` | `3000` | HTTP port |

---

## Design decisions

**"Not found" is a business result, not an error.** Verified against the live service:
ANAF answers an unknown CUI with **HTTP 404** and the normal envelope,
`{"found":[],"notFound":[<cui>]}` (a batch where at least one CUI exists comes back 200).
The client treats a 404 as a successful lookup only when that envelope is present; a 404
without it — what a wrong endpoint path returns — stays `SOURCE_UNAVAILABLE`, so a
misconfigured URL cannot report every company as not found. "This company is not in the
tax register" is an answer a KYB operator needs recorded, not an exception to swallow. It
maps to `VerificationStatus.NOT_FOUND`.

**A failed lookup still creates a verification.** The case is inserted as `PENDING`
before the lookup starts, so a crash mid-lookup leaves a record that says "unfinished"
rather than one claiming an outage. Such rows do not stay that way: `StaleVerificationReaper`
sweeps at startup and every `REAPER_INTERVAL_MS`, and marks any case still `PENDING`
after `PENDING_TIMEOUT_MS` (default 5 minutes) as `INTERRUPTED` with a note. It is a
plain `setInterval`, not a scheduler library — one query a minute needs no infrastructure.
When ANAF is unreachable the case ends as `SOURCE_UNAVAILABLE` and the operator can run
a new check later. The KYB document (§10) requires this, and the reasoning holds
independently: the obligation is to show that the check was attempted.

**All of those return HTTP 201, not 404 or 502.** The resource being created is the
*verification*, and it exists in every one of these cases. A 404 would claim it does not,
and would throw away the audit trail. Only a malformed CUI returns 400 — nothing was
checked and no record is worth keeping.

**Snapshots are append-only and include failures.** Every attempt — including each
retry — is stored with the raw response body, unmodified, in `jsonb`. `success` refers to
the HTTP call, so a `notFound` answer is `success: true`. Nothing in the codebase exposes
update or delete for `DataSnapshot`. A dossier that can be edited after the fact proves
nothing to a supervisory authority, which is the entire reason this entity exists. Be
clear about what that guarantee is today: a convention in the code, not a constraint in
the database — see "Known limitations".

**The rate limit is one shared limiter per process, not per user or per request.** The KYB
document says ANAF allows roughly one request per second and blocks clients that exceed
it; this module never exceeded it, so the blocking behaviour was not observed. That budget
belongs to the deployment, so `AnafRateLimiter` is a single instance shared by every
request in the process and serialises every outbound call, retries included. It is
in-process: running more than one instance of the service needs a distributed limiter
(see "What I would add next"). Each snapshot records how long the attempt waited for the
limiter (`queueWaitMs`) separately from the HTTP call itself (`durationMs`).

**Retries: up to 3 attempts — two waits of 1s and 2s — on timeouts, network errors, 5xx
and 429 only.** Other 4xx are not retried — they will not become successes. Neither is a schema mismatch: a
valid HTTP response of the wrong shape means the contract changed, and repeating the call
will not fix that.

**The external response is validated, but leniently.** The envelope is checked with zod;
the record itself is kept raw. Silently accepting a changed shape and writing garbage
into a compliance dossier is the failure that matters here, but so is refusing to work
because ANAF added a field.

**Every ANAF record field name lives in one file.** `src/anaf/anaf.mapper.ts` is the
only place that knows what `denumire` or `statusInactivi` means. The KYB document (§4.1)
explicitly warns that its field list is not authoritative and must be verified against
the live service, so adapting to a new ANAF version is a change to one file. (The
envelope keys — `found`, `notFound` — and the record's own `cui` are also read by
`anaf.schema.ts` and `anaf.client.ts`, which verify that the answer is about the CUI
that was asked for before the mapper sees it.) The live v9 service groups fields into
sub-objects (`date_generale.denumire`); the mapper also accepts the same names at the
top level as a defensive fallback, which is untested against any real source.

**The CUI control digit is a warning, never a blocker.** A bug in our own checksum would
reject valid companies and block real business; being wrong the other way costs one extra
call to a free service. The result is recorded on the verification and the lookup proceeds
regardless.

**Cache is deliberately not implemented.** The KYB document (§11) allows caching ANAF data for
up to 24 hours but requires a fresh call whenever a new verification is created — and
creating a verification is this module's only path. A cache here would be dead code. It
becomes relevant when preview and autocomplete arrive.

**Tests mock the HTTP layer with undici's `MockAgent`, not nock.** nock patches Node's
`http`/`https` modules, which global `fetch` does not go through — a nock-based suite
would quietly make real calls to ANAF. The client therefore imports `fetch` from `undici`
directly so the dispatcher can be replaced in tests. `disableNetConnect()` is always on:
any undeclared request fails the run.

---

## Mapping to the client's KYB document

The document is the client's research into the domain, not the assignment; this table
shows which of its points Stage 1 covers and where.

| § | Requirement | Where |
|---|---|---|
| §4.1 | POST, array body, CUI as a number without the `RO` prefix | `src/anaf/anaf.client.ts`, `src/cui/cui.util.ts` |
| §4.1 | Meaningful `User-Agent` (the document says ANAF rejects empty or suspicious ones; not tested here) | `src/anaf/anaf.client.ts`, `ANAF_USER_AGENT` |
| §4.1 | CUI not found → message to the operator, do not crash | `VerificationStatus.NOT_FOUND`, `NOT_FOUND_MESSAGE` |
| §4.1 | Service version and field names must be verifiable / replaceable | `ANAF_API_VERSION`, `src/anaf/anaf.mapper.ts` |
| §4.1 | `inactiv` flag is a critical risk marker | `Company.isInactive` (own column, not buried in the snapshot) |
| §5.1 | Company directory | `src/companies/company.entity.ts` |
| §5.2 | VerificationCase as the key entity | `src/verifications/verification-case.entity.ts` |
| §5.3 | Snapshot per external request, raw response, never modified | `src/verifications/data-snapshot.entity.ts` |
| §10 | Source unavailable → case is created and marked failed; the operator runs a new check | `VerificationStatus.SOURCE_UNAVAILABLE` |
| §10 | Failed requests stored too, as proof the attempt was made | `AnafClient.lookup` → `persistAttempt` |
| §10 | Up to 3 attempts with increasing backoff | `src/anaf/anaf.client.ts` |
| §10 | 1 request/second shared by all users — per process here, see Known limitations | `src/common/rate-limit/anaf-rate-limiter.ts` |
| §11 | Cache not used when creating a verification | not implemented — see Design decisions |
| §12 | Stage 1: ANAF + Company / VerificationCase / DataSnapshot | this module |

---

## Tests

44 cases across five suites, no infrastructure required. The ANAF fixtures in
`test/fixtures/` are real responses captured from the v9 service on 2026-09-17 (one
phone number blanked), not hand-written approximations.

| Area | Covered |
|---|---|
| Company found | company stored, case `COMPLETED`, snapshot `success: true` |
| Outbound request | body is `[{cui:number, data:YYYY-MM-DD}]`, no `RO` prefix, `User-Agent` sent |
| Pending state | case is `PENDING` with no `finishedAt` while the lookup is in flight |
| Not found | HTTP 404 + envelope listing the requested CUI → `NOT_FOUND`, no company row, operator message, verification still created |
| 404 without envelope | `SOURCE_UNAVAILABLE`, not mistaken for "not found", not retried |
| HTTP 500 | 3 attempts, **3** failed snapshots, `SOURCE_UNAVAILABLE`, raw body kept |
| Timeout | `SOURCE_UNAVAILABLE`, 3 attempts recorded, reported as a timeout |
| Wrong response shape | `INVALID_RESPONSE`, **not** retried, raw body kept |
| Answer about another CUI | envelope that lists the CUI neither as found nor as notFound, or a record for a different CUI → `INVALID_RESPONSE`, never `NOT_FOUND` |
| Inactive company | `isInactive` promoted to its own column |
| Malformed CUI | 400 before any request is spent; nothing persisted |
| Bad control digit | recorded as a warning, lookup still performed and its outcome kept |
| Timing | `durationMs` is the HTTP call only; limiter wait goes to `queueWaitMs` |
| Repeat check | company updated, not duplicated; two cases created |
| Rate limiter | consecutive calls one interval apart; survives a rejected task |
| CUI normalisation | `RO` prefix, whitespace, length and format rejection |
| Stale PENDING reaper | only `PENDING` rows older than the timeout become `INTERRUPTED`; fresh and terminal rows untouched; idempotent; survives a failing query; timer cleared on shutdown |
| HTTP contract | real requests through the controller with the same `ValidationPipe` as `main.ts`: 201 + body for found / not found / unavailable, 400 for a numeric `cui`, empty `cui`, unknown fields; `GET` returns snapshot metadata only, 404 / 400 on bad ids |

---

## Scope — intentionally out

Authentication and users; multi-tenancy (`tenantId` / `operatorId` from §5.2 and the
row-level isolation from §9); PDF dossier generation; Termene.ro, OpenSanctions and RBR;
the ownership tree and the 25% beneficial-owner calculation; risk scoring; any frontend.

These belong to Stages 1–3 of the KYB document and are well beyond the brief. Including
them in a few-hour task would show poor judgement about scale, not capability.

---

## Known limitations

Things I know about and chose not to fix within the scope of this task, worst first.

- **Snapshot immutability is a code convention, not a database guarantee.** The
  repository has no update or delete path, but nothing stops a `UPDATE` from psql. For a
  dossier shown to a regulator this belongs in Postgres: a separate application role
  without `UPDATE`/`DELETE` on `data_snapshots`, or a trigger that rejects both.
- **Two first-time checks of the same CUI at the same moment can collide.** `upsertCompany`
  is find-then-insert; the second insert hits the unique index and the request fails with
  500, leaving that case `PENDING` (the reaper will close it). The 1 req/s limiter makes the
  window small — the first ANAF call has to take longer than a second — but not zero. The
  fix is `INSERT … ON CONFLICT (cui) DO UPDATE`.
- **No back-pressure.** Concurrent requests queue on the limiter without bound; the
  N-th caller waits N seconds with its connection open, and `ANAF_TIMEOUT_MS` covers the
  fetch, not the queue. Fine for one operator clicking; wrong for a batch import. The right
  shape is a bounded queue answering 429 with `Retry-After`, or 202 + polling.
- **Dates.** `Company.registeredAt` is a JS `Date` in memory and a `date` column in
  Postgres, so it serialises as `2002-01-23T00:00:00.000Z` on `POST` and `2002-01-23` on
  `GET`; and TypeORM writes `date` columns from local time, so on a server west of UTC the
  stored day is off by one. The `data` field sent to ANAF is the UTC date, which between
  00:00 and 03:00 Bucharest time is yesterday. Dates should be `YYYY-MM-DD` strings end to
  end, computed in `Europe/Bucharest`.
- **The rate limiter is per process** (see Design decisions). A second instance, or a
  `--watch` restart, resets the clock.
- **No list endpoint.** A verification is reachable only by id, so an `INTERRUPTED` case is
  visible in the database but not through the API.
- **The mapper's top-level fallback is untested against any real source.** Groups are read
  first, so it cannot override real data; it is defensive code that may deserve deleting.

## What I would add next

In rough order: the database-level immutability and `ON CONFLICT` upsert above;
multi-tenancy with isolation enforced in SQL rather than only in the controller (§9); a
list endpoint with filters (the verification journal from §8); a distributed rate
limiter backed by Redis, because the ANAF budget is per deployment and the current one is
per process; the 24-hour preview cache from §11 with an explicit bypass for dossier
creation; partitioning `data_snapshots` by month, since it is append-only and will
dominate the database; metrics on external calls (latency, outcome, retry rate, queue
wait) so ANAF degradation is visible before operators report it; and a scheduled re-check
with change detection, since a company going inactive after onboarding is exactly what
the register is for.

---

## Note for the reviewer

The first draft was written without network access to ANAF. It was then verified against
the live v9 service on 2026-09-17: every field `src/anaf/anaf.mapper.ts` reads exists
under the expected name and type; v9 is the current version (`v10` does not exist). Two
things the documentation had wrong were found and fixed: "not found" is HTTP 404, not 200,
and `notFound` holds bare numbers, not objects. To re-verify:

```bash
curl -s -X POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: KYB-Module/1.0' \
  -d '[{"cui":14399840,"data":"2026-09-17"}]' | jq
```

If the field names change again, `src/anaf/anaf.mapper.ts` is the one file to touch.
