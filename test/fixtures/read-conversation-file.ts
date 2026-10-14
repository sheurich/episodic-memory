import { createConversationReader } from '../../src/conversation-reader.js';

const archiveRoot = process.argv[2];
const filePath = process.argv[3];
if (!archiveRoot || !filePath) throw new Error('Fixture requires archive and file paths.');

try {
  await createConversationReader(archiveRoot).readConversation({
    path: filePath, startLine: 1, endLine: 1,
  });
  process.stdout.write('unexpected_success\n');
  process.exitCode = 1;
} catch (error: unknown) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  process.stdout.write(`${code}\n`);
  process.exitCode = code === 'not_regular_jsonl' ? 0 : 1;
}
