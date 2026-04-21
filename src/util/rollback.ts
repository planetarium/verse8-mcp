/**
 * Rollback journal for multi-step installers (M3.8, AC-ATOMICITY).
 * Records reverse ops; on failure, invokes them LIFO. Individual reverse
 * failures are swallowed (best-effort cleanup). Sync-only — matches the
 * sync filesystem calls in applyAttachmentArtifacts.
 */

export type ReverseOp = () => void;

export class RollbackJournal {
  private reverses: ReverseOp[] = [];

  record(reverse: ReverseOp): void {
    this.reverses.push(reverse);
  }

  size(): number {
    return this.reverses.length;
  }

  rollback(): void {
    for (let i = this.reverses.length - 1; i >= 0; i--) {
      try {
        this.reverses[i]();
      } catch (e) {
        process.stderr.write(
          `[verse8-rollback] reverse op #${i} failed: ${
            (e as Error).message ?? String(e)
          }\n`,
        );
      }
    }
    this.reverses = [];
  }
}
