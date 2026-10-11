const { computeHunks, normalize } = require("./out/diff.js");
const assert = require("assert");

function show(oldT, newT) {
  const hunks = computeHunks(oldT, newT);
  console.log(
    JSON.stringify(
      hunks.map((h) => ({
        id: h.id,
        newStart: h.newStart,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newLines: h.newLines,
      })),
      null,
      1
    )
  );
  return hunks;
}

// 1) perubahan sederhana di tengah
let h = show("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n");
assert.strictEqual(h.length, 1);
assert.strictEqual(h[0].oldStart, 3);
assert.strictEqual(h[0].newStart, 3);
assert.deepStrictEqual(h[0].oldLines, ["c"]);
assert.deepStrictEqual(h[0].newLines, ["X"]);

// 2) penambahan murni
h = show("a\nb\n", "a\nNEW\nb\n");
assert.strictEqual(h.length, 1);
assert.strictEqual(h[0].oldStart, 2);
assert.strictEqual(h[0].newStart, 2);
assert.deepStrictEqual(h[0].oldLines, []);
assert.deepStrictEqual(h[0].newLines, ["NEW"]);

// 3) penghapusan murni
h = show("a\nGONE\nb\n", "a\nb\n");
assert.strictEqual(h.length, 1);
assert.deepStrictEqual(h[0].oldLines, ["GONE"]);
assert.deepStrictEqual(h[0].newLines, []);
assert.strictEqual(h[0].removedOnly, true);

// 4) banyak hunk
h = show("1\n2\n3\n4\n5\n6\n7\n8\n", "1\nX\n3\n4\n5\nY\n7\n8\n");
assert.strictEqual(h.length, 2);
assert.strictEqual(h[0].newStart, 2);
assert.strictEqual(h[1].newStart, 6);

// 5) file baru (old kosong)
h = show("", "a\nb\n");
assert.strictEqual(h.length, 1);
assert.deepStrictEqual(h[0].newLines, ["a", "b"]);

// 6) file CRLF -> seharusnya dianggap sama dengan LF
assert.strictEqual(computeHunks("a\r\nb\r\n", "a\nb\n").length, 0);

// 7) simulasikan reject: text baru, kembalikan oldLines pada range newStart..newStart+newLines
let oldT = "#include\nmain() {\n  return 1;\n}\nEOF\n";
let newT = "#include\nmain() {\n  return 2;\n  log('x');\n}\nEOF\n";
h = computeHunks(oldT, newT);
assert.strictEqual(h.length, 1);
const hh = h[0];
// reject: ganti range di newT
const lines = newT.split("\n");
const start = hh.newStart - 1;
const end = start + hh.newLines.length;
const eol = newT.includes("\r\n") ? "\r\n" : "\n";
const restored =
  lines.slice(0, start).join("\n") +
  (start > 0 ? "\n" : "") +
  hh.oldLines.join("\n") +
  "\n" +
  lines.slice(end).join("\n");
assert.strictEqual(computeHunks(oldT, restored).length, 0, "reject harus menghasilkan oldT");

// Hook runtime: payload parsing, global store and hash parity with store.ts.
(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const store = require("./out/store.js");
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "aria-test-"));
  try {
    const root = path.join(temp, "Project With Spaces");
    const global = path.join(temp, "store");
    const runtime = path.resolve("adapters/record-event.mjs");
    const patch = "*** Begin Patch\r\n*** Update File: src/old name.ts\r\n*** Move to: src/new name.ts\r\n@@\r\n-old\r\n+new\r\n*** Add File: new file.ts\r\n+hello\r\n*** End Patch";
    const payloads = [
      { cwd: root, tool_name: "apply_patch", tool_input: { command: patch } },
      { cwd: root, tool_input: JSON.stringify({ patch }) },
      { cwd: root, data: { input: { apply_patch: patch } } },
      { cwd: root, input: patch },
      { cwd: root, tool_input: { file_path: "claude file.ts" } },
      { workspace_roots: [root], file_path: path.join(root, "cursor file.ts") },
      [{ root, file: "array one.ts" }, { root, file: "array two.ts" }],
    ];
    for (const payload of payloads) {
      const result = spawnSync(process.execPath, [runtime], {
        input: JSON.stringify(payload, null, 2), encoding: "utf8",
        env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, "");
    }
    const eventsFile = path.join(global, "projects", store.projectHash(root) + ".jsonl");
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.strictEqual(events.length, 16);
    const geminiResult = spawnSync(process.execPath, [runtime, "--gemini"], {
      input: JSON.stringify({ cwd: root, hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: "gemini file.ts", old_string: "a", new_string: "b" } }),
      encoding: "utf8", env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
    });
    assert.equal(geminiResult.status, 0);
    assert.deepEqual(JSON.parse(geminiResult.stdout), {}, "Gemini receives valid neutral JSON, not a blocking decision");
    const geminiEvent = JSON.parse(fs.readFileSync(eventsFile, "utf8").trim().split("\n").at(-1));
    assert.equal(geminiEvent.file, path.join(root, "gemini file.ts"));
    assert.equal(geminiEvent.agent, "gemini");
    const tagged = spawnSync(process.execPath, [runtime, "--agent", "cursor"], {
      input: JSON.stringify({ root, file: "tagged cursor.ts", agent: "gemini", prompt: "private prompt" }),
      encoding: "utf8", env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
    });
    assert.equal(tagged.status, 0); assert.equal(tagged.stdout, "");
    const taggedEvent = JSON.parse(fs.readFileSync(eventsFile, "utf8").trim().split("\n").at(-1));
    assert.equal(taggedEvent.agent, "cursor", "The configured producer flag takes precedence over input payload");
    assert.deepEqual(Object.keys(taggedEvent).sort(), ["agent", "file", "t"], "Tagged events contain only producer ID, path and time");
    assert(events.some((ev) => ev.file === path.join(root, "cursor file.ts")));
    assert(events.some((ev) => ev.file === path.join(root, "src/new name.ts")));
    const hash = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const m = await import(process.argv[1]); process.stdout.write(m.projectHash(process.argv[2]));',
      require("node:url").pathToFileURL(runtime).href, "C:\\Path With Spaces\\ROOT\\"], { input: "", encoding: "utf8" });
    assert.strictEqual(hash.status, 0, hash.stderr);
    assert.strictEqual(hash.stdout, store.projectHash("C:/Path With Spaces/ROOT/"));
    const bad = spawnSync(process.execPath, [runtime], { input: "not json\n{}\n", encoding: "utf8" });
    assert.strictEqual(bad.status, 0);
    fs.writeFileSync(path.join(temp, "blocked"), "file");
    const blocked = spawnSync(process.execPath, [runtime], {
      input: JSON.stringify({ root, file: "test.ts" }), encoding: "utf8",
      env: { ...process.env, OIR_STORE_DIR: path.join(temp, "blocked") },
    });
    assert.strictEqual(blocked.status, 0);
    if (process.platform !== "win32") {
      // Edits from agents Zed runs in its Agent Panel are skipped (Zed reviews them).
      const acpDir = path.join(temp, "external_agents");
      fs.mkdirSync(acpDir);
      const launcher = path.join(acpDir, "agent.sh");
      fs.writeFileSync(launcher, `"${process.execPath}" "${runtime}" --agent claude\n`);
      const before = fs.readFileSync(eventsFile, "utf8");
      const skipped = spawnSync("sh", [launcher], { input: JSON.stringify({ root, file: "acp.ts" }), encoding: "utf8", env: { ...process.env, OIR_STORE_DIR: global } });
      assert.strictEqual(skipped.status, 0, skipped.stderr);
      assert.strictEqual(fs.readFileSync(eventsFile, "utf8"), before, "Zed Agent Panel edits are not recorded");
    }
    console.log("HOOK RUNTIME TESTS PASSED");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
