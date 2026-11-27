/** Stand-in for @deepseek-ai/* so apply() can take and release real DirectoryLeases without a DSH install. */
const rows = new Map();

export class Context {
  constructor() {
    this.fiber = { dispose: async () => {} };
    this.storageDomain = {
      async open() {
        return {
          table() {
            return {
              entries() { return rows.entries(); },
              async put(key, value) { rows.set(key, value); },
              async update(key, change) {
                const current = rows.get(key);
                if (!current) throw new Error('ACP diagnostic attempt is missing');
                rows.set(key, change(current));
              },
            };
          },
          async close() {},
        };
      },
    };
  }
  async plugin() { return { await: async () => {} }; }
}

export class LlmError extends Error {
  constructor(message, code, extra) {
    super(message ?? '');
    this.name = 'LlmError';
    this.code = code;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

export function defineTool(spec) {
  return { ...spec, async execute(args, exec) { return spec.execute(args, exec); } };
}

export function defineDomain(spec) { return spec; }
export function domainTable(schema) { return schema; }
export class Storage {}
export default Storage;
