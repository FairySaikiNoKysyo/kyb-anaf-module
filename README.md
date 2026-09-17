# KYB module — Romanian company lookup via ANAF

Looks up a Romanian company by its tax number (CUI) through the public ANAF web service,
stores the result, and records every call as immutable audit evidence.

This is Stage 1, item 1 of the KYB specification. It is written as production code rather
than as a demo, because the specification says this stage is already usable and sellable
on its own.

---

## Quick start

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL 16
npm ci
npm run migration:run
npm run start:dev             # http://localhost:3000
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

---

## Design decisions

**"Not found" is a business result, not an error.** ANAF answers an unknown CUI with
HTTP 200 and the number in a `notFound` array — not a 404. Code that treats "non-200" as
the only failure path passes its own tests and is wrong in production. More importantly,
"this company is not in the tax register" is an answer a KYB operator needs recorded, not
an exception to swallow. It maps to `VerificationStatus.NOT_FOUND`.

**A failed lookup still creates a verification.** When ANAF is unreachable the case is
saved with `SOURCE_UNAVAILABLE` and the operator can retry later. The specification
requires this, and the reasoning holds independently: the obligation is to show that the
check was attempted.

**All of those return HTTP 201, not 404 or 502.** The resource being created is the
*verification*, and it exists in every one of these cases. A 404 would claim it does not,
and would throw away the audit trail. Only a malformed CUI returns 400 — nothing was
checked and no record is worth keeping.

**Snapshots are append-only and include failures.** Every attempt — including each
retry — is stored with the raw response body, unmodified, in `jsonb`. `success` refers to
the HTTP call, so a `notFound` answer is `success: true`. Nothing in the codebase exposes
update or delete for `DataSnapshot`. A dossier that can be edited after the fact proves
nothing to a supervisory authority, which is the entire reason this entity exists.

**The rate limit is global to the service.** ANAF allows roughly one request per second
and blocks clients that exceed it. That budget belongs to the deployment, not to a user
or a request, so `AnafRateLimiter` is a single shared instance that serialises every
outbound call. It applies to retries too.

**Retries: 3 attempts, 1s/2s/4s, on timeouts, network errors, 5xx and 429 only.** Other
4xx are not retried — they will not become successes. Neither is a schema mismatch: a
valid HTTP response of the wrong shape means the contract changed, and repeating the call
will not fix that.

**The external response is validated, but leniently.** The envelope is checked with zod;
the record itself is kept raw. Silently accepting a changed shape and writing garbage
into a compliance dossier is the failure that matters here, but so is refusing to work
because ANAF added a field.

**Every ANAF field name lives in one file.** `src/anaf/anaf.mapper.ts` is the only place
that knows what `denumire` or `statusInactivi` means. The specification explicitly warns
that its field list is not authoritative and must be verified against the live service,
so adapting to a new ANAF version is a change to one file. The mapper reads both the
grouped (`date_generale.denumire`) and flat (`denumire`) layouts, because different ANAF
versions and mirrors use both.

**The CUI control digit is a warning, never a blocker.** A bug in our own checksum would
reject valid companies and block real business; being wrong the other way costs one extra
call to a free service. The result is recorded on the verification and the lookup proceeds
regardless.

**Cache is deliberately not implemented.** The specification allows caching ANAF data for
up to 24 hours but requires a fresh call whenever a new verification is created — and
creating a verification is this module's only path. A cache here would be dead code. It
becomes relevant when preview and autocomplete arrive.

**Tests mock the HTTP layer with undici's `MockAgent`, not nock.** nock patches Node's
`http`/`https` modules, which global `fetch` does not go through — a nock-based suite
would quietly make real calls to ANAF. The client therefore imports `fetch` from `undici`
directly so the dispatcher can be replaced in tests. `disableNetConnect()` is always on:
any undeclared request fails the run.

---

## Mapping to the specification

| Spec | Requirement | Where |
|---|---|---|
| §4.1 | POST, array body, CUI as a number without the `RO` prefix | `src/anaf/anaf.client.ts`, `src/cui/cui.util.ts` |
| §4.1 | Meaningful `User-Agent` (ANAF rejects empty or suspicious ones) | `src/anaf/anaf.client.ts`, `ANAF_USER_AGENT` |
| §4.1 | CUI not found → message to the operator, do not crash | `VerificationStatus.NOT_FOUND`, `NOT_FOUND_MESSAGE` |
| §4.1 | Service version and field names must be verifiable / replaceable | `ANAF_API_VERSION`, `src/anaf/anaf.mapper.ts` |
| §4.1 | `inactiv` flag is a critical risk marker | `Company.isInactive` (own column, not buried in the snapshot) |
| §5.1 | Company directory | `src/companies/company.entity.ts` |
| §5.2 | VerificationCase as the key entity | `src/verifications/verification-case.entity.ts` |
| §5.3 | Snapshot per external request, raw response, never modified | `src/verifications/data-snapshot.entity.ts` |
| §10 | Source unavailable → case is created, step marked failed, retryable | `VerificationStatus.SOURCE_UNAVAILABLE` |
| §10 | Failed requests stored too, as proof the attempt was made | `AnafClient.lookup` → `persistAttempt` |
| §10 | Up to 3 attempts with increasing backoff | `src/anaf/anaf.client.ts` |
| §10 | 1 request/second **globally**, not per user | `src/common/rate-limit/anaf-rate-limiter.ts` |
| §11 | Cache not used when creating a verification | not implemented — see Design decisions |
| §12 | Stage 1: ANAF + Company / VerificationCase / DataSnapshot | this module |

---

## Tests

25 cases across three suites, no infrastructure required.

| Area | Covered |
|---|---|
| Company found | company stored, case `COMPLETED`, snapshot `success: true` |
| Not found | `NOT_FOUND`, no company row, operator message, verification still created |
| HTTP 500 | 3 attempts, **3** failed snapshots, `SOURCE_UNAVAILABLE`, raw body kept |
| Timeout | `SOURCE_UNAVAILABLE`, every attempt recorded |
| Wrong response shape | `INVALID_RESPONSE`, **not** retried, raw body kept |
| Inactive company | `isInactive` promoted to its own column |
| Malformed CUI | 400 before any request is spent; nothing persisted |
| Bad control digit | recorded as a warning, lookup still performed |
| Repeat check | company updated, not duplicated; two cases created |
| Rate limiter | consecutive calls one interval apart; survives a rejected task |
| CUI normalisation | `RO` prefix, whitespace, length and format rejection |

---

## Scope — intentionally out

Authentication and users; multi-tenancy (`tenantId` / `operatorId` from §5.2 and the
row-level isolation from §9); PDF dossier generation; Termene.ro, OpenSanctions and RBR;
the ownership tree and the 25% beneficial-owner calculation; risk scoring; any frontend.

These belong to Stages 1–3 of the specification. Including them in a few-hour task would
show poor judgement about scale, not capability.

---

## What I would add next

In rough order: multi-tenancy with isolation enforced in SQL rather than only in the
controller (§9); a distributed rate limiter backed by Redis, because the ANAF budget is
per deployment and the current one is per process; the 24-hour preview cache from §11
with an explicit bypass for dossier creation; partitioning `data_snapshots` by month,
since it is append-only and will dominate the database; metrics on external calls
(latency, outcome, retry rate) so ANAF degradation is visible before operators report it;
and a scheduled re-check with change detection, since a company going inactive after
onboarding is exactly what the register is for.

---

## Note for the reviewer

The ANAF endpoint is not reachable from the environment this was written in, so the
response mapping follows the structure documented for v9 and is written to tolerate both
the grouped and flat layouts. Before this runs against production data, the field names
in `src/anaf/anaf.mapper.ts` should be confirmed against a live call:

```bash
curl -s -X POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: KYB-Module/1.0' \
  -d '[{"cui":14399840,"data":"2026-09-17"}]' | jq
```

That is the one file that would change.
