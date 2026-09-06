/**
 * Structured IR errors [N1] — the NL compiler's repair-and-clarification fuel.
 * Every error carries a stable code, the offending document path, and a
 * human/model-readable message using labels where available.
 */

export type IrErrorCode =
  | 'schema-invalid'            // zod validation failure
  | 'unknown-reference'         // source names no asset/operation/port
  | 'id-collision'              // asset id vs operation id [P2a]
  | 'transition-placement'      // transition not between two slots [X1]
  | 'transition-too-long'       // overlap exceeds a neighbor's duration [X2]
  | 'usage-unavailable'         // declared type not offered by source's tracks [C3]
  | 'range-invalid'             // resolved start >= end, or outside source duration
  | 'window-invalid'            // overlay window empty or outside output duration
  | 'missing-place'             // non-base visual layer / visual overlay without anchor [G2]
  | 'video-output-without-video'// video-requiring output, video-less timeline [D4]
  | 'field-not-applicable'      // e.g. place on an audio overlay (post-schema guard)
  | 'unsupported-in-v01'        // spec'd but unimplemented (e.g. clip.speed)
  | 'duration-conflict'         // stated duration conflicts with source [T4]
  | 'reference-cycle';          // operation DAG has a cycle [G1]

export interface IrError {
  code: IrErrorCode;
  /** JSON-path-ish location: "operations[0].timeline[2]" */
  path: string;
  message: string;
}

export const err = (code: IrErrorCode, path: string, message: string): IrError =>
  ({ code, path, message });
