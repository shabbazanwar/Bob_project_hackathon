"use client";

import { useState } from "react";

const GITHUB_PR_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function parseGitHubPrUrl(
  url: string
): { owner: string; repo: string; number: string } | null {
  const m = url.trim().match(GITHUB_PR_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}

type Specialist = "security" | "correctness" | "maintainability";

interface Finding {
  file: string;
  line: string;
  severity: "blocking" | "suggestion" | "nitpick";
  issue: string;
  why: string;
  suggestedFix: string;
  specialist: Specialist;
}

const SPECIALIST_STYLES: Record<Specialist, string> = {
  security:
    "bg-purple-100 text-purple-700 ring-1 ring-purple-200",
  correctness:
    "bg-blue-100 text-blue-700 ring-1 ring-blue-200",
  maintainability:
    "bg-teal-100 text-teal-700 ring-1 ring-teal-200",
};

const SPECIALIST_LABELS: Record<Specialist, string> = {
  security: "🔒 Security",
  correctness: "🐛 Correctness",
  maintainability: "🔧 Maintainability",
};

const SEVERITY_STYLES: Record<
  Finding["severity"],
  { badge: string; border: string }
> = {
  blocking: {
    badge: "bg-red-100 text-red-700 ring-1 ring-red-200",
    border: "border-red-200",
  },
  suggestion: {
    badge: "bg-amber-100 text-amber-700 ring-1 ring-amber-200",
    border: "border-amber-200",
  },
  nitpick: {
    badge: "bg-gray-100 text-gray-600 ring-1 ring-gray-200",
    border: "border-gray-200",
  },
};

function FindingCard({ finding }: { finding: Finding }) {
  const styles = SEVERITY_STYLES[finding.severity] ?? SEVERITY_STYLES.nitpick;
  const specialistClass =
    SPECIALIST_STYLES[finding.specialist] ?? SPECIALIST_STYLES.maintainability;
  const specialistLabel =
    SPECIALIST_LABELS[finding.specialist] ?? finding.specialist;
  return (
    <div
      className={`rounded-lg border bg-white p-5 shadow-sm space-y-3 ${styles.border}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 leading-snug">
          {finding.issue}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${specialistClass}`}
          >
            {specialistLabel}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${styles.badge}`}
          >
            {finding.severity}
          </span>
        </div>
      </div>

      {/* Location */}
      <p className="text-xs text-gray-500 font-mono">
        {finding.file}
        {finding.line && finding.line !== "–" ? `:${finding.line}` : ""}
      </p>

      {/* Why it matters */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">
          Why it matters
        </p>
        <p className="text-sm text-gray-700">{finding.why}</p>
      </div>

      {/* Suggested fix */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">
          Suggested fix
        </p>
        <p className="text-sm text-gray-700 whitespace-pre-wrap font-mono bg-gray-50 rounded p-3 border border-gray-100">
          {finding.suggestedFix}
        </p>
      </div>
    </div>
  );
}

type Status = "idle" | "loading" | "done" | "error";

interface ImpactStats {
  filesChanged: number;
  reviewSeconds: number;
  manualMinutes: number;
  truncated: boolean;
}

function countDiffFiles(diff: string): number {
  return (diff.match(/^diff --git /gm) ?? []).length;
}

export default function Home() {
  const [prUrl, setPrUrl] = useState("");
  const [prFetchStatus, setPrFetchStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [prFetchError, setPrFetchError] = useState("");
  const [diff, setDiff] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [impactStats, setImpactStats] = useState<ImpactStats | null>(null);

  async function handleLoadFromGitHub() {
    if (!parseGitHubPrUrl(prUrl)) {
      setPrFetchError(
        "Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123"
      );
      setPrFetchStatus("error");
      return;
    }

    setPrFetchStatus("loading");
    setPrFetchError("");

    try {
      const res = await fetch("/api/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPrFetchError(data?.error ?? `Request failed (${res.status})`);
        setPrFetchStatus("error");
        return;
      }
      setDiff(data.diff);
      setPrFetchStatus("idle");
    } catch {
      setPrFetchError(
        "Failed to fetch the diff. Check your network connection."
      );
      setPrFetchStatus("error");
    }
  }

  async function handleReview() {
    setStatus("loading");
    setFindings([]);
    setErrorMessage("");
    setImpactStats(null);

    const startTime = Date.now();

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data?.error ?? `Request failed (${res.status})`);
        setStatus("error");
        return;
      }

      const findings: Finding[] = Array.isArray(data.findings) ? data.findings : [];
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      const filesChanged = countDiffFiles(diff);
      const manualMinutes = filesChanged * 4 + findings.length * 2;

      setFindings(findings);
      setImpactStats({
        filesChanged,
        reviewSeconds: elapsedSeconds,
        manualMinutes,
        truncated: !!data.truncated,
      });
      setStatus("done");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Unexpected network error"
      );
      setStatus("error");
    }
  }

  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const suggestion = findings.filter((f) => f.severity === "suggestion").length;
  const nitpick = findings.filter((f) => f.severity === "nitpick").length;

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Heading */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Bob Review Coach</h1>
          <p className="mt-1 text-sm text-gray-500">
            Paste a GitHub PR URL to fetch its diff automatically, or paste a
            git diff directly below.
          </p>
        </div>

        {/* Input */}
        <div className="space-y-3">
          {/* GitHub PR URL */}
          <div className="space-y-2">
            <label
              htmlFor="pr-url-input"
              className="block text-sm font-medium text-gray-700"
            >
              GitHub PR URL{" "}
              <span className="text-gray-400 font-normal">(public repos)</span>
            </label>
            <div className="flex gap-2">
              <input
                id="pr-url-input"
                type="url"
                value={prUrl}
                onChange={(e) => {
                  setPrUrl(e.target.value);
                  if (prFetchStatus === "error") setPrFetchStatus("idle");
                }}
                placeholder="https://github.com/owner/repo/pull/123"
                className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-800 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={handleLoadFromGitHub}
                disabled={prUrl.trim().length === 0 || prFetchStatus === "loading"}
                className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {prFetchStatus === "loading" ? (
                  <>
                    <svg
                      className="animate-spin h-4 w-4 text-gray-500"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Loading…
                  </>
                ) : (
                  "Load diff"
                )}
              </button>
            </div>
            {prFetchStatus === "error" && (
              <p className="text-sm text-red-600">{prFetchError}</p>
            )}
            {prFetchStatus === "idle" && diff && prUrl && (
              <p className="text-sm text-green-600">Diff loaded — ready to review.</p>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-gray-400">
            <div className="flex-1 border-t border-gray-200" />
            <span>or paste a diff directly</span>
            <div className="flex-1 border-t border-gray-200" />
          </div>

          <label
            htmlFor="diff-input"
            className="block text-sm font-medium text-gray-700"
          >
            Git diff
          </label>
          <textarea
            id="diff-input"
            value={diff}
            onChange={(e) => setDiff(e.target.value)}
            placeholder={"Paste your git diff here…\n\ne.g. git diff HEAD~1"}
            rows={20}
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 font-mono text-sm text-gray-800 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
          />
          <button
            type="button"
            onClick={handleReview}
            disabled={diff.trim().length === 0 || status === "loading"}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {status === "loading" ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Reviewing…
              </>
            ) : (
              "Review Code"
            )}
          </button>
        </div>

        {/* Results */}
        <section aria-label="Review results">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Results</h2>

          {/* Loading skeleton */}
          {status === "loading" && (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="rounded-lg border border-gray-200 bg-white p-5 space-y-3 animate-pulse"
                >
                  <div className="flex justify-between gap-3">
                    <div className="h-4 bg-gray-200 rounded w-2/3" />
                    <div className="h-5 bg-gray-200 rounded-full w-20" />
                  </div>
                  <div className="h-3 bg-gray-100 rounded w-1/3" />
                  <div className="h-3 bg-gray-100 rounded w-full" />
                  <div className="h-3 bg-gray-100 rounded w-5/6" />
                </div>
              ))}
            </div>
          )}

          {/* Error state */}
          {status === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              <p className="font-semibold mb-1">Something went wrong</p>
              <p>{errorMessage}</p>
            </div>
          )}

          {/* Empty state — shown only after a successful run with zero findings */}
          {status === "done" && findings.length === 0 && (
            <div className="min-h-32 rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-400 flex items-center justify-center">
              No issues found — looks good! 🎉
            </div>
          )}

          {/* Findings */}
          {status === "done" && findings.length > 0 && (
            <div className="space-y-4">
              {/* Truncation notice */}
              {impactStats?.truncated && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <span className="font-semibold">Large diff detected:</span> only the first ~20 000 characters were reviewed. Split the PR into smaller changes for full coverage.
                </div>
              )}

              {/* Impact stats bar */}
              {impactStats && (
                <div className="rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    {/* Files changed */}
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-400 text-xs font-medium uppercase tracking-wide">Files</span>
                      <span className="font-semibold text-gray-900">{impactStats.filesChanged}</span>
                    </div>

                    <div className="hidden sm:block h-4 w-px bg-gray-200" aria-hidden="true" />

                    {/* Findings by severity */}
                    <div className="flex flex-wrap gap-2 text-xs font-medium">
                      {blocking > 0 && (
                        <span className="rounded-full bg-red-100 text-red-700 ring-1 ring-red-200 px-3 py-1">
                          {blocking} blocking
                        </span>
                      )}
                      {suggestion > 0 && (
                        <span className="rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 px-3 py-1">
                          {suggestion} suggestion{suggestion !== 1 ? "s" : ""}
                        </span>
                      )}
                      {nitpick > 0 && (
                        <span className="rounded-full bg-gray-100 text-gray-600 ring-1 ring-gray-200 px-3 py-1">
                          {nitpick} nitpick{nitpick !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>

                    <div className="hidden sm:block h-4 w-px bg-gray-200" aria-hidden="true" />

                    {/* Time comparison */}
                    <p className="text-sm text-gray-600">
                      <span className="text-gray-400 line-through">Manual review: ~{impactStats.manualMinutes} min</span>
                      <span className="mx-2 text-gray-300">→</span>
                      <span className="font-semibold text-indigo-600">AI review: {impactStats.reviewSeconds}s</span>
                    </p>
                  </div>
                </div>
              )}

              {findings.map((f, i) => (
                <FindingCard key={i} finding={f} />
              ))}
            </div>
          )}

          {/* Initial idle state */}
          {status === "idle" && (
            <div className="min-h-32 rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-400 flex items-center justify-center">
              Review results will appear here.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
