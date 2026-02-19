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
export const DEFAULT_MODEL = "claude-sonnet-4-6";

export let MAX_PROMPT_LENGTH = 100_000;
export let MAX_TURNS = 500;
export let MAX_AGENTS = 100;
export let MAX_BATCH_SIZE = 10;
export let SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Layer 4: Spawning depth limits — stored as an immutable field on Agent at
// creation time. Walking the parent chain at runtime is bypassable if a parent
// is destroyed (chain breaks, depth resets to 0).
export let MAX_AGENT_DEPTH = 3;
export let MAX_CHILDREN_PER_AGENT = 20;

// Setters — ES module namespace objects are read-only, so external modules
// must call these instead of assigning to the exports directly.
export function setMaxPromptLength(v: number) {
  MAX_PROMPT_LENGTH = v;
}
export function setMaxTurns(v: number) {
  MAX_TURNS = v;
}
export function setMaxAgents(v: number) {
  MAX_AGENTS = v;
}
export function setMaxBatchSize(v: number) {
  MAX_BATCH_SIZE = v;
}
export function setSessionTtlMs(v: number) {
  SESSION_TTL_MS = v;
}
export function setMaxAgentDepth(v: number) {
  MAX_AGENT_DEPTH = v;
}
export function setMaxChildrenPerAgent(v: number) {
  MAX_CHILDREN_PER_AGENT = v;
}
