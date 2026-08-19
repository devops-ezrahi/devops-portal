import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { zipEntries } from "./components/FolderUploadForm";
import type { FileEntry } from "./api";

// jsdom's Blob/File predate `.arrayBuffer()`; Node's have it and behave the same
// for what this exercises.
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
});

function entry(path: string, text: string): FileEntry {
  return { file: new File([text], path.split("/").pop()!) as unknown as File, path };
}

// The zip is built one file at a time to keep a node_modules-sized folder out of
// memory, which is easy to get subtly wrong (dropped entries, mangled paths,
// truncated output). This unzips the result to prove it survived the streaming.
describe("zipEntries", () => {
  it("round-trips every entry, folder paths included", async () => {
    const entries = [
      entry("node_modules/arg/package.json", '{"name":"arg","version":"4.1.5"}'),
      entry("node_modules/@babel/core/index.js", "module.exports = 1;"),
      entry("notes.txt", "x".repeat(50_000)),
    ];

    const seen: number[] = [];
    const archive = await zipEntries(entries, (done) => seen.push(done));
    const unzipped = unzipSync(new Uint8Array(await archive.arrayBuffer()));

    expect(Object.keys(unzipped).sort()).toEqual([
      "node_modules/@babel/core/index.js",
      "node_modules/arg/package.json",
      "notes.txt",
    ]);
    expect(new TextDecoder().decode(unzipped["node_modules/arg/package.json"])).toBe(
      '{"name":"arg","version":"4.1.5"}'
    );
    expect(unzipped["notes.txt"].length).toBe(50_000);
    expect(seen).toEqual([1, 2, 3]);
  });
});
