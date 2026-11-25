import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

/**
 * Loopback addresses a local dev server may listen on. The preview URL we
 * hand out is `http://localhost:<port>`, and `localhost` can resolve to
 * either family (Node 17+ keeps the OS order, often ::1 first), so a dev
 * server such as Vite may bind only one of them. Every "is a dev server up
 * on this port?" check must go through the helpers below so the address list
 * lives in one place.
 */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

function probeHost(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * True if any loopback address accepts a TCP connection on `port`. Hosts are
 * probed in parallel, so the worst case is one `timeoutMs`. A host without
 * IPv6 fails the ::1 probe fast and the IPv4 result decides.
 */
export async function isLoopbackPortInUse(port: number, timeoutMs = 300): Promise<boolean> {
  const results = await Promise.all(
    LOOPBACK_HOSTS.map((host) => probeHost(port, host, timeoutMs)),
  );
  return results.some(Boolean);
}

// Child-process body for the sync variant: argv = [port, timeoutMs, ...hosts].
// Exits 0 as soon as any host connects, 1 when all have failed.
const SYNC_PROBE_SCRIPT = `
const net = require("net");
const [port, timeoutMs, ...hosts] = process.argv.slice(1);
let pending = hosts.length;
if (pending === 0) process.exit(1);
for (const host of hosts) {
  const s = net.createConnection({ port: Number(port), host });
  let done = false;
  const finish = (used) => {
    if (done) return;
    done = true;
    s.destroy();
    if (used) process.exit(0);
    if (--pending === 0) process.exit(1);
  };
  s.setTimeout(Number(timeoutMs));
  s.once("connect", () => finish(true));
  s.once("timeout", () => finish(false));
  s.once("error", () => finish(false));
}
`;

/**
 * Synchronous twin of {@link isLoopbackPortInUse} for callers that cannot
 * await (e.g. verse8_status building its project summary). Runs the probe in a
 * short-lived child process with the same address list.
 */
export function isLoopbackPortInUseSync(port: number, timeoutMs = 200): boolean {
  try {
    execFileSync(
      process.execPath,
      ["-e", SYNC_PROBE_SCRIPT, String(port), String(timeoutMs), ...LOOPBACK_HOSTS],
      { timeout: timeoutMs + 800, stdio: ["ignore", "ignore", "ignore"] },
    );
    return true; // exit 0 → some host accepted
  } catch {
    return false; // non-zero exit or the child timed out
  }
}
