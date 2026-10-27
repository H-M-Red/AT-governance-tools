// Airtable Automation Script: Monitor Share Link Changes via Audit Log API
// Trigger: Run on schedule (e.g., every hour)

// Configuration
const ENTERPRISE_ACCOUNT_ID = 'entMSNTDdANSAcrfx'; // Replace with your enterprise ID
const PERSONAL_ACCESS_TOKEN = input.secret('secret'); // Use input.config() in production
const AUDIT_LOG_API_URL = `https://api.airtable.com/v0/meta/enterpriseAccounts/${ENTERPRISE_ACCOUNT_ID}/auditLogEvents`;


// Get tables
const shareLinksTable = base.getTable('Share Links');
const auditTrailTable = base.getTable('Share Link Audit Trail');

// Share link configuration change events only (excludes viewShare)
const SHARE_EVENTS = [
    'enableShare',
    'disableShare', 
    'configureShare',
    'regenerateShare'
];

// Main function
async function monitorShareLinkChanges() {
    try {
        console.log('Starting share link audit check...');
        
        const lastCheckTime = await getLastCheckTime();
        const currentTime = new Date().toISOString();
        
        const auditEvents = await fetchAuditLogEvents(lastCheckTime);
        console.log(`Found ${auditEvents.length} audit events since ${lastCheckTime}`);
        
        if (auditEvents.length > 0) {
            await processAuditEvents(auditEvents);
        }
        
        await updateLastCheckTime(currentTime);
        
        console.log('Share link audit check completed successfully');
        
    } catch (error) {
        console.error('Error in share link monitoring:', error);
        throw error;
    }
}

// Fetch audit log events from Airtable API
async function fetchAuditLogEvents(sinceTimestamp) {
    const allEvents = [];
    let offset = null;
    const sinceDate = new Date(sinceTimestamp);
    let pageCount = 0;
    const MAX_PAGES = 10;
    
    console.log(`Fetching events since: ${sinceTimestamp}`);
    
    do {
        pageCount++;
        
        const params = new URLSearchParams({
            pageSize: '100'
        });
        
        SHARE_EVENTS.forEach(eventType => {
            params.append('filterByEventTypes', eventType);
        });
        
        if (offset) {
            params.append('offset', offset);
        }
        
        const url = `${AUDIT_LOG_API_URL}?${params.toString()}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${PERSONAL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        console.log(`Page ${pageCount}: Received ${data.events.length} events`);
        
        // Filter by timestamp and event type
        const filteredEvents = data.events.filter(event => {
            const eventDate = new Date(event.timestamp);
            return eventDate > sinceDate && SHARE_EVENTS.includes(event.action);
        });
        
        console.log(`  - Kept ${filteredEvents.length} events after date filter`);
        allEvents.push(...filteredEvents);
        
        offset = data.offset || null;
        
        if (pageCount >= MAX_PAGES && offset) {
            console.log(`Reached max pages, stopping`);
            break;
        }
        
        if (offset) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
    } while (offset);
    
    console.log(`Total events collected: ${allEvents.length}`);
    return allEvents;
}

// Calculate risk level based on event type and payload
function calculateRiskLevel(event, existingRecord) {
    const eventType = event.action;
    const payload = event.payload || {};
    
    if (eventType === 'configureShare') {
        if (payload.restrictedToEnterpriseMembers === false || 
            payload.restrictEmailDomainTo === null) {
            return 'High';
        }
        const currentHasPassword = existingRecord?.getCellValue('hasPassword');
        if (payload.isPasswordProtected === false && currentHasPassword) {
            return 'High';
        }
        if (payload.isPasswordProtected === false ||
            payload.restrictEmailDomainTo === false) {
            return 'Medium';
        }
        if (payload.shouldAllowCopy === true || 
            payload.shouldShowExtensions === true) {
            return 'Medium';
        }
        return 'Low';
    }
    
    if (eventType === 'regenerateShare') {
        return 'Medium';
    }
    
    if (eventType === 'disableShare') {
        return 'Low';
    }
    
    if (eventType === 'enableShare') {
        return 'Info';
    }
    
    return 'Info';
}

// Extract changed settings from configureShare payload
function extractChangedSettings(payload) {
    const changedSettings = [];
    
    if (payload.isPasswordProtected !== undefined) {
        changedSettings.push('Password');
    }
    if (payload.restrictEmailDomainTo !== undefined) {
        changedSettings.push('Domain Restriction');
    }
    if (payload.restrictedToEnterpriseMembers !== undefined) {
        changedSettings.push('Enterprise Members');
    }
    if (payload.shouldAllowCopy !== undefined) {
        changedSettings.push('Copy');
    }
    if (payload.shouldShowExtensions !== undefined) {
        changedSettings.push('Extensions');
    }
    
    return changedSettings;
}

// Process audit events and update share link records
async function processAuditEvents(events) {
    // Group events by shareId using modelId field
    const eventsByShareId = {};
    
    events.forEach(event => {
        const shareId = event.modelId; // This is the share ID
        
        if (shareId) {
            if (!eventsByShareId[shareId]) {
                eventsByShareId[shareId] = [];
            }
            eventsByShareId[shareId].push(event);
        }
    });
    
    console.log(`Processing changes for ${Object.keys(eventsByShareId).length} unique share links`);
    
    // Query existing share links
    const shareLinksQuery = await shareLinksTable.selectRecordsAsync({
        fields: ['shareId', 'Status', 'Last Modified', 'Last Event Type', 'hasPassword', 'Change Count']
    });
    
    const shareLinksMap = new Map();
    shareLinksQuery.records.forEach(record => {
        const shareId = record.getCellValue('shareId');
        if (shareId) {
            shareLinksMap.set(shareId, record);
        }
    });
    
    console.log(`Found ${shareLinksMap.size} share links in table`);
    
    const updates = [];
    const newShareLinks = [];
    const newAuditEntries = [];
    
    for (const [shareId, shareEvents] of Object.entries(eventsByShareId)) {
        const existingRecord = shareLinksMap.get(shareId);
        const latestEvent = shareEvents[shareEvents.length - 1];
        
        // Use 'action' field instead of 'eventType'
        let newStatus = 'Active';
        if (latestEvent.action === 'disableShare') {
            newStatus = 'Disabled';
        } else if (latestEvent.action === 'regenerateShare') {
            newStatus = 'Regenerated';
        } else if (latestEvent.action === 'enableShare') {
            newStatus = 'Active';
        } else if (latestEvent.action === 'configureShare') {
            newStatus = existingRecord ? 
                existingRecord.getCellValueAsString('Status') || 'Active' : 'Active';
        }
        
        if (existingRecord) {
            const currentChangeCount = existingRecord.getCellValue('Change Count') || 0;
            
            updates.push({
                id: existingRecord.id,
                fields: {
                    'Status': { name: newStatus },
                    'Last Modified': latestEvent.timestamp,
                    'Last Event Type': latestEvent.action,
                    'Last Audit Check': new Date().toISOString(),
                    'Change Count': currentChangeCount + shareEvents.length
                }
            });
            
            shareEvents.forEach(event => {
                const riskLevel = calculateRiskLevel(event, existingRecord);
                const changedSettings = event.action === 'configureShare' ? 
                    extractChangedSettings(event.payload || {}) : [];
                
                const auditEntry = {
                    fields: {
                        'Share Link': existingRecord.id,
                        'Share ID': shareId,
                        'Event Type': event.action,
                        'Event Time': event.timestamp,
                        'User': event.actor?.user?.email || 'Unknown',
                        'User ID': event.actor?.user?.id || '',
                        'Application ID': event.context?.baseId || '',
                        'Workspace ID': event.context?.workspaceId || '',
                        'Details': JSON.stringify(event.payload || {}, null, 2),
                        'Risk Level': { name: riskLevel }
                    }
                };
                
                const payload = event.payload || {};
                
                if (changedSettings.length > 0) {
                    auditEntry.fields['Changed Settings'] = changedSettings.map(s => ({ name: s }));
                }
                
                if (payload.isPasswordProtected !== undefined) {
                    if (payload.isPasswordProtected === true) {
                        auditEntry.fields['Password Added'] = true;
                    } else {
                        auditEntry.fields['Password Removed'] = true;
                    }
                }
                
                if (payload.restrictedToEnterpriseMembers === false ||
                    payload.restrictEmailDomainTo === null) {
                    auditEntry.fields['Enterprise Restriction Removed'] = true;
                }
                
                if (payload.shouldAllowCopy === true) {
                    auditEntry.fields['Sync Enabled'] = true;
                }
                
                newAuditEntries.push(auditEntry);
                
                if (riskLevel === 'High') {
                    console.log(`HIGH RISK: ${event.action} on share ${shareId} by ${event.actor?.user?.email}`);
                }
            });
            
        } else {
            console.log(`New share: ${shareId} (not in CSV)`);
            const riskLevel = calculateRiskLevel(latestEvent, null);
            
            // Create new share link record
            newShareLinks.push({
                fields: {
                    'shareId': shareId,
                    'Status': { name: newStatus },
                    'Last Modified': latestEvent.timestamp,
                    'Last Event Type': latestEvent.action,
                    'Last Audit Check': new Date().toISOString(),
                    'Change Count': shareEvents.length,
                    'applicationId': latestEvent.context?.baseId || '',
                    'workspaceId': latestEvent.context?.workspaceId || ''
                }
            });
            
            newAuditEntries.push({
                fields: {
                    'Share ID': shareId,
                    'Event Type': latestEvent.action,
                    'Event Time': latestEvent.timestamp,
                    'User': latestEvent.actor?.user?.email || 'Unknown',
                    'User ID': latestEvent.actor?.user?.id || '',
                    'Application ID': latestEvent.context?.baseId || '',
                    'Workspace ID': latestEvent.context?.workspaceId || '',
                    'Details': JSON.stringify(latestEvent.payload || {}, null, 2),
                    'Risk Level': { name: riskLevel },
                    'Note': 'New share link not in original CSV'
                }
            });
        }
    }
    
    // Batch update share links
    if (updates.length > 0) {
        console.log(`Updating ${updates.length} share link records...`);
        while (updates.length > 0) {
            await shareLinksTable.updateRecordsAsync(updates.splice(0, 50));
        }
    }
    
    // Batch create new share links
    if (newShareLinks.length > 0) {
        console.log(`Creating ${newShareLinks.length} new share link records...`);
        while (newShareLinks.length > 0) {
            await shareLinksTable.createRecordsAsync(newShareLinks.splice(0, 50));
        }
    }
    
    // Batch create audit trail entries
    if (newAuditEntries.length > 0) {
        console.log(`Creating ${newAuditEntries.length} audit trail entries...`);
        
        const sanitizedEntries = newAuditEntries.map(entry => {
            const sanitized = { fields: {} };
            for (const [key, value] of Object.entries(entry.fields)) {
                if (value !== undefined && value !== null && value !== '') {
                    sanitized.fields[key] = value;
                }
            }
            return sanitized;
        });
        
        while (sanitizedEntries.length > 0) {
            await auditTrailTable.createRecordsAsync(sanitizedEntries.splice(0, 50));
        }
    }
    
    const highRiskCount = newAuditEntries.filter(e => 
        e.fields['Risk Level']?.name === 'High'
    ).length;
    
    console.log(`\nProcessing complete:`);
    console.log(`  - Updated ${updates.length} share links`);
    console.log(`  - Created ${newShareLinks.length} new share links`);
    console.log(`  - Created ${newAuditEntries.length} audit entries`);
    console.log(`  - High risk events: ${highRiskCount}`);
}

// Get last check time
async function getLastCheckTime() {
    try {
        const configTable = base.getTable('Config');
        const query = await configTable.selectRecordsAsync({
            fields: ['Last Audit Check Time']
        });
        
        if (query.records.length > 0) {
            const lastCheck = query.records[0].getCellValue('Last Audit Check Time');
            if (lastCheck) {
                console.log(`Resuming from: ${lastCheck}`);
                return lastCheck;
            }
        }
    } catch (error) {
        console.log('Config table not found, using default start time');
    }
    
    return getDefaultStartTime();
}

// Update last check time
async function updateLastCheckTime(timestamp) {
    try {
        const configTable = base.getTable('Config');
        const query = await configTable.selectRecordsAsync();
        
        if (query.records.length > 0) {
            await configTable.updateRecordAsync(query.records[0].id, {
                'Last Audit Check Time': timestamp,
                'Last Run Status': { name: 'Success' }
            });
        } else {
            await configTable.createRecordAsync({
                'Config Name': 'Share Link Monitor',
                'Last Audit Check Time': timestamp,
                'Last Run Status': { name: 'Success' }
            });
        }
    } catch (error) {
        console.error('Could not update last check time:', error);
    }
}

// Default to 24 hours ago
function getDefaultStartTime() {
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    return oneDayAgo.toISOString();
}

// Run the main function
await monitorShareLinkChanges();
