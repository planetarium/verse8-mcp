#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCommitMsgHook } from "./cli/commitMsgHook.js";
import { runPreCommitHook } from "./cli/preCommitHook.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `verse8-mcp hook pre-commit` — git hook entrypoint.
  if (argv[0] === "hook" && argv[1] === "pre-commit") {
    const code = runPreCommitHook(process.cwd());
    process.exit(code);
  }

  // `verse8-mcp hook commit-msg <msg-file>` — git commit-msg validator.
  if (argv[0] === "hook" && argv[1] === "commit-msg") {
    const code = runCommitMsgHook(argv[2]);
    process.exit(code);
  }

  // Default / `serve` → stdio MCP server.
  if (argv.length === 0 || argv[0] === "serve") {
    const server = createServer();
    const transport = new StdioServerTransport();

    const shutdown = async () => {
      try {
        await server.close();
      } catch {
        /* noop */
      }
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await server.connect(transport);
    // Keep the process alive — stdio transport holds it open via stdin.
    return;
  }

  process.stderr.write(
    `verse8-mcp: unknown command '${argv.join(" ")}'\n` +
      `usage:\n` +
      `  verse8-mcp serve                    (default — start stdio MCP server)\n` +
      `  verse8-mcp hook pre-commit          (git hook: origin host validator)\n` +
      `  verse8-mcp hook commit-msg <file>   (git hook: V8 commit-format validator, warn-only)\n`,
  );
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`verse8-mcp fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
