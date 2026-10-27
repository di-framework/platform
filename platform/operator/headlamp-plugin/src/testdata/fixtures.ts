/** The YAML fixtures: manifests a user could `kubectl apply`, valid against the CRD. */

import { load } from 'js-yaml';
import type { PlatformInstanceObject } from '../types';
import fullYaml from './full.yaml?raw';
import endpointOnlyYaml from './gateway-endpoint-only.yaml?raw';
import minimalYaml from './minimal.yaml?raw';
import tenancyYaml from './tenancy.yaml?raw';
import tenancyFullYaml from './tenancy-full.yaml?raw';
import tenancyMinimalYaml from './tenancy-minimal.yaml?raw';

/** Only the required fields. */
export const minimal = load(minimalYaml) as PlatformInstanceObject;
/** Every spec field set. */
export const full = load(fullYaml) as PlatformInstanceObject;
/** Some optional fields: the gateway endpoint without a NodePort, and the default policy. */
export const endpointOnly = load(endpointOnlyYaml) as PlatformInstanceObject;
/** The tenancy settings (#442): one tenant and user, tenantAuth through an issuer upstream. */
export const tenancy = load(tenancyYaml) as PlatformInstanceObject;
/** The smallest tenancy settings: one tenant and a user in it. */
export const tenancyMinimal = load(tenancyMinimalYaml) as PlatformInstanceObject;
/** Every tenancy field, and tenant and user fields the form keeps without showing them. */
export const tenancyFull = load(tenancyFullYaml) as PlatformInstanceObject;
