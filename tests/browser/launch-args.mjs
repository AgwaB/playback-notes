// Extra Chrome switches for a test environment, from TEST_BROWSER_ARGS (space-separated).
// CI sets --disable-gpu on hosted macOS runners: Chrome's Metal work there faults the
// virtual machine's paravirtual GPU, and after repeated GPU restarts the kernel ignores
// the GPU process's submissions, so pages stop rendering.
export const browserArgs = () =>
  (process.env.TEST_BROWSER_ARGS ?? "").split(/\s+/u).filter(Boolean);
