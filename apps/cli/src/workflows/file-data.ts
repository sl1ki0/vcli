import type { FileHandle } from "node:fs/promises";

/** Bound actual bytes read, including a file that grows after its initial stat. */
export async function readFileBytes(handle: FileHandle, maximum: number): Promise<Buffer> {
  if ((await handle.stat()).size > maximum) throw new Error("File exceeds its byte limit.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes <= maximum) {
    const buffer = Buffer.alloc(Math.min(65_536, maximum + 1 - bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    bytes += bytesRead;
    if (bytes > maximum) throw new Error("File exceeds its byte limit.");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, bytes);
}
