import fs from 'fs';
import path from 'path';
import { parseConversation } from './parser.js';
import { initDatabase, getAllExchanges, getFileLastIndexed } from './db.js';
import { getArchiveDir, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, isErroredSentinel } from './summary-sentinel.js';
import { shouldSkipConversation } from './sync.js';
import { PiSource } from './parsers/pi.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';
const PI_HEADER_PROBE_BYTES = 64 * 1024;
/** True when the first non-empty line is a Pi `{type:'session'}` header. */
function startsWithPiSessionHeader(conversationPath) {
    let fd;
    try {
        fd = fs.openSync(conversationPath, 'r');
        const buf = Buffer.allocUnsafe(PI_HEADER_PROBE_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
            if (!line.trim())
                continue;
            const parsed = JSON.parse(line);
            return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
                parsed.type === 'session';
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
/**
 * Parse an archived conversation with the parser that matches its archive
 * layout. The Pi writer produces exactly <archive>/pi/<project>/<file>.jsonl,
 * and the generic parser would classify Pi's bare session header as OMP, so a
 * file in that flat layout that starts with a Pi session header goes through
 * the registered Pi parser with the archive's project component. Everything
 * else keeps the generic parser: legacy Claude archives
 * (<archive>/<project>/<file>, including a Claude project literally named "pi"
 * and its nested <session>/subagents/agent-*.jsonl transcripts).
 */
async function parseArchivedConversation(conversationPath) {
    const relativeParts = path.relative(getArchiveDir(), conversationPath).split(path.sep);
    if (relativeParts[0] === 'pi' &&
        relativeParts.length === 3 &&
        startsWithPiSessionHeader(conversationPath)) {
        return new PiSource().parseConversation(conversationPath, relativeParts[1], conversationPath);
    }
    return parseConversation(conversationPath, relativeParts[0], conversationPath);
}
export async function verifyIndex() {
    const result = {
        missing: [],
        orphaned: [],
        outdated: [],
        corrupted: [],
        unindexed: []
    };
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Initialize database once for all checks
    const db = initDatabase();
    const projects = fs.readdirSync(archiveDir);
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);
    const maxMessageBytes = getMaxMessageBytes();
    let totalChecked = 0;
    for (const project of projects) {
        if (excludedProjects.includes(project)) {
            console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(archiveDir, project);
        const stat = statIfExists(projectPath);
        if (!stat?.isDirectory())
            continue;
        const files = findJsonlFiles(projectPath, excludedDirSet);
        for (const file of files) {
            totalChecked++;
            if (totalChecked % 100 === 0) {
                console.log(`  Checked ${totalChecked} conversations...`);
            }
            const conversationPath = path.join(projectPath, file);
            foundFiles.add(conversationPath);
            // An opted-out conversation (DO NOT INDEX marker, or unreadable: fail
            // closed) is archived without a summary or index rows on purpose; it is
            // neither missing, unindexed, nor outdated, and repair never touches it.
            if (shouldSkipConversation(conversationPath))
                continue;
            const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
            // Check for missing or errored summary. An error sentinel (#96) means a
            // previous summarization failed — verify treats it as "missing" so repair
            // re-attempts it rather than reporting the conversation as healthy.
            if (!fs.existsSync(summaryPath)) {
                result.missing.push({ path: conversationPath, reason: 'No summary file' });
                continue;
            }
            const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
            if (isErroredSentinel(summaryContent)) {
                result.missing.push({ path: conversationPath, reason: 'Previous summarization failed (error sentinel)' });
                continue;
            }
            // Parse once: detects corruption and tells whether any exchange is
            // eligible for indexing (oversize exchanges are never indexed).
            let indexableExchanges;
            try {
                const parsed = await parseArchivedConversation(conversationPath);
                indexableExchanges = parsed.filter(exchange => !isOversizeExchange(exchange, maxMessageBytes));
            }
            catch (error) {
                result.corrupted.push({
                    path: conversationPath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            // Check if file is outdated (modified after last_indexed), or never indexed at all.
            // An empty summary is the permanent-skip sentinel (#91): nothing to index there.
            // A parseable archive with no indexable exchanges (all oversize, or none)
            // legitimately has zero rows, so it is not "unindexed".
            const lastIndexed = getFileLastIndexed(db, conversationPath);
            if (lastIndexed === null && summaryContent.length > 0) {
                if (indexableExchanges && indexableExchanges.length > 0) {
                    result.unindexed.push({ path: conversationPath });
                }
            }
            else if (lastIndexed !== null) {
                const fileStat = fs.statSync(conversationPath);
                if (fileStat.mtimeMs > lastIndexed) {
                    result.outdated.push({
                        path: conversationPath,
                        fileTime: fileStat.mtimeMs,
                        dbTime: lastIndexed
                    });
                }
            }
        }
    }
    console.log(`Verified ${totalChecked} conversations.`);
    // Check for orphaned database entries
    const dbExchanges = getAllExchanges(db);
    db.close();
    for (const exchange of dbExchanges) {
        if (!foundFiles.has(exchange.archivePath)) {
            result.orphaned.push({
                uuid: exchange.id,
                path: exchange.archivePath
            });
        }
    }
    return result;
}
export async function repairIndex(issues) {
    console.log('Repairing index...');
    // To avoid circular dependencies, we import the indexer functions dynamically
    const { initDatabase, insertExchange, deleteExchange } = await import('./db.js');
    const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
    const { summarizeConversation } = await import('./summarizer.js');
    const db = initDatabase();
    await initEmbeddings();
    const maxMessageBytes = getMaxMessageBytes();
    // Remove orphaned entries first
    for (const orphan of issues.orphaned) {
        console.log(`Removing orphaned entry: ${orphan.uuid}`);
        deleteExchange(db, orphan.uuid);
    }
    // Re-index missing and outdated conversations, and index the unindexed ones. An unindexed
    // conversation already has its summary, so it is not summarized again.
    const toReindex = [
        ...issues.missing.map(m => ({ conversationPath: m.path, summarize: true })),
        ...issues.outdated.map(o => ({ conversationPath: o.path, summarize: true })),
        ...(issues.unindexed ?? []).map(u => ({ conversationPath: u.path, summarize: false }))
    ];
    for (const { conversationPath, summarize } of toReindex) {
        // Fail closed: never summarize or embed an opted-out conversation.
        if (shouldSkipConversation(conversationPath)) {
            console.log(`Skipping opted-out conversation: ${conversationPath}`);
            continue;
        }
        console.log(`Re-indexing: ${conversationPath}`);
        try {
            const exchanges = await parseArchivedConversation(conversationPath);
            if (exchanges.length === 0) {
                console.log(`  Skipped (no exchanges)`);
                continue;
            }
            // Generate/update summary. A summarizer failure should not prevent
            // repair from refreshing the searchable index.
            if (summarize) {
                const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
                try {
                    const summary = await summarizeConversation(exchanges);
                    fs.writeFileSync(summaryPath, summary, 'utf-8');
                    console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
                }
                catch (error) {
                    fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8');
                    console.error('  Failed to summarize %s:', conversationPath, error);
                }
            }
            // Index exchanges, applying the same oversize policy as sync/indexer.
            const indexable = exchanges.filter(exchange => !isOversizeExchange(exchange, maxMessageBytes));
            const oversizeSkipped = exchanges.length - indexable.length;
            for (const exchange of indexable) {
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            console.log(`  Indexed ${indexable.length} exchanges` + (oversizeSkipped > 0 ? ` (skipped ${oversizeSkipped} oversize)` : ''));
        }
        catch (error) {
            console.error('Failed to re-index %s:', conversationPath, error);
        }
    }
    db.close();
    // Report corrupted files (manual intervention needed)
    if (issues.corrupted.length > 0) {
        console.log('\n⚠️  Corrupted files (manual review needed):');
        issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
    }
    console.log('✅ Repair complete.');
}
