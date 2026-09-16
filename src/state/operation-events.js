export const OPERATION_EVENT = "pixice:operation-updated";

export function publishOperation(operation) {
  if (typeof window === "undefined" || !operation?.id) return;
  window.dispatchEvent(new CustomEvent(OPERATION_EVENT, { detail: operation }));
}
