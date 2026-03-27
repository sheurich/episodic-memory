/**
 * Gemini CLI conversation parser.
 *
 * Reads JSON session files from ~/.gemini/tmp/<projectHash>/chats/session-*.json
 * and produces ConversationExchange records.
 *
 * Gemini session format:
 *   {
 *     sessionId, projectHash, startTime, lastUpdated, summary?,
 *     messages: [
 *       { id, timestamp, type: 'user'|'gemini'|'error'|'info',
 *         content?, toolCalls?: [...] }
 *     ]
 *   }
 *
 * Project name resolution uses ~/.gemini/projects.json which maps
 * filesystem paths to human-readable names.  The directory hash is
 * sha256(path).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getGeminiChatsBaseDir, getGeminiDir, getExcludedProjects } from '../paths.js';
/**
 * Extract plain text from a Gemini message content field.
 * Content can be a string or an array of {text: string} blocks.
 */
function extractContent(content) {
    if (!content)
        return '';
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .filter(block => typeof block === 'object' && block.text)
            .map(block => block.text)
            .join('\n');
    }
    return String(content);
}
/**
 * Load the hash→project-name mapping from projects.json.
 * Returns a Map<hash, { name, path }>.
 */
function loadProjectMap() {
    const map = new Map();
    const projectsFile = path.join(getGeminiDir(), 'projects.json');
    if (!fs.existsSync(projectsFile))
        return map;
    try {
        const raw = JSON.parse(fs.readFileSync(projectsFile, 'utf-8'));
        const projects = typeof raw === 'object' && raw.projects ? raw.projects : raw;
        for (const [dirPath, name] of Object.entries(projects)) {
            const hash = crypto.createHash('sha256').update(dirPath).digest('hex');
            map.set(hash, { name: String(name), dirPath });
        }
    }
    catch {
        // Ignore malformed projects.json
    }
    return map;
}
export async function parseGeminiConversation(filePath, projectName, archivePath) {
    const exchanges = [];
    let session;
    try {
        session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return exchanges;
    }
    if (!session.messages || session.messages.length === 0)
        return exchanges;
    // Pair user→gemini exchanges
    let currentUser = null;
    for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i];
        if (msg.type === 'user') {
            // Finalize any pending exchange (user with no reply)
            // Start a new potential exchange
            currentUser = {
                message: extractContent(msg.content),
                index: i,
                timestamp: msg.timestamp
            };
        }
        else if (msg.type === 'gemini' && currentUser) {
            // Build assistant text from content + tool call summaries
            const assistantParts = [];
            const text = extractContent(msg.content);
            if (text) {
                assistantParts.push(text);
            }
            const toolCalls = [];
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    toolCalls.push({
                        id: tc.id || crypto.randomUUID(),
                        exchangeId: '',
                        toolName: tc.name || 'unknown',
                        toolInput: tc.args,
                        toolResult: tc.result ? JSON.stringify(tc.result) : undefined,
                        isError: tc.status === 'error',
                        timestamp: tc.timestamp || msg.timestamp
                    });
                }
            }
            // Accumulate consecutive gemini messages into this exchange
            let lastGeminiIndex = i;
            let lastTimestamp = msg.timestamp;
            while (lastGeminiIndex + 1 < session.messages.length &&
                session.messages[lastGeminiIndex + 1].type === 'gemini') {
                lastGeminiIndex++;
                const next = session.messages[lastGeminiIndex];
                lastTimestamp = next.timestamp;
                const nextText = extractContent(next.content);
                if (nextText)
                    assistantParts.push(nextText);
                if (next.toolCalls) {
                    for (const tc of next.toolCalls) {
                        toolCalls.push({
                            id: tc.id || crypto.randomUUID(),
                            exchangeId: '',
                            toolName: tc.name || 'unknown',
                            toolInput: tc.args,
                            toolResult: tc.result ? JSON.stringify(tc.result) : undefined,
                            isError: tc.status === 'error',
                            timestamp: tc.timestamp || next.timestamp
                        });
                    }
                }
            }
            const assistantMessage = assistantParts.join('\n\n');
            if (!assistantMessage.trim() && toolCalls.length === 0) {
                // Skip exchanges with no assistant output
                i = lastGeminiIndex;
                currentUser = null;
                continue;
            }
            const exchangeId = crypto
                .createHash('md5')
                .update(`${archivePath}:${currentUser.index}-${lastGeminiIndex}`)
                .digest('hex');
            const finalToolCalls = toolCalls.map(tc => ({ ...tc, exchangeId }));
            exchanges.push({
                id: exchangeId,
                project: projectName,
                timestamp: lastTimestamp,
                userMessage: currentUser.message || '(tool results only)',
                assistantMessage,
                archivePath,
                lineStart: currentUser.index + 1, // 1-indexed
                lineEnd: lastGeminiIndex + 1,
                source: 'gemini',
                sessionId: session.sessionId,
                toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined
            });
            i = lastGeminiIndex;
            currentUser = null;
        }
        // Skip 'error' and 'info' message types
    }
    return exchanges;
}
export class GeminiSource {
    name = 'gemini';
    label = 'Gemini CLI';
    async discoverConversations() {
        const baseDir = getGeminiChatsBaseDir();
        if (!fs.existsSync(baseDir))
            return [];
        const projectMap = loadProjectMap();
        const excluded = new Set(getExcludedProjects());
        const results = [];
        const hashDirs = fs.readdirSync(baseDir);
        for (const hash of hashDirs) {
            const chatsDir = path.join(baseDir, hash, 'chats');
            if (!fs.existsSync(chatsDir) || !fs.statSync(chatsDir).isDirectory())
                continue;
            // Resolve project name from hash
            const info = projectMap.get(hash);
            const projectName = info?.name || `gemini-${hash.slice(0, 8)}`;
            if (excluded.has(projectName))
                continue;
            const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                results.push({
                    project: projectName,
                    filePath: path.join(chatsDir, file)
                });
            }
        }
        return results;
    }
    async parseConversation(filePath, project, archivePath) {
        return parseGeminiConversation(filePath, project, archivePath);
    }
}
