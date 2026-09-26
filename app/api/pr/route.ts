import { NextRequest, NextResponse } from "next/server";

const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export async function POST(req: NextRequest) {
  let prUrl: string;
  try {
    const body = await req.json();
    prUrl = body?.prUrl;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!prUrl || typeof prUrl !== "string") {
    return NextResponse.json(
      { error: "Missing 'prUrl' field in request body" },
      { status: 400 }
    );
  }

  const m = prUrl.trim().match(GITHUB_PR_RE);
  if (!m) {
    return NextResponse.json(
      { error: "Invalid GitHub PR URL" },
      { status: 400 }
    );
  }

  const [, owner, repo, number] = m;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        "User-Agent": "bob-review-coach",
      },
    });
  } catch (err) {
    console.error("[pr] GitHub fetch error:", err);
    return NextResponse.json(
      { error: "Failed to reach GitHub API" },
      { status: 502 }
    );
  }

  if (res.status === 404) {
    return NextResponse.json(
      {
        error:
          "Pull request not found. Make sure the PR exists and the repository is public.",
      },
      { status: 404 }
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[pr] GitHub API returned ${res.status} for ${apiUrl}:`,
      body
    );
    return NextResponse.json(
      {
        error: `GitHub returned ${res.status}. The repository may be private or the PR may not exist.`,
      },
      { status: res.status }
    );
  }

  const diff = await res.text();

  if (!diff.trim()) {
    return NextResponse.json(
      { error: "GitHub returned an empty diff for this pull request." },
      { status: 422 }
    );
  }

  return NextResponse.json({ diff });
}
