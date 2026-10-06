// State contract of the Verse8 mod (hooks/verse8.mjs). `claude plugin validate`
// checks every `$.state.get/set` in the module against this declaration.

/** A reminder that files changed after the last `verse8_preview`. */
export type Verse8PreviewReminder = {
  /** Edit/Write calls counted since the last preview. */
  edits: number;
  /** The main-loop turn that ended with the edits still unpreviewed. */
  turnId: string;
};

declare module "claude-code" {
  interface PluginState {
    verse8: {
      /** Edit/Write calls in the current main-loop turn. */
      edits: number;
      /** Set when a turn ends with edits and no preview; null once previewed. */
      reminder: Verse8PreviewReminder | null;
    };
  }
}
