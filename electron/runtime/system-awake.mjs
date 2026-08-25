export function createSystemAwakeController(powerSaveBlocker) {
  let blockerId = null;

  const stop = () => {
    if (blockerId === null) return false;
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
    return false;
  };

  return {
    setEnabled(enabled) {
      if (!enabled) return stop();
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return true;
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      return true;
    },
    stop
  };
}
