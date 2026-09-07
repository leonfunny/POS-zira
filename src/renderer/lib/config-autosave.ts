import type { AgentConfig } from '../../shared/types';

type Patch = Partial<AgentConfig>;
type Key = keyof AgentConfig;
export type AutosaveSnapshot = {
  status: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  error: string | null;
};

/** Owned by the app session, not the Settings tab. Only edited fields queue. */
export class ConfigAutosave {
  private pending: Patch = {};
  private versions = new Map<Key, number>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: AutosaveSnapshot = { status: 'idle', error: null };

  constructor(
    private write: (patch: Patch) => Promise<AgentConfig>,
    private onSaved: (config: AgentConfig) => void,
    private isCurrent: () => boolean,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  getPending = (): Patch => ({ ...this.pending });
  cancel = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = {};
    this.versions.clear();
  };

  private publish(status: AutosaveSnapshot['status'], error: string | null = null) {
    this.snapshot = { status, error };
    this.listeners.forEach(listener => listener());
  }

  enqueue = (patch: Patch) => {
    if (!this.isCurrent()) return;
    const keys = Object.keys(patch) as Key[];
    if (!keys.length) return;
    this.pending = { ...this.pending, ...patch };
    keys.forEach(key => this.versions.set(key, ++this.revision));
    this.publish(this.running ? 'saving' : 'pending');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => { /* The visible error retains the draft. */ });
    }, 600);
  };

  flush = (): Promise<void> => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return this.running;
    if (!this.isCurrent()) return Promise.reject(new Error('Settings session changed'));
    if (!this.versions.size) return Promise.resolve();
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  };

  private async drain() {
    try {
      while (this.versions.size && this.isCurrent()) {
        const sent = new Map(this.versions);
        const patch = { ...this.pending };
        this.publish('saving');
        const updated = await this.write(patch);
        if (!this.isCurrent()) return;
        for (const [key, version] of sent) {
          if (this.versions.get(key) === version) {
            this.versions.delete(key);
            delete this.pending[key];
          }
        }
        this.onSaved(updated);
      }
      if (this.isCurrent()) this.publish('saved');
    } catch (error) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.isCurrent()) this.publish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
