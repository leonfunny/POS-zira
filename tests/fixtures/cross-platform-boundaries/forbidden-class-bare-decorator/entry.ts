function bootstrap<T extends new (...args: any[]) => object>(target: T): T {
  return target;
}

@bootstrap
export class DecoratedWorker {}
