import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export declare function migrateSchema(db: Database.Database): void;
/**
 * Earlier versions created `tool_calls` with a plain
 * `FOREIGN KEY (exchange_id) REFERENCES exchanges(id)`.
 * Without ON DELETE CASCADE, deleting an exchange that had tool calls
 * raised SQLITE_CONSTRAINT_FOREIGNKEY (#81), and orphans accumulated.
 *
 * This migration:
 *   1. Detects the legacy schema by inspecting sqlite_master.sql.
 *   2. Drops orphaned tool_calls rows.
 *   3. Recreates the table with ON DELETE CASCADE and copies surviving rows.
 */
export declare function migrateToolCallsCascade(db: Database.Database): void;
export declare function initDatabase(): Database.Database;
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export declare function deleteExchange(db: Database.Database, id: string): void;
/**
 * Delete every indexed exchange (row and vector) for an archive file except
 * the ids in keepIds. Used when re-indexing, so exchanges that no longer exist
 * or are no longer eligible for indexing do not remain searchable.
 */
export declare function deleteStaleExchangesForArchive(db: Database.Database, archivePath: string, keepIds: ReadonlySet<string>): number;
/**
 * Atomically replace an archive's indexed exchanges: delete every row (and
 * vector) whose id is not among the replacements, then insert the replacements.
 * Embeddings must be prepared by the caller first; if any delete or insert
 * fails the whole archive rolls back to its previous rows. Returns the number
 * of stale exchanges removed.
 */
export declare function replaceExchangesForArchive(db: Database.Database, archivePath: string, replacements: ReadonlyArray<{
    exchange: ConversationExchange;
    embedding: number[];
    toolNames?: string[];
}>): number;
