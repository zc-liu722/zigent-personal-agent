const PI = Math.PI;
const EARTH_SEMI_MAJOR_AXIS = 6_378_245;
const EARTH_ECCENTRICITY_SQUARED = 0.006693421622965943;

function transformLatitude(longitudeOffset: number, latitudeOffset: number): number {
  let result = -100 + 2 * longitudeOffset + 3 * latitudeOffset
    + 0.2 * latitudeOffset * latitudeOffset
    + 0.1 * longitudeOffset * latitudeOffset
    + 0.2 * Math.sqrt(Math.abs(longitudeOffset));
  result += (20 * Math.sin(6 * longitudeOffset * PI) + 20 * Math.sin(2 * longitudeOffset * PI)) * 2 / 3;
  result += (20 * Math.sin(latitudeOffset * PI) + 40 * Math.sin(latitudeOffset / 3 * PI)) * 2 / 3;
  result += (160 * Math.sin(latitudeOffset / 12 * PI) + 320 * Math.sin(latitudeOffset * PI / 30)) * 2 / 3;
  return result;
}

function transformLongitude(longitudeOffset: number, latitudeOffset: number): number {
  let result = 300 + longitudeOffset + 2 * latitudeOffset
    + 0.1 * longitudeOffset * longitudeOffset
    + 0.1 * longitudeOffset * latitudeOffset
    + 0.1 * Math.sqrt(Math.abs(longitudeOffset));
  result += (20 * Math.sin(6 * longitudeOffset * PI) + 20 * Math.sin(2 * longitudeOffset * PI)) * 2 / 3;
  result += (20 * Math.sin(longitudeOffset * PI) + 40 * Math.sin(longitudeOffset / 3 * PI)) * 2 / 3;
  result += (150 * Math.sin(longitudeOffset / 12 * PI) + 300 * Math.sin(longitudeOffset / 30 * PI)) * 2 / 3;
  return result;
}

/** Convert a GPS/WGS84 point to the GCJ-02 coordinates used by Amap. */
export function wgs84ToGcj02(latitude: number, longitude: number): { latitude: number; longitude: number } {
  const latitudeOffset = transformLatitude(longitude - 105, latitude - 35);
  const longitudeOffset = transformLongitude(longitude - 105, latitude - 35);
  const radians = latitude / 180 * PI;
  const sinLatitude = Math.sin(radians);
  const magic = 1 - EARTH_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude;
  const sqrtMagic = Math.sqrt(magic);
  const latitudeDelta = latitudeOffset * 180
    / ((EARTH_SEMI_MAJOR_AXIS * (1 - EARTH_ECCENTRICITY_SQUARED)) / (magic * sqrtMagic) * PI);
  const longitudeDelta = longitudeOffset * 180
    / (EARTH_SEMI_MAJOR_AXIS / sqrtMagic * Math.cos(radians) * PI);
  return {
    latitude: Number((latitude + latitudeDelta).toFixed(6)),
    longitude: Number((longitude + longitudeDelta).toFixed(6))
  };
}

export function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
): number {
  const toRadians = (degrees: number) => degrees * PI / 180;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
