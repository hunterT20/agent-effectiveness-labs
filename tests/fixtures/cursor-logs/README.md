# Frozen cursor-agent stream-json logs

One directory per tested `cursor-agent` version (`<YYYY.MM.DD>/`). Unit tests in
`packages/runtime/test/adapters/cursor.test.ts` and `packages/runtime/test/telemetry/` parse these
files through the real extractor, so the expected numbers in those tests must move together with
the fixture bytes.

## Provenance (read before trusting numbers)

| Version      | File                 | Origin                                                               |
| ------------ | -------------------- | -------------------------------------------------------------------- |
| `2026.09.02` | `stdout-success.log` | **Hand-authored** to match the documented event shape; not captured. |
| `2026.09.02` | `stdout-partial.log` | **Hand-authored** (truncated stream + malformed line + bad type).    |

No redacted _real_ capture has been recorded yet because capturing one requires a paid live
`cursor-agent` call (Holdpoint B). When a real log is captured (with `AEL_LIVE_CURSOR=1` and human
approval), redact `session_id`/`chat_id`/`request_id`/paths/prompt bodies, drop it in a new
`<version>/` directory, and replace the "Hand-authored" rows above.

## Event shape assumed by the extractor

- `system` / `subtype: init` — `cwd`, `model`, `apiKeySource`, `session_id`, `chat_id`.
- `assistant` — optional per-turn `usage` block.
- `tool_call` — emitted **twice** per call (`subtype: started` then `completed`) sharing a
  `call_id`; the extractor counts distinct `call_id`s.
- `result` — `subtype`, `duration_ms`, `is_error`, `request_id`, and the **cumulative** `usage`
  block. When present, the `result` usage is authoritative and per-turn `assistant` usage is
  ignored (prevents double counting).

Expected extraction for `stdout-success.log`: input 2400, output 640, cached 160, reasoning 128,
subagent 0, toolCalls 1, chat id `chat-redacted-001`. For `stdout-partial.log`: input 10, output 5
(summed from assistant events because no `result` usage exists), toolCalls unavailable, 2 rejected
lines.
