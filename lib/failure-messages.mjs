// Fixed, skill-authored failure text. Hosts see these instead of raw dependency errors,
// which can carry paths or signed URLs.

// Fixed cause phrases keyed by the worker's `detail`; modelled on youtube-transcript-api's
// exception set so hosts can tell blocked / disabled / unavailable / restricted apart.
export const FAILURE_DETAILS = Object.freeze({
  "subtitle-parse-failed": "The subtitle data could not be parsed.",
  "subtitle-cue-mismatch":
    "Some subtitle cues could not be parsed; none were silently discarded.",
  "transcript-empty-text": "A transcript cue has empty text.",
  "transcript-encoding-unsupported":
    "The transcript file is not UTF-8 text (for example EUC-KR/CP949); save it as UTF-8 and retry.",
  "transcript-invalid-timing":
    "A transcript cue has an invalid or non-positive time interval.",
  "transcript-duration-overrun":
    "A transcript timestamp exceeds the known source duration.",
  "bot-check":
    "YouTube answered with a sign-in/bot check for this anonymous session; no cookies, tokens or proxies are used.",
  "age-restricted":
    "The video is age-restricted and requires a signed-in session, which this skill does not use.",
  "login-required": "YouTube requires a signed-in session to view this video.",
  "video-unavailable":
    "The video is unavailable (removed, private or an invalid ID).",
  "video-unplayable":
    "YouTube reports the video as unplayable in this region or session.",
  "player-unparsable":
    "The watch page did not contain a readable player response.",
  "no-transcript":
    "The video exposes no transcript (captions disabled or none uploaded).",
  "transcript-refused":
    "YouTube refused the transcript body (proof-of-origin gate), and the caption list for its Android app client offered no readable track either.",
  "transcript-empty": "The selected transcript track loaded no rows.",
  "botguard-challenge":
    "The BotGuard attestation challenge could not be fetched or was incomplete.",
  "botguard-integrity":
    "The attestation server refused to issue an integrity token.",
  "botguard-mint": "The proof-of-origin token could not be minted.",
  "botguard-failed": "The token worker failed.",
  "transcript-refused-no-token":
    "No proof-of-origin token could be minted here (not macOS, or inside a host sandbox where sandbox-exec cannot apply a profile), and YouTube's caption list for its Android app client offered no readable track either. Supply a transcript, or on macOS run the skill's commands outside the host sandbox.",
  "sandbox-unavailable":
    "The confined runtime for token minting cannot run here (not macOS, or this process already runs inside a host sandbox where sandbox-exec cannot apply a profile).",
  "network-unavailable": "A DNS lookup or connection failed from this process.",
  "download-failed":
    "yt-dlp did not produce a single audio file within the size budget.",
  "podcast-spotify":
    "Spotify does not publish episode audio files. Use the episode's Apple Podcasts link, a direct link to its audio file, or a downloaded audio file.",
  "podcast-show-link":
    "The link points to a whole podcast show. Share the link of one episode instead.",
  "podcast-episode-not-found":
    "Apple's public lookup lists only a show's 200 most recent episodes, with their audio files; this episode or its audio was not among them. Use a direct link to the episode's audio file or a downloaded file.",
  "not-media-link":
    "The link is not a single YouTube video, an audio or video file, or an Apple Podcasts episode (for example a channel, playlist, show or web page). Share one video or episode link, a direct media file link, or supply a transcript.",
  "podcast-lookup-failed":
    "Apple's public podcast lookup did not return readable episode data.",
  "path-not-found":
    "The path does not exist; check for typos and quote paths that contain spaces.",
  "path-not-file": "The path is a folder or another non-file; pass a file.",
  "asr-runtime-failed":
    "The local ASR executable or model failed to run (for example a missing DLL, an incompatible build, or a file that is not a whisper.cpp model). The source itself was not rejected; check the configured executable, its adjacent libraries and the model.",
  "no-decodable-audio": "The file contains no decodable audio.",
  "windows-script-wrapper":
    "Windows .cmd and .bat wrappers are not executed; configure the .exe itself.",
  "transcript-format-unsupported":
    "Only SRT, VTT and TXT transcripts are supported; convert other formats such as SAMI (.smi) or ASS to SRT first.",
  "source-http-refused":
    "The server answered with an HTTP error (for example 403 or 404); the address may be wrong, expired or blocked for this client.",
});

/** Base text per failure code, shared by the extraction worker and the CLI boundary. */
export const FAILURE_MESSAGES = Object.freeze({
  ASR_REQUIRED:
    "No captions were acquired. Supply a transcript or explicitly enable prepared local ASR.",
  CAPABILITY_MISSING:
    "A required local capability is unavailable (an explicitly configured executable or model, a media tool, or the confined token runtime).",
  SOURCE_UNSUPPORTED:
    "This source cannot be extracted with the available safe adapters.",
  SOURCE_ACCESS_DENIED:
    "Source access was denied or no transcript track was available; no bypass was attempted. Supply a transcript file or an explicitly approved browser capture.",
  NO_USABLE_EVIDENCE:
    "The source did not provide usable transcript evidence.",
  RESOURCE_LIMIT: "Extraction exceeded a configured resource budget.",
  TIMEOUT: "Source extraction timed out.",
  CANCELLED: "Extraction was cancelled.",
  NETWORK_UNAVAILABLE:
    "The source could not be reached from this process: the host name did not resolve or network access is not permitted here. If the URL is correct, the command environment probably has no network access (for example a host agent's sandboxed shell such as Codex workspace-write); otherwise check the URL. This is not a refusal by the source.",
  UNSAFE_URL:
    "Only credential-free public HTTP(S) destinations are allowed.",
  UNSAFE_PATH: "An input must be an existing regular local file.",
  SOURCE_UNAVAILABLE: "The source is unavailable.",
  TRANSCRIPT_UNAVAILABLE:
    "The source exposes no transcript. Supply a transcript file, an explicitly approved browser capture, or (local media only) approve local ASR/OCR.",
  INVALID_CONTRACT: "The transcript or extraction input is invalid.",
  // Operating-system errors that reach the CLI boundary unchanged.
  EBUSY:
    "A file is in use by another program that does not allow reading it (on Windows, a program that opened it without sharing). Close that program and retry.",
  EACCES: "The operating system denied access to a file or folder.",
  EPERM: "The operating system denied access to a file or folder.",
  ENOENT: "A file or folder does not exist.",
});

export function safeFailureMessage(code, detail) {
  const cause = FAILURE_DETAILS[detail];
  const base = FAILURE_MESSAGES[code] ?? "Source extraction failed safely.";
  return cause ? `${base} Cause: ${cause}` : base;
}
