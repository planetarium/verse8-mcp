import { sanitizeChildEnv } from "./childEnv.js";

/**
 * Environments for the git calls that decide whether a project token file
 * is tracked or about to be committed (INV-16). An inherited `GIT_*`
 * variable must not be able to change what such a call answers.
 */

/** Variables that change how git reads a pathspec (`GIT_LITERAL_PATHSPECS` and friends). */
const PATHSPEC_VAR = /^GIT_(LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS$/i;

/**
 * Env for a check that asks git about a folder from scratch: every
 * inherited `GIT_*` variable is dropped by one rule rather than a list.
 * They can point git at another repository or index (`GIT_DIR`,
 * `GIT_INDEX_FILE`), change how the pathspec is read
 * (`GIT_LITERAL_PATHSPECS`), or inject config (`GIT_CONFIG_*`). If git then
 * cannot work at all, the check fails — it does not answer wrongly.
 */
export function gitEnvFromScratch(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = sanitizeChildEnv(base);
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * Env for a git call made from inside a git hook. git itself hands the hook
 * `GIT_DIR`, `GIT_INDEX_FILE` (a temporary index for `git commit -a` or
 * `git commit <paths>`) and `GIT_WORK_TREE`; dropping those would make the
 * hook look at the wrong index, so here only the variables that change how
 * a pathspec is read are removed.
 */
export function gitEnvInsideHook(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (PATHSPEC_VAR.test(key)) delete env[key];
  }
  return env;
}
