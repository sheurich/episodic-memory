/**
 * Parser registry – discovers and aggregates all conversation sources.
 */
export { ClaudeSource, parseClaudeConversation } from './claude.js';
export { GeminiSource, parseGeminiConversation } from './gemini.js';
export { PiSource, parsePiConversation } from './pi.js';
export { OpenCodeSource, parseOpenCodeConversation } from './opencode.js';
import { ClaudeSource } from './claude.js';
import { GeminiSource } from './gemini.js';
import { PiSource } from './pi.js';
import { OpenCodeSource } from './opencode.js';
/**
 * Return all registered conversation sources.
 * Add new sources here.
 */
export function getAllSources() {
    return [
        new ClaudeSource(),
        new GeminiSource(),
        new PiSource(),
        new OpenCodeSource(),
    ];
}
