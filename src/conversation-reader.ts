import { constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { formatConversationAsMarkdown } from './show.js';

const MAX_LINES = 40;
const MAX_SELECTED_INPUT_BYTES = 64 * 1024;
const MAX_FORMATTED_OUTPUT_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const READ_DEADLINE_MS = 5_000;
const READ_CHUNK_BYTES = 16 * 1024;

export type ConversationReadErrorCode =
  | 'path_outside_archive'
  | 'file_not_found'
  | 'symlink_not_allowed'
  | 'not_regular_jsonl'
  | 'invalid_line_window'
  | 'line_window_too_large'
  | 'selected_input_too_large'
  | 'formatted_output_too_large'
  | 'scan_limit_exceeded'
  | 'read_deadline_exceeded'
  | 'invalid_jsonl'
  | 'unverifiable_archive_header'
  | 'read_failed';

export class ConversationReadError extends Error {
  constructor(
    public readonly code: ConversationReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationReadError';
  }
}

export interface ConversationReadRequest {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ConversationReadResult {
  path: string;
  startLine: number;
  endLine: number;
  linesRead: number;
  markdown: string;
}

export interface ConversationReader {
  readConversation(request: ConversationReadRequest, signal?: AbortSignal): Promise<ConversationReadResult>;
}

function abortError(): Error {
  const error = new Error('Conversation read cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function validateLineWindow(startLine: number, endLine: number): void {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < 1 ||
    endLine < startLine
  ) {
    throw new ConversationReadError(
      'invalid_line_window',
      'startLine and endLine must be safe integers with 1 <= startLine <= endLine.',
    );
  }
  if (endLine - startLine + 1 > MAX_LINES) {
    throw new ConversationReadError('line_window_too_large', `A read may select at most ${MAX_LINES} lines.`);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveCandidate(configuredRoot: string, canonicalRoot: string, requestedPath: string): string {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    throw new ConversationReadError('path_outside_archive', 'Conversation path must be absolute and inside the archive.');
  }

  const requestedAbsolute = path.resolve(requestedPath);
  if (!isWithinRoot(configuredRoot, requestedAbsolute)) {
    throw new ConversationReadError('path_outside_archive', 'Conversation path is outside the approved archive.');
  }

  const relative = path.relative(configuredRoot, requestedAbsolute);
  const candidate = path.resolve(canonicalRoot, relative);
  if (!isWithinRoot(canonicalRoot, candidate)) {
    throw new ConversationReadError('path_outside_archive', 'Conversation path is outside the approved archive.');
  }
  if (path.extname(candidate) !== '.jsonl') {
    throw new ConversationReadError('not_regular_jsonl', 'Conversation path must name a regular .jsonl file.');
  }
  return candidate;
}

function rejectSymlinkComponents(canonicalRoot: string, candidate: string, signal?: AbortSignal): void {
  const relative = path.relative(canonicalRoot, candidate);
  let current = canonicalRoot;
  for (const component of relative.split(path.sep)) {
    if (!component) continue;
    throwIfAborted(signal);
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw new ConversationReadError('file_not_found', 'Conversation file was not found in the archive.');
      }
      throw new ConversationReadError('read_failed', 'Conversation path could not be validated.');
    }
    if (stat.isSymbolicLink()) {
      throw new ConversationReadError('symlink_not_allowed', 'Symlinks are not allowed in conversation archive paths.');
    }
    if (current === candidate && !stat.isFile()) {
      throw new ConversationReadError('not_regular_jsonl', 'Conversation path must name a regular .jsonl file.');
    }
  }
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new ConversationReadError('read_deadline_exceeded', 'Conversation read exceeded its fixed deadline.');
  }
}

interface TrustedOmpHeaderMetadata {
  type: 'session';
}

function isTitleSlot(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === 'title';
  } catch {
    return false;
  }
}

// A numeric `version` normally marks a Pi session header. Current OMP also
// writes `version: 3`, but only after its fixed-width title slot, which Pi never
// writes, so the numeric form is trusted only when allowNumericVersion is set.
function parseTrustedOmpHeader(line: string, allowNumericVersion = false): TrustedOmpHeaderMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const header = parsed as Record<string, unknown>;
  if (
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    header.id.length === 0 ||
    (typeof header.version === 'number' && !allowNumericVersion) ||
    'payload' in header ||
    'session' in header
  ) {
    return undefined;
  }
  for (const field of ['timestamp', 'cwd'] as const) {
    if (field in header && typeof header[field] !== 'string') return undefined;
  }

  // Retain only the structural discriminator. Header strings and any unknown
  // fields are never forwarded into the selected message window.
  return { type: 'session' };
}

/**
 * Create a reader whose trust boundary is fixed once, at extension startup.
 * Limits are intentionally constants rather than caller-controlled options.
 */
export function createConversationReader(archiveRoot: string): ConversationReader {
  const configuredRoot = path.resolve(archiveRoot);
  const canonicalRoot = realpathSync(configuredRoot);

  return {
    async readConversation(request: ConversationReadRequest, signal?: AbortSignal): Promise<ConversationReadResult> {
      throwIfAborted(signal);
      const deadline = Date.now() + READ_DEADLINE_MS;
      validateLineWindow(request.startLine, request.endLine);
      const candidate = resolveCandidate(configuredRoot, canonicalRoot, request.path);
      rejectSymlinkComponents(canonicalRoot, candidate, signal);
      throwIfAborted(signal);
      checkDeadline(deadline);

      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      const nonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;
      let file;
      try {
        // A target can change to a FIFO after validation. Non-blocking open
        // lets the descriptor check reject it without waiting for a writer.
        file = await open(candidate, fsConstants.O_RDONLY | noFollow | nonBlock);
      } catch (error: any) {
        if (error?.code === 'ELOOP') {
          throw new ConversationReadError('symlink_not_allowed', 'Symlinks are not allowed in conversation archive paths.');
        }
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          throw new ConversationReadError('file_not_found', 'Conversation file was not found in the archive.');
        }
        throw new ConversationReadError('read_failed', 'Conversation file could not be opened safely.');
      }

      try {
        throwIfAborted(signal);
        checkDeadline(deadline);
        const openedStat = await file.stat();
        if (!openedStat.isFile()) {
          throw new ConversationReadError('not_regular_jsonl', 'Conversation path must name a regular .jsonl file.');
        }

        // O_NOFOLLOW protects the final component where available. Comparing
        // the open descriptor with the current path identity also closes the
        // practical rename/replacement race on platforms without it.
        const currentStat = lstatSync(candidate);
        if (
          currentStat.isSymbolicLink() ||
          currentStat.dev !== openedStat.dev ||
          currentStat.ino !== openedStat.ino
        ) {
          throw new ConversationReadError('symlink_not_allowed', 'Conversation path changed during secure open.');
        }
        const currentCanonical = realpathSync(candidate);
        if (!isWithinRoot(canonicalRoot, currentCanonical)) {
          throw new ConversationReadError('path_outside_archive', 'Conversation path escaped the approved archive.');
        }

        const selectedLines: string[] = [];
        let selectedBytes = 0;
        let currentLine = 1;
        let scannedBytes = 0;
        let selectedLineParts: Buffer[] = [];
        let headerLineParts: Buffer[] = [];
        let headerBytes = 0;
        let trustedOmpHeader: TrustedOmpHeaderMetadata | undefined;
        let trustedOmpHeaderLine = 0;
        let hasLeadingTitleSlot = false;
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let reachedEnd = false;

        const appendHeader = (part: Buffer): void => {
          if (part.length === 0) return;
          if (headerBytes <= MAX_SELECTED_INPUT_BYTES) {
            headerBytes += part.length;
            if (headerBytes <= MAX_SELECTED_INPUT_BYTES) headerLineParts.push(Buffer.from(part));
          }
          // After a title slot, line 2 decides whether this is an OMP archive.
          // If it is too large to inspect, fail closed: guessing Pi here would
          // render private OMP thinking blocks. This runs before the selection
          // accounting so it takes precedence over selected_input_too_large
          // when line 2 is itself inside the selected window.
          if (currentLine === 2 && hasLeadingTitleSlot && headerBytes > MAX_SELECTED_INPUT_BYTES) {
            throw new ConversationReadError(
              'unverifiable_archive_header',
              'Archive session header after the title slot exceeds the 64 KiB inspection limit.',
            );
          }
        };

        // Once the selection cap is hit, stop buffering and defer the error:
        // a title slot on line 1 means line 2 may still be an oversized header,
        // and unverifiable_archive_header takes precedence over
        // selected_input_too_large.
        let selectedInputTooLarge = false;
        const throwSelectedInputTooLarge = (): never => {
          throw new ConversationReadError(
            'selected_input_too_large',
            'Selected conversation lines exceed the 64 KiB input limit.',
          );
        };

        const appendSelected = (part: Buffer): void => {
          if (part.length === 0 || selectedInputTooLarge) return;
          selectedBytes += part.length;
          if (selectedBytes > MAX_SELECTED_INPUT_BYTES) {
            selectedInputTooLarge = true;
            selectedLineParts = [];
            // A line-1 selection that is not a possible title slot (over the
            // header inspection limit) can never turn into a header error.
            if (currentLine === 1 && headerBytes > MAX_SELECTED_INPUT_BYTES) throwSelectedInputTooLarge();
            return;
          }
          selectedLineParts.push(Buffer.from(part));
        };

        const finishLine = (): void => {
          // Current OMP writes a fixed-width {type:"title"} slot before the
          // session header (src/parser.ts skips it), so the header is on line 1
          // or, after a title slot, line 2.
          if (currentLine <= 2) {
            if (headerBytes <= MAX_SELECTED_INPUT_BYTES) {
              const headerLine = headerLineParts.length === 0
                ? ''
                : Buffer.concat(headerLineParts).toString('utf8');
              if (currentLine === 1) {
                trustedOmpHeader = parseTrustedOmpHeader(headerLine);
                if (trustedOmpHeader) trustedOmpHeaderLine = 1;
                else hasLeadingTitleSlot = isTitleSlot(headerLine);
              } else if (hasLeadingTitleSlot) {
                trustedOmpHeader = parseTrustedOmpHeader(headerLine, true);
                if (trustedOmpHeader) trustedOmpHeaderLine = 2;
              }
            }
            headerBytes = 0;
          }
          headerLineParts = [];

          if (currentLine >= request.startLine && currentLine <= request.endLine && !selectedInputTooLarge) {
            const line = selectedLineParts.length === 0
              ? ''
              : Buffer.concat(selectedLineParts).toString('utf8');
            selectedLines.push(line);
            if (currentLine < request.endLine) {
              selectedBytes += 1;
              if (selectedBytes > MAX_SELECTED_INPUT_BYTES) selectedInputTooLarge = true;
            }
          }
          selectedLineParts = [];
          if (currentLine === request.endLine) reachedEnd = true;
          currentLine += 1;
          // Only a title slot on line 1 leaves line 2's header verdict pending.
          if (selectedInputTooLarge && (reachedEnd || !(currentLine === 2 && hasLeadingTitleSlot))) {
            throwSelectedInputTooLarge();
          }
        };

        while (!reachedEnd) {
          throwIfAborted(signal);
          checkDeadline(deadline);
          const remainingScanBytes = MAX_SCAN_BYTES - scannedBytes;
          if (remainingScanBytes === 0) {
            throw new ConversationReadError('scan_limit_exceeded', 'Conversation scan reached the fixed 64 MiB limit.');
          }
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, remainingScanBytes),
            null,
          );
          throwIfAborted(signal);
          checkDeadline(deadline);
          if (bytesRead === 0) break;
          scannedBytes += bytesRead;

          let segmentStart = 0;
          for (let index = 0; index < bytesRead; index += 1) {
            if (buffer[index] !== 0x0a) continue;
            if (currentLine <= 2) {
              appendHeader(buffer.subarray(segmentStart, index));
            }
            if (currentLine >= request.startLine && currentLine <= request.endLine) {
              appendSelected(buffer.subarray(segmentStart, index));
            }
            finishLine();
            segmentStart = index + 1;
            if (reachedEnd) break;
          }
          if (!reachedEnd && currentLine <= 2) {
            appendHeader(buffer.subarray(segmentStart, bytesRead));
          }
          if (!reachedEnd && currentLine >= request.startLine && currentLine <= request.endLine) {
            appendSelected(buffer.subarray(segmentStart, bytesRead));
          }
        }

        if (!reachedEnd && (selectedLineParts.length > 0 || headerLineParts.length > 0)) finishLine();
        if (selectedInputTooLarge) throwSelectedInputTooLarge();
        throwIfAborted(signal);
        checkDeadline(deadline);

        const selectedJsonl = selectedLines.join('\n');
        const formattingPrefix = trustedOmpHeader && trustedOmpHeaderLine < request.startLine
          ? `${JSON.stringify(trustedOmpHeader)}\n`
          : '';
        if (selectedJsonl.trim() && selectedBytes + Buffer.byteLength(formattingPrefix, 'utf8') > MAX_SELECTED_INPUT_BYTES) {
          throw new ConversationReadError(
            'selected_input_too_large',
            'Selected conversation lines and trusted metadata exceed the 64 KiB input limit.',
          );
        }
        const formattingJsonl = `${formattingPrefix}${selectedJsonl}`;
        let markdown: string;
        try {
          markdown = selectedJsonl.trim()
            ? formatConversationAsMarkdown(
                formattingJsonl,
                undefined,
                undefined,
                trustedOmpHeader ? { trustedFormat: 'omp' } : {},
              )
            : '';
        } catch {
          throw new ConversationReadError('invalid_jsonl', 'Selected conversation lines are not valid supported JSONL.');
        }
        throwIfAborted(signal);
        checkDeadline(deadline);
        if (Buffer.byteLength(markdown, 'utf8') > MAX_FORMATTED_OUTPUT_BYTES) {
          throw new ConversationReadError(
            'formatted_output_too_large',
            'Formatted conversation output exceeds the fixed 64 KiB limit.',
          );
        }

        return {
          path: candidate,
          startLine: request.startLine,
          endLine: request.endLine,
          linesRead: selectedLines.length,
          markdown,
        };
      } finally {
        await file.close().catch(() => {});
      }
    },
  };
}
