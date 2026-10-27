# Share Link Security Auditor

**Status: deployed, real production automation, running hourly.**

## The problem

Airtable's native Admin Panel doesn't surface share-link creation or configuration
changes today. One enterprise account's security team flagged over 22,000 active share
links as a compliance concern, with no way to answer the basic question a security
review always asks: which of these are actually dangerous, and what changed?

## The approach

After confirming with Airtable's own product team that native admin visibility into
share links wasn't on the near-term roadmap, this closes the gap directly against
Airtable's real Enterprise Audit Log API:

1. **A one-time CSV backfill** seeded a `Share Links` table with the full existing
   inventory before any live monitoring existed, since the Audit Log API only returns
   events going forward, not historical state.
2. **An hourly cron automation** (the script in this folder) polls
   `GET /v0/meta/enterpriseAccounts/{id}/auditLogEvents`, filtered to four event types
   that actually change a share's risk profile: `enableShare`, `disableShare`,
   `configureShare`, `regenerateShare`. Plain `viewShare` events are deliberately
   excluded, since those represent usage, not a configuration change.
3. A `Config` table stores the last successful check time, so each run is incremental
   rather than a full re-scan, and records whether the previous run succeeded.
4. Every matched event becomes a new row in `Share Link Audit Trail`, risk-scored
   High/Medium/Low/Info based on what actually changed (see the scoring logic in the
   script), and the corresponding `Share Links` record's status is updated.

## Why no auto-remediation

An early design question was whether to auto-revoke high-risk links outright, for
example, any edit-access link with no password. That was deliberately rejected.
Automatically revoking a share link a real user depends on, with no warning, can break
someone's workflow. This tool surfaces risk and makes remediation fast; a human decides
what actually happens to a given link.

## The risk model, briefly

- **High**: removing enterprise-member restriction, or removing a password that was
  previously set, the two changes that genuinely widen exposure.
- **Medium**: regenerating a share, or loosening password/domain restrictions.
- **Low**: disabling a share.
- **Info**: enabling a share, or anything not otherwise classified.

The ordering is deliberate: a share that just lost its only protection should never
rank below one that's merely being rotated or turned off.

See [`monitor-share-link-changes.js`](./monitor-share-link-changes.js) for the real,
deployed script.
