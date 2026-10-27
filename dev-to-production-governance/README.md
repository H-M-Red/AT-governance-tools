# Dev-to-Production Base Change Governance

**Status: deployed, real production automation.**

## The problem

Airtable doesn't natively support a structured review-and-approval process for changes
to a live production base. For an enterprise customer with strict internal controls on
who can change what, that's a real gap: a change gets made directly in production, with
no intake record, no reviewer sign-off, and no audit trail of what the value was before
and after.

## The architecture

A governance base sits alongside the production base(s) it protects, with three linked
pieces:

1. **Intake** (`1) Intake: Set Pending Review + AI Summary`): when someone submits a
   change request, record creation triggers an automation that sets Status to
   *Pending Review* and generates an AI summary of the request for reviewers, so a
   human reviewer gets a readable synopsis instead of raw field/value diffs.
2. **Approval**: a human reviewer changes Status to *Approved* based on that summary
   (and the underlying request detail).
3. **Apply** ([`apply-approved-change-to-production.js`](./apply-approved-change-to-production.js)):
   a `recordMatchesConditions` trigger fires only when Status = Approved, running the
   script in this folder.

## What the apply script actually does

- Parses the target base, table, field, and record straight out of the **Field URL**
  and **Record URL** the requester submitted, format-agnostic, matched against
  Airtable's own ID prefixes (`app`, `tbl`, `fld`, `rec`) rather than assuming a
  specific URL shape.
- Performs a **single, targeted field update**, never a full-base diff or bulk change,
  deliberately scoping the blast radius of any one approved request.
- **Reads the current value before writing**, so the Change Log captures a real
  old-value/new-value pair for audit purposes, not just "a change happened."
- Includes an **idempotency guard**: before doing any writes, it checks whether this
  request already has a Change Log entry. Airtable automation scripts can retry after a
  timeout, and without this guard, a retried run could double-apply the same change,
  the same category of bug that shows up as duplicate billing events or duplicate
  database writes when a retry isn't designed around idempotency.
- Logs the applied change, including who approved it, to a `Change Log` table in the
  governance base, independent of whatever audit trail the production base itself has.

## A real platform constraint this was built around

Airtable's `customScript` automation action nodes can't currently be created
through Airtable's own API, they're read-only there. That meant this script couldn't be
deployed programmatically; it had to be pasted into the Airtable UI by hand. The script
itself documents that constraint and the manual setup steps directly in its header
comment, so the next person maintaining it doesn't have to rediscover the limitation.

See [`apply-approved-change-to-production.js`](./apply-approved-change-to-production.js)
for the real, deployed script.
