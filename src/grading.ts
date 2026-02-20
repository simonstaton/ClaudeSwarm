/**
 * Confidence grading system for agent fixes (V3 Phase 2.3).
 *
 * After producing a fix, an agent self-assesses along three axes:
 *  - Ticket clarity: how well-defined was the problem?
 *  - Fix confidence: how confident is the agent in its solution?
 *  - Blast radius: how much of the system is affected?
 *
 * The combined score yields a risk label:
 *  - Low Risk - safe to auto-merge
 *  - Medium Risk - human review recommended
 *  - High Risk - block merge, escalate to orchestrator
 */

export type ClarityLevel = "high" | "medium" | "low";
export type ConfidenceLevel = "high" | "medium" | "low";
export type BlastRadius = "isolated" | "moderate" | "broad";
export type RiskLevel = "low" | "medium" | "high";

export interface GradeResult {
  taskId: string;
  agentId: string;
  ticketClarity: ClarityLevel;
  fixConfidence: ConfidenceLevel;
  blastRadius: BlastRadius;
  overallRisk: RiskLevel;
  reasoning?: string;
  createdAt: string;
}

export interface GradeInput {
  taskId: string;
  agentId: string;
  ticketClarity: ClarityLevel;
  fixConfidence: ConfidenceLevel;
  blastRadius: BlastRadius;
  reasoning?: string;
}

const VALID_CLARITY: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const VALID_CONFIDENCE: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const VALID_BLAST_RADIUS: ReadonlySet<string> = new Set(["isolated", "moderate", "broad"]);

/** Validate raw input from API request. Returns an error string or null. */
export function validateGradeInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return "Request body must be an object";
  const obj = input as Record<string, unknown>;

  if (!obj.taskId || typeof obj.taskId !== "string") return "taskId is required";
  if (!obj.agentId || typeof obj.agentId !== "string") return "agentId is required";
  if (!VALID_CLARITY.has(obj.ticketClarity as string)) return "ticketClarity must be high, medium, or low";
  if (!VALID_CONFIDENCE.has(obj.fixConfidence as string)) return "fixConfidence must be high, medium, or low";
  if (!VALID_BLAST_RADIUS.has(obj.blastRadius as string)) return "blastRadius must be isolated, moderate, or broad";
  if (obj.reasoning !== undefined && typeof obj.reasoning !== "string") return "reasoning must be a string";
  if (typeof obj.reasoning === "string" && obj.reasoning.length > 5000)
    return "reasoning must be 5000 characters or less";

  return null;
}

/**
 * Numeric risk scores for each axis value.
 * Higher = riskier. Each axis contributes 0-2 to the total.
 */
const CLARITY_SCORE: Record<ClarityLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const CONFIDENCE_SCORE: Record<ConfidenceLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const BLAST_RADIUS_SCORE: Record<BlastRadius, number> = {
  isolated: 0,
  moderate: 1,
  broad: 2,
};

/**
 * Compute the overall risk level from three axis values.
 *
 * Total score ranges from 0 (best) to 6 (worst):
 *   0-1 → Low Risk
 *   2-3 → Medium Risk
 *   4-6 → High Risk
 *
 * Special rule: any single axis at its worst value ("low" clarity,
 * "low" confidence, or "broad" blast radius) forces at least Medium Risk.
 */
export function computeRisk(
  ticketClarity: ClarityLevel,
  fixConfidence: ConfidenceLevel,
  blastRadius: BlastRadius,
): RiskLevel {
  const total = CLARITY_SCORE[ticketClarity] + CONFIDENCE_SCORE[fixConfidence] + BLAST_RADIUS_SCORE[blastRadius];

  // Any single worst-case axis forces at least Medium
  const hasWorstCase = ticketClarity === "low" || fixConfidence === "low" || blastRadius === "broad";

  if (total >= 4) return "high";
  if (total >= 2 || hasWorstCase) return "medium";
  return "low";
}

/** Create a GradeResult from validated input. */
export function createGrade(input: GradeInput): GradeResult {
  return {
    taskId: input.taskId,
    agentId: input.agentId,
    ticketClarity: input.ticketClarity,
    fixConfidence: input.fixConfidence,
    blastRadius: input.blastRadius,
    overallRisk: computeRisk(input.ticketClarity, input.fixConfidence, input.blastRadius),
    reasoning: input.reasoning,
    createdAt: new Date().toISOString(),
  };
}

/**
 * In-memory grade store. Keyed by taskId.
 * Grades persist for the lifetime of the server process.
 */
export class GradeStore {
  private grades = new Map<string, GradeResult>();

  /** Submit a grade for a task. Overwrites any previous grade. */
  submit(input: GradeInput): GradeResult {
    const grade = createGrade(input);
    this.grades.set(grade.taskId, grade);
    return grade;
  }

  /** Get the grade for a task, if any. */
  get(taskId: string): GradeResult | null {
    return this.grades.get(taskId) ?? null;
  }

  /** Get all grades. */
  getAll(): GradeResult[] {
    return Array.from(this.grades.values());
  }

  /** Get grades filtered by risk level. */
  getByRisk(risk: RiskLevel): GradeResult[] {
    return this.getAll().filter((g) => g.overallRisk === risk);
  }

  /** Get grades for a specific agent. */
  getByAgent(agentId: string): GradeResult[] {
    return this.getAll().filter((g) => g.agentId === agentId);
  }

  /** Remove the grade for a task. */
  remove(taskId: string): boolean {
    return this.grades.delete(taskId);
  }

  /** Clear all grades. */
  clear(): number {
    const count = this.grades.size;
    this.grades.clear();
    return count;
  }
}
