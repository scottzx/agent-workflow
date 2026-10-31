/** Execution interfaces shared by DSH and future standalone A2A hosts. */
import type { SafeError } from '@1agents/acp-service/runtime';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { A2AExecutionRef } from './execution-binding.js';

const roleText = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
const rolePath = roleText.refine(isAbsolute, 'Expected an absolute role cache path');
/** Host-authored summary of a verified, immutable role/skill lock. */
export const a2aRoleSkillsSchema = z.object({
  roleId: roleText, roleVersion: roleText, lockPath: rolePath, roleDirectory: rolePath,
  entryGuidePath: rolePath.optional(),
  skills: z.array(z.object({ key: roleText, skillId: roleText, sourceId: roleText, name: roleText,
    revision: z.string().regex(/^[a-f0-9]{64}$/), directory: rolePath, guidePath: rolePath }).strict()).min(1).max(100),
}).strict();
export type A2ARoleSkills = z.infer<typeof a2aRoleSkillsSchema>;

/** Explicit host-side requirements checked without creating an agent session. */
export interface A2APreflightRequirements {
  allowedDirectories?: string[];
  jobDirectory?: string;
  requiredFiles?: string[];
  python?: { executable: string; modules: string[] };
  node?: { executable: string; modules?: string[]; moduleRoot?: string };
}
export interface A2APreflightInput extends A2APreflightRequirements { cwd: string }
export interface A2APreflightReport {
  ok: boolean;
  checkedAt: string;
  cwd: string;
  jobDirectory?: string;
  checks: { id: string; ok: boolean; detail?: string }[];
}

export interface A2ATarget {
  sessionId: string;
  cwd: string;
  agentPreset?: string;
  preflight?: A2APreflightReport;
  /** Logical host binding; several bindings may use one canonical skill profile. */
  roleId?: string;
  roleSkills?: A2ARoleSkills;
  /** Set when this target was attached again through session/load or session/resume. */
  resumed?: boolean;
  restoreMethod?: 'session/load' | 'session/resume';
  /** Absent on records written before session close. Callers treat that as attached. */
  state?: 'attached' | 'busy' | 'idle' | 'closing' | 'closed' | 'stale' | 'deleted';
  lastUsedAt?: string;
  lifecycle?: { mode: 'persistent' | 'one-shot'; idleTtlSeconds?: number; closeAfter?: 'terminal' | 'ack' };
  /** Model the host selected for a standard preset. Absent when the session uses the host default. */
  provider?: string;
  model?: string;
}

export interface A2ACloseResult {
  processReleased: true | 'pending';
  /** False when the preset has no ACP child process. */
  acp?: boolean;
}

export interface A2ASessionStatus {
  attached: boolean;
  activeTurn: boolean;
  lastUsedAt?: string;
}

/** Omitted location and preset reuse a saved context or the host defaults. */
export interface A2APrepareInput {
  sessionId?: string;
  cwd?: string;
  agentPreset?: string;
  preflight?: A2APreflightRequirements;
  /** Only selects a host-configured profile; clients cannot supply profile or cache configuration. */
  roleId?: string;
  /** Optional existing parent lock under the host cache's locks directory. */
  roleLockPath?: string;
  /** Standard presets only, passed together. Omitted keeps the session's current or host-default model. */
  provider?: string;
  model?: string;
}

/** A single DSH turn's output, without transport or host dependencies. */
export interface A2ARunResult {
  text: string;
  outcome: 'completed' | 'failed' | 'input-required';
  detail?: string;
  /** Bounded, safe failure context; execution state is independent of recovery policy. */
  error?: SafeError;
  /** Known host endings select a fixed explanation without forwarding raw detail. */
  failureReason?: 'missing-final-answer' | 'max-tokens' | 'forked' | 'unsupported-ending'
    | 'discarded' | 'disposed' | 'aborted' | 'interrupted';
}

/** Implementations own session admission, execution and precise cancellation. */
export interface A2ABackend {
  /** Does not allocate a session or submit a model prompt. */
  preflight?(input: A2APreflightInput): Promise<A2APreflightReport>;
  /** Optional read-only reconciliation; never resumes or repeats execution. */
  recover?(target: A2ATarget, options: { requestId: string }): Promise<SafeError | undefined>;
  /** Cancel pending admission and drain owned initialization before rejecting an aborted preparation. */
  prepare(input: A2APrepareInput, options?: { signal: AbortSignal }): Promise<A2ATarget>;
  run(target: A2ATarget, prompt: string, options: { requestId: string; signal: AbortSignal;
    /** Hosts with a session queue call this again immediately before submitting the prompt. */
    beforeStart?: (signal?: AbortSignal) => Promise<void>;
    /** Process-slot wait stays submitted. Undefined means the handshake has started. */
    onCapacity?: (pending: { code: 'CAPACITY_PENDING'; position: number; waitedMs: number } | undefined) => void;
    /** Set by the gateway. The DSH host binds it for the prompt and never puts the workbench credential here. */
    execution?: A2AExecutionRef }): Promise<A2ARunResult>;
  /** Ordinary session release. Hosts that cannot close omit this and the gateway reports UNSUPPORTED. */
  close?(target: A2ATarget, options?: { signal?: AbortSignal }): Promise<A2ACloseResult>;
  status?(target: A2ATarget): Promise<A2ASessionStatus>;
  /** Controlled delete: ACP session/delete, never DSH history. The gateway sends it only when allowDelete is set. */
  delete?(target: A2ATarget): Promise<A2ACloseResult>;
}
