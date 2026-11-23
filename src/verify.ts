import fs from 'fs';
import path from 'path';
import { parseConversation } from './parser.js';
import { initDatabase, getAllExchanges, getFileLastIndexed } from './db.js';
import { getArchiveDir, getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, isErroredSentinel } from './summary-sentinel.js';
import { shouldSkipConversation } from './sync.js';
import { PiSource } from './parsers/pi.js';
import type { ConversationExchange } from './types.js';

export interface VerificationResult {
  missing: Array<{ path: string; reason: string }>;
  orphaned: Array<{ uuid: string; path: string }>;
  outdated: Array<{ path: string; fileTime: number; dbTime: number }>;
  corrupted: Array<{ path: string; error: string }>;
  /** Archived conversations with a real summary but no rows in the index (e.g. after the database was rebuilt). */
  unindexed: Array<{ path: string }>;
}

/**
 * Parse an archived conversation with the parser that matches its archive
 * layout. Multi-source archives are <archive>/pi/<project>/<file>; the generic
 * parser would classify Pi's bare session header as OMP, so Pi archives go
 * through the registered Pi parser with the archive's project component.
 * Legacy Claude archives (<archive>/<project>/<file>, including a Claude
 * project literally named "pi") keep the generic parser.
 */
async function parseArchivedConversation(conversationPath: string): Promise<ConversationExchange[]> {
  const relativeParts = path.relative(getArchiveDir(), conversationPath).split(path.sep);
  if (relativeParts[0] === 'pi' && relativeParts.length >= 3) {
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

      // Check if file is outdated (modified after last_indexed), or never indexed at all.
      // An empty summary is the permanent-skip sentinel (#91): nothing to index there.
      const lastIndexed = getFileLastIndexed(db, conversationPath);
      // An opted-out conversation (DO NOT INDEX marker, or unreadable: fail
      // closed) must never be scheduled for indexing.
      if (lastIndexed === null && summaryContent.length > 0) {
        if (!shouldSkipConversation(conversationPath)) {
          result.unindexed.push({ path: conversationPath });
        }
      } else if (lastIndexed !== null) {
        const fileStat = fs.statSync(conversationPath);
        if (fileStat.mtimeMs > lastIndexed) {
          result.outdated.push({
            path: conversationPath,
            fileTime: fileStat.mtimeMs,
            dbTime: lastIndexed
          });
        }
      }

      // Try parsing to detect corruption
      try {
        await parseArchivedConversation(conversationPath);
      } catch (error) {
        result.corrupted.push({
          path: conversationPath,
          error: error instanceof Error ? error.message : String(error)
        });
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
  const { initDatabase, insertExchange, deleteExchange } = await import('./db.js');
  const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
  const { summarizeConversation } = await import('./summarizer.js');

  const db = initDatabase();
  await initEmbeddings();

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
        } catch (error) {
          fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8');
          console.error('  Failed to summarize %s:', conversationPath, error);
        }
      }

      // Index exchanges
      for (const exchange of exchanges) {
        const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
        const embedding = await generateExchangeEmbedding(
          exchange.userMessage,
          exchange.assistantMessage,
          toolNames
        );
        insertExchange(db, exchange, embedding, toolNames);
      }

      console.log(`  Indexed ${exchanges.length} exchanges`);
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
