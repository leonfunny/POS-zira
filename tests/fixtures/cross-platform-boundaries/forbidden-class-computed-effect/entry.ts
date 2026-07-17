import { register } from './startup';

export class EagerWorker {
  [register()] = 'registered';
}
