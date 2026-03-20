import type { ReplayEntitySlabAnalysisResult, ReplayFamilyAnalysisResult, ReplayFamilyScanResult, ReplayScalarFamilyAnalysisResult } from "./replayInvestigation";
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

async function withReplayBuffer<T>(
  buffer: ArrayBuffer,
  run: (module: EmscriptenModule, replayPointer: number, size: number) => T,
): Promise<T> {
  const bytes = new Uint8Array(buffer);
  const module = await loadModule();
  const allocBuffer = module.cwrap<(size: number) => number>("lra_alloc_buffer", "number", [
    "number",
  ]);
  const copyChunk = module.cwrap<
    (destination: number, offset: number, chunk: Uint8Array, size: number) => void
  >("lra_copy_buffer_chunk", null, ["number", "number", "array", "number"]);
  const freeBuffer = module.cwrap<(pointer: number) => void>("lra_free_buffer", null, ["number"]);

  const replayPointer = allocBuffer(bytes.length);
  if (!replayPointer) {
    throw new Error("Failed to allocate replay buffer in Wasm memory.");
  }

  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
      copyChunk(replayPointer, offset, chunk, chunk.length);
    }

    return run(module, replayPointer, bytes.length);
  } finally {
    freeBuffer(replayPointer);
  }
}

function parseJsonResult<T extends object>(module: EmscriptenModule, pointer: number): T {
  const freeString = module.cwrap<(value: number) => void>("lra_free_string", null, ["number"]);
  try {
    const json = module.UTF8ToString(pointer);
    const parsed = JSON.parse(json) as T | { error: string };
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    return parsed;
  } finally {
    freeString(pointer);
  }
}

export async function parseReplayBufferWithWasm(buffer: ArrayBuffer): Promise<ReplaySummary> {
  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const parseBuffer = module.cwrap<(input: number, size: number) => number>(
      "lra_parse_replay_buffer",
      "number",
      ["number", "number"],
    );

    return parseJsonResult<ReplaySummary>(module, parseBuffer(replayPointer, size));
  });
}

export async function scanReplayFamiliesWithWasm(
  buffer: ArrayBuffer,
  minimumLength = 256,
  minimumRecords = 4,
  topFamilies = 20,
): Promise<ReplayFamilyScanResult> {
  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const scanFamilies = module.cwrap<
      (input: number, size: number, minimumLength: number, minimumRecords: number, topFamilies: number) => number
    >("lra_scan_replay_families_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);

    return parseJsonResult<ReplayFamilyScanResult>(
      module,
      scanFamilies(replayPointer, size, minimumLength, minimumRecords, topFamilies),
    );
  });
}

export async function analyzeEntitySlabWithWasm(
  buffer: ArrayBuffer,
  options: {
    length: number;
    firstByte: number;
    headerSize: number;
    stride?: number;
    topSlots?: number;
  },
): Promise<ReplayEntitySlabAnalysisResult> {
  const {
    length,
    firstByte,
    headerSize,
    stride = 16,
    topSlots = 24,
  } = options;

  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const analyzeFamily = module.cwrap<
      (
        input: number,
        size: number,
        length: number,
        firstByte: number,
        headerSize: number,
        stride: number,
        topSlots: number,
      ) => number
    >("lra_analyze_entity_slab_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);

    return parseJsonResult<ReplayEntitySlabAnalysisResult>(
      module,
      analyzeFamily(
        replayPointer,
        size,
        length,
        firstByte,
        headerSize,
        stride,
        topSlots,
      ),
    );
  });
}

export async function analyzeSparseFamilyWithWasm(
  buffer: ArrayBuffer,
  options: {
    length: number;
    firstByte: number;
    headerSize: number;
    stride?: number;
    topSlots?: number;
    moveEpsilon?: number;
    smoothThreshold?: number;
  },
): Promise<ReplayFamilyAnalysisResult> {
  const {
    length,
    firstByte,
    headerSize,
    stride = 16,
    topSlots = 24,
    moveEpsilon = 25,
    smoothThreshold = 800,
  } = options;

  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const analyzeFamily = module.cwrap<
      (
        input: number,
        size: number,
        length: number,
        firstByte: number,
        headerSize: number,
        stride: number,
        topSlots: number,
        moveEpsilon: number,
        smoothThreshold: number,
      ) => number
    >("lra_analyze_sparse_family_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);

    return parseJsonResult<ReplayFamilyAnalysisResult>(
      module,
      analyzeFamily(
        replayPointer,
        size,
        length,
        firstByte,
        headerSize,
        stride,
        topSlots,
        moveEpsilon,
        smoothThreshold,
      ),
    );
  });
}



export async function analyzeScalarFamilyWithWasm(
  buffer: ArrayBuffer,
  options: {
    length: number;
    firstByte: number;
    headerSize: number;
    stride?: number;
    topSlots?: number;
  },
): Promise<ReplayScalarFamilyAnalysisResult> {
  const {
    length,
    firstByte,
    headerSize,
    stride = 16,
    topSlots = 24,
  } = options;

  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const analyzeFamily = module.cwrap<
      (
        input: number,
        size: number,
        length: number,
        firstByte: number,
        headerSize: number,
        stride: number,
        topSlots: number,
      ) => number
    >("lra_analyze_scalar_family_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);

    return parseJsonResult<ReplayScalarFamilyAnalysisResult>(
      module,
      analyzeFamily(
        replayPointer,
        size,
        length,
        firstByte,
        headerSize,
        stride,
        topSlots,
      ),
    );
  });
}
