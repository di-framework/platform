/**
 * Utility class for detecting Cloud Foundry runtime environments.
 */

export class CloudFoundryDetector {
  /**
   * Returns true if running within a Cloud Foundry runtime environment
   * (determined by presence of VCAP_APPLICATION or VCAP_SERVICES).
   */
  static isCloudFoundry(env: Record<string, string | undefined> = process.env): boolean {
    const vcapApp = env.VCAP_APPLICATION;
    const vcapServices = env.VCAP_SERVICES;
    return Boolean(
      (typeof vcapApp === 'string' && vcapApp.trim().length > 0) ||
        (typeof vcapServices === 'string' && vcapServices.trim().length > 0),
    );
  }

  /**
   * Retrieves raw VCAP_APPLICATION JSON string from environment.
   */
  static getApplicationJson(
    env: Record<string, string | undefined> = process.env,
  ): string | undefined {
    const val = env.VCAP_APPLICATION;
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  }

  /**
   * Retrieves raw VCAP_SERVICES JSON string from environment.
   */
  static getServicesJson(
    env: Record<string, string | undefined> = process.env,
  ): string | undefined {
    const val = env.VCAP_SERVICES;
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  }
}

/**
 * Convenient standalone check for Cloud Foundry runtime.
 */
export function isCloudFoundry(env: Record<string, string | undefined> = process.env): boolean {
  return CloudFoundryDetector.isCloudFoundry(env);
}
