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
export class ConversationReadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ConversationReadError';
    }
}
function abortError() {
    const error = new Error('Conversation read cancelled.');
    error.name = 'AbortError';
    return error;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
function validateLineWindow(startLine, endLine) {
    if (!Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < 1 ||
        endLine < 1 ||
        endLine < startLine) {
        throw new ConversationReadError('invalid_line_window', 'startLine and endLine must be safe integers with 1 <= startLine <= endLine.');
    }
    if (endLine - startLine + 1 > MAX_LINES) {
        throw new ConversationReadError('line_window_too_large', `A read may select at most ${MAX_LINES} lines.`);
    }
}
function isWithinRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveCandidate(configuredRoot, canonicalRoot, requestedPath) {
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
function rejectSymlinkComponents(canonicalRoot, candidate, signal) {
    const relative = path.relative(canonicalRoot, candidate);
    let current = canonicalRoot;
    for (const component of relative.split(path.sep)) {
        if (!component)
            continue;
        throwIfAborted(signal);
        current = path.join(current, component);
        let stat;
        try {
            stat = lstatSync(current);
        }
        catch (error) {
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
function checkDeadline(deadline) {
    if (Date.now() > deadline) {
        throw new ConversationReadError('read_deadline_exceeded', 'Conversation read exceeded its fixed deadline.');
    }
}
function parseTrustedOmpHeader(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const header = parsed;
    if (header.type !== 'session' ||
        typeof header.id !== 'string' ||
        header.id.length === 0 ||
        typeof header.version === 'number' ||
        'payload' in header ||
        'session' in header) {
        return undefined;
    }
    for (const field of ['timestamp', 'cwd']) {
        if (field in header && typeof header[field] !== 'string')
            return undefined;
    }
    // Retain only the structural discriminator. Header strings and any unknown
    // fields are never forwarded into the selected message window.
    return { type: 'session' };
}
/**
 * Create a reader whose trust boundary is fixed once, at extension startup.
 * Limits are intentionally constants rather than caller-controlled options.
 */
export function createConversationReader(archiveRoot) {
    const configuredRoot = path.resolve(archiveRoot);
    const canonicalRoot = realpathSync(configuredRoot);
    return {
        async readConversation(request, signal) {
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
            }
            catch (error) {
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
                if (currentStat.isSymbolicLink() ||
                    currentStat.dev !== openedStat.dev ||
                    currentStat.ino !== openedStat.ino) {
                    throw new ConversationReadError('symlink_not_allowed', 'Conversation path changed during secure open.');
                }
                const currentCanonical = realpathSync(candidate);
                if (!isWithinRoot(canonicalRoot, currentCanonical)) {
                    throw new ConversationReadError('path_outside_archive', 'Conversation path escaped the approved archive.');
                }
                const selectedLines = [];
                let selectedBytes = 0;
                let currentLine = 1;
                let scannedBytes = 0;
                let selectedLineParts = [];
                let headerLineParts = [];
                let headerBytes = 0;
                let trustedOmpHeader;
                const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
                let reachedEnd = false;
                const appendHeader = (part) => {
                    if (part.length === 0 || headerBytes > MAX_SELECTED_INPUT_BYTES)
                        return;
                    headerBytes += part.length;
                    if (headerBytes <= MAX_SELECTED_INPUT_BYTES)
                        headerLineParts.push(Buffer.from(part));
                };
                const appendSelected = (part) => {
                    if (part.length === 0)
                        return;
                    selectedBytes += part.length;
                    if (selectedBytes > MAX_SELECTED_INPUT_BYTES) {
                        throw new ConversationReadError('selected_input_too_large', 'Selected conversation lines exceed the 64 KiB input limit.');
                    }
                    selectedLineParts.push(Buffer.from(part));
                };
                const finishLine = () => {
                    if (currentLine === 1 && headerBytes <= MAX_SELECTED_INPUT_BYTES) {
                        const headerLine = headerLineParts.length === 0
                            ? ''
                            : Buffer.concat(headerLineParts).toString('utf8');
                        trustedOmpHeader = parseTrustedOmpHeader(headerLine);
                    }
                    headerLineParts = [];
                    if (currentLine >= request.startLine && currentLine <= request.endLine) {
                        const line = selectedLineParts.length === 0
                            ? ''
                            : Buffer.concat(selectedLineParts).toString('utf8');
                        selectedLines.push(line);
                        if (currentLine < request.endLine) {
                            selectedBytes += 1;
                            if (selectedBytes > MAX_SELECTED_INPUT_BYTES) {
                                throw new ConversationReadError('selected_input_too_large', 'Selected conversation lines exceed the 64 KiB input limit.');
                            }
                        }
                    }
                    selectedLineParts = [];
                    if (currentLine === request.endLine)
                        reachedEnd = true;
                    currentLine += 1;
                };
                while (!reachedEnd) {
                    throwIfAborted(signal);
                    checkDeadline(deadline);
                    const remainingScanBytes = MAX_SCAN_BYTES - scannedBytes;
                    if (remainingScanBytes === 0) {
                        throw new ConversationReadError('scan_limit_exceeded', 'Conversation scan reached the fixed 64 MiB limit.');
                    }
                    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remainingScanBytes), null);
                    throwIfAborted(signal);
                    checkDeadline(deadline);
                    if (bytesRead === 0)
                        break;
                    scannedBytes += bytesRead;
                    let segmentStart = 0;
                    for (let index = 0; index < bytesRead; index += 1) {
                        if (buffer[index] !== 0x0a)
                            continue;
                        if (currentLine === 1) {
                            appendHeader(buffer.subarray(segmentStart, index));
                        }
                        if (currentLine >= request.startLine && currentLine <= request.endLine) {
                            appendSelected(buffer.subarray(segmentStart, index));
                        }
                        finishLine();
                        segmentStart = index + 1;
                        if (reachedEnd)
                            break;
                    }
                    if (!reachedEnd && currentLine === 1) {
                        appendHeader(buffer.subarray(segmentStart, bytesRead));
                    }
                    if (!reachedEnd && currentLine >= request.startLine && currentLine <= request.endLine) {
                        appendSelected(buffer.subarray(segmentStart, bytesRead));
                    }
                }
                if (!reachedEnd && (selectedLineParts.length > 0 || headerLineParts.length > 0))
                    finishLine();
                throwIfAborted(signal);
                checkDeadline(deadline);
                const selectedJsonl = selectedLines.join('\n');
                const formattingPrefix = trustedOmpHeader && request.startLine > 1
                    ? `${JSON.stringify(trustedOmpHeader)}\n`
                    : '';
                if (selectedJsonl.trim() && selectedBytes + Buffer.byteLength(formattingPrefix, 'utf8') > MAX_SELECTED_INPUT_BYTES) {
                    throw new ConversationReadError('selected_input_too_large', 'Selected conversation lines and trusted metadata exceed the 64 KiB input limit.');
                }
                const formattingJsonl = `${formattingPrefix}${selectedJsonl}`;
                let markdown;
                try {
                    markdown = selectedJsonl.trim() ? formatConversationAsMarkdown(formattingJsonl) : '';
                }
                catch {
                    throw new ConversationReadError('invalid_jsonl', 'Selected conversation lines are not valid supported JSONL.');
                }
                throwIfAborted(signal);
                checkDeadline(deadline);
                if (Buffer.byteLength(markdown, 'utf8') > MAX_FORMATTED_OUTPUT_BYTES) {
                    throw new ConversationReadError('formatted_output_too_large', 'Formatted conversation output exceeds the fixed 64 KiB limit.');
                }
                return {
                    path: candidate,
                    startLine: request.startLine,
                    endLine: request.endLine,
                    linesRead: selectedLines.length,
                    markdown,
                };
            }
            finally {
                await file.close().catch(() => { });
            }
        },
    };
}
