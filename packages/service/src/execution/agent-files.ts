/** Plugin-style agent definitions, the format Claude Code and Grok load natively: `<root>/agents/*.md`, Markdown with a frontmatter header. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const AGENT_FILE_MAX_BYTES = 64 * 1024;
const MAX_AGENT_FILES = 100;
export const agentNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AgentDefinition {
  name: string;
  description?: string;
  /** Real path of the Markdown file. */
  file: string;
  /** The Markdown body after the frontmatter: the role's instructions. */
  body: string;
  sha256: string;
}

const within = (root: string, value: string): boolean => {
  const relative = path.relative(root, value);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Reads the top-level `key: value` lines of a leading `---` block. Nested YAML is not needed for name and description. */
export function parseAgentMarkdown(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    let value = pair[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    fields[pair[1]!] = value;
  }
  return { fields, body: normalized.slice(match[0].length).trim() };
}

/**
 * Read one agent file that must stay inside `root` after symlinks resolve.
 * The frontmatter `name` must be a valid agent name; the body must not be empty.
 */
export async function readAgentFile(file: string, root: string): Promise<AgentDefinition> {
  const actualRoot = await realpath(root), actual = await realpath(file);
  if (!within(actualRoot, actual) || path.extname(actual) !== '.md') throw new Error('Agent file must be a .md file inside its directory');
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > AGENT_FILE_MAX_BYTES) throw new Error(`Agent file must be a regular file of at most ${AGENT_FILE_MAX_BYTES} bytes`);
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const { fields, body } = parseAgentMarkdown(bytes.toString('utf8'));
  const name = fields.name ?? path.basename(actual, '.md');
  if (!agentNamePattern.test(name)) throw new Error(`Invalid agent name in ${path.basename(actual)}`);
  if (!body) throw new Error(`Agent file ${path.basename(actual)} has no instructions`);
  return { name, ...(fields.description ? { description: fields.description } : {}), file: actual, body,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** List `<root>/agents/*.md` in name order. Names must be unique within the directory. */
export async function listAgentFiles(root: string): Promise<AgentDefinition[]> {
  if (!path.isAbsolute(root)) throw new Error('Agent path must be absolute');
  const actualRoot = await realpath(root);
  if (!(await lstat(actualRoot)).isDirectory()) throw new Error('Agent path must be a directory');
  const directory = path.join(actualRoot, 'agents');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No agents/ directory under this path');
    throw error;
  }
  const files = entries.filter(entry => entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink())).map(entry => entry.name).sort();
  if (files.length > MAX_AGENT_FILES) throw new Error(`At most ${MAX_AGENT_FILES} agent files are supported`);
  const agents: AgentDefinition[] = [];
  for (const name of files) agents.push(await readAgentFile(path.join(directory, name), actualRoot));
  const names = agents.map(agent => agent.name);
  if (new Set(names).size !== names.length) throw new Error('Agent names must be unique within agents/');
  return agents;
}

/** The prompt prefix a host prepends to a path agent's first message. */
export function agentPromptPrefix(agent: AgentDefinition): string {
  return `宿主已按路径加载智能体 ${agent.name}（${agent.file}）。以下是它的角色说明：\n\n${agent.body}\n\n上游任务：\n`;
}
