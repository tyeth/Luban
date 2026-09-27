# Claude skills for the Luban MCP CNC surface

Load order matters. **`cnc-motion-rules` is canonical and comes first**; the other skills assume
it and point back to it rather than repeating it.

| Skill | Load when | Holds |
|---|---|---|
| [`cnc-motion-rules`](cnc-motion-rules/SKILL.md) | Before ANY motion, position or coordinate reasoning | The eight motion laws, coordinate doctrine (machine coords; the frame handshake; the work origin is the operator's), `get_position.reliability` semantics, sanctioned exceptions, measurable WCS selection and rechecking (`references/work-datums.md`), vocabulary, recording rules |
| [`cnc-probing`](cnc-probing/SKILL.md) | Touch-probe measurement, surface scans, probe calibration | Measurement routing and local continuation (`references/planning.md`), contact photographs, shoulder recovery and measured timing; CAM links in `references/cam-probing.md` |
| [`cnc-visual-alignment`](cnc-visual-alignment/SKILL.md) | Camera frames → millimetres, visual servo, landmarks in frame | Continuous live viewing, synchronized inspection frames, metric calibration and frame-reading heuristics |
| [`tool-change`](tool-change/SKILL.md) | Swapping bits without re-touching the stock | Tool-setter flows A (MCP offset via `apply_tool_length_offset`) and B (touchscreen wizard) |
| [`cnc-thread-milling`](cnc-thread-milling/SKILL.md) | Internal/external thread-milling preparation, import and execution | Cutter geometry, bore/boss review, per-feature datums, offline conversion and approved file-job handoff |

For a plain transit or a Snapmaker-ready file, `cnc-motion-rules` alone is enough (§7–§8 carry the canonical calls).
A thread-milling controller export also needs `cnc-thread-milling` before submission.
See the [engineering guide](../../src/server/services/mcp/docs/thread-milling.md).

Rules of the house that every skill shares:

- Operator law is never overridden on model judgment. A refusal from a tool is the rule catching you.
- Motion is authorised only by an explicit imperative in the operator's latest message, then by
  their click on the staged job's confirm page. Chat is not a gate.
- Every number states its frame (machine), whether it is toolhead Z or a physical height, the
  tool, the B angle and the date. Undated, unframed numbers are not numbers.
- The MCP source that enforces these rules is `src/server/services/mcp/` — `README.md` there is
  the engineering reference; `docs/TOOLS.md` the per-tool one.
