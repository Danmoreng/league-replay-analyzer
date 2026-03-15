import type { ReplaySummary } from "./replayParser";
import createReplayModule from "./generated/wasm/rofl_wasm.js";

interface EmscriptenModule {
  cwrap<Fn extends (...args: never[]) => unknown>(
    identifier: string,
    returnType: "number" | "string" | null,
    argTypes: string[],
  ): Fn;
  UTF8ToString(pointer: number): string;
}

const CHUNK_SIZE = 64 * 1024;

let modulePromise: Promise<EmscriptenModule> | null = null;

async function loadModule(): Promise<EmscriptenModule> {
  if (!modulePromise) {
    modulePromise = createReplayModule() as Promise<EmscriptenModule>;
  }

  return modulePromise;
}

export async function parseReplayBufferWithWasm(buffer: ArrayBuffer): Promise<ReplaySummary> {
  const bytes = new Uint8Array(buffer);
  const module = await loadModule();
  const allocBuffer = module.cwrap<(size: number) => number>("lra_alloc_buffer", "number", [
    "number",
  ]);
  const copyChunk = module.cwrap<
    (destination: number, offset: number, chunk: Uint8Array, size: number) => void
  >("lra_copy_buffer_chunk", null, ["number", "number", "array", "number"]);
  const freeBuffer = module.cwrap<(pointer: number) => void>("lra_free_buffer", null, ["number"]);
  const parseBuffer = module.cwrap<(input: number, size: number) => number>(
    "lra_parse_replay_buffer",
    "number",
    ["number", "number"],
  );
  const freeString = module.cwrap<(pointer: number) => void>("lra_free_string", null, ["number"]);

  const replayPointer = allocBuffer(bytes.length);
  if (!replayPointer) {
    throw new Error("Failed to allocate replay buffer in Wasm memory.");
  }

  let resultPointer = 0;
  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
      copyChunk(replayPointer, offset, chunk, chunk.length);
    }

    resultPointer = parseBuffer(replayPointer, bytes.length);
    const json = module.UTF8ToString(resultPointer);
    const parsed = JSON.parse(json) as ReplaySummary | { error: string };
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    return parsed;
  } finally {
    if (resultPointer) {
      freeString(resultPointer);
    }
    freeBuffer(replayPointer);
  }
}
