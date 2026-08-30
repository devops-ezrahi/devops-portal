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

/**
 * The archive is never assembled in the tab — it goes out as parts as it is
 * produced. Joining them back up is what the server does by appending them, so
 * doing the same here is what makes the assertions below about a whole zip
 * meaningful.
 */
async function zipToBlob(entries: FileEntry[], onProgress: (done: number) => void = () => {}) {
  const parts: Blob[] = [];
  await zipEntries(entries, onProgress, async (part) => {
    parts.push(part);
  });
  return new Blob(parts);
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
    const archive = await zipToBlob(entries, (done) => seen.push(done));
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

  // Deflating an already-compressed file gains ~0% and costs full CPU per byte,
  // so those extensions are stored. A compressible payload proves which branch
  // ran: stored keeps the run verbatim, deflate would collapse it.
  it("stores already-compressed extensions instead of deflating", async () => {
    const payload = "x".repeat(2000);
    const archive = await zipToBlob([
      entry("pkgs/arg-4.1.5.tgz", payload),
      entry("pkgs/readme.txt", payload),
    ]);
    const raw = Buffer.from(await archive.arrayBuffer());

    expect(raw.includes(Buffer.from(payload))).toBe(true);
    expect(raw.lastIndexOf(Buffer.from(payload))).toBe(raw.indexOf(Buffer.from(payload)));
    expect(Object.keys(unzipSync(new Uint8Array(raw))).sort()).toEqual([
      "pkgs/arg-4.1.5.tgz",
      "pkgs/readme.txt",
    ]);
  });
});
