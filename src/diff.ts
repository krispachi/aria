import { DefaultLinesDiffComputer } from "vscode-diff";

export interface Hunk {
  id: string;
  oldStart: number; // 1-based, line in the baseline snapshot
  newStart: number; // 1-based, line in the current file
  oldLines: string[];
  newLines: string[];
  removedOnly: boolean;
}

export function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function toLines(text: string): string[] {
  const parts = normalize(text).split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

const computer = new DefaultLinesDiffComputer();

// Same algorithm and options as VS Code's diff editor (advanced, whitespace
// significant, no moves), so CodeLens rows match the red/green rows it draws.
export function computeHunks(oldText: string, newText: string): Hunk[] {
  const oldNormalized = normalize(oldText), newNormalized = normalize(newText);
  if (oldNormalized === newNormalized) return [];
  const oldLines = toLines(oldNormalized), newLines = toLines(newNormalized);
  // Feed model-style lines (a trailing newline yields a final empty line), as
  // the editor does; hunks are then clamped to the logical lines.
  const result = computer.computeDiff(oldNormalized.split("\n"), newNormalized.split("\n"), { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 1000 });
  const clamp = (n: number, lines: string[]) => Math.min(n, lines.length + 1);
  const hunks = result.changes.map(change => {
    const oldStart = clamp(change.original.startLineNumber, oldLines), newStart = clamp(change.modified.startLineNumber, newLines);
    return toHunk(oldStart, newStart,
      oldLines.slice(oldStart - 1, clamp(change.original.endLineNumberExclusive, oldLines) - 1),
      newLines.slice(newStart - 1, clamp(change.modified.endLineNumberExclusive, newLines) - 1));
  }).filter(h => h.oldLines.length || h.newLines.length);
  // Only the final newline differs: represent it as a change of the last line
  // so accepting/rejecting can carry the EOF marker.
  const last = hunks.at(-1);
  const coversEnd = last && last.oldStart - 1 + last.oldLines.length === oldLines.length && last.newStart - 1 + last.newLines.length === newLines.length;
  if (oldNormalized.endsWith("\n") !== newNormalized.endsWith("\n") && !coversEnd && oldLines.length && newLines.length) {
    hunks.push(toHunk(oldLines.length, newLines.length, [oldLines[oldLines.length - 1]], [newLines[newLines.length - 1]]));
  }
  return hunks;
}

function toHunk(oldStart: number, newStart: number, oldLines: string[], newLines: string[]): Hunk {
  return { id: `${oldStart}:${newStart}`, oldStart, newStart, oldLines, newLines, removedOnly: newLines.length === 0 };
}
