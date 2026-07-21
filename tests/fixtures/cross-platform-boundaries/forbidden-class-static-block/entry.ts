export class EagerWorker {
  static {
    setInterval(() => undefined, 1_000);
  }
}
