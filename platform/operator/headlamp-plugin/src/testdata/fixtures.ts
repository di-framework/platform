/** The YAML fixtures: manifests a user could `kubectl apply`, valid against the CRD. */

import { load } from 'js-yaml';
import type { PlatformInstanceObject } from '../types';
import fullYaml from './full.yaml?raw';
import endpointOnlyYaml from './gateway-endpoint-only.yaml?raw';
import minimalYaml from './minimal.yaml?raw';

/** Only the required fields. */
export const minimal = load(minimalYaml) as PlatformInstanceObject;
/** Every spec field set. */
export const full = load(fullYaml) as PlatformInstanceObject;
/** Some optional fields: the gateway endpoint without a NodePort, and the default policy. */
export const endpointOnly = load(endpointOnlyYaml) as PlatformInstanceObject;
