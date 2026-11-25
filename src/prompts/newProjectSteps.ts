/**
 * What `verse8_new_project_confirm` does, in order. Shared by the AGENTS.md
 * template and the `new-project` prompt so the two lists cannot drift apart
 * again. Keep it in step with `runNewProjectConfirm` (`src/tools/newProject.ts`)
 * and the agent8-backend client (`src/api/agent8Backend.ts`).
 */
export const NEW_PROJECT_CONFIRM_STEPS = `1. GET  /api/select-template (creates the GitLab project)
2. GET  /api/gitlab/project-access-token (check existing PAT)
3. POST /api/gitlab/project-access-token (grant a 30-day PAT and get the clone URL)
4. \`git clone -b develop <oauth2-embedded URL>\` into \`<targetDir>/<slug>\`
5. Install git hooks + AGENTS.md + \`.verse8/project.json\` (attach)`;
