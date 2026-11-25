// Unit tests for the shared loopback port check (src/util/loopback.ts).
//
// verse8_preview (async) and verse8_status (sync) both ask "is a dev server
// listening on this port?" through these helpers. Issue #30: a dev server may
// bind only ::1 when `localhost` resolves to IPv6 first, so both variants must
// report a ::1-only listener as in use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import {
  isLoopbackPortInUse,
  isLoopbackPortInUseSync,
} from "../../dist/util/loopback.js";

function listen(host) {
  return new Promise((resolve, reject) => {
    const srv = createServer((c) => c.end());
    srv.once("error", reject);
    srv.listen({ port: 0, host, ipv6Only: host === "::1" }, () => resolve(srv));
  });
}

function close(srv) {
  return new Promise((r) => srv.close(r));
}

// Null when this host cannot bind the IPv6 loopback (IPv6 disabled).
async function tryListenIpv6() {
  try {
    return await listen("::1");
  } catch {
    return null;
  }
}

const probe = await tryListenIpv6();
const skipNoIpv6 = probe === null ? "IPv6 loopback (::1) unavailable" : false;
if (probe) await close(probe);

test("loopback: listener only on ::1 counts as in use (async)", { skip: skipNoIpv6 }, async () => {
  const srv = await listen("::1");
  try {
    assert.equal(await isLoopbackPortInUse(srv.address().port), true);
  } finally {
    await close(srv);
  }
});

test("loopback: listener only on ::1 counts as in use (sync)", { skip: skipNoIpv6 }, async () => {
  const srv = await listen("::1");
  try {
    assert.equal(isLoopbackPortInUseSync(srv.address().port), true);
  } finally {
    await close(srv);
  }
});

test("loopback: listener only on 127.0.0.1 counts as in use (async and sync)", async () => {
  const srv = await listen("127.0.0.1");
  try {
    const port = srv.address().port;
    assert.equal(await isLoopbackPortInUse(port), true);
    assert.equal(isLoopbackPortInUseSync(port), true);
  } finally {
    await close(srv);
  }
});

test("loopback: nothing listening counts as not in use (async and sync)", async () => {
  // Port 0 is the one TCP port nothing can listen on (binding 0 means "pick
  // any port"), so it is closed on every loopback with no race. Releasing a
  // reserved port instead would let another process take it before the probe.
  // Connecting to it is refused on Linux (ECONNREFUSED, like any closed port)
  // and rejected on Windows (EADDRNOTAVAIL); both count as not in use.
  assert.equal(await isLoopbackPortInUse(0), false);
  assert.equal(isLoopbackPortInUseSync(0), false);
});
