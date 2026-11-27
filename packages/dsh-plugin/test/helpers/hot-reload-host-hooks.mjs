/** Resolve every @deepseek-ai/* specifier to the local shim. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return { url: new URL('./hot-reload-host-shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
