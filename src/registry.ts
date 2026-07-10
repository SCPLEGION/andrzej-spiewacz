import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STATE_BASE_DIR } from "./config.js";

/**
 * Permanent mapping of Discord users to worker-slot indices. Unlike the fixed
 * PlayerPool (src/pool.ts), this registry never forgets or reuses an index:
 * once a user links, their slot number is theirs forever across restarts.
 */
export interface WorkerRegistry {
  /** Discord user id -> permanently assigned slot index. */
  users: Record<string, number>;
  /** Next never-used index to hand out. */
  nextIndex: number;
}

/** A fresh registry with no users assigned yet. */
export function emptyRegistry(): WorkerRegistry {
  return { users: {}, nextIndex: 0 };
}

/**
 * Assign `userId` a permanent slot index (pure — does not mutate `registry`):
 * returns their existing index if they already have one, else hands out
 * `registry.nextIndex` and returns a new registry with it recorded. No cap —
 * always succeeds.
 */
export function assignSlot(
  registry: WorkerRegistry,
  userId: string,
): { registry: WorkerRegistry; index: number; created: boolean } {
  const existing = registry.users[userId];
  if (existing !== undefined) {
    return { registry, index: existing, created: false };
  }
  const index = registry.nextIndex;
  const next: WorkerRegistry = {
    users: { ...registry.users, [userId]: index },
    nextIndex: index + 1,
  };
  return { registry: next, index, created: true };
}

/**
 * Load the registry from disk, or an empty one if the file doesn't exist yet.
 * A corrupt file is logged and treated as empty rather than crashing the
 * worker manager.
 */
export function loadRegistry(path: string = resolve(STATE_BASE_DIR, "registry.json")): WorkerRegistry {
  if (!existsSync(path)) return emptyRegistry();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerRegistry;
  } catch (err) {
    console.warn(`[registry] failed to parse ${path}, starting fresh: ${(err as Error).message}`);
    return emptyRegistry();
  }
}

/**
 * Persist the registry atomically: write to a temp file then rename over the
 * real path, so a crash mid-write can never leave a torn/partial registry.json.
 */
export function saveRegistry(registry: WorkerRegistry, path: string = resolve(STATE_BASE_DIR, "registry.json")): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmpPath, path);
}
