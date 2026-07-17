function bootstrap(_target: object, _name: string): void {}

export class DecoratedWorker {
  @bootstrap
  status = 'idle';
}
