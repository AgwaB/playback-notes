<h1 align="center">Playback Notes</h1>

<p align="center">
  <strong>Readable reports from anything you watch or listen to—with the evidence attached.</strong><br>
  A skill for Claude Code, Codex and pi. No separate API key: the agent you already use writes the report,<br>
  every claim links to its moment in the recording, and the citations are checked before export.
</p>

<p align="center">
  <a href="https://github.com/AgwaB/playback-notes/actions/workflows/windows.yml"><img src="https://img.shields.io/badge/CI-cross--platform-57606a?style=flat-square" alt="Cross-platform CI workflow; open for current results"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24.15%2B%20%2824.x%29%20or%2026%2B-417E38?style=flat-square" alt="Node.js 24.15 or later in 24.x, or 26+"></a>
  <a href="#example-output"><img src="https://img.shields.io/badge/exports-HTML%20%C2%B7%20Markdown%20%C2%B7%20PDF-b5382b?style=flat-square" alt="HTML, Markdown or PDF, as you choose"></a>
</p>

<p align="center">
  <a href="#example-output">Example output</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#token-usage">Token usage</a>
</p>

## Example output

Andrej Karpathy's [“[1hr Talk] Intro to Large Language Models”](https://www.youtube.com/watch?v=zjkBMFhNj_g), summarized both ways with this skill:

![Animation: the one-hour YouTube talk fast-forwards through its chapters while its 1,704 caption lines are read; a briefing (4 key points, 6 sections) is written in a moment and a deep-dive (5 key points, 18 sections) at length; clicking the timestamp 01:32 in the briefing opens the video at that moment; each report can be saved as HTML, Markdown or PDF.](references/assets/example-output.webp)

<p align="center">Read the full reports: <a href="examples/karpathy-intro-llms/briefing.md"><strong>Briefing</strong></a> · <a href="examples/karpathy-intro-llms/deep-dive.md"><strong>Deep-dive</strong></a> (Markdown; each timestamp opens the video at that moment)</p>

<p align="center"><sub>Unofficial summary, not affiliated with or endorsed by the creator. Written from the video's automatic captions; the transcript is not included. Video thumbnail © Andrej Karpathy.</sub></p>

## How it works

![Five steps: your video, audio or transcript, local evidence, analysis by your agent, validation, and a report in the formats you choose: HTML, Markdown or PDF](references/assets/how-it-works.png)

## Usage

Send your agent a YouTube or Apple Podcasts **episode** link, or an audio/video file or direct URL. You can also supply an SRT, VTT or TXT transcript.

- **Briefing** — key conclusions and why they hold.
- **Deep-dive** — detailed explanations, examples and caveats.

```text
Give me a briefing on this video as HTML and Markdown: <url>
Analyze this recording in depth, in Spanish, and export a PDF: <path>
```

Choose **HTML, Markdown, PDF**, or any combination; the agent asks if you don't specify. Reports default to `.playback-notes/reports/` in your working folder.

Ask follow-up questions about the same source for timestamp-cited answers. If a transcript is unavailable, the agent asks before local transcription.

## Installation

Requires **Node.js 24.15+ within the 24.x line, or 26+** (Node 25 is not supported).

```bash
npx skills add AgwaB/playback-notes -g
(cd ~/.agents/skills/playback-notes && npm ci)
```

**Both lines are required.** The first installs the skill with the [`skills` CLI](https://github.com/vercel-labs/skills) for the agents you pick, such as Claude Code, Codex and pi. The second installs its dependencies. In Windows PowerShell, use the [PowerShell commands](references/windows.md) instead.

To update or remove it:

```bash
npx skills update playback-notes -g
(cd ~/.agents/skills/playback-notes && npm ci)  # updating removes the dependencies

npx skills remove playback-notes -g
```

Installed it as `video-summarizer` before the rename? Remove that copy with `npx skills remove video-summarizer -g`.

<details>
<summary><strong>Alternative:</strong> manual install (read-only copy)</summary>

```bash
git clone https://github.com/AgwaB/playback-notes.git
cd playback-notes
npm ci
node scripts/install.mjs --link ~/.claude/skills/playback-notes
```

This installs a read-only copy in `~/.agents/skills/playback-notes`, where Codex and pi find it. `--link` connects Claude Code; omit it if you don't use Claude Code. To update, pull this repository, run `npm ci`, then repeat the last command.

</details>

On Windows, follow the [PowerShell setup](references/windows.md); on WSL, the [WSL guide](references/wsl.md).

## Token usage

Same one-hour Karpathy talk · `openai-codex/gpt-6.1-sol` (medium) · English HTML + Markdown · automatic captions. Averages from **2 runs per mode**; observed ranges in parentheses.

| Mode | Processed tokens (mean; range) | Cached input | Estimated cost |
| --- | --- | --- | --- |
| **Briefing** | **420k** (307k–533k) | 349k | $0.212 |
| **Deep-dive** | **679k** (526k–832k) | 599k | $0.294 |

Totals include cached context re-read across all turns, not the required context-window size. Costs are host estimates; actual usage and charges vary.

## License

[MIT](LICENSE)
