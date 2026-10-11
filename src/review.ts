import { Hunk, normalize } from "./diff";

export interface ReviewRow {
  text: string;
  kind: "context" | "old" | "new";
  sourceLine: number;
  hunkId?: string;
  index?: number;
}

// A replacement line is one decision: its old and new rows share the action.
export function lineHunk(hunk: Hunk, index: number): Hunk | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= Math.max(hunk.oldLines.length, hunk.newLines.length)) return;
  const oldLines = hunk.oldLines.slice(index, index + 1);
  const newLines = hunk.newLines.slice(index, index + 1);
  return {
    id: hunk.id,
    oldStart: hunk.oldStart + Math.min(index, hunk.oldLines.length),
    newStart: hunk.newStart + Math.min(index, hunk.newLines.length),
    oldLines, newLines, removedOnly: !newLines.length,
  };
}

export function reviewRows(content: string, hunks: Hunk[]): ReviewRow[] {
  const lines = normalize(content).split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (!content) lines.length = 0;
  const rows: ReviewRow[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.newStart - 1;
    while (cursor < start && cursor < lines.length) {
      rows.push({ text: lines[cursor], kind: "context", sourceLine: cursor++ });
    }
    hunk.oldLines.forEach((text, index) => rows.push({ text, kind: "old", sourceLine: start + Math.min(index, hunk.newLines.length), hunkId: hunk.id, index }));
    hunk.newLines.forEach((text, index) => rows.push({ text, kind: "new", sourceLine: start + index, hunkId: hunk.id, index }));
    cursor = start + hunk.newLines.length;
  }
  while (cursor < lines.length) rows.push({ text: lines[cursor], kind: "context", sourceLine: cursor++ });
  return rows;
}
