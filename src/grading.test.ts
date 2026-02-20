import { describe, expect, it, beforeEach } from "vitest";
import {
  type BlastRadius,
  type ClarityLevel,
  type ConfidenceLevel,
  type GradeInput,
  GradeStore,
  computeRisk,
  createGrade,
  validateGradeInput,
} from "./grading";

describe("computeRisk", () => {
  it("returns low for all best-case values", () => {
    expect(computeRisk("high", "high", "isolated")).toBe("low");
  });

  it("returns low for score of 1 (one medium axis)", () => {
    expect(computeRisk("medium", "high", "isolated")).toBe("low");
    expect(computeRisk("high", "medium", "isolated")).toBe("low");
    expect(computeRisk("high", "high", "moderate")).toBe("low");
  });

  it("returns medium for score of 2", () => {
    expect(computeRisk("medium", "medium", "isolated")).toBe("medium");
    expect(computeRisk("high", "medium", "moderate")).toBe("medium");
  });

  it("returns medium for score of 3", () => {
    expect(computeRisk("medium", "medium", "moderate")).toBe("medium");
  });

  it("returns high for score of 4 or more", () => {
    expect(computeRisk("low", "low", "isolated")).toBe("high");
    expect(computeRisk("low", "medium", "moderate")).toBe("high");
    expect(computeRisk("low", "low", "moderate")).toBe("high");
    expect(computeRisk("low", "low", "broad")).toBe("high");
  });

  it("forces medium when any axis is at worst value", () => {
    expect(computeRisk("low", "high", "isolated")).toBe("medium");
    expect(computeRisk("high", "low", "isolated")).toBe("medium");
    expect(computeRisk("high", "high", "broad")).toBe("medium");
  });

  it("returns high for all worst-case values", () => {
    expect(computeRisk("low", "low", "broad")).toBe("high");
  });

  it("covers all combinations systematically", () => {
    const clarities: ClarityLevel[] = ["high", "medium", "low"];
    const confidences: ConfidenceLevel[] = ["high", "medium", "low"];
    const radii: BlastRadius[] = ["isolated", "moderate", "broad"];

    for (const c of clarities) {
      for (const f of confidences) {
        for (const b of radii) {
          const result = computeRisk(c, f, b);
          expect(["low", "medium", "high"]).toContain(result);
        }
      }
    }
  });
});

describe("validateGradeInput", () => {
  const validInput = {
    taskId: "task-123",
    agentId: "agent-456",
    ticketClarity: "high",
    fixConfidence: "medium",
    blastRadius: "isolated",
  };

  it("returns null for valid input", () => {
    expect(validateGradeInput(validInput)).toBeNull();
  });

  it("returns null for valid input with reasoning", () => {
    expect(validateGradeInput({ ...validInput, reasoning: "Looks good" })).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateGradeInput(null)).toBe("Request body must be an object");
    expect(validateGradeInput("string")).toBe("Request body must be an object");
  });

  it("rejects missing taskId", () => {
    expect(validateGradeInput({ ...validInput, taskId: undefined })).toBe("taskId is required");
  });

  it("rejects missing agentId", () => {
    expect(validateGradeInput({ ...validInput, agentId: undefined })).toBe("agentId is required");
  });

  it("rejects invalid ticketClarity", () => {
    expect(validateGradeInput({ ...validInput, ticketClarity: "bad" })).toBe(
      "ticketClarity must be high, medium, or low",
    );
  });

  it("rejects invalid fixConfidence", () => {
    expect(validateGradeInput({ ...validInput, fixConfidence: "bad" })).toBe(
      "fixConfidence must be high, medium, or low",
    );
  });

  it("rejects invalid blastRadius", () => {
    expect(validateGradeInput({ ...validInput, blastRadius: "bad" })).toBe(
      "blastRadius must be isolated, moderate, or broad",
    );
  });

  it("rejects non-string reasoning", () => {
    expect(validateGradeInput({ ...validInput, reasoning: 123 })).toBe("reasoning must be a string");
  });

  it("rejects oversized reasoning", () => {
    expect(validateGradeInput({ ...validInput, reasoning: "x".repeat(5001) })).toBe(
      "reasoning must be 5000 characters or less",
    );
  });
});

describe("createGrade", () => {
  it("computes risk and sets createdAt", () => {
    const input: GradeInput = {
      taskId: "task-1",
      agentId: "agent-1",
      ticketClarity: "high",
      fixConfidence: "high",
      blastRadius: "isolated",
    };

    const grade = createGrade(input);
    expect(grade.taskId).toBe("task-1");
    expect(grade.agentId).toBe("agent-1");
    expect(grade.overallRisk).toBe("low");
    expect(grade.createdAt).toBeTruthy();
  });

  it("preserves reasoning", () => {
    const input: GradeInput = {
      taskId: "task-1",
      agentId: "agent-1",
      ticketClarity: "low",
      fixConfidence: "low",
      blastRadius: "broad",
      reasoning: "Very uncertain about this change",
    };

    const grade = createGrade(input);
    expect(grade.overallRisk).toBe("high");
    expect(grade.reasoning).toBe("Very uncertain about this change");
  });
});

describe("GradeStore", () => {
  let store: GradeStore;

  beforeEach(() => {
    store = new GradeStore();
  });

  const makeInput = (overrides?: Partial<GradeInput>): GradeInput => ({
    taskId: "task-1",
    agentId: "agent-1",
    ticketClarity: "high",
    fixConfidence: "high",
    blastRadius: "isolated",
    ...overrides,
  });

  it("submits and retrieves a grade", () => {
    const grade = store.submit(makeInput());
    expect(grade.overallRisk).toBe("low");

    const retrieved = store.get("task-1");
    expect(retrieved).toEqual(grade);
  });

  it("returns null for unknown taskId", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("overwrites previous grade for the same taskId", () => {
    store.submit(makeInput({ fixConfidence: "high" }));
    const updated = store.submit(makeInput({ fixConfidence: "low" }));
    expect(updated.overallRisk).toBe("medium");
    expect(store.get("task-1")?.fixConfidence).toBe("low");
  });

  it("lists all grades", () => {
    store.submit(makeInput({ taskId: "task-1" }));
    store.submit(makeInput({ taskId: "task-2" }));
    expect(store.getAll()).toHaveLength(2);
  });

  it("filters by risk level", () => {
    store.submit(makeInput({ taskId: "task-low" }));
    store.submit(makeInput({ taskId: "task-high", fixConfidence: "low", ticketClarity: "low" }));
    expect(store.getByRisk("low")).toHaveLength(1);
    expect(store.getByRisk("high")).toHaveLength(1);
  });

  it("filters by agent", () => {
    store.submit(makeInput({ taskId: "task-1", agentId: "agent-a" }));
    store.submit(makeInput({ taskId: "task-2", agentId: "agent-b" }));
    store.submit(makeInput({ taskId: "task-3", agentId: "agent-a" }));
    expect(store.getByAgent("agent-a")).toHaveLength(2);
    expect(store.getByAgent("agent-b")).toHaveLength(1);
  });

  it("removes a grade", () => {
    store.submit(makeInput());
    expect(store.remove("task-1")).toBe(true);
    expect(store.get("task-1")).toBeNull();
    expect(store.remove("task-1")).toBe(false);
  });

  it("clears all grades", () => {
    store.submit(makeInput({ taskId: "task-1" }));
    store.submit(makeInput({ taskId: "task-2" }));
    expect(store.clear()).toBe(2);
    expect(store.getAll()).toHaveLength(0);
  });
});
