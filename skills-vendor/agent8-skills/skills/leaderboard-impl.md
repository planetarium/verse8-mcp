---
name: leaderboard-impl
description: A method to implement leaderboards and rankings in a game. Explain how to store on a server and display it on a client (using `gameserver-sdk` skill).
---

# Leaderboard Implementation

A leaderboard is a global collection with **one item per player**, keyed by the player's account. Using the account as the item id (`options.id`) turns every submission into an upsert of that player's single entry, so there are no duplicates to clean up and every query stays small.

## Prerequisites

**Important:** This implementation uses the Agent8 GameServer SDK 2.x. Before implementing a leaderboard, you must:

1. Read and understand the `gameserver-sdk` skill
2. Set up the server the way that skill describes — a structured project (`server/src/server.ts`, created by `bunx @agent8/gameserver-node init`), or the project's existing root `server.js`, which holds the same class without `export` and type annotations
3. On a project still pinned to `@agent8/gameserver` 1.x, upgrade first: the item id below is passed as `options.id`, and 2.x ignores the 1.x `item.__id` form.
4. If the game already has a `rankings` collection from an earlier implementation (generated ids, possibly several items per player), use a new collection name such as `leaderboard`. The account-keyed upsert only replaces the item whose id is the account, so the old items would list players twice, and `getMyEntry` could read a stale lower score

The leaderboard uses global Collections (`$global.addCollectionItem`, `$global.getCollectionItems`, `$global.countCollectionItems`) and `$lock`.

## Server Code

```ts filename="server/src/server.ts"
export class Server {
  /**
   * Records a score if it beats the player's best.
   * @returns {Promise<{ updated: boolean, entry: Item | null }>}
   */
  async submitScore(score: number, nickname: string) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
      throw new Error("Invalid score.");
    }
    const name = typeof nickname === "string" ? nickname.trim() : "";
    if (name.length < 1 || name.length > 15) {
      throw new Error("Nickname must be between 1 and 15 characters.");
    }

    // Read-compare-write on this player's entry: the lock stops two
    // submissions in flight from both passing the comparison.
    return $lock(`score:${$sender.account}`, async () => {
      const best = await this.getMyEntry();
      if (best && best.score >= score) return { updated: false, entry: best };

      const entry = await $global.addCollectionItem(
        "rankings",
        { account: $sender.account, nickname: name, score, updatedAt: Date.now() },
        { id: $sender.account } // upsert: replaces this player's previous entry
      );
      return { updated: true, entry };
    });
  }

  /** The top 20, highest first. */
  async getTopRankings() {
    return $global.getCollectionItems("rankings", {
      orderBy: [{ field: "score", direction: "desc" }],
      limit: 20,
    });
  }

  /** The caller's entry and rank; ties share a rank. */
  async getMyRank() {
    const entry = await this.getMyEntry();
    if (!entry) return { entry: null, rank: null };

    const higher = await $global.countCollectionItems("rankings", {
      filters: [{ field: "score", operator: ">", value: entry.score }],
    });
    return { entry, rank: higher + 1 };
  }

  // A filtered read rather than getCollectionItem, which throws for a player
  // who has no entry yet — this returns null instead.
  async getMyEntry() {
    const [entry] = await $global.getCollectionItems("rankings", {
      filters: [{ field: "account", operator: "==", value: $sender.account }],
    });
    return entry ?? null;
  }
}
```

Why it holds up:

- **No composite index needed.** `getTopRankings` orders on `score` with no filter, and `getMyEntry` filters on `account` with no order — each touches one field. Global collections accept `filters` and `orderBy` together only on the SAME field, so never add a tiebreaker sort (`score` desc, then `updatedAt` asc) or filter one field while ordering by another.
- **The rank is exact.** `countCollectionItems` is not capped at 100. It does not yet include writes from the last ~2s, so a very recent submission from another player can be missing from the count.
- **One item per player, never one per play.** `getCollectionItems` returns at most 100 items per call, so a collection of every play cannot be deduplicated or sorted reliably later.
- **Scores are not currency.** Grant rewards with `$asset`, whose balance changes are atomic, not by writing to this collection.

To keep a history of every play as well, write each one to a second collection (e.g. `plays`, with a generated id). Keep the leaderboard itself at one item per player.

## Client-Side Implementation

### Leaderboard Dialog Component

Create a separate file for the leaderboard component:

```tsx filename='components/LeaderboardDialog.tsx'
import React, { useState, useEffect } from "react";
import { useGameServer } from "@agent8/gameserver";

interface LeaderboardDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ScoreEntry {
  __id: string;
  account: string;
  nickname: string;
  score: number;
}

interface MyRank {
  entry: ScoreEntry | null;
  rank: number | null;
}

const LeaderboardDialog: React.FC<LeaderboardDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { connected, server, account } = useGameServer();
  const [topRanks, setTopRanks] = useState<ScoreEntry[]>([]);
  // Ties share a rank, matching getMyRank: a row's rank is 1 + the number of rows with a higher score.
  const rankAt = (i: number) => {
    let r = i;
    while (r > 0 && topRanks[r - 1].score === topRanks[i].score) r--;
    return r + 1;
  };
  const [myRank, setMyRank] = useState<MyRank | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen || !connected) return;

    const fetchLeaderboard = async () => {
      try {
        setLoading(true);
        // Neither function takes arguments, so the args array is omitted.
        const [top, my] = await Promise.all([
          server.remoteFunction("getTopRankings"),
          server.remoteFunction("getMyRank"),
        ]);
        setTopRanks(top as ScoreEntry[]);
        setMyRank(my as MyRank);
      } catch (error) {
        console.error("Failed to fetch leaderboard:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchLeaderboard();
  }, [isOpen, connected, server]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-xl font-bold">Leaderboard</h1>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8">Loading...</div>
        ) : (
          <div>
            <div className="space-y-2 mb-6">
              {topRanks.map((entry, index) => (
                <div
                  key={entry.__id}
                  className={`flex justify-between items-center p-2 rounded ${
                    entry.account === account ? "bg-blue-100" : "bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">#{rankAt(index)}</span>
                    <span>{entry.nickname}</span>
                  </div>
                  <span className="font-bold">
                    {entry.score.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            {/* Show the player's row when it is not in the list — not when rank > 20: ties at the
                cut-off, and counts that lag buffered writes, can leave a rank-20 player off the list */}
            {myRank?.entry && !topRanks.some((e) => e.account === account) && (
              <div className="border-t pt-4">
                <h2 className="font-medium mb-2">Your Best</h2>
                <div className="flex justify-between items-center p-2 bg-blue-50 rounded">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">#{myRank.rank}</span>
                    <span>{myRank.entry.nickname}</span>
                  </div>
                  <span className="font-bold">
                    {myRank.entry.score.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full mt-4 px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default LeaderboardDialog;
```

### Score Submission Component

The dialog reads the player's best first, so a score that cannot place skips the nickname prompt. `submitScore` still re-checks on the server — `updated` is `false` when the score did not beat the player's best:

```tsx filename='components/GameOverDialog.tsx'
import React, { useState, useEffect } from "react";
import { useGameServer } from "@agent8/gameserver";

interface GameOverDialogProps {
  score: number;
  onRestart: () => void;
  onScoreSubmitted: () => void;
}

const GameOverDialog: React.FC<GameOverDialogProps> = ({
  score,
  onRestart,
  onScoreSubmitted,
}) => {
  const { connected, server } = useGameServer();
  const [nickname, setNickname] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [myBestScore, setMyBestScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Check current best score when dialog opens
  useEffect(() => {
    if (!connected) return;

    const fetchMyBestScore = async () => {
      try {
        setLoading(true);
        const myRank = await server.remoteFunction("getMyRank");
        setMyBestScore(myRank.entry?.score ?? null); // ?? keeps a best score of 0
      } catch (error) {
        console.error("Failed to fetch best score:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchMyBestScore();
  }, [connected, server]);

  const handleSubmit = async () => {
    if (!connected) {
      setError("Not connected to server.");
      return;
    }
    if (nickname.trim().length === 0) {
      setError("Nickname cannot be empty.");
      return;
    }
    if (nickname.trim().length > 15) {
      setError("Nickname cannot exceed 15 characters.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      const result = await server.remoteFunction("submitScore", [
        score,
        nickname.trim(),
      ]);
      if (result.updated) {
        onScoreSubmitted(); // recommend: close gameOver dialog and show leaderboard dialog
      } else {
        // A higher best was stored meanwhile (another tab/device): the "not high enough" box explains it.
        setMyBestScore(result.entry?.score ?? null);
        setIsSubmitting(false);
      }
    } catch (e: any) {
      setError(e.message || "Failed to submit score.");
      setIsSubmitting(false);
    }
  };

  if (loading) {
    // Keep a way out while the server is unreachable — loading never ends until it connects.
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-sm w-full mx-4">
          <div className="text-center py-8">Loading...</div>
          <button
            onClick={onRestart}
            className="w-full mt-4 px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Play Again
          </button>
        </div>
      </div>
    );
  }

  const isNewHighScore = myBestScore === null || score > myBestScore;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-sm w-full mx-4">
        <h1 className="text-2xl font-bold text-center mb-4">Game Over</h1>

        <div className="text-center mb-6">
          <p className="text-lg mb-2">
            Final Score:{" "}
            <span className="font-bold text-blue-600">
              {score.toLocaleString("en-US")}
            </span>
          </p>

          {myBestScore !== null && (
            <p className="text-sm text-gray-600">
              Your Best: {myBestScore.toLocaleString("en-US")}
            </p>
          )}
        </div>

        <div className="space-y-4">
          {isNewHighScore ? (
            <>
              {myBestScore !== null && (
                <div className="bg-green-100 border border-green-300 rounded p-3 text-center">
                  <p className="text-green-800 font-medium">
                    🎉 New High Score!
                  </p>
                </div>
              )}

              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Enter your nickname"
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                maxLength={15}
                disabled={isSubmitting}
              />

              <button
                onClick={handleSubmit}
                disabled={!connected || isSubmitting || !nickname.trim()}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {isSubmitting ? "Submitting..." : "Submit High Score"}
              </button>

              {error && (
                <p className="text-red-500 text-sm text-center">{error}</p>
              )}
            </>
          ) : (
            <div className="bg-gray-100 border border-gray-300 rounded p-3 text-center">
              <p className="text-gray-700">
                Score not high enough to save.
                <br />
                Keep trying to beat your best!
              </p>
            </div>
          )}

          <button
            onClick={onRestart}
            className="w-full px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Play Again
          </button>
        </div>
      </div>
    </div>
  );
};

export default GameOverDialog;
```

### Usage Example

```tsx filename='YourGameComponent.tsx'
import React, { useState } from "react";
import LeaderboardDialog from "./LeaderboardDialog";
import GameOverDialog from "./GameOverDialog";

const YourGame = () => {
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showGameOver, setShowGameOver] = useState(false);
  const [finalScore, setFinalScore] = useState(0);

  const handleGameOver = (score: number) => {
    setFinalScore(score);
    setShowGameOver(true);
  };

  const handleScoreSubmitted = () => {
    setShowGameOver(false);
    setShowLeaderboard(true);
  };

  return (
    <div>
      {/* Your game content */}
      <button
        onClick={() => setShowLeaderboard(true)}
        className="px-4 py-2 bg-blue-600 text-white rounded"
      >
        Show Leaderboard
      </button>

      <LeaderboardDialog
        isOpen={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
      />

      {showGameOver && (
        <GameOverDialog
          score={finalScore}
          onRestart={() => setShowGameOver(false)}
          onScoreSubmitted={handleScoreSubmitted}
        />
      )}
    </div>
  );
};
```
