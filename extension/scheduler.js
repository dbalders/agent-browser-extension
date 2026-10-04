// A fair keyed reader/writer scheduler. A pending writer blocks later readers of
// its keys, while unrelated keys continue. Resources may be resolved lazily so a
// session cleanup barrier can include tabs created by its earlier operations.
export class CommandScheduler {
  constructor() { this.queue = []; this.running = new Set(); }

  resources(job) {
    const result = new Map();
    for (const [key, mode] of typeof job.resources === 'function' ? job.resources() : job.resources) {
      result.set(key, mode === 'write' || result.get(key) === 'write' ? 'write' : 'read');
    }
    return result;
  }

  conflicts(first, second) {
    for (const [key, mode] of first) if (second.has(key) && (mode === 'write' || second.get(key) === 'write')) return true;
    return false;
  }

  schedule(options, task) {
    const result = new Promise((resolve, reject) => this.queue.push({ ...options, task, resolve, reject }));
    this.pump();
    return result;
  }

  pump() {
    const blocked = [];
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index]; let keys;
      try { keys = this.resources(job); }
      catch (error) { this.queue.splice(index, 1); job.reject(error); continue; }
      if ([...this.running].some(active => this.conflicts(keys, active.keys)) || blocked.some(earlier => this.conflicts(keys, earlier))) {
        blocked.push(keys); index++; continue;
      }
      this.queue.splice(index, 1); job.keys = keys; this.running.add(job);
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.running.delete(job); this.pump(); });
    }
  }

  cancel(predicate, error) {
    const retained = [];
    for (const job of this.queue) {
      if (job.cancelable !== false && predicate(job)) job.reject(error);
      else retained.push(job);
    }
    this.queue = retained; this.pump();
  }

  sessionIds() { return new Set([...this.queue, ...this.running].map(job => job.sessionId).filter(id => id !== undefined)); }
}
