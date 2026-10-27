# Personal Access Token Security Auditor — Architecture

**Status: designed, not deployed.** The data model and workflow below are fully
specified and the tables are live, but the two automation scripts described here were
never pasted into their automation nodes, Airtable's API can create the trigger and the
placeholder action, but not the actual `Run a script` step, so the real script content
lives outside this base rather than inside it. This document describes the design
honestly as a design, not as running code.

## The problem

An enterprise customer's internal AI assistant was prompting employees to create
personal access tokens they didn't understand the scope or risk of, a quiet,
AI-generated version of the same credential-sprawl problem security teams already worry
about. There was no inventory of what tokens existed, who created them, what they could
access, or whether any of that access was ever actually used.

## The design, adapted from the share-link auditor

This reuses the same core pattern as the share-link auditor (poll the audit log,
risk-score, keep a human in the loop before anything destructive happens), applied to a
different Airtable object.

### Data model (live, real tables)

- **`PAT Registry`**: one row per personal access token discovered across the
  enterprise account, kept in sync from the `list-enterprise-personal-access-tokens`
  API. Tracks owner, scopes, whether it's a service account, whether it carries
  enterprise-wide scopes, last-used time, a computed risk level and reasons, and a flag
  for whether the token was possibly prompted into existence by the customer's internal
  AI assistant rather than deliberately requested by the human owner.
- **`PAT Audit Trail`**: event-level history (creation, scope changes, deletion,
  revocation) sourced from Airtable's Enterprise Audit Log Events API, filtered to the
  `personalAccessToken` category.
- **`Revocation Queue`**: the human-in-the-loop review step. A token flagged as high
  risk lands here with a reason and a requester, and only moves to actual revocation
  once a reviewer sets its status to Approved.
- **`Config`**: last check time, run status, and an explicit
  `Require Human Approval Before Revoke` checkbox, the single setting that enforces the
  whole human-in-the-loop design at the configuration level, not just in script logic.

### Intended automation flow (not yet scripted into these nodes)

1. **`PAT Discovery & Risk Audit`** (hourly): pulls the current PAT inventory plus
   PAT-related audit log events since the last check, syncs `PAT Registry` and
   `PAT Audit Trail`, computes a risk score per token, and for anything High risk,
   creates a row in `Revocation Queue` rather than acting on it directly.
2. **`Revoke Approved Tokens`** (hourly): looks at `Revocation Queue` for rows a human
   has set to Approved, and only for those, calls Airtable's
   `revoke-enterprise-personal-access-tokens` endpoint, then logs the result back onto
   the token's registry record.

## Why this is designed the way it is

The same reasoning as the share-link auditor's refusal to auto-remediate applies here,
with higher stakes: a personal access token can be load-bearing for an integration or a
script someone depends on daily. Revoking it automatically, even one that looks
objectively risky, risks breaking something in production with no warning. The
`Revocation Queue` and the `Require Human Approval Before Revoke` config flag exist
specifically to make that an explicit, deliberate step, not a side effect of a
risk score crossing a threshold.

## What's honestly missing

The actual script logic for both automations above, the API calls, the risk-scoring
function, the sync logic, was never completed and pasted into these nodes. The tables,
the fields, and the workflow they're built to support are real; the running code isn't,
yet.
