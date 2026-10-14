import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, insertExchange, deleteExchange } from './db.js';
import { parseConversation } from './parser.js';
import { initEmbeddings, generateExchangeEmbedding } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { ConversationExchange, ConversationSource, AgentSource } from './types.js';
import { getAllSources } from './parsers/index.js';
import { getArchiveDir, getExcludedProjects, getConversationSourceDirs, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, shouldQueueForSummary } from './summary-sentinel.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';

// Set max output tokens for Claude SDK (used by summarizer)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';

// Increase max listeners for concurrent API calls
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;

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

function sessionIdForSummary(exchanges: ConversationExchange[]): string | undefined {
  return exchanges.find(exchange => exchange.sessionId)?.sessionId;
}

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

  const maxMessageBytes = getMaxMessageBytes();
  let oversizeSkipped = 0;

  if (noSummaries) {
    console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
  }

  console.log('Scanning for conversation files...');
  const sourceDirs = getConversationSourceDirs();
  const ARCHIVE_DIR = getArchiveDir();

  let totalExchanges = 0;
  let conversationsProcessed = 0;

  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);

  for (const sourceDir of sourceDirs) {
  const projects = fs.readdirSync(sourceDir);

  for (const project of projects) {
    // Skip excluded projects
    if (excludedProjects.includes(project)) {
      console.log(`\nSkipping excluded project: ${project}`);
      continue;
    }

    // Skip if limiting to specific project
    if (limitToProject && project !== limitToProject) continue;
    const projectPath = path.join(sourceDir, project);
    const stat = statIfExists(projectPath);

    if (!stat?.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet);

    if (files.length === 0) continue;

    console.log(`\nProcessing project: ${project} (${files.length} conversations)`);
    if (concurrency > 1) console.log(`  Concurrency: ${concurrency}`);

    // Create archive directory for this project
    const projectArchive = path.join(ARCHIVE_DIR, project);
    fs.mkdirSync(projectArchive, { recursive: true });

    // Prepare all conversations first
    type ConvToProcess = {
      file: string;
      sourcePath: string;
      archivePath: string;
      summaryPath: string;
      exchanges: ConversationExchange[];
    };

    const toProcess: ConvToProcess[] = [];

    for (const file of files) {
      const sourcePath = path.join(projectPath, file);
      const archivePath = path.join(projectArchive, file);

      // Source transcripts can vanish mid-run (Claude Code cleanup). Skip loudly.
      let exchanges;
      try {
        // Copy to archive (ensure parent dirs exist for subagent files)
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.copyFileSync(sourcePath, archivePath);
          console.log(`  Archived: ${file}`);
        }

        // Parse conversation
        exchanges = await parseConversation(sourcePath, project, archivePath);
      } catch (error) {
        console.log(`  Skipped ${file} (read failed: ${error instanceof Error ? error.message : error})`);
        continue;
      }

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

    // Batch summarize conversations in parallel (unless --no-summaries)
    if (!noSummaries) {
      const needsSummary = toProcess.filter(c => shouldQueueForSummary(c.summaryPath));

      if (needsSummary.length > 0) {
        console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);

        await processBatch(needsSummary, async (conv) => {
          try {
            const summary = await summarizeConversation(conv.exchanges, sessionIdForSummary(conv.exchanges));
            fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
            const wordCount = summary.split(/\s+/).length;
            console.log(`  ✓ ${conv.file}: ${wordCount} words`);
            return summary;
          } catch (error) {
            // Write an error sentinel so the failure is retryable on a later run (#96).
            try { fs.writeFileSync(conv.summaryPath, formatErrorSentinel(error), 'utf-8'); } catch {}
            console.log(`  ✗ ${conv.file}: ${error}`);
            return null;
          }
        }, concurrency);
      }
    } else {
      console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
    }

    // Now process embeddings and DB inserts (fast, sequential is fine)
    for (const conv of toProcess) {
      for (const exchange of conv.exchanges) {
        // Skip oversize single messages BEFORE embedding — a foreign
        // summarizer's pasted transcript is noise, and embedding it is the
        // expensive waste (#139).
        if (isOversizeExchange(exchange, maxMessageBytes)) {
          oversizeSkipped++;
          continue;
        }
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

      // Check if we hit the limit
      if (maxConversations && conversationsProcessed >= maxConversations) {
        console.log(`\nReached limit of ${maxConversations} conversations`);
        db.close();
        console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
        return;
      }
    }
  }
  } // end sourceDir loop

  if (oversizeSkipped > 0) {
    console.log(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set EPISODIC_MEMORY_MAX_MESSAGE_BYTES to change) — likely embedded-transcript payloads (#139)`);
  }

  db.close();
  console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
}

/**
 * Index conversations from all non-Claude sources (Gemini, Pi, OpenCode).
 *
 * Claude Code and Codex are covered by indexConversations() / indexUnprocessed()
 * which use the upstream-maintained getConversationSourceDirs() pipeline with
 * high-water-mark incremental indexing and summary-sentinel retry.
 * This function extends coverage to the remaining sources via the
 * ConversationSource registry.
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
    maxConversations,
  } = options;

  console.log('Initializing database...');
  const db = initDatabase();

  console.log('Loading embedding model...');
  await initEmbeddings();

  if (noSummaries) {
    console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
  }

  // Default to non-Claude sources; Claude+Codex are handled by indexConversations().
  const defaultSources: AgentSource[] = ['gemini', 'pi', 'opencode'];
  const allSources = getAllSources();
  const activeSources = requestedSources
    ? allSources.filter(s => requestedSources.includes(s.name))
    : allSources.filter(s => defaultSources.includes(s.name));

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
      console.log('  No conversations found.');
      continue;
    }

    console.log(`  Found ${conversations.length} conversation files`);

    const byProject = new Map<string, typeof conversations>();
    for (const conv of conversations) {
      const arr = byProject.get(conv.project) || [];
      arr.push(conv);
      byProject.set(conv.project, arr);
    }

    for (const [project, convs] of byProject) {
      console.log(`\n  [${source.name}] Project: ${project} (${convs.length} files)`);

      const archiveDir = path.join(getArchiveDir(), source.name, project);
      fs.mkdirSync(archiveDir, { recursive: true });

      for (const conv of convs) {
        const fileName = path.basename(conv.filePath);
        const archivePath = path.join(archiveDir, fileName);

        const alreadyIndexed = db.prepare(
          'SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?'
        ).get(archivePath) as { count: number };
        if (alreadyIndexed.count > 0) continue;

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

        if (!noSummaries) {
          const ext = path.extname(fileName);
          const summaryPath = path.join(archiveDir, fileName.replace(ext, '-summary.txt'));
          if (!fs.existsSync(summaryPath)) {
            try {
              const summary = await summarizeConversation(exchanges);
              fs.writeFileSync(summaryPath, summary, 'utf-8');
            } catch (_err) {
              // Non-fatal: continue without summary
            }
          }
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

export async function indexSession(sessionId: string, concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log(`Indexing session: ${sessionId}`);

  // Find the conversation file for this session
  const sourceDirs = getConversationSourceDirs();
  const ARCHIVE_DIR = getArchiveDir();
  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);
  let found = false;

  for (const sourceDir of sourceDirs) {
  const projects = fs.readdirSync(sourceDir);

  for (const project of projects) {
    if (excludedProjects.includes(project)) continue;

    const projectPath = path.join(sourceDir, project);
    if (!statIfExists(projectPath)?.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet).filter(f => f.includes(sessionId));

    if (files.length > 0) {
      found = true;
      const file = files[0];
      const sourcePath = path.join(projectPath, file);

      const db = initDatabase();
      await initEmbeddings();

      const projectArchive = path.join(ARCHIVE_DIR, project);
      fs.mkdirSync(projectArchive, { recursive: true });

      const archivePath = path.join(projectArchive, file);

      // Archive + parse — source may vanish mid-run (Claude Code cleanup).
      let exchanges;
      try {
        if (!fs.existsSync(archivePath)) {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.copyFileSync(sourcePath, archivePath);
        }
        exchanges = await parseConversation(sourcePath, project, archivePath);
      } catch (error) {
        console.log(`Skipped ${file} (read failed: ${error instanceof Error ? error.message : error})`);
        db.close();
        break;
      }

      if (exchanges.length > 0) {
        // Generate summary (unless --no-summaries)
        const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
        if (!noSummaries && shouldQueueForSummary(summaryPath)) {
          fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
          try {
            const summary = await summarizeConversation(exchanges, sessionIdForSummary(exchanges));
            fs.writeFileSync(summaryPath, summary, 'utf-8');
            console.log(`Summary: ${summary.split(/\s+/).length} words`);
          } catch (error) {
            // Write an error sentinel so the failure is retryable on a later run (#96).
            try { fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8'); } catch {}
            console.log(`Summary failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Index
        const maxMessageBytes = getMaxMessageBytes();
        let oversizeSkipped = 0;
        for (const exchange of exchanges) {
          // Skip oversize single messages BEFORE embedding — a foreign
          // summarizer's pasted transcript is noise, and embedding it is the
          // expensive waste (#139).
          if (isOversizeExchange(exchange, maxMessageBytes)) {
            oversizeSkipped++;
            continue;
          }
          const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage,
            exchange.assistantMessage,
            toolNames
          );
          insertExchange(db, exchange, embedding, toolNames);
        }

        if (oversizeSkipped > 0) {
          console.log(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set EPISODIC_MEMORY_MAX_MESSAGE_BYTES to change) — likely embedded-transcript payloads (#139)`);
        }

        console.log(`✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`);
      }

      db.close();
      break;
    }
  }
  if (found) break;
  } // end sourceDir loop

  if (!found) {
    console.log(`Session ${sessionId} not found`);
  }
}

export async function indexUnprocessed(concurrency: number = 1, noSummaries: boolean = false): Promise<void> {
  console.log('Finding unprocessed conversations...');
  if (concurrency > 1) console.log(`Concurrency: ${concurrency}`);
  if (noSummaries) console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');

  const db = initDatabase();
  await initEmbeddings();

  const sourceDirs = getConversationSourceDirs();
  const ARCHIVE_DIR = getArchiveDir();
  const excludedProjects = getExcludedProjects();
  const excludedDirSet = new Set(excludedProjects);

  type UnprocessedConv = {
    project: string;
    file: string;
    sourcePath: string;
    archivePath: string;
    summaryPath: string;
    exchanges: ConversationExchange[];
    // Defined only for OMP, whose active path can abandon already indexed turns.
    abandonedOmpIds?: string[];
  };

  const unprocessed: UnprocessedConv[] = [];

  // Collect all unprocessed conversations from all source dirs
  for (const sourceDir of sourceDirs) {
  const projects = fs.readdirSync(sourceDir);

  for (const project of projects) {
    if (excludedProjects.includes(project)) continue;

    const projectPath = path.join(sourceDir, project);
    if (!statIfExists(projectPath)?.isDirectory()) continue;

    const files = findJsonlFiles(projectPath, excludedDirSet);

    for (const file of files) {
      const sourcePath = path.join(projectPath, file);
      const projectArchive = path.join(ARCHIVE_DIR, project);
      const archivePath = path.join(projectArchive, file);
      const summaryPath = archivePath.replace('.jsonl', '-summary.txt');

      // Append-only harnesses resume past the last indexed line. OMP instead
      // reconciles the parsed active path below: regeneration can reuse a user line.
      const hw = db.prepare(
        'SELECT COALESCE(MAX(line_end), 0) as maxLine FROM exchanges WHERE archive_path = ?'
      ).get(archivePath) as { maxLine: number };
      const maxIndexedLine = hw.maxLine;

      // Ensure parent dirs exist for subagent files
      try {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });

        // Refresh the archive when the source may have grown beyond what we've seen.
        const archiveRefreshed = !fs.existsSync(archivePath) || maxIndexedLine > 0;
        if (archiveRefreshed) {
          fs.copyFileSync(sourcePath, archivePath);
        }

        const exchanges = await parseConversation(sourcePath, project, archivePath);
        const indexedOmp = db.prepare(`
          SELECT id, user_message AS userMessage, assistant_message AS assistantMessage,
                 line_start AS lineStart, line_end AS lineEnd
          FROM exchanges WHERE archive_path = ? AND harness = 'omp'
        `).all(archivePath) as Array<Pick<ConversationExchange,
          'id' | 'userMessage' | 'assistantMessage' | 'lineStart' | 'lineEnd'>>;

        // An empty parsed path has no harness metadata. Previously indexed OMP
        // rows identify deletion-only reconciliation (e.g. a new unanswered root).
        const reconcileOmp = exchanges.some(e => e.harness === 'omp') ||
          (exchanges.length === 0 && indexedOmp.length > 0);
        if (reconcileOmp) {
          // All rows may have been removed by an empty/oversize active path.
          if (!archiveRefreshed) fs.copyFileSync(sourcePath, archivePath);
          const activeIds = new Set(exchanges.map(e => e.id));
          const abandonedOmpIds = indexedOmp.filter(e => !activeIds.has(e.id)).map(e => e.id);
          const indexedById = new Map(indexedOmp.map(e => [e.id, e]));
          const changed = exchanges.filter(e => {
            const old = indexedById.get(e.id);
            return !old || old.userMessage !== e.userMessage || old.assistantMessage !== e.assistantMessage ||
              old.lineStart !== e.lineStart || old.lineEnd !== e.lineEnd;
          });
          if (changed.length > 0 || abandonedOmpIds.length > 0) {
            unprocessed.push({ project, file, sourcePath, archivePath, summaryPath,
              exchanges: changed, abandonedOmpIds });
          }
        } else {
          const newExchanges = maxIndexedLine > 0
            ? exchanges.filter(e => e.lineStart > maxIndexedLine)
            : exchanges;
          if (newExchanges.length === 0) continue;
          unprocessed.push({ project, file, sourcePath, archivePath, summaryPath, exchanges: newExchanges });
        }
      } catch (error) {
        console.log(`  Skipped ${file} (read failed: ${error instanceof Error ? error.message : error})`);
        continue;
      }
    }
  }
  } // end sourceDir loop

  if (unprocessed.length === 0) {
    console.log('✅ All conversations are already processed!');
    db.close();
    return;
  }

  console.log(`Found ${unprocessed.length} unprocessed conversations`);

  // Batch process summaries (unless --no-summaries)
  if (!noSummaries) {
    const needsSummary = unprocessed.filter(c => c.exchanges.length > 0 && shouldQueueForSummary(c.summaryPath));
    if (needsSummary.length > 0) {
      console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);

      await processBatch(needsSummary, async (conv) => {
        try {
          const summary = await summarizeConversation(conv.exchanges, sessionIdForSummary(conv.exchanges));
          fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
          const wordCount = summary.split(/\s+/).length;
          console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
          return summary;
        } catch (error) {
          // Write an error sentinel so the failure is retryable on a later run (#96).
          try { fs.writeFileSync(conv.summaryPath, formatErrorSentinel(error), 'utf-8'); } catch {}
          console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
          return null;
        }
      }, concurrency);
    }
  } else {
    console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
  }

  // Now index embeddings
  console.log(`\nIndexing embeddings...`);
  const maxMessageBytes = getMaxMessageBytes();
  let oversizeSkipped = 0;
  for (const conv of unprocessed) {
    if (conv.abandonedOmpIds !== undefined) {
      try {
        const prepared: Array<{
          exchange: ConversationExchange; embedding: number[]; toolNames?: string[];
        }> = [];
        const removeIds = new Set(conv.abandonedOmpIds);
        for (const exchange of conv.exchanges) {
          if (isOversizeExchange(exchange, maxMessageBytes)) {
            oversizeSkipped++;
            // Also exclude an old row if its stable ID now contains oversize text.
            removeIds.add(exchange.id);
            continue;
          }
          const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage, exchange.assistantMessage, toolNames
          );
          const vector = new Float32Array(embedding);
          if (vector.length !== 384 || !vector.every(Number.isFinite)) {
            throw new Error(`Invalid OMP embedding for exchange ${exchange.id}`);
          }
          prepared.push({ exchange, embedding, toolNames });
        }

        // No writes until every replacement embedding is ready. The existing
        // helpers handle vectors and FK tool-call cleanup; the outer transaction
        // rolls back the entire archive if any insert or delete fails.
        db.transaction(() => {
          for (const { exchange, embedding, toolNames } of prepared) {
            insertExchange(db, exchange, embedding, toolNames);
          }
          for (const id of removeIds) {
            if (db.prepare(`SELECT id FROM exchanges
                WHERE id = ? AND archive_path = ? AND harness = 'omp'`).get(id, conv.archivePath)) {
              deleteExchange(db, id);
            }
          }
        })();
      } catch (error) {
        db.close();
        throw error;
      }
      continue;
    }

    for (const exchange of conv.exchanges) {
      // Skip oversize single messages BEFORE embedding — a foreign
      // summarizer's pasted transcript is noise, and embedding it is the
      // expensive waste (#139).
      if (isOversizeExchange(exchange, maxMessageBytes)) {
        oversizeSkipped++;
        continue;
      }
      const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
      const embedding = await generateExchangeEmbedding(
        exchange.userMessage,
        exchange.assistantMessage,
        toolNames
      );
      insertExchange(db, exchange, embedding, toolNames);
    }
  }

  if (oversizeSkipped > 0) {
    console.log(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set EPISODIC_MEMORY_MAX_MESSAGE_BYTES to change) — likely embedded-transcript payloads (#139)`);
  }

  db.close();
  console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}
