import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { parseConversation } from './parser.js';
import { initDatabase, getAllExchanges, getFileLastIndexed } from './db.js';
import { getArchiveDir, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, isErroredSentinel } from './summary-sentinel.js';
import { shouldSkipConversation } from './sync.js';
import { PiSource } from './parsers/pi.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';
import type { ConversationExchange } from './types.js';

export interface VerificationResult {
  missing: Array<{ path: string; reason: string }>;
  orphaned: Array<{ uuid: string; path: string }>;
  outdated: Array<{ path: string; fileTime: number; dbTime: number }>;
  corrupted: Array<{ path: string; error: string }>;
  /** Archived conversations with a real summary but no rows in the index (e.g. after the database was rebuilt). */
  unindexed: Array<{ path: string }>;
}

const PI_HEADER_READ_CHUNK_BYTES = 64 * 1024;
const PI_HEADER_MAX_LINE_BYTES = 64 * 1024 * 1024;

function isPiSessionHeaderLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === 'session';
  } catch {
    return false;
  }
}

/**
 * True when the first non-empty line is a Pi `{type:'session'}` header. The
 * whole line is read however long it is (Pi's parser does the same), up to a
 * safety ceiling, so a large valid header is not misrouted to the OMP parser.
 */
function startsWithPiSessionHeader(conversationPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(conversationPath, 'r');
    let parts: Buffer[] = [];
    let lineBytes = 0;
    let position = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(PI_HEADER_READ_CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1 || newline >= bytesRead) {
          parts.push(chunk.subarray(start, bytesRead));
          lineBytes += bytesRead - start;
          if (lineBytes > PI_HEADER_MAX_LINE_BYTES) return false;
          break;
        }
        // Enforce the ceiling on the completed line before concatenating it.
        if (lineBytes + (newline - start) > PI_HEADER_MAX_LINE_BYTES) return false;
        parts.push(chunk.subarray(start, newline));
        const line = Buffer.concat(parts).toString('utf8');
        parts = [];
        lineBytes = 0;
        if (line.trim()) return isPiSessionHeaderLine(line);
        start = newline + 1;
      }
    }
    const lastLine = Buffer.concat(parts).toString('utf8');
    return lastLine.trim() ? isPiSessionHeaderLine(lastLine) : false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * True only when the archive has at least one valid JSON record and every
 * non-blank line parses as JSON. A valid archive can legitimately parse to zero
 * exchanges (e.g. an OMP active branch abandoned by a new unanswered root), but
 * an archive with any malformed line may have lost messages (a valid session
 * header followed by damaged message lines still parses to zero exchanges), so
 * it needs manual review and must never drive a deletion-only replacement.
 */
async function isStrictValidJsonlArchive(conversationPath: string): Promise<boolean> {
  const lines = readline.createInterface({
    input: fs.createReadStream(conversationPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  let validRecords = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        validRecords++;
      } catch {
        return false;
      }
    }
    return validRecords > 0;
  } finally {
    lines.close();
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
async function parseArchivedConversation(conversationPath: string): Promise<ConversationExchange[]> {
  const relativeParts = path.relative(getArchiveDir(), conversationPath).split(path.sep);
  if (
    relativeParts[0] === 'pi' &&
    relativeParts.length === 3 &&
    startsWithPiSessionHeader(conversationPath)
  ) {
    return new PiSource().parseConversation(conversationPath, relativeParts[1], conversationPath);
  }
  return parseConversation(conversationPath, relativeParts[0], conversationPath);
}

export async function verifyIndex(): Promise<VerificationResult> {
  const result: VerificationResult = {
    missing: [],
    orphaned: [],
    outdated: [],
    corrupted: [],
    unindexed: []
  };

  const archiveDir = getArchiveDir();

  // Track all files we find
  const foundFiles = new Set<string>();

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

    if (!stat?.isDirectory()) continue;

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
      if (shouldSkipConversation(conversationPath)) continue;

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
      let parsedExchangeCount: number | undefined;
      let indexableExchanges: ConversationExchange[] | undefined;
      try {
        const parsed = await parseArchivedConversation(conversationPath);
        parsedExchangeCount = parsed.length;
        indexableExchanges = parsed.filter(exchange => !isOversizeExchange(exchange, maxMessageBytes));
      } catch (error) {
        result.corrupted.push({
          path: conversationPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Check if file is outdated (modified after last_indexed), or never indexed at all.
      // An empty summary is the permanent-skip sentinel (#91): nothing to index there.
      // An archive whose exchanges were all parsed but are all oversize
      // legitimately has zero rows, so it is not "unindexed". An archive with a
      // real summary that parses to no exchanges and is not strictly valid JSONL
      // (no valid record, or any malformed line) is reported as corrupted: repair cannot index it,
      // so reporting it as unindexed would never converge. A valid archive that
      // legitimately has zero exchanges (e.g. an abandoned OMP branch) is clean.
      const lastIndexed = getFileLastIndexed(db, conversationPath);
      if (lastIndexed === null && summaryContent.length > 0) {
        if (indexableExchanges && indexableExchanges.length > 0) {
          result.unindexed.push({ path: conversationPath });
        } else if (parsedExchangeCount === 0 && !(await isStrictValidJsonlArchive(conversationPath))) {
          result.corrupted.push({
            path: conversationPath,
            error: 'Archive has a summary but contains no parseable exchanges'
          });
        }
      } else if (lastIndexed !== null) {
        const fileStat = fs.statSync(conversationPath);
        if (fileStat.mtimeMs > lastIndexed) {
          // A zero-exchange archive with any malformed line must not be
          // scheduled for repair: replacing its rows would delete the last
          // good index entries for a file that needs manual review.
          if (parsedExchangeCount === 0 && !(await isStrictValidJsonlArchive(conversationPath))) {
            result.corrupted.push({
              path: conversationPath,
              error: 'Archive parses to no exchanges and contains malformed JSONL lines'
            });
            continue;
          }
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

export async function repairIndex(issues: VerificationResult): Promise<void> {
  console.log('Repairing index...');

  // To avoid circular dependencies, we import the indexer functions dynamically
  const { initDatabase, deleteExchange, replaceExchangesForArchive } = await import('./db.js');
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

      // An archive with a malformed line (or no valid record) needs manual
      // review and must not have its existing rows deleted. A fully valid
      // archive with zero exchanges falls through so stale rows (e.g. an
      // abandoned OMP branch) are removed.
      if (exchanges.length === 0 && !(await isStrictValidJsonlArchive(conversationPath))) {
        console.log(`  Skipped (malformed or missing JSONL records; manual review needed)`);
        continue;
      }

      // Generate/update summary. A summarizer failure should not prevent
      // repair from refreshing the searchable index.
      if (summarize && exchanges.length > 0) {
        const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
        try {
          const summary = await summarizeConversation(exchanges);
          fs.writeFileSync(summaryPath, summary, 'utf-8');
          console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
        } catch (error) {
          fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8');
          console.error('  Failed to summarize %s:', conversationPath, error);
        }
      }

      // Index exchanges, applying the same oversize policy as sync/indexer.
      const indexable = exchanges.filter(exchange => !isOversizeExchange(exchange, maxMessageBytes));
      const oversizeSkipped = exchanges.length - indexable.length;
      // Prepare every replacement embedding before touching the database, then
      // swap the archive's rows in one transaction: a failed embedding or insert
      // leaves the existing rows and vectors untouched. Stale rows (now
      // oversize, or gone from the archive) are removed in the same transaction.
      const prepared: Array<{ exchange: ConversationExchange; embedding: number[]; toolNames?: string[] }> = [];
      for (const exchange of indexable) {
        const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
        const embedding = await generateExchangeEmbedding(
          exchange.userMessage,
          exchange.assistantMessage,
          toolNames
        );
        prepared.push({ exchange, embedding, toolNames });
      }
      const staleRemoved = replaceExchangesForArchive(db, conversationPath, prepared);
      if (staleRemoved > 0) console.log(`  Removed ${staleRemoved} stale indexed exchange(s)`);

      console.log(`  Indexed ${indexable.length} exchanges` + (oversizeSkipped > 0 ? ` (skipped ${oversizeSkipped} oversize)` : ''));
    } catch (error) {
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
