/**
 * Build the env a spawned child process should see, with verse8 secrets and
 * MCP redirect overrides stripped. A malicious dependency or Vite plugin
 * running inside `bun run dev` (or any other future spawn) must not be able
 * to read the access token or redirect MCP traffic to an attacker host.
 *
 * The function returns a NEW object — the input env is never mutated.
 * (US-M2-1.)
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.VERSE8_ACCESS_TOKEN;
  delete out.VERSE8_API_URL;
  delete out.VERSE8_AGENT8_BACKEND_URL;
  delete out.VERSE8_CREATE_URL;
  delete out.VERSE8_WEB_URL;
  // @agent8/deploy's auth variable — verse8_deploy re-adds it for the
  // upload step only.
  delete out.V8_ACCESS_TOKEN;
  for (const key of Object.keys(out)) {
    if (/^VERSE8_.*_MCP_URL$/.test(key)) {
      delete out[key];
    }
  }
  return out;
}
