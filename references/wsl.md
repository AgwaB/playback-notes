# WSL setup and GPU diagnosis

WSL is a Linux execution environment. Its Node, ffmpeg, whisper.cpp executable,
native libraries, host skill installation and preference file must be usable from
inside WSL; Windows `.exe` binaries and Windows filesystem paths are not a
substitute for Linux runtimes. The model may be on a mounted Windows drive if it
is readable from WSL. Do not copy media or model files into public output.

Use Node 24.15 or later within 24.x, or Node 26 or later; Node 25 is excluded.
HTML and Markdown output need no browser. Only a requested PDF
needs an installed Linux Chromium runtime. See the dated [support matrix](support-matrix.md)
for current verification boundaries.

Use existing, compatible CPU and CUDA whisper.cpp builds and their required Linux
libraries. A GPU driver on the Windows host does not by itself install those
builds or make the GPU visible inside every WSL process. The skill does not
download software or change drivers. Obtain the user's approval for any software
or model installation.

After preparing the tools, the user's optional
`~/.agents/video-summarizer-asr.json` can contain absolute WSL paths:

```json
{
  "localAsrExecutable": "/absolute/path/to/cpu/whisper-cli",
  "localAsrGpuExecutable": "/absolute/path/to/cuda/whisper-cli",
  "localAsrModel": "/absolute/path/to/ggml-large-v3-turbo.bin"
}
```

Preserve any existing preferences when configuring them. The host passes the CPU
and model paths after the user approves local ASR; `prepare` then selects the
matching GPU preference automatically and falls back to CPU if the probe fails.
An explicitly passed GPU candidate takes precedence. A stored preference alone
does not approve ASR or downloads.

Run `prepare --check` with the actual paths and inspect the resulting evidence
warning plus `raw/extraction.json` after transcription. Only `backend: cuda`
confirms CUDA; `unknown` or exit code zero alone does not. On WSL, an
`ASR_GPU_FALLBACK` warning may report that `/dev/dxg` is unavailable or
inaccessible. GPU support, device permissions, or the host's sandbox can each
affect visibility; check them in the **same process environment** that runs the
skill. A CUDA driver-version message in that environment is not enough to prove
that the host driver is incompatible. Do not silently disable host isolation or
change a user's security settings. If a permitted environment cannot expose the
device, use the CPU or ask the user how to proceed.

Long CPU inference can exceed the default one-hour `asrTimeoutMs`. Choose an
appropriate explicit limit for the authorized job, tell the user about the wait,
and preserve any user-specified limit. Distinguish a host/test runner's shorter
deadline from the skill's ASR deadline; poll a running session instead of restarting
it when a tool wait returns early. Automatic transcription can
omit, translate or romanize speech when languages switch, and timestamps can be
inaccurate; check mixed-language passages against the source rather than merging
unverified alternative transcriptions.
