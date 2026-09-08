import { RestaurantCheckController as SharedController, type RestaurantControllerDependencies } from '../../shared/restaurant-check-controller';
import type { PosAction, PosState } from './pos-store';
export type { RestaurantCheckAccess } from '../../shared/restaurant-check-controller';

/** Typed Electron port; Android never imports main-process modules. */
export class RestaurantCheckController extends SharedController {
  constructor(deps: Omit<RestaurantControllerDependencies, 'getState' | 'dispatch'> & {
    getState(): PosState;
    dispatch(action: PosAction): void;
  }) {
    super({ ...deps, dispatch: action => deps.dispatch(action as PosAction) });
  }
}
