import { NextRequest, NextResponse } from "next/server";
import OpenAI, { RateLimitError } from "openai";

export type Specialist = "security" | "correctness" | "maintainability";

export interface Finding {
  file: string;
  line: string;
  severity: "blocking" | "suggestion" | "nitpick";
  issue: string;
  why: string;
  suggestedFix: string;
  specialist: Specialist;
}

const DIFF_CHAR_LIMIT = 20_000;

/**
 * Truncate a diff to at most `limit` characters, cutting at the last hunk
 * boundary (`\ndiff --git ` or `\n@@`) before the limit so the diff stays
 * syntactically coherent.  Returns the (possibly unchanged) diff and a flag
 * indicating whether truncation occurred.
 */
function truncateDiff(diff: string, limit: number): { diff: string; truncated: boolean } {
  if (diff.length <= limit) return { diff, truncated: false };

  const slice = diff.slice(0, limit);
  // Prefer cutting at the start of a new file diff, then at a hunk header.
  const fileBoundary = slice.lastIndexOf("\ndiff --git ");
  const hunkBoundary = slice.lastIndexOf("\n@@");
  const cut = fileBoundary > 0 ? fileBoundary : hunkBoundary > 0 ? hunkBoundary : limit;

  return { diff: diff.slice(0, cut), truncated: true };
}

const FINDING_SHAPE = `For every problem you find, produce one JSON object with exactly these fields:
  "file"         – the file path from the diff header (e.g. "src/utils/auth.ts")
  "line"         – the line number or range where the problem appears (e.g. "42" or "38-45"); use "–" if not determinable
  "severity"     – one of: "blocking", "suggestion", or "nitpick"
  "issue"        – a short title for the problem (≤ 15 words)
  "why"          – plain-English explanation of why this matters to a reviewer (1–3 sentences)
  "suggestedFix" – a concrete description of how to fix it, including a code snippet where helpful

Return ONLY a valid JSON array of finding objects — no markdown fences, no commentary, no extra keys.
Return AT MOST 10 findings, prioritising the most severe (blocking first, then suggestion, then nitpick).
If you find no problems in your area, return an empty array: []`;

const SPECIALIST_PROMPTS: Record<Specialist, string> = {
  security: `You are a security-focused code reviewer. Analyse the supplied git diff and identify ONLY security issues such as:
- Injection vulnerabilities (SQL, command, XSS, etc.)
- Exposed secrets, credentials, or API keys
- Broken or missing authentication / authorisation checks
- Insecure direct object references
- Sensitive data leakage or improper data exposure
- Use of deprecated or unsafe cryptographic functions
- Any other vulnerability that could be exploited by an attacker

${FINDING_SHAPE}`,

  correctness: `You are a correctness-focused code reviewer. Analyse the supplied git diff and identify ONLY bugs and logic errors such as:
- Off-by-one errors and incorrect boundary conditions
- Null / undefined dereferences and missing null-checks
- Incorrect operator precedence or type coercion surprises
- Race conditions and concurrency issues
- Missing or incorrect error handling that would cause silent failures
- Wrong algorithm logic or incorrect data transformations

${FINDING_SHAPE}`,

  maintainability: `You are a maintainability-focused code reviewer. Analyse the supplied git diff and identify ONLY code quality issues such as:
- Unclear, misleading, or overly abbreviated naming
- Functions or classes that are excessively large or do too many things
- Dead code, unused variables, redundant logic
- Duplicated code that should be extracted
- Missing or outdated comments / documentation on non-obvious logic
- Violations of established project conventions visible in the diff

${FINDING_SHAPE}`,
};

const STAGGER_MS = 500;
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the suggested retry delay out of Groq's rate-limit error message.
 * Groq includes text like "Please try again in 1.5s" or "try again in 10s".
 * Falls back to `fallbackMs` if no match is found.
 */
function retryDelayMs(message: string, fallbackMs = 10_000): number {
  const m = message.match(/try again in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return fallbackMs;
}

async function runSpecialist(
  client: OpenAI,
  specialist: Specialist,
  diff: string
): Promise<Finding[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: SPECIALIST_PROMPTS[specialist] },
          { role: "user", content: `Here is the git diff to review:\n\n${diff}` },
        ],
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error(`[review/${specialist}] JSON parse failed. Raw response:`, raw);
        throw new Error("too_large");
      }

      const items: Omit<Finding, "specialist">[] = Array.isArray(parsed)
        ? parsed
        : ((parsed as Record<string, unknown>).findings ??
           (parsed as Record<string, unknown>).results ??
           (parsed as Record<string, unknown>).issues ??
           []) as Omit<Finding, "specialist">[];

      return items.map((item) => ({ ...item, specialist }));
    } catch (err) {
      // Non-retryable errors — re-throw immediately.
      if (!(err instanceof RateLimitError)) throw err;

      lastError = err;
      const delay = retryDelayMs(err.message);
      console.warn(
        `[review/${specialist}] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
          `Retrying in ${delay}ms…`
      );
      if (attempt < MAX_RETRIES) await sleep(delay);
    }
  }

  // All retries exhausted on rate-limit errors.
  throw new Error("rate_limited");
}

export async function POST(req: NextRequest) {
  let diff: string;
  try {
    const body = await req.json();
    diff = body?.diff;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!diff || typeof diff !== "string" || diff.trim().length === 0) {
    return NextResponse.json(
      { error: "Missing or empty 'diff' field in request body" },
      { status: 400 }
    );
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY environment variable is not set" },
      { status: 500 }
    );
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const { diff: reviewDiff, truncated } = truncateDiff(diff, DIFF_CHAR_LIMIT);
  if (truncated) {
    console.warn(
      `[review] Diff truncated from ${diff.length} to ${reviewDiff.length} chars`
    );
  }

  let findings: Finding[];
  try {
    const specialists: Specialist[] = ["security", "correctness", "maintainability"];
    // Stagger the starts to avoid bursting all three calls simultaneously,
    // then await all of them so they still run concurrently after their offset.
    const promises = specialists.map((s, i) =>
      sleep(i * STAGGER_MS).then(() => runSpecialist(client, s, reviewDiff))
    );
    const results = await Promise.all(promises);
    findings = results.flat();
  } catch (err) {
    if (err instanceof Error && err.message === "too_large") {
      return NextResponse.json(
        {
          error:
            "The diff is too large for the model to process. Try reviewing a smaller set of changes.",
        },
        { status: 422 }
      );
    }
    if (err instanceof Error && err.message === "rate_limited") {
      return NextResponse.json(
        {
          error:
            "The review service is busy right now. Please try again in a moment.",
        },
        { status: 429 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Inference request failed: ${message}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ findings, truncated });
}
