export const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\/(?!\s|tmp)/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+/i, // DELETE FROM anywhere (not just at end)
  /mongodb(\+srv)?:\/\//i,
  /postgres(ql)?:\/\//i,
  /mysql:\/\//i,
  // Layer 5: Block high-impact irreversible operations
  /gh\s+pr\s+merge/i,
  /gh\s+pr\s+approve/i,
  /gcloud\s+.*\s+deploy/i,
  /terraform\s+(apply|destroy)/i,
  /git\s+push\s+.*--force/i,
];

export const ALLOWED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
];
export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export const MAX_PROMPT_LENGTH = 100_000;
export const MAX_TURNS = 500;
export const MAX_AGENTS = 20;
export const MAX_BATCH_SIZE = 10;
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Layer 4: Spawning depth limits — stored as an immutable field on Agent at
// creation time. Walking the parent chain at runtime is bypassable if a parent
// is destroyed (chain breaks, depth resets to 0).
export const MAX_AGENT_DEPTH = 3;
export const MAX_CHILDREN_PER_AGENT = 6;
