import { describe, it, expect, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	existsSync,
	writeFileSync,
	chmodSync,
	copyFileSync,
	linkSync,
	readFileSync,
} from "fs";
import { spawn as spawnProcess } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCHER_PATH = join(REPO_ROOT, "cli", "episodic-memory.js");

async function waitFor(
	condition: () => boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!condition()) {
		throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
	}
}

/**
 * Install a stub npm and return the node executable the dispatcher must be
 * launched with. POSIX resolves `npm` from PATH. On Windows the installer
 * ignores PATH and only runs the npm-cli.js beside process.execPath, so stage a
 * node next to a stub npm package (same pattern as test/native-install.test.ts).
 */
function installNpmStub(binDir: string, stubBody: string): { nodeExecutable: string; pathEnv: string } {
	if (process.platform !== "win32") {
		const npmStubPath = join(binDir, "npm");
		writeFileSync(npmStubPath, `#!/usr/bin/env node\n${stubBody}`, "utf-8");
		chmodSync(npmStubPath, 0o755);
		return { nodeExecutable: process.execPath, pathEnv: `${binDir}:${process.env.PATH}` };
	}

	const nodeDir = join(binDir, "node");
	const npmDir = join(nodeDir, "node_modules", "npm");
	mkdirSync(join(npmDir, "bin"), { recursive: true });
	writeFileSync(
		join(npmDir, "package.json"),
		JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }),
	);
	writeFileSync(join(npmDir, "bin", "npm-cli.js"), stubBody, "utf-8");
	const nodeExe = join(nodeDir, "node.exe");
	try {
		linkSync(process.execPath, nodeExe);
	} catch {
		copyFileSync(process.execPath, nodeExe);
	}
	return { nodeExecutable: nodeExe, pathEnv: process.env.PATH ?? "" };
}

describe("cli/episodic-memory.js dispatcher — dependency self-heal", () => {
	let root: string;
	let binDir: string;

	afterEach(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(binDir, { recursive: true, force: true });
		} catch {}
	});

	it("runs npm install when node_modules is missing, before dispatching a subcommand", async () => {
		// Regression test for the gap where mcp-server-wrapper.js self-healed a
		// missing node_modules but the CLI dispatcher (invoked directly by the
		// SessionStart `sync` hook) had no such probe and crashed with
		// ERR_MODULE_NOT_FOUND instead.
		root = mkdtempSync(join(tmpdir(), "episodic-memory-cli-root-"));
		binDir = mkdtempSync(join(tmpdir(), "episodic-memory-cli-bin-"));

		const pidFile = join(root, "npm-stub.pid");
		const { nodeExecutable, pathEnv } = installNpmStub(
			binDir,
			`const { writeFileSync } = require('fs');\n` +
				`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
				// Finite fallback so an orphaned stub can never outlive the test run.
				`setTimeout(() => process.exit(0), 60000);\n` +
				`setInterval(() => {}, 1000);\n`,
		);

		// An empty plugin root: node_modules is entirely absent, so the
		// dispatcher's findMissingDeps probe reports everything missing and
		// takes the install path, invoking our stub npm.
		const child = spawnProcess(nodeExecutable, [DISPATCHER_PATH, "stats"], {
			cwd: root,
			env: {
				...process.env,
				CLAUDE_PLUGIN_ROOT: root,
				PATH: pathEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Register completion immediately so an early exit cannot be missed.
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => resolve()),
		);

		let stubPid: number | undefined;
		try {
			// The file can exist before the stub finishes writing it, so wait for
			// a complete, valid PID rather than for mere existence.
			const readStubPid = (): number | undefined => {
				try {
					const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
					return Number.isInteger(pid) && pid > 0 ? pid : undefined;
				} catch {
					return undefined;
				}
			};
			await waitFor(() => readStubPid() !== undefined, 10_000);
			stubPid = readStubPid();
			expect(stubPid).toBeGreaterThan(0);
		} finally {
			child.kill("SIGTERM");
			await exited;
			if (process.platform === "win32") {
				// Windows kill() is forceful: the dispatcher cannot run its signal
				// cleanup, so stop the orphaned stub and skip the lock assertion.
				if (stubPid !== undefined) {
					try {
						process.kill(stubPid);
					} catch {}
				}
			} else {
				expect(existsSync(join(root, ".episodic-memory-install.lock"))).toBe(
					false,
				);
			}
		}
	}, 20_000);

	it("does not attempt an install for --help", async () => {
		root = mkdtempSync(join(tmpdir(), "episodic-memory-cli-root-"));
		binDir = mkdtempSync(join(tmpdir(), "episodic-memory-cli-bin-"));

		const pidFile = join(root, "npm-stub.pid");
		const { nodeExecutable, pathEnv } = installNpmStub(
			binDir,
			`const { writeFileSync } = require('fs');\n` +
				`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
				`process.exit(0);\n`,
		);

		const output = await new Promise<string>((resolve, reject) => {
			const child = spawnProcess(
				nodeExecutable,
				[DISPATCHER_PATH, "--help"],
				{
					cwd: root,
					env: {
						...process.env,
						CLAUDE_PLUGIN_ROOT: root,
						PATH: pathEnv,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("exit", (code) =>
				code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)),
			);
			child.on("error", reject);
		});

		expect(output).toContain("USAGE:");
		expect(existsSync(pidFile)).toBe(false);
	}, 20_000);
});
