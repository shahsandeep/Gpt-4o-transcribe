// Word-level diff for comparing two transcripts (e.g. enhanced vs not).
// LCS-based: tokens are marked equal / removed (only in A) / added (only in B).
// Comparison is punctuation- and case-insensitive; the original word is shown.

export type DiffType = 'equal' | 'removed' | 'added';

export interface DiffToken {
  type: DiffType;
  text: string;
}

interface Tok {
  display: string;
  key: string;
}

function tokenize(s: string): Tok[] {
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => ({ display: w, key: w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') }));
}

/** Diff two strings at the word level. A = baseline, B = candidate. */
export function diffWords(a: string, b: string): DiffToken[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;

  // LCS length table (suffix DP), then backtrack for the alignment.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i].key !== '' && A[i].key === B[j].key
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i].key !== '' && A[i].key === B[j].key) {
      out.push({ type: 'equal', text: A[i].display });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'removed', text: A[i].display });
      i++;
    } else {
      out.push({ type: 'added', text: B[j].display });
      j++;
    }
  }
  while (i < n) out.push({ type: 'removed', text: A[i++].display });
  while (j < m) out.push({ type: 'added', text: B[j++].display });
  return out;
}

export interface DiffStats {
  equal: number;
  changed: number;
  total: number;
  pct: number; // percent of words that differ
}

export function diffStats(tokens: DiffToken[]): DiffStats {
  let equal = 0;
  let changed = 0;
  for (const t of tokens) {
    if (t.type === 'equal') equal++;
    else changed++;
  }
  const total = equal + changed;
  return { equal, changed, total, pct: total ? Math.round((changed / total) * 100) : 0 };
}
