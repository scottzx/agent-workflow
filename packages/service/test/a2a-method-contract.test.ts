import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_AGENT_METHODS } from '../src/a2a/gateway.js';
import { TARGET_METHODS } from '../src/execution/targets.js';
import { DISCOVERY_METHODS } from '../src/execution/project-discovery.js';

interface MethodDescriptor {
  description?: unknown;
  parameters?: unknown;
}

// The DreamMate node rejects the whole registration when a method descriptor's
// `parameters` is not a JSON Schema object with a top-level type: "object",
// so the check below reads the raw descriptors instead of any shared helper.
function contractViolations(methods: object): string[] {
  const violations: string[] = [];
  for (const [name, raw] of Object.entries(methods as Record<string, unknown>)) {
    const descriptor = (raw ?? {}) as MethodDescriptor;
    const parameters = descriptor.parameters;
    const isObjectSchema = !!parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      && (parameters as { type?: unknown }).type === 'object';
    if (!isObjectSchema) violations.push(`method "${name}" parameters must be an object schema with type: "object"`);
    const description = descriptor.description;
    if (typeof description !== 'string' || description.trim() === '') {
      violations.push(`method "${name}" description must be a non-empty string`);
    }
  }
  return violations;
}

test('REMOTE_AGENT_METHODS satisfy the node registration contract', () => {
  const violations = contractViolations(REMOTE_AGENT_METHODS);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('TARGET_METHODS satisfy the node registration contract', () => {
  const violations = contractViolations(TARGET_METHODS);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('DISCOVERY_METHODS satisfy the node registration contract', () => {
  const violations = contractViolations(DISCOVERY_METHODS);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('REMOTE_AGENT_METHODS registers the expected method set', () => {
  assert.ok(Object.keys(REMOTE_AGENT_METHODS).length >= 38,
    `expected at least 38 registered methods, got ${Object.keys(REMOTE_AGENT_METHODS).length}`);
});
