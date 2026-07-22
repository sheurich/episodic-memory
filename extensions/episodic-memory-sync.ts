/**
 * Episodic Memory Sync Extension for Pi
 *
 * On session start, runs the multi-source indexer in the background to
 * pick up new conversations from Claude, Gemini, Pi, and OpenCode.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		const indexCli = path.join(__dirname, "..", "dist", "index-cli.js");

		// Fire and forget — don't block session startup
		const child = spawn("node", [indexCli, "index-all-sources", "--no-summaries"], {
			stdio: "ignore",
			detached: true,
		});
		child.unref();
	});
}
