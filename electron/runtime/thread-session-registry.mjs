export class ThreadSessionRegistry {
  constructor() {
    this.loaded = new Map();
    this.loading = new Map();
    this.generations = new Map();
  }

  remember(threadId, cwd, { loaded = false } = {}) {
    if (!this.generations.has(threadId)) this.generations.set(threadId, 0);
    if (loaded) this.loaded.set(threadId, cwd);
  }

  async ensure(threadId, resume) {
    if (!this.generations.has(threadId)) this.generations.set(threadId, 0);
    const loadedCwd = this.loaded.get(threadId);
    if (loadedCwd) return loadedCwd;

    let pending = this.loading.get(threadId);
    if (!pending) {
      const generation = this.generations.get(threadId) ?? 0;
      pending = Promise.resolve()
        .then(resume)
        .then((cwd) => {
          if (!cwd) throw new Error("Runtime returned a thread without a working directory");
          if ((this.generations.get(threadId) ?? 0) !== generation) {
            throw new Error("The provider restarted while this thread was reconnecting. Retry the request.");
          }
          this.loaded.set(threadId, cwd);
          return cwd;
        })
        .finally(() => {
          if (this.loading.get(threadId) === pending) this.loading.delete(threadId);
        });
      this.loading.set(threadId, pending);
    }
    return pending;
  }

  delete(threadId) {
    this.loaded.delete(threadId);
    this.loading.delete(threadId);
    this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
  }

  clear() {
    const threadIds = new Set([...this.loaded.keys(), ...this.loading.keys(), ...this.generations.keys()]);
    this.loaded.clear();
    this.loading.clear();
    for (const threadId of threadIds) {
      this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
    }
  }
}
