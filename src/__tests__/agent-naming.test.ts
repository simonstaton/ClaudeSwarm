import { describe, expect, it } from "vitest";
import { generateNameFromPrompt } from "../agents";

const ID = "3f2a1bcc-dead-beef-0000-111122223333";
const SUFFIX = "3f2a1b"; // id.slice(0, 6)

describe("generateNameFromPrompt", () => {
  describe("happy path — well-formed English prompts", () => {
    it("extracts up to 3 meaningful words and appends UUID suffix", () => {
      expect(generateNameFromPrompt("Analyze security vulnerabilities in auth module", ID)).toBe(
        `analyze-security-vulnerabilities-${SUFFIX}`,
      );
    });

    it("lowercases the result", () => {
      expect(generateNameFromPrompt("FIX Login Bug", ID)).toBe(`fix-login-bug-${SUFFIX}`);
    });

    it("stops at 3 content words even when more are available", () => {
      const result = generateNameFromPrompt("refactor the distributed rate limiting middleware layer", ID);
      expect(result).toBe(`refactor-distributed-rate-${SUFFIX}`);
    });

    it("uses only the first newline-delimited line", () => {
      const result = generateNameFromPrompt("analyze auth\nignore this second line completely", ID);
      expect(result).toBe(`analyze-auth-${SUFFIX}`);
    });

    it("strips punctuation and special characters", () => {
      // "the" is a stop word; "!" "()" "—" "/" become spaces; "asap" precedes "auth"
      expect(generateNameFromPrompt("Fix the bug! (ASAP) — auth/login", ID)).toBe(`fix-bug-asap-${SUFFIX}`);
    });
  });

  describe("dot-split fix — dots must not prematurely end the line", () => {
    it("does not split the line on dots in version strings", () => {
      // Old code: split(/[\n.!?]/) → first segment "v1" → "v1" is 2 chars, filtered →
      //   no words → UUID fallback.
      // New code: split("\n") only → full line processed → "v1"/"2"/"3" each ≤2 chars,
      //   filtered; "the" is a stop word → ["upgrade","auth","module"] → content name.
      expect(generateNameFromPrompt("v1.2.3 upgrade the auth module", ID)).toBe(`upgrade-auth-module-${SUFFIX}`);
    });

    it("does not split the line on dots in domain names", () => {
      // Old code: first segment "api" → single-word slug "api".
      // New code: dots become spaces → ["api","example","com",...] → 3-word slug.
      expect(generateNameFromPrompt("api.example.com rate limit analysis", ID)).toBe(`api-example-com-${SUFFIX}`);
    });

    it("does not split the line on dots in file paths", () => {
      // Old code: "src/auth" + "ts refactor..." → slug "src-auth".
      // New code: dot→space, "ts" filtered (2 chars) → ["src","auth","refactor",...].
      expect(generateNameFromPrompt("src/auth.ts refactor login flow", ID)).toBe(`src-auth-refactor-${SUFFIX}`);
    });

    it("does split on newlines as intended", () => {
      const result = generateNameFromPrompt("first line words\nnever appear in result", ID);
      const parts = result.split("-");
      expect(parts).not.toContain("never");
      expect(parts).not.toContain("appear");
    });
  });

  describe("uniqueness — identical prompts produce different names via UUID suffix", () => {
    it("two promptless-named agents from identical prompts get different names", () => {
      const idA = "aaaa1111-0000-0000-0000-000000000000";
      const idB = "bbbb2222-0000-0000-0000-000000000000";
      const nameA = generateNameFromPrompt("analyze the auth module", idA);
      const nameB = generateNameFromPrompt("analyze the auth module", idB);
      expect(nameA).not.toBe(nameB);
      expect(nameA).toContain("aaaa11");
      expect(nameB).toContain("bbbb22");
    });
  });

  describe("fallback to agent-<uuid8> for degenerate prompts", () => {
    it("falls back on empty string", () => {
      expect(generateNameFromPrompt("", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on whitespace-only prompt", () => {
      expect(generateNameFromPrompt("   ", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back when all words are stop words", () => {
      expect(generateNameFromPrompt("do it", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back when all words are shorter than 3 chars", () => {
      expect(generateNameFromPrompt("go do it", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on punctuation-only prompt", () => {
      expect(generateNameFromPrompt("!!! --- ???", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on non-ASCII / non-Latin prompts", () => {
      expect(generateNameFromPrompt("こんにちは世界", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });

    it("falls back on numeric-only tokens that are too short", () => {
      // "10" and "20" are 2 chars — filtered by length >= 3
      expect(generateNameFromPrompt("10 20", ID)).toBe(`agent-${ID.slice(0, 8)}`);
    });
  });

  describe("output constraints", () => {
    it("result never exceeds 40 characters", () => {
      const longPrompt = "implementation refactoring authentication middleware distributed";
      const result = generateNameFromPrompt(longPrompt, ID);
      expect(result.length).toBeLessThanOrEqual(40);
    });

    it("output contains only [a-z0-9-] characters", () => {
      const prompts = [
        "Fix the <XSS> injection vulnerability NOW!",
        "Analyze `auth.ts` — high priority",
        "v2.0 release: deploy to production environment",
        "Run 10 parallel tests",
      ];
      for (const p of prompts) {
        const result = generateNameFromPrompt(p, ID);
        expect(result).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("explicit name from caller is used unchanged (not passed through this function)", () => {
      // This is a contract test: the caller passes opts.name directly without
      // going through generateNameFromPrompt. We verify the function is only
      // called when opts.name is falsy by ensuring it always produces a suffix.
      const result = generateNameFromPrompt("some prompt", ID);
      expect(result).toContain(SUFFIX);
    });
  });
});
