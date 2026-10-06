// State contract of the Verse8 mod (hooks/verse8.mjs). `claude plugin validate`
// checks every `$.state.get/set` in the module against this declaration.

/** Where git stood at the last preview, or at session start before any. */
export type Verse8Baseline = {
  /** Full commit hash of HEAD at that moment. */
  head: string;
  kind: "preview" | "session";
};

/** Files differ from the baseline: the preview is stale. */
export type Verse8PreviewReminder = {
  /** Files committed since the baseline plus files the working tree changed. */
  files: number;
  since: "preview" | "session";
};

declare module "claude-code" {
  interface PluginState {
    verse8: {
      baseline: Verse8Baseline | null;
      /** Set at the end of a main-loop turn when git differs from the baseline; null otherwise. */
      reminder: Verse8PreviewReminder | null;
    };
  }
}
