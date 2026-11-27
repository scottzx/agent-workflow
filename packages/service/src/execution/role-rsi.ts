/**
 * Read-only RSI projection for one role directory under `<project>/.1agents/roles/<roleId>`.
 * The role id is a single path segment. A symlink that leaves the roles directory is not a role.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCalibration, type CalibrationReport } from '../rsi/calibrate.js';
import { checkGate, type GateReport } from '../rsi/gate.js';
import { roleVersion, type RoleVersion } from '../rsi/outline-run.js';

const ROLE_ID = /^[A-Za-z0-9._-]+$/;

export class RoleRsiError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = 'RoleRsiError';
  }
}

export interface RoleRsiView {
  roleId: string;
  version: RoleVersion;
  checklist: unknown;
  workflow: unknown;
  gate: GateReport | { ready: false; reasons: string[]; error: string };
  calibration: CalibrationReport | null;
}

function decodeRoleId(raw: string): string {
  let roleId: string;
  try { roleId = decodeURIComponent(raw); }
  catch { throw new RoleRsiError('Invalid role id', 400); }
  if (!ROLE_ID.test(roleId) || roleId === '.' || roleId === '..' || roleId.includes('..')) throw new RoleRsiError('Invalid role id', 400);
  return roleId;
}

/** The role directory, or nothing when this id is not a real child of `.1agents/roles`. */
function roleDirectory(projectRoot: string, roleId: string): string | undefined {
  const rolesRoot = path.resolve(projectRoot, '.1agents', 'roles');
  const roleDir = path.resolve(rolesRoot, roleId);
  if (path.relative(rolesRoot, roleDir) !== roleId) return;
  let info;
  try { info = lstatSync(roleDir); }
  catch { return; }
  if (!info.isDirectory() && !info.isSymbolicLink()) return;
  let realRoles: string, realRole: string;
  try { realRoles = realpathSync(rolesRoot); realRole = realpathSync(roleDir); }
  catch { return; }
  if (path.relative(realRoles, realRole) !== roleId) return;
  return realRole;
}

async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > 1_000_000) return null;
    return JSON.parse(text) as unknown;
  } catch { return null; }
}

/** A calibration dropped beside the role, for a copy that never went through the runtime workspace. */
async function readRoleCalibration(file: string): Promise<CalibrationReport | undefined> {
  const value = await readJson(file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const report = value as CalibrationReport;
  if ((report.schemaVersion !== 1 && report.schemaVersion !== 2) || typeof report.calibratedAt !== 'string' || typeof report.passed !== 'boolean') return;
  return report;
}

function newerCalibration(left: CalibrationReport | undefined, right: CalibrationReport | undefined): CalibrationReport | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return (right.calibratedAt > left.calibratedAt ? right : left);
}

/** Checklist, workflow, gate and the newest calibration for one role. Missing files stay null; a missing role is 404. */
export async function readRoleRsi(projectRoots: readonly string[], rawRoleId: string): Promise<RoleRsiView> {
  const roleId = decodeRoleId(rawRoleId);
  let directory: string | undefined;
  for (const root of projectRoots) {
    directory = roleDirectory(root, roleId);
    if (directory) break;
  }
  if (!directory) throw new RoleRsiError('Role not found', 404);
  const agentsDir = path.dirname(path.dirname(directory));
  const workspace = path.join(agentsDir, 'runtime');
  const [checklist, workflow, runtimeCalibration, roleCalibration] = await Promise.all([
    readJson(path.join(directory, 'checklist.json')),
    readJson(path.join(directory, 'workflow.json')),
    loadCalibration(workspace, roleId),
    readRoleCalibration(path.join(directory, 'calibration.json')),
  ]);
  let gate: RoleRsiView['gate'];
  try { gate = await checkGate({ roleDirectory: directory, workspace }); }
  catch (error) { gate = { ready: false, reasons: [], error: error instanceof Error ? error.message : String(error) }; }
  const version = 'role' in gate && gate.role ? gate.role : await roleVersion(directory).catch(() => ({ dirty: true }));
  return { roleId, version, checklist, workflow, gate, calibration: newerCalibration(runtimeCalibration, roleCalibration) };
}

/** Walk up from a seed until a directory that contains `.1agents/roles`. */
export function discoverProjectRoots(seeds: readonly string[]): string[] {
  const found: string[] = [];
  for (const seed of seeds) {
    if (!seed) continue;
    let dir = path.resolve(seed);
    for (let depth = 0; depth < 12; depth++) {
      try {
        if (statSync(path.join(dir, '.1agents', 'roles')).isDirectory()) found.push(dir);
      } catch { /* keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...new Set(found)];
}
