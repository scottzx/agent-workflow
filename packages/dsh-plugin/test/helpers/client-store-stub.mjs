/** Stand-in for the host's `@deepseek-ai/dsh-client-store` when only its sources are available. */

/**
 * Notify every listener of one snapshot change.
 * @param {Iterable<() => void>} listeners - the subscribed listeners.
 * @param {string} reason - the diagnostic reason.
 */
export function notifySubscribers(listeners, reason) {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error(reason, error)
    }
  }
}

/**
 * A minimal snapshot store.
 * @param {unknown} initial - the first value.
 * @returns {object} the store.
 */
export function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set: next => {
      value = next
      notifySubscribers(listeners, '[client-store] snapshot')
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
