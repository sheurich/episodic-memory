/**
 * Claude Code conversation parser.
 *
 * Reads JSONL files from ~/.claude/projects/<project>/<session>.jsonl
 * and produces ConversationExchange records.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import crypto from 'crypto';
import { getExcludedProjects } from '../paths.js';
function getProjectsDir() {
    return process.env.TEST_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}
export async function parseClaudeConversation(filePath, projectName, archivePath) {
    const exchanges = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });
    let lineNumber = 0;
    let currentExchange = null;
    const finalizeExchange = () => {
        if (currentExchange && currentExchange.assistantMessages.length > 0) {
            const exchangeId = crypto
                .createHash('md5')
                .update(`${archivePath}:${currentExchange.userLine}-${currentExchange.lastAssistantLine}`)
                .digest('hex');
            const toolCalls = currentExchange.toolCalls.map(tc => ({
                ...tc,
                exchangeId
            }));
            const exchange = {
                id: exchangeId,
                project: projectName,
                timestamp: currentExchange.timestamp,
                userMessage: currentExchange.userMessage,
                assistantMessage: currentExchange.assistantMessages.join('\n\n'),
                archivePath,
                lineStart: currentExchange.userLine,
                lineEnd: currentExchange.lastAssistantLine,
                source: 'claude',
                parentUuid: currentExchange.parentUuid,
                isSidechain: currentExchange.isSidechain,
                sessionId: currentExchange.sessionId,
                cwd: currentExchange.cwd,
                gitBranch: currentExchange.gitBranch,
                agentVersion: currentExchange.claudeVersion,
                claudeVersion: currentExchange.claudeVersion,
                thinkingLevel: currentExchange.thinkingLevel,
                thinkingDisabled: currentExchange.thinkingDisabled,
                thinkingTriggers: currentExchange.thinkingTriggers,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined
            };
            exchanges.push(exchange);
        }
    };
    for await (const line of rl) {
        lineNumber++;
        try {
            const parsed = JSON.parse(line);
            if (parsed.type !== 'user' && parsed.type !== 'assistant') {
                continue;
            }
            if (!parsed.message) {
                continue;
            }
            let text = '';
            const toolCalls = [];
            if (typeof parsed.message.content === 'string') {
                text = parsed.message.content;
            }
            else if (Array.isArray(parsed.message.content)) {
                const textBlocks = parsed.message.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text);
                text = textBlocks.join('\n');
                if (parsed.message.role === 'assistant') {
                    for (const block of parsed.message.content) {
                        if (block.type === 'tool_use') {
                            const toolCallId = crypto.randomUUID();
                            toolCalls.push({
                                id: toolCallId,
                                exchangeId: '',
                                toolName: block.name || 'unknown',
                                toolInput: block.input,
                                isError: false,
                                timestamp: parsed.timestamp || new Date().toISOString()
                            });
                        }
                    }
                }
            }
            if (!text.trim() && toolCalls.length === 0) {
                continue;
            }
            if (parsed.message.role === 'user') {
                finalizeExchange();
                currentExchange = {
                    userMessage: text || '(tool results only)',
                    userLine: lineNumber,
                    assistantMessages: [],
                    lastAssistantLine: lineNumber,
                    timestamp: parsed.timestamp || new Date().toISOString(),
                    parentUuid: parsed.parentUuid,
                    isSidechain: parsed.isSidechain,
                    sessionId: parsed.sessionId,
                    cwd: parsed.cwd,
                    gitBranch: parsed.gitBranch,
                    claudeVersion: parsed.version,
                    thinkingLevel: parsed.thinkingMetadata?.level,
                    thinkingDisabled: parsed.thinkingMetadata?.disabled,
                    thinkingTriggers: parsed.thinkingMetadata?.triggers ? JSON.stringify(parsed.thinkingMetadata.triggers) : undefined,
                    toolCalls: []
                };
            }
            else if (parsed.message.role === 'assistant' && currentExchange) {
                if (text.trim()) {
                    currentExchange.assistantMessages.push(text);
                }
                currentExchange.lastAssistantLine = lineNumber;
                if (toolCalls.length > 0) {
                    currentExchange.toolCalls.push(...toolCalls);
                }
                if (parsed.timestamp) {
                    currentExchange.timestamp = parsed.timestamp;
                }
                if (parsed.sessionId)
                    currentExchange.sessionId = parsed.sessionId;
                if (parsed.cwd)
                    currentExchange.cwd = parsed.cwd;
                if (parsed.gitBranch)
                    currentExchange.gitBranch = parsed.gitBranch;
                if (parsed.version)
                    currentExchange.claudeVersion = parsed.version;
            }
        }
        catch (error) {
            continue;
        }
    }
    finalizeExchange();
    return exchanges;
}
export class ClaudeSource {
    name = 'claude';
    label = 'Claude Code';
    async discoverConversations() {
        const projectsDir = getProjectsDir();
        if (!fs.existsSync(projectsDir))
            return [];
        const results = [];
        const excludedProjects = getExcludedProjects();
        const projects = fs.readdirSync(projectsDir);
        for (const project of projects) {
            if (excludedProjects.includes(project))
                continue;
            const projectPath = path.join(projectsDir, project);
            if (!fs.statSync(projectPath).isDirectory())
                continue;
            const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
                results.push({
                    project,
                    filePath: path.join(projectPath, file)
                });
            }
        }
        return results;
    }
    async parseConversation(filePath, project, archivePath) {
        return parseClaudeConversation(filePath, project, archivePath);
    }
}
