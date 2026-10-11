import type { Readable } from 'node:stream';
import type { z } from 'zod';
import type { ClaimRequestSchema, HeartbeatRequestSchema, HelloRequest, HelloResponse, LiveSingleRequestSchema, SubmitIntentRequest, SubmitIntentResponse } from '../shared/protocol/api.js';
import type { Command } from '../shared/protocol/commands.js';
import type { AutoReconcileRequest, OperatorReconcileRequest, PreflightResultRequest, ResultRequest } from '../shared/protocol/results.js';
import type { RouteKey } from '../shared/protocol/version.js';
import type { JobStatus, PostType } from '../shared/types.js';
import { ApiError } from './errors.js';

// What the job endpoints of the local API call: Task 2b's LivePostingCoordinator. NO_COORDINATOR (tests) answers every
// job endpoint with 503 BUSY.

export interface CoordinatorPort {
  /** Hello step 0 and the coordinator's part of the answer; omitted: no command, posting closed. */
  hello?(clientId: string, req: HelloRequest): Promise<Pick<HelloResponse, 'dispatch' | 'stops'> & { probe_gate: boolean; survey_gate: boolean }>;
  /** null → 204 (nothing allowed now). */
  claim(clientId: string, req: z.infer<typeof ClaimRequestSchema>): Promise<{ command: Command } | null>;
  heartbeat(clientId: string, jobId: string, req: z.infer<typeof HeartbeatRequestSchema>): { continue: boolean; paused: boolean; reason_ja: string | null };
  asset(clientId: string, jobId: string, attemptId: string, commandId: string): Promise<{ stream: Readable; bytes: number; sha256: string; mime: string }>;
  submitIntent(clientId: string, jobId: string, req: SubmitIntentRequest): Promise<Omit<SubmitIntentResponse, 'protocol_version' | 'request_id'>>;
  result(clientId: string, jobId: string, req: ResultRequest): Promise<{ job_status: JobStatus; idempotent_replay: boolean; applied: boolean }>;
  /** Waits up to maxMs for in-flight post-intent results before the server closes. */
  drain(maxMs: number): Promise<void>;
  // Task 2c: reconcile, retry, resume with stops, preflight, live_single.
  reconcileResult(clientId: string, jobId: string, req: AutoReconcileRequest): Promise<{ job_status: JobStatus; reconcile_outcome: string }>;
  operatorReconcile(jobId: string, req: Omit<OperatorReconcileRequest, 'protocol_version' | 'request_id'>): Promise<{ status: 200 | 202; body: Record<string, unknown> }>;
  retry(jobId: string | null): Promise<Record<string, unknown>>;
  redraft(o: { id: string | null; type: PostType | null; dry: boolean }): Promise<Record<string, unknown>>;
  resume(confirmChecked: boolean): Promise<Record<string, unknown>>;
  preflight(routeKey: RouteKey | 'configured'): Promise<string>;
  preflightResult(clientId: string, id: string, req: PreflightResultRequest): Promise<{ applied: boolean }>;
  liveSingle(req: z.infer<typeof LiveSingleRequestSchema>): Promise<Record<string, unknown>>;
}

const busy = (): never => {
  throw new ApiError(503, 'BUSY', 'SALON BOARD への投稿の機能はまだ準備中です。', true);
};

/** A stub for server tests. */
export const NO_COORDINATOR: CoordinatorPort = {
  claim: async () => busy(),
  heartbeat: () => busy(),
  asset: async () => busy(),
  submitIntent: async () => busy(),
  result: async () => busy(),
  drain: async () => undefined,
  reconcileResult: async () => busy(),
  operatorReconcile: async () => busy(),
  retry: async () => busy(),
  redraft: async () => busy(),
  resume: async () => busy(),
  preflight: async () => busy(),
  preflightResult: async () => busy(),
  liveSingle: async () => busy(),
};
