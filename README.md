# Airtable Governance & Security Tooling

Three systems built as an enterprise Technical Account Manager at Airtable to close real
governance and security gaps for enterprise customers, gaps the platform didn't yet
solve natively. Two are real, deployed automations with their actual production scripts
included below. The third is a fully designed system whose automation logic was never
scripted into these specific nodes, and is documented honestly as such.

## What's here

| Project | Status | What it does |
|---|---|---|
| [`share-link-security-auditor/`](./share-link-security-auditor) | **Deployed, running hourly** | Polls Airtable's Enterprise Audit Log API for share-link configuration changes, risk-scores every change, and gives admins a live view of exposure instead of an undifferentiated pile of links. |
| [`dev-to-production-governance/`](./dev-to-production-governance) | **Deployed, running on a trigger** | A structured intake-and-approval workflow for reviewing and applying base changes to production, with an AI-generated summary for reviewers and an idempotency guard against duplicate applies. |
| [`pat-security-auditor/`](./pat-security-auditor) | **Designed, not deployed** | A personal access token discovery, risk-scoring, and human-approval revocation system. The data model and workflow are fully specified; the automation scripts themselves were never pasted into these nodes. |

## Why these exist

All three were built after confirming, directly with Airtable's own product team, that
native support wasn't coming in the near term. Rather than wait on a roadmap, each one
closes the gap using only the platform's own audit log API, automations, and scripting
environment, no external service, no changes to the underlying platform required.

## A design pattern that shows up in all three

Every system here treats **human approval as a first-class step**, not an afterthought.
The share-link auditor surfaces risk but never auto-revokes a link. The governance
workflow requires an explicit approval status before any production write happens, and
guards against a retried automation run double-applying the same change. The PAT
auditor's revocation queue exists specifically so a flagged, high-risk token gets a
human's eyes before it's actually revoked, since auto-revoking a token in a live
enterprise environment can break a workflow someone depends on, with no warning.

That tradeoff, moving fast without skipping the step that actually matters, is the
through-line across everything in this repo.
