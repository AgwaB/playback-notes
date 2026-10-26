# Structured report authoring

Use [the report schema](../schemas/report.schema.json) and [the evidence schema](../schemas/evidence.schema.json) as the executable contract. Both modes use the same block vocabulary and fixed renderer.

## Top-level fields

```json
{
  "schemaVersion": 1,
  "evidenceRef": { "id": "ev-example", "sha256": "ACTUAL_EVIDENCE_FILE_HASH" },
  "mode": "briefing",
  "outputLanguage": "ko",
  "title": "A specific, evidence-grounded title",
  "summary": [
    { "text": "The central claim, retaining its important condition.", "attribution": "source", "citations": [{ "kind": "segment", "id": "seg-000001" }] }
  ],
  "sections": [
    { "id": "mechanism", "heading": "How it works", "blocks": [
      { "type": "paragraph", "statement": { "text": "Explain the supported mechanism.", "attribution": "source", "citations": [{ "kind": "segment", "id": "seg-000001" }] } }
    ] }
  ],
  "caveats": []
}
```

Replace placeholder IDs/hash with actual evidence values. IDs are stable identifiers, not display headings. Use the requested output language; non-Korean interface labels currently fall back to English while report text remains in the requested language.

## Statement and citation

```json
{ "text": "Plain text, not HTML.", "attribution": "interpretation", "citations": [{ "kind": "segment", "id": "seg-000002" }] }
```

`attribution` is exactly `source` or `interpretation`. Each substantive statement needs at least one citation. Cite the contiguous transcript run a statement rests on (one or two runs, not every segment it touches). The renderer collapses *strictly adjacent* timed segment citations into one chip labelled `first start–last start` (cue start times, not the interval's end) that seeks to the first; citations that skip a segment stay separate chips. A citation is a `segment` or an inspected `frame` ID; its timestamp is resolved from evidence, not authored independently. Inference is allowed but visibly labeled; it still needs grounding.

## Blocks

| Type | Payload | Use |
|---|---|---|
| `paragraph` | `statement` | Explanations and causal reasoning |
| `list` | `ordered`, `items` (statements) | Steps, mechanisms, conditional conclusions |
| `table` | `columns` (strings), `rows` (statement cells) | Comparisons where every substantive cell is grounded |
| `quote` | `verbatim`, `statement` | Exact transcript quote, or clearly labeled translation/paraphrase |
| `code` | `text`, nullable `language`, `attribution`, `citations` | Source code or explicitly labeled reconstruction; never executed |
| `figure` | `frameId`, `alt`, `caption` (statement) | Existing verified image asset, actually inspected by the host |
| `diagram` | `kind` (`stack`/`flow`), `id`, `title`, `alt`, `nodes`, `edges`, `caption` (statement) | Host-structured schematic drawn by the fixed renderer; never host SVG |

For a figure, `caption.citations` must cite the same frame and `analysis.inspectedFrameIds` must include it. Only bounded PNG/JPEG assets under `assets/` are supported. Frames come only from approved local OCR sampling or supplied assets; do not fabricate frame records to add decorative imagery. On-screen text read from a frame is quoted with `verbatim: false` (verbatim matching applies to transcript segments only) and the wording you report is what you confirmed in the image; if OCR misread a card, use the image-confirmed text in the report and leave the evidence file untouched.

### Diagram block

A diagram is an authored visualization, not evidence; its `caption` must cite the segments it summarizes and is normally `interpretation`. Draw only when a reader learns more than from a paragraph or table (a ranked hierarchy, a causal chain); otherwise use a table or list. Budget, enforced by validation: 2–9 nodes, ≤12 edges, at most 2 `focal` nodes, edge labels ≤14 characters, `flow` must be a connected acyclic graph, `stack` has no edges (top node first). The renderer owns layout, colors and markup (orthogonal connectors, hairline borders, no shadows). Markdown receives a text fallback: nodes with sublabels, then one `A → B (label)` line per edge, then the caption. The SVG scales to the page width; on narrow phones a 9-node flow becomes small, so prefer few, short labels and keep any condition that matters in the caption or prose. Design rules follow diagram-design (MIT).

```json
{ "type": "diagram", "kind": "flow", "id": "cause-chain", "title": "…", "alt": "One sentence about the content.",
  "nodes": [{ "id": "a", "label": "≤40 chars", "sublabel": null, "focal": false }],
  "edges": [{ "from": "a", "to": "b", "label": null }],
  "caption": { "text": "…", "attribution": "interpretation", "citations": [{ "kind": "segment", "id": "seg-000001" }] } }
```

No raw HTML, Markdown, CSS, JavaScript, arbitrary blocks, model-provided URLs or template directives are accepted as a renderer instruction. Text that resembles markup is escaped as text. Markdown is generated through an AST serializer, not unescaped string concatenation.

## Mode depth

### Briefing

- Lead with the central conclusion and a small number of decisive points.
- Explain the mechanism just far enough to make the claim understandable.
- Retain important assumptions, constraints and exceptions.
- Keep the hierarchy compact; do not compress away the reason a conclusion holds.

### Deep-dive

- Organize around the video's actual conceptual structure, not a generic template.
- Explain definitions, causal steps, methods, comparisons, examples and counterarguments when present.
- Preserve qualifications and distinguish demonstrations from claims.
- Include useful tables/quotes/code only when grounded; unsupported detail is not depth.
- Account for the full reviewed source. Explicitly name gaps and unresolved ambiguities.

Do not use a word-count target to overwrite source fidelity. A short or repetitive source may warrant a short deep-dive.
