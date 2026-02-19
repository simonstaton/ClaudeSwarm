import { describe, expect, it } from "vitest";

/**
 * Tests for the prompt normalization logic when handling attachment-only messages.
 * The logic under test (from src/routes/agents.ts):
 *   const promptText = typeof prompt === "string" ? prompt : "";
 *   fullPrompt = promptText ? promptText + suffix : suffix.trimStart();
 */

function buildFullPrompt(prompt: unknown, suffix: string): string {
  const promptText = typeof prompt === "string" ? prompt : "";
  let fullPrompt = promptText;
  if (suffix) {
    fullPrompt = promptText ? promptText + suffix : suffix.trimStart();
  }
  return fullPrompt;
}

describe("prompt cleanup for attachment-only messages", () => {
  const attachmentSuffix = "\n\nAttached files:\n- /workspace/image.png";

  it("concatenates prompt and suffix when both present", () => {
    const result = buildFullPrompt("Analyze this image", attachmentSuffix);
    expect(result).toBe("Analyze this image\n\nAttached files:\n- /workspace/image.png");
  });

  it("strips leading whitespace from suffix when prompt is empty string", () => {
    const result = buildFullPrompt("", attachmentSuffix);
    expect(result).toBe("Attached files:\n- /workspace/image.png");
    expect(result).not.toMatch(/^\n/);
  });

  it("strips leading whitespace from suffix when prompt is undefined", () => {
    const result = buildFullPrompt(undefined, attachmentSuffix);
    expect(result).toBe("Attached files:\n- /workspace/image.png");
    expect(result).not.toMatch(/^\n/);
  });

  it("strips leading whitespace from suffix when prompt is null", () => {
    const result = buildFullPrompt(null, attachmentSuffix);
    expect(result).toBe("Attached files:\n- /workspace/image.png");
  });

  it("returns prompt as-is when there are no attachments", () => {
    const result = buildFullPrompt("Hello agent", "");
    expect(result).toBe("Hello agent");
  });

  it("returns empty string when both prompt and suffix are empty", () => {
    const result = buildFullPrompt("", "");
    expect(result).toBe("");
  });

  it("preserves internal whitespace in prompt", () => {
    const result = buildFullPrompt("Line 1\n\nLine 2", attachmentSuffix);
    expect(result).toContain("Line 1\n\nLine 2");
  });
});
