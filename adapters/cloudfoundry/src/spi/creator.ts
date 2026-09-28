import type { CloudFoundryServiceInfo, RawVcapServiceData } from '../types';

/**
 * Service Provider Interface (SPI) for converting raw VCAP_SERVICES entry data
 * into a typed CloudFoundryServiceInfo model.
 */
export interface CloudFoundryServiceInfoCreator<
  T extends CloudFoundryServiceInfo = CloudFoundryServiceInfo,
> {
  /**
   * Evaluates if this creator accepts and can parse the given raw service entry.
   */
  accept(serviceData: RawVcapServiceData): boolean;

  /**
   * Constructs the strongly typed ServiceInfo model from the service data.
   */
  createServiceInfo(serviceData: RawVcapServiceData): T;
}
