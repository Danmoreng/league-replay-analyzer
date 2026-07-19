declare module "*generated/wasm/rofl_wasm.js" {
  type ReplayWasmModuleFactory = (moduleOverrides?: Record<string, unknown>) => Promise<unknown>;

  const createReplayModule: ReplayWasmModuleFactory;
  export default createReplayModule;
}
