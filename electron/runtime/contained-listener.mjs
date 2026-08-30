export function containListenerErrors(listener, onError) {
  return (...args) => {
    try {
      return listener(...args);
    } catch (error) {
      try {
        onError?.(error, ...args);
      } catch {
        // An error reporter must not turn a contained event failure into a process crash.
      }
      return undefined;
    }
  };
}
