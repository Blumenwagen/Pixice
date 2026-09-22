// Backend integration checks need Node's native fetch/AbortSignal pair, not jsdom.
export default {
  test: {
    environment: "node",
    setupFiles: [],
    include: ["tests/backend-service.test.js", "tests/connect-server.test.js", "tests/connect-operations.test.js"]
  }
};
