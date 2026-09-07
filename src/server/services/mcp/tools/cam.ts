/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import { InspectionReport, REPORT_FORMATS, ReportFormat } from '../inspectionReport';
import { jobManager } from '../jobs';
import { describeProbeCamPlanAsGcode, planProbeCam, renderStoredReport, runProbeCamProcedure } from '../probeCam';
import { probeFeedService } from '../probeFeed';
import { McpToolError, ToolRegistry } from '../registry';
import { validateGcode } from '../validator';

export function registerCamTools(registry: ToolRegistry, getConfirmBaseUrl: () => string): void {
    registry.register({
        name: 'run_probing_gcode',
        description: 'Stage a CAM-generated PROBING PROGRAM (Fusion 360 / FreeCAD / any Grbl-Marlin post, or hand-written) '
            + 'for ONE human approval, run it through the sensor-gated probing engine, and return an inspection report the '
            + 'CAM can read back. The program is PARSED and TRANSLATED, never sent raw (the Snapmaker firmware has no G38 '
            + 'cycle): G38.2/G38.3 -> a coarse/fine/confirm march toward the programmed target (the travel limit), retreating '
            + 'to the cycle start; G38.4/G38.5 -> coarse steps until the probe releases, then on to the target; G0/G1 links '
            + '-> law 2 (link_mode "raise": XY at the safe traverse height with guarded segmented descents; "stepped": a '
            + 'touch-probing traverse at the programmed height that lifts hop_lift_mm on contact); a bare G0 B<angle> line -> '
            + 'a 3+2 station (raise to the traverse height, then the verified rotation; B with XYZ, incremental B and A/C '
            + 'refused); G4 dwells; G90/G91, G53, G20/G21 honoured; programmed feeds ignored. Refused: M3/M4 (spindle with '
            + 'the probe fitted), M0/M1, M6, G28, G92/G55-G59, arcs, macro variables. Coordinates are the CAM WCS (work frame) '
            + 'unless frame: "machine". Probe metadata in a comment before a cycle - (PROBE id=3 name=top group=boss1 '
            + 'role=x_minus nominal=10,20,0 normal=0,0,1 tol=0.1,-0.1 offset=0) - gives the report nominals, normals, '
            + 'tolerances (lower signed) and surface offset; a (RESULTS documentid=.. modelversion=.. toolpathid=1.00001 '
            + 'toolpath=NAME) comment fills the Fusion results envelope. Without metadata the target is the nominal and the '
            + 'approach direction the normal. Deviations are of the SURFACE (tip centre minus one tip radius along the '
            + 'normal) and need set_probe_geometry\'s tip diameter. Result: report (JSON), reportText in report_format '
            + '(fusion = Fusion 360 inspection results, START/TOOLPATHID/G330/G331/G800/G801/END as Autodesk\'s own result '
            + 'generator writes them - for Inspect Surface; renishaw = the Renishaw Inspection Plus printout Fusion imports '
            + 'for Probe WCS / Probe Geometry results, features reduced from (PROBE group= role= feature= nominal_size= '
            + 'nominal_center= tol_size= tol_pos=) metadata: SIZE D / POSN X Y Z / OUT OF TOL / OUT OF POS lines; csv; grbl '
            + '[PRB:] lines; json), files under the app data dir mcp-inspection/.',
        inputSchema: {
            type: 'object',
            properties: {
                gcode: { type: 'string', description: 'The probing program text.' },
                source: { type: 'string', description: 'Name of the program / CAM operation, for the report and the operator.' },
                frame: { type: 'string', enum: ['work', 'machine'], description: 'Coordinate frame of the program: work (CAM WCS, default) or machine.' },
                link_mode: { type: 'string', enum: ['raise', 'stepped'], description: 'How XY links run: "raise" (default, law 2 traverse height) or "stepped" (touch-probing traverse at the programmed height).' },
                hop_lift_mm: { type: 'number', description: 'stepped link_mode: lift per contact, default 2 (0.5-10).' },
                on_miss: { type: 'string', enum: ['abort', 'continue'], description: 'G38.2 without contact: abort (default, Grbl semantics) or record no_contact and continue.' },
                report_format: { type: 'string', enum: REPORT_FORMATS, description: 'Primary report rendering, default fusion (Inspect Surface G800/G801); renishaw for Probe WCS / Probe Geometry features. JSON is always stored too.' },
                coarse_step_mm: { type: 'number', description: 'Coarse step, default 1 (0.2-1; never larger).' },
                fine_step_mm: { type: 'number', description: 'Fine step, default 0.1 (0.02-0.5).' },
                backoff_mm: { type: 'number', description: 'Confirm-cycle lift, default 1.' },
                sensor_delay_ms: { type: 'number', description: 'Contact-check window per step, default 300, floor 30 (GPIO: 50).' },
                confirm_passes: { type: 'number', description: 'Lift-and-retest cycles per contact, default 3 (1-10).' },
                reason: { type: 'string', description: 'Shown to the operator: what this program inspects and why.' },
            },
            required: ['gcode', 'reason'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            const reason = String(args.reason || '').trim();
            if (!reason) {
                throw new McpToolError('reason is required; it is shown to the operator.');
            }
            probeFeedService.assertNoOvertravel();
            const plan = planProbeCam(args as Parameters<typeof planProbeCam>[0]);
            const envelope = `; reason: ${reason}
${describeProbeCamPlanAsGcode(plan)}`;
            const validation = validateGcode(envelope);
            const job = jobManager.submit(
                envelope,
                `cam-probing ${plan.source} (${plan.parsed.probeCount} cycles) - ${reason.slice(0, 40)}`,
                'cnc',
                validation,
                'procedure'
            );
            job.runner = async () => runProbeCamProcedure(plan, job.id);
            return {
                job: jobManager.describe(job),
                plan: {
                    source: plan.source,
                    frame: plan.frame,
                    probeCycles: plan.parsed.probeCount,
                    steps: plan.parsed.steps.filter((s) => s.kind === 'move' || s.kind === 'probe').length,
                    linkMode: plan.linkMode,
                    onMiss: plan.onMiss,
                    reportFormat: plan.reportFormat,
                    warnings: plan.warnings,
                    hopZ: plan.hopZ,
                    staged: plan.staged,
                },
                confirm_url: `${getConfirmBaseUrl()}/confirm/${job.id}`,
                next_step: 'Ask the operator to open confirm_url and review the TRANSLATED program (every original line with the '
                    + 'moves it becomes), then start with start_gcode_job wait_for_approval_ms. The result carries the inspection '
                    + 'report; get_inspection_report re-renders it in any format.',
            };
        },
    });

    registry.register({
        name: 'get_inspection_report',
        description: 'Render the inspection report of a finished (or aborted) run_probing_gcode job in another format: fusion '
            + '(Fusion 360 inspection results, G800 nominal / G801 measured), renishaw (Inspection Plus printout - Fusion Probe '
            + 'WCS / Geometry import, features from group/role metadata), csv, grbl ([PRB:] lines) or json. Also writes '
            + 'the file under the app data dir mcp-inspection/<job>.<ext> and returns its path.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string' },
                format: { type: 'string', enum: REPORT_FORMATS },
            },
            required: ['job_id', 'format'],
            additionalProperties: false,
        },
        handler: async (args: { job_id?: string; format?: string }) => {
            const job = jobManager.get(String(args.job_id || ''));
            if (!job) {
                throw new McpToolError('Unknown job_id.');
            }
            const result = job.result as { report?: InspectionReport } | null;
            if (!result || !result.report) {
                throw new McpToolError(`Job ${job.id} has no inspection report (state ${job.state}) - it is not a run_probing_gcode job, or it has not run yet.`);
            }
            const format = String(args.format) as ReportFormat;
            if (!REPORT_FORMATS.includes(format)) {
                throw new McpToolError(`format must be one of ${REPORT_FORMATS.join(', ')}.`);
            }
            const rendered = renderStoredReport(result.report, format, job.id);
            return { job_id: job.id, format, text: rendered.text, file: rendered.file, summary: result.report.summary };
        },
    });
}
