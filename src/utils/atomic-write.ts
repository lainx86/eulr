import { randomBytes } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const temporaryPath = path.join(
    directory,
    `.${basename}.eulr-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const mode = options.mode ?? (await existingMode(filePath)) ?? 0o666;
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, "wx", mode);
    temporaryCreated = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
