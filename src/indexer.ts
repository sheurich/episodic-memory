/**
 * Multi-source conversation indexer.
 *
 * Discovers conversations from all registered sources (Claude, Gemini, Pi),
 * parses them, generates embeddings, and stores them in the unified
 * sqlite-vec database.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, insertExchange } from './db.js';
import { initEmbeddings, generateExchangeEmbedding } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { ConversationExchange, ConversationSource, AgentSource } from './types.js';
import { getArchiveDir, getExcludedProjects } from './paths.js';
import { getAllSources } from './parsers/index.js';

// Re-export parseConversation for backward compatibility
export { parseClaudeConversation as parseConversation } from './parsers/claude.js';

// Set max output tokens for Claude SDK (used by summarizer)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';

import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

// Allow overriding paths for testing
function getProjectsDir(): string {
  return process.env.TEST_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

// Process items in batches with limited concurrency
async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

// ── Backward-compatible Claude-only indexing (retained for existing callers) ──

export async function indexConversations(
  limitToProject?: string,
  maxConversations?: number,
  concurrency: number = 1,
  noSummaries: boolean = false
): Promise<void> {
  console.log('Initializing database...');
  const db = initDatabase();

  console.log('Loading embedding model...');
  await initEmbeddings();

  if (noSummaries) {
    console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
  }

  console.log('Scanning for conversation files...');
  const PROJECTS_DIR = getProjectsDir();
  const ARCHIVE_DIR = getArchiveDir();
  const projects = fs.readdirSync(PROJECTS_DIR);

  let totalExchanges = 0;
  let conversationsProcessed = 0;

  const excludedProjects = getExcludedProjects();

  for (const project of projects) {
    if (excludedProjects.includes(project)) {
      console.log(`\nSkipping excluded project: ${project}`);
      continue;
    }

    if (limitToProject && project !== limitToProject) continue;
    const projectPath = path.join(PROJECTS_DIR, project);
    const stat = fs.statSync(projectPath);

    if (!stat.isDirectory()) continue;

    const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

    if (files.length === 0) continue;

    console.log(`\nProcessing project: ${project} (${files.length} conversations)`);
    if (concurrency > 1) console.log(`  Concurrency: ${concurrency}`);

    const projectArchive = path.join(ARCHIVE_DIR, project);
    fs.mkdirSync(projectArchive, { recursive: true });

    type ConvToProcess = {
      file: string;
      sourcePath: string;
      archivePath: string;
      summaryPath: string;
      exchanges: ConversationExchange[];
    };

    const { parseClaudeConversation } = await import('./parsers/claude.js');
    const toProcess: ConvToProcess[] = [];

    for (const file of files) {
      const sourcePath = path.join(projectPath, file);
      const archivePath = path.join(projectArchive, file);

      if (!fs.existsSync(archivePath)) {
        fs.copyFileSync(sourcePath, archivePath);
        console.log(`  Archived: ${file}`);
      }

      const exchanges = await parseClaudeConversation(sourcePath, project, archivePath);

      if (exchanges.length === 0) {
        console.log(`  Skipped ${file} (no exchanges)`);
        continue;
      }

      toProcess.push({
        file,
        sourcePath,
        archivePath,
        summaryPath: archivePath.replace('.jsonl', '-summary.txt'),
        exchanges
      });
    }

    if (!noSummaries) {
      const needsSummary = toProcess.filter(c => !fs.existsSync(c.summaryPath));

      if (needsSummary.length > 0) {
        console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);

        await processBatch(needsSummary, async (conv) => {
          try {
            const summary = await summarizeConversation(conv.exchanges);
            fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
            const wordCount = summary.split(/\s+/).length;
            console.log(`  ✓ ${conv.file}: ${wordCount} words`);
            return summary;
          } catch (error) {
            console.log(`  ✗ ${conv.file}: ${error}`);
            return null;
          }
        }, concurrency);
      }
    } else {
      console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
    }

    for (const conv of toProcess) {
      for (const exchange of conv.exchanges) {
        const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
        const embedding = await generateExchangeEmbedding(
          exchange.userMessage,
          exchange.assistantMessage,
          toolNames
        );

        insertExchange(db, exchange, embedding, toolNames);
      }

      totalExchanges += conv.exchanges.length;
      conversationsProcessed++;

      if (maxConversations && conversationsProcessed >= maxConversations) {
        console.log(`\nReached limit of ${maxConversations} conversations`);
        db.close();
        console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
        return;
      }
    }
  }

  db.close();
  console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
}

// ── Multi-source indexing ──

/**
 * Index conversations from all registered sources (Claude, Gemini, Pi).
 * This is the primary entry point for the unified indexer.
 */
export async function indexAllSources(
  options: {
    sources?: AgentSource[];
    concurrency?: number;
    noSummaries?: boolean;
    maxConversations?: number;
  } = {}
): Promise<void> {
  const {
    sources: requestedSources,
    concurrency = 1,
    noSummaries = false,
    maxConversations
  } = options;

  console.log('Initializing database...');
  const db = initDatabase();

  console.log('Loading embedding model...');
  await initEmbeddings();

  if (noSummaries) {
    console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
  }

  const allSources = getAllSources();
  const activeSources = requestedSources
    ? allSources.filter(s => requestedSources.includes(s.name))
    : allSources;

  let totalExchanges = 0;
  let totalConversations = 0;

  for (const source of activeSources) {
    console.log(`\n━━━ Scanning source: ${source.label} ━━━`);

    let conversations: Array<{ project: string; filePath: string }>;
    try {
      conversations = await source.discoverConversations();
    } catch (error) {
      console.log(`  ⚠️  Discovery failed: ${error}`);
      continue;
    }

    if (conversations.length === 0) {
      console.log(`  No conversations found.`);
      continue;
    }

    console.log(`  Found ${conversations.length} conversation files`);

    // Group by project for cleaner output
    const byProject = new Map<string, typeof conversations>();
    for (const conv of conversations) {
      const arr = byProject.get(conv.project) || [];
      arr.push(conv);
      byProject.set(conv.project, arr);
    }

    for (const [project, convs] of byProject) {
      console.log(`\n  [${source.name}] Project: ${project} (${convs.length} files)`);

      // Archive directory for this source+project
      const archiveDir = path.join(getArchiveDir(), `${source.name}`, project);
      fs.mkdirSync(archiveDir, { recursive: true });

      for (const conv of convs) {
        const fileName = path.basename(conv.filePath);
        const archivePath = path.join(archiveDir, fileName);

        // Skip already-indexed files
        const alreadyIndexed = db.prepare(
          'SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?'
        ).get(archivePath) as { count: number };

        if (alreadyIndexed.count > 0) continue;

        // Copy to archive
        if (!fs.existsSync(archivePath)) {
          fs.copyFileSync(conv.filePath, archivePath);
        }

        let exchanges: ConversationExchange[];
        try {
          exchanges = await source.parseConversation(conv.filePath, project, archivePath);
        } catch (error) {
          console.log(`    ✗ Parse error ${fileName}: ${error}`);
          continue;
        }

        if (exchanges.length === 0) continue;

        // Generate summary if enabled
        if (!noSummaries) {
          const ext = path.extname(fileName);
          const summaryPath = path.join(archiveDir, fileName.replace(ext, '-summary.txt'));
          if (!fs.existsSync(summaryPath)) {
            try {
              const summary = await summarizeConversation(exchanges);
              fs.writeFileSync(summaryPath, summary, 'utf-8');
            } catch (error) {
              // Non-fatal: continue without summary
            }
          }
        }

        // Embed and store
        for (const exchange of exchanges) {
          const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage,
            exchange.assistantMessage,
            toolNames
          );
          insertExchange(db, exchange, embedding, toolNames);
        }

        totalExchanges += exchanges.length;
        totalConversations++;

        if (maxConversations && totalConversations >= maxConversations) {
          console.log(`\n  Reached limit of ${maxConversations} conversations`);
          db.close();
          console.log(`\n✅ Multi-source indexing complete! Sources: ${activeSources.length}, Conversations: ${totalConversations}, Exchanges: ${totalExchanges}`);
          return;
        }
      }
    }
  }

  db.close();
  console.log(`\n✅ Multi-source indexing complete! Sources: ${activeSources.length}, Conversations: ${totalConversations}, Exchanges: ${totalExchanges}`);
}

// ── indexUnprocessed (updated for multi-source) ──

export async function indexUnprocessed(concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log('Finding unprocessed conversations across all sources...');
  if (concurrency > 1) console.log(`Concurrency: ${concurrency}`);
  if (noSummaries) console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');

  const db = initDatabase();
  await initEmbeddings();

  const allSources = getAllSources();

  type UnprocessedConv = {
    source: ConversationSource;
    project: string;
    filePath: string;
    archivePath: string;
    summaryPath: string;
    exchanges: ConversationExchange[];
  };

  const unprocessed: UnprocessedConv[] = [];

  for (const source of allSources) {
    let conversations: Array<{ project: string; filePath: string }>;
    try {
      conversations = await source.discoverConversations();
    } catch {
      continue;
    }

    for (const conv of conversations) {
      const archiveDir = path.join(getArchiveDir(), source.name, conv.project);
      const fileName = path.basename(conv.filePath);
      const archivePath = path.join(archiveDir, fileName);
      const ext = path.extname(fileName);
      const summaryPath = path.join(archiveDir, fileName.replace(ext, '-summary.txt'));

      const alreadyIndexed = db.prepare(
        'SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?'
      ).get(archivePath) as { count: number };

      if (alreadyIndexed.count > 0) continue;

      fs.mkdirSync(archiveDir, { recursive: true });

      if (!fs.existsSync(archivePath)) {
        fs.copyFileSync(conv.filePath, archivePath);
      }

      let exchanges: ConversationExchange[];
      try {
        exchanges = await source.parseConversation(conv.filePath, conv.project, archivePath);
      } catch {
        continue;
      }
      if (exchanges.length === 0) continue;

      unprocessed.push({ source, project: conv.project, filePath: conv.filePath, archivePath, summaryPath, exchanges });
    }
  }

  if (unprocessed.length === 0) {
    console.log('✅ All conversations are already processed!');
    db.close();
    return;
  }

  console.log(`Found ${unprocessed.length} unprocessed conversations`);

  // Summaries
  if (!noSummaries) {
    const needsSummary = unprocessed.filter(c => !fs.existsSync(c.summaryPath));
    if (needsSummary.length > 0) {
      console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);

      await processBatch(needsSummary, async (conv) => {
        try {
          const summary = await summarizeConversation(conv.exchanges);
          fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
          const wordCount = summary.split(/\s+/).length;
          console.log(`  ✓ [${conv.source.name}] ${conv.project}: ${wordCount} words`);
          return summary;
        } catch (error) {
          console.log(`  ✗ [${conv.source.name}] ${conv.project}: ${error}`);
          return null;
        }
      }, concurrency);
    }
  } else {
    console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
  }

  // Index embeddings
  console.log(`\nIndexing embeddings...`);
  for (const conv of unprocessed) {
    for (const exchange of conv.exchanges) {
      const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
      const embedding = await generateExchangeEmbedding(
        exchange.userMessage,
        exchange.assistantMessage,
        toolNames
      );
      insertExchange(db, exchange, embedding, toolNames);
    }
  }

  db.close();
  console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}

// ── indexSession (retained for backward compat) ──

export async function indexSession(sessionId: string, concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log(`Indexing session: ${sessionId}`);

  const PROJECTS_DIR = getProjectsDir();
  const ARCHIVE_DIR = getArchiveDir();
  const projects = fs.readdirSync(PROJECTS_DIR);
  const excludedProjects = getExcludedProjects();
  let found = false;

  const { parseClaudeConversation } = await import('./parsers/claude.js');

  for (const project of projects) {
    if (excludedProjects.includes(project)) continue;

    const projectPath = path.join(PROJECTS_DIR, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const files = fs.readdirSync(projectPath).filter(f => f.includes(sessionId) && f.endsWith('.jsonl'));

    if (files.length > 0) {
      found = true;
      const file = files[0];
      const sourcePath = path.join(projectPath, file);

      const db = initDatabase();
      await initEmbeddings();

      const projectArchive = path.join(ARCHIVE_DIR, project);
      fs.mkdirSync(projectArchive, { recursive: true });

      const archivePath = path.join(projectArchive, file);

      if (!fs.existsSync(archivePath)) {
        fs.copyFileSync(sourcePath, archivePath);
      }

      const exchanges = await parseClaudeConversation(sourcePath, project, archivePath);

      if (exchanges.length > 0) {
        const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
        if (!noSummaries && !fs.existsSync(summaryPath)) {
          const summary = await summarizeConversation(exchanges);
          fs.writeFileSync(summaryPath, summary, 'utf-8');
          console.log(`Summary: ${summary.split(/\s+/).length} words`);
        }

        for (const exchange of exchanges) {
          const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage,
            exchange.assistantMessage,
            toolNames
          );
          insertExchange(db, exchange, embedding, toolNames);
        }

        console.log(`✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`);
      }

      db.close();
      break;
    }
  }

  if (!found) {
    console.log(`Session ${sessionId} not found`);
  }
}
