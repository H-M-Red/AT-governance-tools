// ─── WHAT THIS SCRIPT DOES ──────────────────────────────────────────────
// Runs as the "Run a script" action inside the automation:
//   "Apply Approved Change Request to Production"
// Trigger: recordUpdated / recordMatchesConditions on "Production base updates"
//          (tblAdTHP2sZkRQ8j5) where Status = Approved.
//
// It does a SINGLE targeted field update against whichever external
// production base the requester pointed at (parsed from the Field URL /
// Record URL they submitted) — never a full-base diff. It logs the old
// value, the new value, and who approved it to the Change Log table for
// audit purposes.
//
// Reads: Field URL, Record URL, New Value, Name, Approver (from the
//        triggering "Production base updates" record)
// Writes: the target field on the target record in the EXTERNAL production
//         base (via REST API), plus a new row in Change Log
// (tbl8migbX45Nef5CE) in THIS base.
//
// This script must be pasted into a "Run a script" step that an admin adds
// manually in the Airtable UI — customScript automation steps can't be
// created via the Airtable MCP tools, so this is hand-delivered.
// See setup notes at the bottom of this file.

// ─── CONFIGURATION ───────────────────────────────────────────────────────
const CONFIG = {
  REQUESTS_TABLE_ID: 'tblAdTHP2sZkRQ8j5', // Production base updates
  CHANGE_LOG_TABLE_ID: 'tbl8migbX45Nef5CE', // Change Log

  // Fields on "Production base updates"
  FIELD_URL_FIELD_ID: 'fldC15gtx8FbiBQSv', // Field URL
  RECORD_URL_FIELD_ID: 'fldN41ShThCJH7E42', // Record URL
  NEW_VALUE_FIELD_ID: 'fld2vI3IpU0ifSv7P', // New Value
  NAME_FIELD_ID: 'fldsKYUtCm28wIbUw', // Name (primary field)
  APPROVER_FIELD_ID: 'fldg4kjRTyvIFZI62', // Approver (lastModifiedBy on Status)

  // Fields on "Change Log"
  LOG_ENTRY_FIELD_ID: 'fldGjsl828YLOUJzb', // Log Entry (primary field)
  CHANGE_REQUEST_LINK_FIELD_ID: 'fldJjXVkl3m7NLrm4', // Change Request (link back)
  LOG_BASE_ID_FIELD_ID: 'fld29MJ1Z2IMNDbfJ', // Base ID
  LOG_TABLE_ID_FIELD_ID: 'fldFxNpBdcElVENOK', // Table ID
  LOG_FIELD_ID_FIELD_ID: 'fldHsFlCaMz1ojIf1', // Field ID
  LOG_RECORD_ID_FIELD_ID: 'fld6u9yXjuVBWMDbV', // Record ID
  LOG_OLD_VALUE_FIELD_ID: 'fldhCimiyjFlruQWj', // Old Value
  LOG_NEW_VALUE_FIELD_ID: 'fldcPjm170MWtt5IS', // New Value
  LOG_APPROVER_FIELD_ID: 'fldDso1uKX0r1Bl9w', // Approver
  LOG_APPLIED_AT_FIELD_ID: 'fldCT6TAVBrYVQE13', // Applied At
};

const ID_PATTERNS = {
  base: /app[A-Za-z0-9]{14}/,
  table: /tbl[A-Za-z0-9]{14}/,
  field: /fld[A-Za-z0-9]{14}/,
  record: /rec[A-Za-z0-9]{14}/,
};

// Pull an Airtable ID out of a URL by matching its known prefix pattern —
// this is deliberately format-agnostic (works regardless of exact URL
// structure/query params Airtable's "copy URL" features produce).
function extractId(url, pattern, label) {
  const match = url && url.match(pattern);
  if (!match) {
    throw new Error(`Could not find a ${label} ID in URL: "${url}"`);
  }
  return match[0];
}

// Best-effort type coercion for the human-typed "New Value" text field.
// NOTE: this mechanism is designed for simple field types — text, number,
// checkbox (true/false), and single select (must match an existing option's
// NAME exactly, since the REST API expects option names on write, not IDs).
// It is NOT designed for linked records, attachments, or multi-select
// fields — flag those requests for a manual/scripted exception if they
// come in.
function coerceValue(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return rawValue;
  const trimmed = String(rawValue).trim();
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed);
  return rawValue;
}

async function main() {
  try {
    // ── Inputs/Secrets wired up manually in the automation UI ──
    // 1. Under "Inputs," add a variable named "requestRecordId" mapped to
    //    the trigger's record ID (the "Airtable record ID" token from the
    //    trigger step's output).
    // 2. Under "Secrets" (a separate section from Inputs — Airtable moved
    //    credential storage to a centralized Secrets store), add a secret
    //    named "productionUpdatePat" containing a Personal Access Token
    //    with data.records:read and data.records:write scope on every
    //    production base this workflow may target. Secrets are created/
    //    managed in Builder Hub and referenced here via input.secret(name).
    const config = input.config();
    const requestRecordId = config.requestRecordId;
    const pat = input.secret('productionUpdatePat');

    if (!requestRecordId) {
      throw new Error('Missing input variable "requestRecordId" — wire it up to the trigger record ID in the automation UI.');
    }
    if (!pat) {
      throw new Error('Missing secret "productionUpdatePat" — add it under Secrets, containing a PAT with data.records:read/write scope.');
    }

    const requestsTable = base.getTable(CONFIG.REQUESTS_TABLE_ID);
    const changeLogTable = base.getTable(CONFIG.CHANGE_LOG_TABLE_ID);

    const requestRecord = await requestsTable.selectRecordAsync(requestRecordId, {
      fields: [
        CONFIG.FIELD_URL_FIELD_ID,
        CONFIG.RECORD_URL_FIELD_ID,
        CONFIG.NEW_VALUE_FIELD_ID,
        CONFIG.NAME_FIELD_ID,
        CONFIG.APPROVER_FIELD_ID,
      ],
    });

    if (!requestRecord) {
      throw new Error(`Request record ${requestRecordId} not found in Production base updates.`);
    }

    // ── Idempotency guard ──
    // Automation scripts can retry after a timeout. Before doing any writes,
    // check whether this request already has a Change Log entry so a retry
    // can't double-apply the same change.
    const existingLogQuery = await changeLogTable.selectRecordsAsync({
      fields: [CONFIG.CHANGE_REQUEST_LINK_FIELD_ID],
    });
    const alreadyApplied = existingLogQuery.records.some((logRecord) => {
      const linked = logRecord.getCellValue(CONFIG.CHANGE_REQUEST_LINK_FIELD_ID) || [];
      return linked.some((l) => l.id === requestRecordId);
    });
    if (alreadyApplied) {
      console.log(`Request ${requestRecordId} already has a Change Log entry — skipping duplicate apply.`);
      output.set('summary', 'Skipped: this request was already applied.');
      return;
    }

    const fieldUrl = requestRecord.getCellValueAsString(CONFIG.FIELD_URL_FIELD_ID);
    const recordUrl = requestRecord.getCellValueAsString(CONFIG.RECORD_URL_FIELD_ID);
    const rawNewValue = requestRecord.getCellValueAsString(CONFIG.NEW_VALUE_FIELD_ID);
    const newValue = coerceValue(rawNewValue);

    // ── Parse target base/table/field/record out of the two submitted URLs ──
    const fieldUrlBaseId = extractId(fieldUrl, ID_PATTERNS.base, 'base');
    const fieldUrlTableId = extractId(fieldUrl, ID_PATTERNS.table, 'table');
    const targetFieldId = extractId(fieldUrl, ID_PATTERNS.field, 'field');

    const recordUrlBaseId = extractId(recordUrl, ID_PATTERNS.base, 'base');
    const recordUrlTableId = extractId(recordUrl, ID_PATTERNS.table, 'table');
    const targetRecordId = extractId(recordUrl, ID_PATTERNS.record, 'record');

    if (fieldUrlBaseId !== recordUrlBaseId || fieldUrlTableId !== recordUrlTableId) {
      throw new Error(
        `Field URL and Record URL point to different bases/tables. Field URL: "${fieldUrl}". Record URL: "${recordUrl}".`
      );
    }

    const targetBaseId = fieldUrlBaseId;
    const targetTableId = fieldUrlTableId;

    // ── Read the CURRENT value from the production base before writing ──
    // (via REST API — this script runs in the governance base, so it must
    // reach the external production base over HTTP, not via `base.getTable`)
    // NOTE: uses the global `fetch` (standard Web Fetch API) — this
    // scripting environment does NOT have `remoteFetchAsync`. A few
    // environment-specific limits apply to `fetch` here: no redirect-
    // following (only 'error'/'manual' modes), no streaming/caching/cookies,
    // no FormData bodies, and a 4.5 MB response payload cap — none of which
    // affect this script's single-record GET/PATCH calls.
    const getResponse = await fetch(
      `https://api.airtable.com/v0/${targetBaseId}/${targetTableId}/${targetRecordId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${pat}` } }
    );
    if (!getResponse.ok) {
      throw new Error(`Failed to read production record before update: ${getResponse.status} ${await getResponse.text()}`);
    }
    const currentRecordData = await getResponse.json();
    const oldValue = currentRecordData.fields[targetFieldId] !== undefined
      ? currentRecordData.fields[targetFieldId]
      : null;

    // ── Apply the targeted update — a single scoped field write ──
    const patchResponse = await fetch(
      `https://api.airtable.com/v0/${targetBaseId}/${targetTableId}/${targetRecordId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${pat}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: { [targetFieldId]: newValue } }),
      }
    );
    if (!patchResponse.ok) {
      throw new Error(`Failed to write production update: ${patchResponse.status} ${await patchResponse.text()}`);
    }

    // ── Write the audit trail ──
    const approverInfo = requestRecord.getCellValue(CONFIG.APPROVER_FIELD_ID);
    const approverName = (approverInfo && (approverInfo.name || approverInfo.email)) || 'Unknown';

    await changeLogTable.createRecordsAsync([
      {
        fields: {
          [CONFIG.LOG_ENTRY_FIELD_ID]: `${requestRecord.name || requestRecordId} — applied ${new Date().toISOString()}`,
          [CONFIG.CHANGE_REQUEST_LINK_FIELD_ID]: [{ id: requestRecordId }],
          [CONFIG.LOG_BASE_ID_FIELD_ID]: targetBaseId,
          [CONFIG.LOG_TABLE_ID_FIELD_ID]: targetTableId,
          [CONFIG.LOG_FIELD_ID_FIELD_ID]: targetFieldId,
          [CONFIG.LOG_RECORD_ID_FIELD_ID]: targetRecordId,
          [CONFIG.LOG_OLD_VALUE_FIELD_ID]: typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue),
          [CONFIG.LOG_NEW_VALUE_FIELD_ID]: String(newValue),
          [CONFIG.LOG_APPROVER_FIELD_ID]: approverName,
          [CONFIG.LOG_APPLIED_AT_FIELD_ID]: new Date().toISOString(),
        },
      },
    ]);

    output.set(
      'summary',
      `Applied update to field ${targetFieldId} on record ${targetRecordId} (table ${targetTableId}, base ${targetBaseId}). Old value logged, new value written, Change Log entry created.`
    );
  } catch (error) {
    console.error('Error applying approved production update:', error.message);
    output.set('summary', `FAILED: ${error.message}`);
    throw error; // re-throw so the automation run shows as failed in run history
  }
}

await main();

// ─── MANUAL SETUP STEPS (do these in the Airtable UI) ───────────
// 1. In the governance base, create a new automation: "Apply Approved Change
//    Request to Production".
// 2. Trigger: "When record matches conditions" on Production base updates,
//    condition: Status = Approved.
// 3. Add action: "Run a script".
// 4. Paste this entire script in.
// 5. Under Inputs, add variable "requestRecordId" -> map to the trigger's
//    Airtable record ID token.
// 6. Under Secrets, add "productionUpdatePat" (create it in Builder Hub if
//    it doesn't exist yet) -> a PAT scoped to data.records:read +
//    data.records:write on the production base(s) this workflow will target.
// 7. Turn the automation on after testing.
