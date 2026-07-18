import type {
  ReplayEntitySlabAnalysisResult,
  ReplayFamilyAnalysisResult,
  ReplayFamilyScanResult,
  ReplayScalarFamilyAnalysisResult,
} from "./replayInvestigation";
import type { ReplayKillResult } from "./replayKills";
import type { ReplayObjectiveResult } from "./replayObjectives";
import type { ReplayWardPositionResearchResult } from "./replayWardPositionResearch";
import type { ReplayWardResult } from "./replayWards";
import type { ReplaySummary } from "./replayParser";
import createReplayModule from "./generated/wasm/rofl_wasm.js";
import defaultDecoderProfileRegistryJson from "../../../packages/rofl-core/profiles/replay-decoder-profiles.v1.json?raw";

interface EmscriptenModule {
  cwrap<Fn extends (...args: never[]) => unknown>(
    identifier: string,
    returnType: "number" | "string" | null,
    argTypes: string[],
  ): Fn;
  UTF8ToString(pointer: number): string;
}

const CHUNK_SIZE = 64 * 1024;

export const DEFAULT_DECODER_PROFILE_REGISTRY_JSON = defaultDecoderProfileRegistryJson;

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

async function withReplayAndProfileBuffers<T>(
  buffer: ArrayBuffer,
  profileJson: string,
  run: (
    module: EmscriptenModule,
    replayPointer: number,
    replaySize: number,
    profilePointer: number,
    profileSize: number,
  ) => T,
): Promise<T> {
  const replayBytes = new Uint8Array(buffer);
  const profileBytes = new TextEncoder().encode(profileJson);
  if (profileBytes.length === 0) {
    throw new Error("Decoder profile registry must not be empty.");
  }

  const module = await loadModule();
  const allocBuffer = module.cwrap<(size: number) => number>("lra_alloc_buffer", "number", [
    "number",
  ]);
  const copyChunk = module.cwrap<
    (destination: number, offset: number, chunk: Uint8Array, size: number) => void
  >("lra_copy_buffer_chunk", null, ["number", "number", "array", "number"]);
  const freeBuffer = module.cwrap<(pointer: number) => void>("lra_free_buffer", null, ["number"]);

  const replayPointer = allocBuffer(replayBytes.length);
  if (!replayPointer) {
    throw new Error("Failed to allocate replay buffer in Wasm memory.");
  }

  let profilePointer = 0;
  try {
    profilePointer = allocBuffer(profileBytes.length);
    if (!profilePointer) {
      throw new Error("Failed to allocate decoder profile registry in Wasm memory.");
    }

    for (let offset = 0; offset < replayBytes.length; offset += CHUNK_SIZE) {
      const chunk = replayBytes.subarray(offset, Math.min(offset + CHUNK_SIZE, replayBytes.length));
      copyChunk(replayPointer, offset, chunk, chunk.length);
    }
    for (let offset = 0; offset < profileBytes.length; offset += CHUNK_SIZE) {
      const chunk = profileBytes.subarray(offset, Math.min(offset + CHUNK_SIZE, profileBytes.length));
      copyChunk(profilePointer, offset, chunk, chunk.length);
    }

    return run(module, replayPointer, replayBytes.length, profilePointer, profileBytes.length);
  } finally {
    if (profilePointer) {
      freeBuffer(profilePointer);
    }
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

export async function parseReplayBufferWithWasm(
  buffer: ArrayBuffer,
  profileJson = DEFAULT_DECODER_PROFILE_REGISTRY_JSON,
): Promise<ReplaySummary> {
  return withReplayAndProfileBuffers(buffer, profileJson, (module, replayPointer, size, profilePointer, profileSize) => {
    const parseBuffer = module.cwrap<(input: number, size: number, profiles: number, profileSize: number) => number>(
      "lra_parse_replay_buffer_with_profiles",
      "number",
      ["number", "number", "number", "number"],
    );

    return parseJsonResult<ReplaySummary>(module, parseBuffer(replayPointer, size, profilePointer, profileSize));
  });
}

export async function extractReplayKillsWithWasm(
  buffer: ArrayBuffer,
  profileJson = DEFAULT_DECODER_PROFILE_REGISTRY_JSON,
): Promise<ReplayKillResult> {
  return withReplayAndProfileBuffers(buffer, profileJson, (module, replayPointer, size, profilePointer, profileSize) => {
    const extractKills = module.cwrap<(input: number, size: number, profiles: number, profileSize: number) => number>(
      "lra_extract_replay_kills_buffer_with_profiles",
      "number",
      ["number", "number", "number", "number"],
    );

    return parseJsonResult<ReplayKillResult>(module, extractKills(replayPointer, size, profilePointer, profileSize));
  });
}

export async function extractReplayObjectivesWithWasm(
  buffer: ArrayBuffer,
  profileJson = DEFAULT_DECODER_PROFILE_REGISTRY_JSON,
): Promise<ReplayObjectiveResult> {
  return withReplayAndProfileBuffers(buffer, profileJson, (module, replayPointer, size, profilePointer, profileSize) => {
    const extractObjectives = module.cwrap<(input: number, size: number, profiles: number, profileSize: number) => number>(
      "lra_extract_replay_objectives_buffer_with_profiles",
      "number",
      ["number", "number", "number", "number"],
    );

    return parseJsonResult<ReplayObjectiveResult>(module, extractObjectives(replayPointer, size, profilePointer, profileSize));
  });
}

export async function extractReplayWardsWithWasm(
  buffer: ArrayBuffer,
  profileJson = DEFAULT_DECODER_PROFILE_REGISTRY_JSON,
): Promise<ReplayWardResult> {
  return withReplayAndProfileBuffers(buffer, profileJson, (module, replayPointer, size, profilePointer, profileSize) => {
    const extractWards = module.cwrap<(input: number, size: number, profiles: number, profileSize: number) => number>(
      "lra_extract_replay_wards_buffer_with_profiles",
      "number",
      ["number", "number", "number", "number"],
    );

    return parseJsonResult<ReplayWardResult>(module, extractWards(replayPointer, size, profilePointer, profileSize));
  });
}

/**
 * Returns replay-byte coordinate hypotheses for visual research only. This is
 * intentionally a separate ABI from the productive ward lifecycle decoder.
 */
export async function extractReplayWardPositionCandidatesWithWasm(
  buffer: ArrayBuffer,
  profileJson = DEFAULT_DECODER_PROFILE_REGISTRY_JSON,
): Promise<ReplayWardPositionResearchResult> {
  return withReplayAndProfileBuffers(buffer, profileJson, (module, replayPointer, size, profilePointer, profileSize) => {
    const extractWardPositionCandidates = module.cwrap<
      (input: number, size: number, profiles: number, profileSize: number) => number
    >("lra_extract_replay_ward_position_candidates_buffer_with_profiles", "number", ["number", "number", "number", "number"]);

    return parseJsonResult<ReplayWardPositionResearchResult>(
      module,
      extractWardPositionCandidates(replayPointer, size, profilePointer, profileSize),
    );
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
      (
        input: number,
        size: number,
        minimumLength: number,
        minimumRecords: number,
        topFamilies: number,
      ) => number
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
  const { length, firstByte, headerSize, stride = 16, topSlots = 24 } = options;

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
      analyzeFamily(replayPointer, size, length, firstByte, headerSize, stride, topSlots),
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
  const { length, firstByte, headerSize, stride = 16, topSlots = 24 } = options;

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
      analyzeFamily(replayPointer, size, length, firstByte, headerSize, stride, topSlots),
    );
  });
}

export async function analyzeCleanRowOffsetsWithWasm(
  buffer: ArrayBuffer,
  options: {
    length: number;
    firstByte: number;
    headerSize: number;
    stride?: number;
    slotIndices: number[];
    topFields?: number;
  },
): Promise<any> {
  const { length, firstByte, headerSize, stride = 16, slotIndices, topFields = 8 } = options;

  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const analyzeFamily = module.cwrap<
      (
        input: number,
        size: number,
        length: number,
        firstByte: number,
        headerSize: number,
        stride: number,
        slotIndicesCsv: string,
        topFields: number,
      ) => number
    >("lra_analyze_clean_row_offsets_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "string",
      "number",
    ]);

    return parseJsonResult<any>(
      module,
      analyzeFamily(
        replayPointer,
        size,
        length,
        firstByte,
        headerSize,
        stride,
        slotIndices.join(","),
        topFields,
      ),
    );
  });
}

export async function analyzeBitfieldSchemaWithWasm(
  buffer: ArrayBuffer,
  options: {
    length: number;
    firstByte: number;
    headerSize: number;
    stride?: number;
    slotIndices: number[];
    topWindows?: number;
  },
): Promise<any> {
  const { length, firstByte, headerSize, stride = 16, slotIndices, topWindows = 12 } = options;

  return withReplayBuffer(buffer, (module, replayPointer, size) => {
    const analyzeFamily = module.cwrap<
      (
        input: number,
        size: number,
        length: number,
        firstByte: number,
        headerSize: number,
        stride: number,
        slotIndicesCsv: string,
        topWindows: number,
      ) => number
    >("lra_analyze_bitfield_schema_buffer", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "string",
      "number",
    ]);

    return parseJsonResult<any>(
      module,
      analyzeFamily(
        replayPointer,
        size,
        length,
        firstByte,
        headerSize,
        stride,
        slotIndices.join(","),
        topWindows,
      ),
    );
  });
}
