import { KubeObject, type KubeObjectInterface } from '@kinvolk/headlamp-plugin/lib/k8s/cluster';
import { API_VERSION, KIND, PLURAL, type PlatformInstanceObject } from './types';

export const ROUTE_LIST = 'platforminstances';
export const ROUTE_DETAILS = 'platforminstance';
export const LIST_PATH = '/platform/instances';
export const DETAILS_PATH = '/platform/instances/:namespace/:name';

/** The API object in Headlamp's KubeObjectInterface shape. */
export type PlatformInstanceInterface = KubeObjectInterface &
  Pick<PlatformInstanceObject, 'spec' | 'status'>;

/**
 * Headlamp's resource class for PlatformInstance. Reads and watches go through Headlamp's API
 * proxy with the viewer's own credentials.
 */
export class PlatformInstance extends KubeObject<PlatformInstanceInterface> {
  static kind = KIND;
  static apiVersion = API_VERSION;
  static apiName = PLURAL;
  static isNamespaced = true;

  static get detailsRoute() {
    return ROUTE_DETAILS;
  }

  static get listRoute() {
    return ROUTE_LIST;
  }

  get spec() {
    return this.jsonData.spec;
  }

  get status() {
    return this.jsonData.status ?? {};
  }
}

/** The object as the API returned it, in this plugin's own types. */
export function asObject(item: PlatformInstance): PlatformInstanceObject {
  return item.jsonData as unknown as PlatformInstanceObject;
}
