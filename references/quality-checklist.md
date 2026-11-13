# Host acceptance checklist

## Evidence and reasoning

- [ ] Requested source and mode are correct; no already-supplied information was asked again.
- [ ] All chunks marked reviewed were actually read; cited images were actually inspected.
- [ ] Conclusions preserve the source's important conditions and exceptions.
- [ ] Each substantive statement has relevant citations, not merely syntactically valid IDs.
- [ ] Quotations, times, speakers and visual observations were not invented.
- [ ] Inference/reconstruction is visibly distinguished from source claims.
- [ ] Every figure shows content the text relies on; no figure of people merely talking. Points in a conversation are given to a speaker only where the turn is certain.
- [ ] The text is written for the reader in the report language: terms of art explained once with the original term beside a translation, no tool vocabulary (chunk, contact sheet, verbatim, frame or segment IDs), no “(translation)” prefix on quotes (the renderer labels them).
- [ ] Partial evidence/analysis was disclosed and approved for the exact current scope.
- [ ] The output language matches the explicit preference, otherwise the user's conversation language (English only when unknown), and is recorded in `request.json.outputLanguage`; built-in labels are the skill's own (translated for Korean, Japanese, Simplified Chinese and Spanish reports, English otherwise); both modes have appropriate, source-driven depth.

## Documents

- [ ] HTML is readable before opening the source panel; navigation does not obscure primary content.
- [ ] Clicking a time seeks correctly where supported; a blocked player leaves transcript/source fallback usable.
- [ ] Untimed evidence has no fabricated seek target.
- [ ] Local-only links disclose sharing/playback limitations; no private paths or signed URLs leaked.
- [ ] All requested formats carry the same report/evidence hashes and substantive content. Only the formats the user chose were produced.
- [ ] Tables, quotations, code and images are readable; no clipped mobile layout or PDF text.
- [ ] When PDF is requested, its fonts render the actual output language, including Korean when requested. Text extraction alone is not sufficient to rule out every visual font issue; visually inspect the PDF when fonts/languages change.
- [ ] Markdown images resolve relative to the shared report folder.
- [ ] Only existing successful exports have active links.

## Completion and sharing

- [ ] Public manifest is `completed` for all requested formats; otherwise report incomplete with exact missing outputs.
- [ ] Private work/cache/source files are outside the public root.
- [ ] User understands that HTML contains the full transcript unless `publishTranscript` is false (the report's own quotes always), and that local media is normally not included.
- [ ] The loopback server is not exposed externally and is stopped when no longer needed.
- [ ] No unsupported host, OS, live YouTube or ASR compatibility is claimed.
