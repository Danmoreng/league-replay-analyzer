export interface ReplayFamilyHeaderCandidate {
  headerSize: number;
  elementCount: number;
}

export interface ReplayFamilyScanItem {
  length: number;
  firstByte: number;
  paddingByte: number;
  recordCount: number;
  chunkCount: number;
  chunkSpanStart: number;
  chunkSpanEnd: number;
  recommendedStride: number;
  recommendedHeaderSize: number;
  headerSizeCandidates: ReplayFamilyHeaderCandidate[];
}

export interface ReplayFamilyScanResult {
  scannedChunkCount: number;
  minimumLength: number;
  minimumRecords: number;
  families: ReplayFamilyScanItem[];
}

export interface ReplayAnalysisSample {
  chunkId: number;
  recordIndex: number;
  timestamp: number;
  x: number;
  y: number;
  mask: number;
  maskBits: string;
  firstByte: number;
}

export interface ReplayAnalysisCandidate {
  rank: number;
  slotIndex: number;
  pairLabel: string;
  leftLane: number;
  rightLane: number;
  classKey: string;
  score: number;
  coordinateSamples: number;
  transitions: number;
  smoothTransitions: number;
  movingTransitions: number;
  smoothRatio: number;
  movingRatio: number;
  coverage: number;
  avgDistance: number;
  maxDistance: number;
  xRange: number;
  yRange: number;
  topFirstByte: number;
  topFirstByteCount: number;
  topMask: number;
  topMaskBits: string;
  topMaskCount: number;
  chunkSpanStart: number;
  chunkSpanEnd: number;
  samples: ReplayAnalysisSample[];
}

export interface ReplayAnalysisClass {
  key: string;
  members: number;
  bestScore: number;
  totalCoordinateSamples: number;
  totalMovingTransitions: number;
}

export interface ReplayFamilyAnalysisResult {
  length: number;
  firstByte: number;
  recordCount: number;
  headerSize: number;
  stride: number;
  gameLengthMillis: number;
  chunkBaseId: number;
  elementCount: number;
  laneCount: number;
  error?: string;
  candidates: ReplayAnalysisCandidate[];
  classes: ReplayAnalysisClass[];
}


export interface ReplayScalarSample {
  chunkId: number;
  recordIndex: number;
  timestamp: number;
  rawU32: number;
  firstByte: number;
  mask: number;
  maskBits: string;
}

export interface ReplayScalarLane {
  laneIndex: number;
  activeSamples: number;
  nonZeroSamples: number;
  uniqueValues: number;
  transitions: number;
  changedTransitions: number;
  minU32: number;
  maxU32: number;
  minFiniteF32: number;
  maxFiniteF32: number;
  samples: ReplayScalarSample[];
}

export interface ReplayScalarSlot {
  rank: number;
  slotIndex: number;
  score: number;
  activeRecords: number;
  totalLaneSamples: number;
  maxActiveLanes: number;
  topFirstByte: number;
  topFirstByteCount: number;
  topMask: number;
  topMaskBits: string;
  topMaskCount: number;
  chunkSpanStart: number;
  chunkSpanEnd: number;
  lanes: ReplayScalarLane[];
}

export interface ReplayScalarFamilyAnalysisResult {
  length: number;
  firstByte: number;
  recordCount: number;
  headerSize: number;
  stride: number;
  gameLengthMillis: number;
  chunkBaseId: number;
  elementCount: number;
  laneCount: number;
  error?: string;
  slots: ReplayScalarSlot[];
}
