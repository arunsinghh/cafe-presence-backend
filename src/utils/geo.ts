/**
 * Geographic calculation utilities.
 */

/**
 * Calculate the distance between two GPS coordinates
 * using the Haversine formula.
 *
 * @param latitude1 - Latitude of first point in degrees
 * @param longitude1 - Longitude of first point in degrees
 * @param latitude2 - Latitude of second point in degrees
 * @param longitude2 - Longitude of second point in degrees
 * @returns Distance between points in meters
 */
export const calculateHaversineDistance = (
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number
): number => {
  const EARTH_RADIUS_METERS = 6_371_000;

  const toRadians = (degrees: number): number =>
    (degrees * Math.PI) / 180;

  const lat1 = toRadians(latitude1);
  const lat2 = toRadians(latitude2);
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);

  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLongitude / 2) ** 2;

  const c =
    2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
};

