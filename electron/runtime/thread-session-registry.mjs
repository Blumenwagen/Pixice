export class ThreadSessionRegistry {
  constructor() {
    this.loaded = new Map();
    this.loading = new Map();
  }

  remember(threadId, cwd, { loaded = false } = {}) {
    if (loaded) this.loaded.set(threadId, cwd);
  }

  async ensure(threadId, resume) {
    const loadedCwd = this.loaded.get(threadId);
    if (loadedCwd) return loadedCwd;

    let pending = this.loading.get(threadId);
    if (!pending) {
      pending = Promise.resolve()
        .then(resume)
        .then((cwd) => {
          if (!cwd) throw new Error("Runtime returned a thread without a working directory");
          this.loaded.set(threadId, cwd);
          return cwd;
        })
        .finally(() => this.loading.delete(threadId));
      this.loading.set(threadId, pending);
    }
    return pending;
  }

  delete(threadId) {
    this.loaded.delete(threadId);
    this.loading.delete(threadId);
  }

  clear() {
    this.loaded.clear();
    this.loading.clear();
  }
}
