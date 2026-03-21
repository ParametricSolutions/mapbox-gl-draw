import * as turf from '@turf/turf';
import { fastBearing, fastDistance, fastDestination } from './fast_math.js';

// Reusable unit options to avoid object allocation
const UNITS_METERS = { units: 'meters' };
const UNITS_KM = { units: 'kilometers' };

// Cache for turf.point objects to reduce GC pressure
const pointCache = new Map();
const MAX_POINT_CACHE_SIZE = 100;

/**
 * Get or create a cached turf point. Reuses existing point objects when possible.
 * @param {Array} coord - [lng, lat] coordinate array
 * @returns {Object} Turf point feature
 */
function getCachedPoint(coord) {
  const key = `${coord[0]},${coord[1]}`;
  let point = pointCache.get(key);
  if (!point) {
    point = turf.point(coord);
    // Limit cache size to prevent memory bloat
    if (pointCache.size >= MAX_POINT_CACHE_SIZE) {
      const firstKey = pointCache.keys().next().value;
      pointCache.delete(firstKey);
    }
    pointCache.set(key, point);
  }
  return point;
}

/**
 * Clear the point cache (call when switching modes or cleaning up)
 */
export function clearPointCache() {
  pointCache.clear();
}

/**
 * Find the nearest line segment to a given point from an array of coordinates
 * Returns the segment {start, end} and the distance in meters
 */
export function findNearestSegment(coords, snapPoint) {
  let nearestSegment = null;
  let minDistance = Infinity;

  for (let i = 0; i < coords.length - 1; i++) {
    const segmentStart = coords[i];
    const segmentEnd = coords[i + 1];
    const segment = turf.lineString([segmentStart, segmentEnd]);
    const nearestPoint = turf.nearestPointOnLine(segment, snapPoint);
    const distance = turf.distance(snapPoint, nearestPoint, UNITS_METERS);

    if (distance < minDistance) {
      minDistance = distance;
      nearestSegment = { start: segmentStart, end: segmentEnd };
    }
  }

  return nearestSegment ? { segment: nearestSegment, distance: minDistance } : null;
}

/**
 * When clicking on a point that sits on a line, detect the underlying line's bearing
 * Used by distance drawing modes to enable orthogonal snapping to lines under points
 */
export function getUnderlyingLineBearing(ctx, map, e, snappedCoord) {
  const snapping = ctx.snapping;
  if (!snapping || !snapping.snappedGeometry || snapping.snappedGeometry.type !== 'Point') {
    return null;
  }

  // Query all features at click point across all snap buffer layers
  const bufferLayers = snapping.bufferLayers.map(layerId => '_snap_buffer_' + layerId);
  const allFeaturesAtPoint = map.queryRenderedFeatures(e.point, {
    layers: bufferLayers
  });

  // Look for a line or polygon feature
  const underlyingFeature = allFeaturesAtPoint.find((feature) => {
    if (feature.id === snapping.snappedFeature.id && feature.layer.id === snapping.snappedFeature.layer.id) {
      return false;
    }
    const geomType = feature.geometry.type;
    return geomType === 'LineString' ||
           geomType === 'MultiLineString' ||
           geomType === 'Polygon' ||
           geomType === 'MultiPolygon';
  });

  if (!underlyingFeature) {
    return null;
  }

  let underlyingGeom = underlyingFeature.geometry;
  if (underlyingGeom.type === 'Polygon' || underlyingGeom.type === 'MultiPolygon') {
    underlyingGeom = turf.polygonToLine(underlyingGeom).geometry;
  }

  if (underlyingGeom.type !== 'LineString' && underlyingGeom.type !== 'MultiLineString') {
    return null;
  }

  const snapPoint = turf.point([snappedCoord.lng, snappedCoord.lat]);
  const coords = underlyingGeom.type === 'LineString' ? underlyingGeom.coordinates : underlyingGeom.coordinates.flat();

  const result = findNearestSegment(coords, snapPoint);
  if (!result) {
    return null;
  }

  const bearing = fastBearing(result.segment.start, result.segment.end);

  return {
    bearing: bearing,
    segment: result.segment
  };
}

/**
 * Get BOTH adjacent segments at a corner point (vertex)
 * Returns an array of bearings and segments when the point is at a vertex
 * This enables perpendicular snapping to both adjacent lines at corners
 */
export function getAdjacentSegmentsAtVertex(ctx, map, e, snappedCoord) {
  const snapping = ctx.snapping;
  if (!snapping) {
    return null;
  }

  // Query all features at click point across all snap buffer layers
  const bufferLayers = snapping.bufferLayers.map(layerId => '_snap_buffer_' + layerId);
  const allFeaturesAtPoint = map.queryRenderedFeatures(e.point, {
    layers: bufferLayers
  });

  // Look for a line or polygon feature
  const lineFeatures = allFeaturesAtPoint.filter((feature) => {
    const geomType = feature.geometry.type;
    return geomType === 'LineString' ||
           geomType === 'MultiLineString' ||
           geomType === 'Polygon' ||
           geomType === 'MultiPolygon';
  });

  if (lineFeatures.length === 0) {
    return null;
  }

  const snapPoint = turf.point([snappedCoord.lng, snappedCoord.lat]);
  const segments = [];
  const VERTEX_TOLERANCE = 1; // meters - distance to consider as being on a vertex

  for (const feature of lineFeatures) {
    let geom = feature.geometry;
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      geom = turf.polygonToLine(geom).geometry;
    }

    if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') {
      continue;
    }

    const coords = geom.type === 'LineString' ? geom.coordinates : geom.coordinates.flat();

    // Check if snap point is very close to a vertex (corner)
    for (let i = 0; i < coords.length; i++) {
      const vertexDist = fastDistance(snapPoint.geometry.coordinates, coords[i]);
      if (vertexDist < VERTEX_TOLERANCE) {
        if (i > 0) {
          const prevSegment = { start: coords[i - 1], end: coords[i] };
          segments.push({ bearing: fastBearing(prevSegment.start, prevSegment.end), segment: prevSegment });
        } else if (geom.type === 'LineString' && coords.length > 2 &&
                   fastDistance(coords[0], coords[coords.length - 1]) < 1) {
          const prevSegment = { start: coords[coords.length - 2], end: coords[i] };
          segments.push({ bearing: fastBearing(prevSegment.start, prevSegment.end), segment: prevSegment });
        }

        if (i < coords.length - 1) {
          const nextSegment = { start: coords[i], end: coords[i + 1] };
          segments.push({ bearing: fastBearing(nextSegment.start, nextSegment.end), segment: nextSegment });
        } else if (geom.type === 'LineString' && coords.length > 2 &&
                   fastDistance(coords[0], coords[coords.length - 1]) < 1) {
          const nextSegment = { start: coords[i], end: coords[1] };
          segments.push({ bearing: fastBearing(nextSegment.start, nextSegment.end), segment: nextSegment });
        }

        break; // Found the vertex, no need to continue
      }
    }
  }

  return segments.length > 0 ? segments : null;
}

/**
 * Get the bearing of a snapped line at a given coordinate
 * Returns the bearing and segment of the nearest line segment
 */
export function getSnappedLineBearing(ctx, snappedCoord) {
  const snapping = ctx.snapping;
  if (!snapping || !snapping.snappedGeometry) {
    return null;
  }

  const geom = snapping.snappedGeometry;

  // Only process LineString or MultiLineString
  if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') {
    return null;
  }

  const snapPoint = turf.point([snappedCoord.lng, snappedCoord.lat]);
  const coords = geom.type === 'LineString' ? geom.coordinates : geom.coordinates.flat();

  const result = findNearestSegment(coords, snapPoint);
  if (!result) {
    return null;
  }

  const bearing = fastBearing(result.segment.start, result.segment.end);
  return { bearing, segment: result.segment };
}

/**
 * Calculate where a circle (centered at centerPoint with radius in meters)
 * intersects with a line segment
 * Returns the intersection point closest to mousePosition, or null if no intersection exists
 */
export function calculateCircleLineIntersection(centerPoint, radiusMeters, lineSegment, mousePosition) {
  const center = turf.point(centerPoint);
  const lineStart = turf.point(lineSegment.start);
  const lineEnd = turf.point(lineSegment.end);

  // Extend the line segment in both directions to ensure we catch all intersections
  const lineBearing = turf.bearing(lineStart, lineEnd);
  const extendedLineStart = turf.destination(lineStart, 0.1, lineBearing + 180, { units: 'kilometers' }).geometry.coordinates;
  const extendedLineEnd = turf.destination(lineEnd, 0.1, lineBearing, { units: 'kilometers' }).geometry.coordinates;

  // Create a circle polygon approximation
  const circle = turf.circle(centerPoint, radiusMeters / 1000, { steps: 64, units: 'kilometers' });
  const extendedLine = turf.lineString([extendedLineStart, extendedLineEnd]);

  try {
    // Find intersection points between circle and line
    const intersections = turf.lineIntersect(circle, extendedLine);

    if (intersections.features.length === 0) {
      return null;
    }

    // If only one intersection, return it
    if (intersections.features.length === 1) {
      const coord = intersections.features[0].geometry.coordinates;
      const distance = turf.distance(center, turf.point(coord), { units: 'meters' });
      return { coord, distance };
    }

    // Multiple intersections: choose the one closest to mouse position
    const mousePoint = turf.point(mousePosition);
    let closestIntersection = null;
    let minDistanceToMouse = Infinity;

    for (const intersection of intersections.features) {
      const coord = intersection.geometry.coordinates;
      const distanceToMouse = turf.distance(mousePoint, turf.point(coord), { units: 'meters' });

      if (distanceToMouse < minDistanceToMouse) {
        minDistanceToMouse = distanceToMouse;
        closestIntersection = coord;
      }
    }

    if (closestIntersection) {
      const distance = turf.distance(center, turf.point(closestIntersection), { units: 'meters' });
      return { coord: closestIntersection, distance };
    }
  } catch (e) {
    return null;
  }

  return null;
}

/**
 * Calculate where the bearing line from startPoint intersects with lineSegment (extended to infinity)
 * Returns null if lines are parallel or intersection distance is unreasonable
 */
export function calculateLineIntersection(startPoint, bearing, lineSegment) {
  const lineBearing = fastBearing(lineSegment.start, lineSegment.end);

  // Check if lines are nearly parallel (within 5 degrees)
  let angleDiff = Math.abs(bearing - lineBearing);
  if (angleDiff > 180) angleDiff = Math.abs(360 - angleDiff);
  if (angleDiff < 5 || angleDiff > 175) {
    return null;
  }

  const bearingLine = turf.lineString([
    fastDestination(startPoint, 100, bearing + 180),
    fastDestination(startPoint, 100, bearing)
  ]);

  const extendedSnapLine = turf.lineString([
    fastDestination(lineSegment.start, 100, lineBearing + 180),
    fastDestination(lineSegment.start, 100, lineBearing)
  ]);

  try {
    const intersection = turf.lineIntersect(bearingLine, extendedSnapLine);

    if (intersection.features.length > 0) {
      const intersectionPoint = intersection.features[0].geometry.coordinates;
      const distance = fastDistance(startPoint, intersectionPoint);

      // Only return if distance is reasonable (less than 10km)
      if (distance < 10000) {
        return {
          coord: intersectionPoint,
          distance: distance
        };
      }
    }
  } catch (e) {
    return null;
  }

  return null;
}

/**
 * When extended guidelines are active and we're snapping to a line,
 * check if the cursor is close to an intersection between the extended guidelines and the snapped line.
 * If yes, return a point snap at that intersection to prioritize it.
 * Returns null if no close intersection found.
 */
export function findExtendedGuidelineIntersection(extendedGuidelines, snapInfo, cursorPosition, snapTolerance) {
  if (!extendedGuidelines || extendedGuidelines.length === 0) {
    return null;
  }

  if (!snapInfo || snapInfo.type !== 'line') {
    return null;
  }

  const cursorCoord = [cursorPosition.lng, cursorPosition.lat];
  const lineSegment = snapInfo.segment;
  const lineBearing = fastBearing(lineSegment.start, lineSegment.end);

  const extendedSnapLine = turf.lineString([
    fastDestination(lineSegment.start, 100, lineBearing + 180),
    fastDestination(lineSegment.start, 100, lineBearing)
  ]);

  let closestIntersection = null;
  let minDistance = Infinity;

  for (const guideline of extendedGuidelines) {
    try {
      const guidelineLineString = turf.lineString(guideline.geometry.coordinates);
      const intersections = turf.lineIntersect(guidelineLineString, extendedSnapLine);

      for (const intersection of intersections.features) {
        const intersectionCoord = intersection.geometry.coordinates;
        const distanceToCursor = fastDistance(cursorCoord, intersectionCoord);

        if (distanceToCursor < minDistance) {
          minDistance = distanceToCursor;
          closestIntersection = intersectionCoord;
        }
      }
    } catch (e) {
      // Ignore errors and continue
      continue;
    }
  }

  // If we found an intersection within snap tolerance, return it as a point snap
  if (closestIntersection && minDistance <= snapTolerance) {
    return {
      type: 'point',
      coord: closestIntersection,
      snappedFeature: snapInfo.snappedFeature
    };
  }

  return null;
}

/**
 * Find all intersection points between extended guidelines and nearby snap lines.
 * This proactively calculates intersections so users can snap to them even when
 * not directly hovering over the snap line's buffer.
 *
 * @param {Object} map - The Mapbox GL map instance
 * @param {Object} snapping - The snapping context with bufferLayers info
 * @param {Array} extendedGuidelines - Array of extended guideline GeoJSON features
 * @param {Object} cursorPosition - Current cursor position {lng, lat}
 * @param {number} snapToleranceMeters - Snap tolerance in meters
 * @returns {Object|null} Snap info for the closest intersection, or null
 */
export function findAllGuidelineIntersections(map, snapping, extendedGuidelines, cursorPosition, snapToleranceMeters) {
  if (!map || !snapping || !extendedGuidelines || extendedGuidelines.length === 0) {
    return null;
  }

  const cursorPoint = turf.point([cursorPosition.lng, cursorPosition.lat]);

  // Query all snap buffer layers for line features near the cursor
  const bufferLayers = snapping.bufferLayers || [];
  const queryLayers = bufferLayers.map(layerId => '_snap_buffer_' + layerId);

  // Create a bounding box around the extended guidelines to query features
  let allCoords = [];
  for (const guideline of extendedGuidelines) {
    if (guideline.geometry && guideline.geometry.coordinates) {
      allCoords = allCoords.concat(guideline.geometry.coordinates);
    }
  }

  if (allCoords.length === 0) {
    return null;
  }

  // Get bounds of extended guidelines and expand slightly
  let bbox;
  try {
    bbox = turf.bbox(turf.lineString(allCoords));
  } catch (e) {
    return null;
  }
  const sw = map.project([bbox[0], bbox[1]]);
  const ne = map.project([bbox[2], bbox[3]]);

  // Query features within the guideline bounds
  let allFeatures = [];
  try {
    allFeatures = map.queryRenderedFeatures(
      [[sw.x - 50, ne.y - 50], [ne.x + 50, sw.y + 50]],
      { layers: queryLayers }
    );
  } catch (e) {
    return null;
  }

  // Filter to only line/polygon features (not extended guidelines themselves)
  const lineFeatures = allFeatures.filter(f => {
    if (f.properties && f.properties.isExtendedGuideline) {
      return false;
    }
    const geomType = f.geometry.type;
    return geomType === 'LineString' ||
           geomType === 'MultiLineString' ||
           geomType === 'Polygon' ||
           geomType === 'MultiPolygon';
  });

  let closestIntersection = null;
  let minDistance = Infinity;
  let closestFeature = null;

  // Check each line feature against each guideline
  for (const feature of lineFeatures) {
    let geom = feature.geometry;

    // Convert polygons to linestrings
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      try {
        geom = turf.polygonToLine(geom).geometry;
      } catch (e) {
        continue;
      }
    }

    // Get coordinates array
    let coordsArrays = [];
    if (geom.type === 'LineString') {
      coordsArrays = [geom.coordinates];
    } else if (geom.type === 'MultiLineString') {
      coordsArrays = geom.coordinates;
    }

    for (const coords of coordsArrays) {
      if (coords.length < 2) continue;

      let lineString;
      try {
        lineString = turf.lineString(coords);
      } catch (e) {
        continue;
      }

      // Check against each guideline
      for (const guideline of extendedGuidelines) {
        try {
          const guidelineLineString = turf.lineString(guideline.geometry.coordinates);
          const intersections = turf.lineIntersect(guidelineLineString, lineString);

          for (const intersection of intersections.features) {
            const intersectionCoord = intersection.geometry.coordinates;
            const intersectionPoint = turf.point(intersectionCoord);

            // Check distance from cursor to intersection
            const distanceToCursor = turf.distance(cursorPoint, intersectionPoint, UNITS_METERS);

            if (distanceToCursor < minDistance) {
              minDistance = distanceToCursor;
              closestIntersection = intersectionCoord;
              closestFeature = feature;
            }
          }
        } catch (e) {
          continue;
        }
      }
    }
  }

  // If we found an intersection within snap tolerance, return it as a point snap
  if (closestIntersection && minDistance <= snapToleranceMeters) {
    return {
      type: 'point',
      coord: closestIntersection,
      snappedFeature: closestFeature,
      isGuidelineIntersection: true
    };
  }

  return null;
}

/**
 * Find intersection points between a collinear direction line and nearby snap lines.
 * This allows users to "drag a line out until it meets something" by snapping to
 * where the collinear extension of an adjacent segment crosses other snap lines.
 *
 * @param {Object} map - The Mapbox GL map instance
 * @param {Object} snapping - The snapping context with bufferLayers info
 * @param {Array} vertexCoord - The vertex being dragged [lng, lat]
 * @param {number} collinearBearing - The bearing of the collinear direction
 * @param {Object} cursorPosition - Current cursor position {lng, lat}
 * @param {number} snapToleranceMeters - Snap tolerance in meters
 * @returns {Object|null} Snap info for the closest intersection, or null
 */
export function findCollinearIntersections(map, snapping, vertexCoord, collinearBearing, cursorPosition, snapToleranceMeters) {
  if (!map || !vertexCoord || collinearBearing === null || collinearBearing === undefined) {
    return null;
  }

  const cursorCoord = [cursorPosition.lng, cursorPosition.lat];

  const collinearLine = turf.lineString([
    fastDestination(vertexCoord, 500, collinearBearing + 180),
    vertexCoord,
    fastDestination(vertexCoord, 500, collinearBearing)
  ]);

  // Get bounds of collinear line and expand
  let bbox;
  try {
    bbox = turf.bbox(collinearLine);
  } catch (e) {
    return null;
  }
  const sw = map.project([bbox[0], bbox[1]]);
  const ne = map.project([bbox[2], bbox[3]]);

  // Query features - try snap buffer layers first, then fall back to all features
  let allFeatures = [];
  const bufferLayers = (snapping && snapping.bufferLayers) || [];
  const queryLayers = bufferLayers.map(layerId => '_snap_buffer_' + layerId);

  try {
    if (queryLayers.length > 0) {
      allFeatures = map.queryRenderedFeatures(
        [[sw.x - 100, ne.y - 100], [ne.x + 100, sw.y + 100]],
        { layers: queryLayers }
      );
    }
    // If no features found with buffer layers, try querying all features
    if (allFeatures.length === 0) {
      allFeatures = map.queryRenderedFeatures(
        [[sw.x - 100, ne.y - 100], [ne.x + 100, sw.y + 100]]
      );
    }
  } catch (e) {
    return null;
  }

  // Filter to only line/polygon features (exclude draw layers and extended guidelines)
  const lineFeatures = allFeatures.filter(f => {
    if (f.properties && f.properties.isExtendedGuideline) {
      return false;
    }
    // Exclude mapbox-gl-draw internal layers
    if (f.layer && f.layer.id && (f.layer.id.startsWith('gl-draw') || f.layer.id.startsWith('mapbox-gl-draw'))) {
      return false;
    }
    const geomType = f.geometry.type;
    return geomType === 'LineString' ||
           geomType === 'MultiLineString' ||
           geomType === 'Polygon' ||
           geomType === 'MultiPolygon';
  });

  let closestIntersection = null;
  let minDistance = Infinity;
  let closestFeature = null;

  // Check each line feature against the collinear line
  for (const feature of lineFeatures) {
    let geom = feature.geometry;

    // Convert polygons to linestrings
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      try {
        geom = turf.polygonToLine(geom).geometry;
      } catch (e) {
        continue;
      }
    }

    // Get coordinates array
    let coordsArrays = [];
    if (geom.type === 'LineString') {
      coordsArrays = [geom.coordinates];
    } else if (geom.type === 'MultiLineString') {
      coordsArrays = geom.coordinates;
    }

    for (const coords of coordsArrays) {
      if (coords.length < 2) continue;

      let lineString;
      try {
        lineString = turf.lineString(coords);
      } catch (e) {
        continue;
      }

      // Find intersections
      try {
        const intersections = turf.lineIntersect(collinearLine, lineString);

        for (const intersection of intersections.features) {
          const intersectionCoord = intersection.geometry.coordinates;
          const distanceToCursor = fastDistance(cursorCoord, intersectionCoord);

          if (distanceToCursor < minDistance) {
            minDistance = distanceToCursor;
            closestIntersection = intersectionCoord;
            closestFeature = feature;
          }
        }
      } catch (e) {
        continue;
      }
    }
  }

  // If we found an intersection within snap tolerance, return it as a point snap
  if (closestIntersection && minDistance <= snapToleranceMeters) {
    return {
      type: 'point',
      coord: closestIntersection,
      snappedFeature: closestFeature,
      isCollinearIntersection: true
    };
  }

  return null;
}

// Cache for parallel line search results
let parallelLinesCache = {
  key: null,
  result: [],
  timestamp: 0
};
const PARALLEL_CACHE_TTL = 100; // Cache valid for 100ms

/**
 * Find the closest snap lines that intersect the orthogonal line from the midpoint
 * of the line being drawn. Returns the closest line on each side (max 2 lines).
 * OPTIMIZED: Uses bbox-based querying and caching to reduce expensive operations.
 * @param {Object} ctx - The context object with options
 * @param {Object} map - The Mapbox map instance
 * @param {Array} lastVertex - The last vertex coordinate [lng, lat]
 * @param {Object} currentPosition - Current mouse position {lng, lat}
 */
export function findNearbyParallelLines(ctx, map, lastVertex, currentPosition) {
  const snapping = ctx.snapping;
  if (!snapping || !snapping.bufferLayers || snapping.bufferLayers.length === 0) {
    return [];
  }

  // Create cache key from rounded positions (to allow small movements to hit cache)
  const precision = 5; // ~1m precision
  const cacheKey = `${lastVertex[0].toFixed(precision)},${lastVertex[1].toFixed(precision)}-${currentPosition.lng.toFixed(precision)},${currentPosition.lat.toFixed(precision)}`;

  // Check cache
  const now = Date.now();
  if (parallelLinesCache.key === cacheKey && (now - parallelLinesCache.timestamp) < PARALLEL_CACHE_TTL) {
    return parallelLinesCache.result;
  }

  const currentPosPoint = getCachedPoint([currentPosition.lng, currentPosition.lat]);

  // Query features near the mouse position using a screen-space radius
  // This is simpler and more reliable than the perpendicular intersection method
  const searchRadiusPixels = ctx.options.parallelSnapSearchRadius || 300; // pixels - larger radius to find parallel lines
  const mouseScreenPos = map.project([currentPosition.lng, currentPosition.lat]);

  const bufferLayers = snapping.bufferLayers.map(layerId => '_snap_buffer_' + layerId);
  const allFeatures = map.queryRenderedFeatures(
    [
      [mouseScreenPos.x - searchRadiusPixels, mouseScreenPos.y - searchRadiusPixels],
      [mouseScreenPos.x + searchRadiusPixels, mouseScreenPos.y + searchRadiusPixels]
    ],
    { layers: bufferLayers }
  );

  const nearbyLines = [];
  const seenFeatureIds = new Set(); // Avoid duplicates

  for (const feature of allFeatures) {
    // Skip duplicates (same feature can appear multiple times in query)
    const featureKey = feature.id || `${feature.properties?.id || ''}-${feature.geometry?.coordinates?.[0]}`;
    if (seenFeatureIds.has(featureKey)) continue;
    seenFeatureIds.add(featureKey);

    let geom = feature.geometry;

    // Skip points
    if (geom.type === 'Point') {
      continue;
    }

    // Convert polygons to lines
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      try {
        geom = turf.polygonToLine(geom).geometry;
      } catch (e) {
        continue;
      }
    }

    // Process LineString and MultiLineString
    if (geom.type === 'LineString') {
      const coords = geom.coordinates;
      if (coords.length >= 2) {
        // Find the nearest point on this line to the mouse
        try {
          const line = turf.lineString(coords);
          const nearestPoint = turf.nearestPointOnLine(line, currentPosPoint);
          const distanceToMouse = turf.distance(currentPosPoint, nearestPoint, UNITS_METERS);

          // Find the segment containing the nearest point for accurate bearing
          const nearestCoord = nearestPoint.geometry.coordinates;
          let segmentBearing = null;
          let minSegDist = Infinity;
          let bestSegment = null;

          for (let i = 0; i < coords.length - 1; i++) {
            const segStart = coords[i];
            const segEnd = coords[i + 1];
            const segLine = turf.lineString([segStart, segEnd]);
            const segNearest = turf.nearestPointOnLine(segLine, turf.point(nearestCoord));
            const segDist = turf.distance(turf.point(nearestCoord), segNearest, UNITS_METERS);

            if (segDist < minSegDist) {
              minSegDist = segDist;
              segmentBearing = fastBearing(segStart, segEnd);
              bestSegment = { start: segStart, end: segEnd };
            }
          }

          if (segmentBearing !== null && bestSegment) {
            nearbyLines.push({
              feature: feature,
              bearing: segmentBearing,
              segment: bestSegment,
              geometry: geom,
              distanceToMouse: distanceToMouse
            });
          }
        } catch (e) {
          continue;
        }
      }
    } else if (geom.type === 'MultiLineString') {
      // Process each line in the MultiLineString
      for (const lineCoords of geom.coordinates) {
        if (lineCoords.length >= 2) {
          try {
            const line = turf.lineString(lineCoords);
            const nearestPoint = turf.nearestPointOnLine(line, currentPosPoint);
            const distanceToMouse = turf.distance(currentPosPoint, nearestPoint, UNITS_METERS);

            // Find the segment for bearing
            const nearestCoord = nearestPoint.geometry.coordinates;
            let segmentBearing = null;
            let minSegDist = Infinity;
            let bestSegment = null;

            for (let i = 0; i < lineCoords.length - 1; i++) {
              const segStart = lineCoords[i];
              const segEnd = lineCoords[i + 1];
              const segLine = turf.lineString([segStart, segEnd]);
              const segNearest = turf.nearestPointOnLine(segLine, turf.point(nearestCoord));
              const segDist = turf.distance(turf.point(nearestCoord), segNearest, UNITS_METERS);

              if (segDist < minSegDist) {
                minSegDist = segDist;
                segmentBearing = fastBearing(segStart, segEnd);
                bestSegment = { start: segStart, end: segEnd };
              }
            }

            if (segmentBearing !== null && bestSegment) {
              nearbyLines.push({
                feature: feature,
                bearing: segmentBearing,
                segment: bestSegment,
                geometry: { type: 'LineString', coordinates: lineCoords },
                distanceToMouse: distanceToMouse
              });
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
  }

  // Sort by distance to mouse and return the closest ones (up to 5)
  let result = [];
  if (nearbyLines.length > 0) {
    nearbyLines.sort((a, b) => a.distanceToMouse - b.distanceToMouse);
    result = nearbyLines.slice(0, 5); // Return up to 5 closest lines
  }

  // Update cache
  parallelLinesCache = { key: cacheKey, result, timestamp: now };

  return result;
}

/**
 * Find the best matching parallel line bearing within tolerance
 * Returns null if no match, or {bearing, matchedLine} if found
 * @param {Array} nearbyLines - Array of nearby parallel line candidates
 * @param {number} mouseBearing - Current mouse bearing in degrees
 * @param {number} tolerance - Tolerance in degrees for matching (from ctx.options.parallelSnapTolerance)
 */
export function getParallelBearing(nearbyLines, mouseBearing, tolerance) {
  if (!nearbyLines || nearbyLines.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestDiff = Infinity;

  const normalizedMouse = ((mouseBearing % 360) + 360) % 360;

  for (const line of nearbyLines) {
    const lineBearing = line.bearing;
    const normalizedLine = ((lineBearing % 360) + 360) % 360;

    // Check both directions of the line (bearing and bearing + 180)
    for (const testBearing of [normalizedLine, (normalizedLine + 180) % 360]) {
      let diff = Math.abs(testBearing - normalizedMouse);
      if (diff > 180) diff = 360 - diff;

      if (diff <= tolerance && diff < bestDiff) {
        bestDiff = diff;
        // Use the actual bearing that matched (either lineBearing or lineBearing + 180)
        const matchedBearing = testBearing === normalizedLine ? lineBearing : lineBearing + 180;
        bestMatch = {
          bearing: matchedBearing,
          matchedLine: line,
          diff: diff
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Check if a calculated position (from bearing/distance snap) is very close to any existing vertex
 * If yes, snap exactly to that vertex to maintain geometric precision
 *
 * @param {Array} calculatedCoord - The calculated coordinate [lng, lat]
 * @param {Array<Array>} existingVertices - Array of existing vertex coordinates
 * @param {number} snapThreshold - Distance threshold in meters (default: 0.5m)
 * @returns {Array|null} The nearby vertex coordinate if found, or null
 */
export function snapToNearbyVertex(calculatedCoord, existingVertices, snapThreshold = 0.5) {
  if (!calculatedCoord || !existingVertices || existingVertices.length === 0) {
    return null;
  }

  for (const vertex of existingVertices) {
    const distance = fastDistance(calculatedCoord, vertex);

    if (distance <= snapThreshold) {
      return vertex;
    }
  }

  return null;
}

/**
 * Resolves conflicts between orthogonal, parallel, and bothSnapsActive snapping
 * Returns which snap should win based on proximity and bearing comparison
 *
 * @param {Object} options
 * @param {Object|null} options.orthogonalMatch - Orthogonal snap match object with bearing
 * @param {Object|null} options.parallelLineMatch - Parallel line snap match object with diff property
 * @param {boolean} options.bothSnapsActive - Whether double orthogonal snap is active
 * @param {Array} options.lastVertex - Last vertex coordinate [lng, lat]
 * @param {Object} options.lngLat - Current mouse position {lng, lat}
 * @param {Object|null} options.closingPerpendicularSnap - Closing perpendicular snap object (for bothSnapsActive calculation)
 * @param {number} options.proximityThreshold - Distance threshold in meters for bothSnapsActive priority
 * @param {number} options.mouseBearing - Current mouse bearing in degrees
 *
 * @returns {Object} { orthogonalMatch, parallelLineMatch } - One will be null based on conflict resolution
 */
export function resolveSnapConflicts(options) {
  let { orthogonalMatch, parallelLineMatch, bothSnapsActive, lastVertex, lngLat, closingPerpendicularSnap, proximityThreshold, mouseBearing } = options;

  // Smart conflict resolution with geo-based priority for bothSnapsActive
  if (bothSnapsActive && parallelLineMatch) {
    // Calculate the bothSnapsActive intersection point
    const perpLine = {
      start: fastDestination(closingPerpendicularSnap.firstVertex, 100, closingPerpendicularSnap.perpendicularBearing + 180),
      end: fastDestination(closingPerpendicularSnap.firstVertex, 100, closingPerpendicularSnap.perpendicularBearing),
    };

    const intersection = calculateLineIntersection(
      lastVertex,
      orthogonalMatch.bearing,
      perpLine
    );

    if (intersection) {
      const distanceToIntersection = fastDistance([lngLat.lng, lngLat.lat], intersection.coord);

      // If very close to intersection (within configured threshold), prioritize bothSnapsActive
      if (distanceToIntersection < proximityThreshold) {
        parallelLineMatch = null;
      } else {
        // Far from intersection, allow bearing comparison
        const orthogonalDiff = (() => {
          const normOrtho = ((orthogonalMatch.bearing % 360) + 360) % 360;
          const normMouse = ((mouseBearing % 360) + 360) % 360;
          let diff = Math.abs(normOrtho - normMouse);
          if (diff > 180) diff = 360 - diff;
          return diff;
        })();

        const parallelDiff = parallelLineMatch.diff;

        // If parallel is closer to mouse bearing, disable orthogonal snaps
        if (parallelDiff < orthogonalDiff) {
          orthogonalMatch = null;
          // This will also disable bothSnapsActive since orthogonalMatch becomes null
        } else {
          parallelLineMatch = null;
        }
      }
    }
  } else if (orthogonalMatch && parallelLineMatch) {
    // No bothSnapsActive - simple bearing comparison
    const orthogonalDiff = (() => {
      const normOrtho = ((orthogonalMatch.bearing % 360) + 360) % 360;
      const normMouse = ((mouseBearing % 360) + 360) % 360;
      let diff = Math.abs(normOrtho - normMouse);
      if (diff > 180) diff = 360 - diff;
      return diff;
    })();

    const parallelDiff = parallelLineMatch.diff;

    if (parallelDiff < orthogonalDiff) {
      orthogonalMatch = null;
    } else {
      parallelLineMatch = null;
    }
  }

  return { orthogonalMatch, parallelLineMatch };
}

/**
 * Calculate the perpendicular point on a line from a given vertex
 * Returns the point on the line where a perpendicular from the vertex intersects
 * Also returns the distance from cursor to this perpendicular point
 *
 * @param {Array} fromVertex - The vertex to draw perpendicular from [lng, lat]
 * @param {Object} lineSegment - Line segment {start, end}
 * @param {Object} cursorPosition - Current cursor position {lng, lat}
 * @returns {Object|null} {coord: [lng, lat], distanceFromCursor: meters} or null if no intersection
 */
export function calculatePerpendicularToLine(fromVertex, lineSegment, cursorPosition) {
  const lineBearing = fastBearing(lineSegment.start, lineSegment.end);

  const perpBearing1 = lineBearing + 90;
  const perpBearing2 = lineBearing - 90;

  const extendedLine = turf.lineString([
    fastDestination(lineSegment.start, 100, lineBearing + 180),
    fastDestination(lineSegment.end, 100, lineBearing)
  ]);

  let bestIntersection = null;
  let minDistance = Infinity;
  const cursorCoord = [cursorPosition.lng, cursorPosition.lat];

  for (const perpBearing of [perpBearing1, perpBearing2]) {
    const perpLine = turf.lineString([
      fastDestination(fromVertex, 100, perpBearing + 180),
      fastDestination(fromVertex, 100, perpBearing)
    ]);

    try {
      const intersections = turf.lineIntersect(perpLine, extendedLine);

      if (intersections.features.length > 0) {
        const intersectionCoord = intersections.features[0].geometry.coordinates;
        const distanceFromCursor = fastDistance(intersectionCoord, cursorCoord);

        if (distanceFromCursor < minDistance) {
          minDistance = distanceFromCursor;
          bestIntersection = {
            coord: intersectionCoord,
            distanceFromCursor: distanceFromCursor
          };
        }
      }
    } catch (e) {
      continue;
    }
  }

  return bestIntersection;
}

/**
 * Extract bearings from extended guidelines.
 * Returns an array of {bearing, guideline} objects for each extended guideline.
 * Used to enable perpendicular snapping to extended guidelines.
 */
export function getExtendedGuidelineBearings(extendedGuidelines) {
  if (!extendedGuidelines || extendedGuidelines.length === 0) {
    return [];
  }

  const bearings = [];

  for (const guideline of extendedGuidelines) {
    if (guideline.geometry && guideline.geometry.type === 'LineString') {
      const coords = guideline.geometry.coordinates;
      if (coords.length >= 2) {
        // Calculate bearing from first to last coordinate
        const bearing = fastBearing(coords[0], coords[coords.length - 1]);
        bearings.push({
          bearing: bearing,
          guideline: guideline,
          isMidpointGuideline: guideline.properties && guideline.properties.isMidpointGuideline
        });
      }
    }
  }

  return bearings;
}

/**
 * Check if the mouse bearing is orthogonal (perpendicular or parallel) to any extended guideline.
 * Returns an orthogonal match object if within tolerance, or null otherwise.
 * @param {Array} guidelineBearings - Array from getExtendedGuidelineBearings()
 * @param {number} mouseBearing - Current mouse bearing in degrees
 * @param {number} tolerance - Tolerance in degrees for matching
 * @returns {Object|null} Match object with bearing, referenceBearing, etc. or null
 */
export function getPerpendicularToGuidelineBearing(guidelineBearings, mouseBearing, tolerance) {
  if (!guidelineBearings || guidelineBearings.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestDiff = Infinity;
  const normalizedMouse = ((mouseBearing % 360) + 360) % 360;

  for (const guidelineInfo of guidelineBearings) {
    const guidelineBearing = guidelineInfo.bearing;

    // Check all orthogonal angles (0°, 90°, 180°, 270° from guideline bearing)
    // 0° and 180° = parallel to guideline, 90° and 270° = perpendicular to guideline
    for (const angle of [0, 90, 180, 270]) {
      const orthogonalBearing = guidelineBearing + angle;
      const normalizedOrtho = ((orthogonalBearing % 360) + 360) % 360;

      let diff = Math.abs(normalizedOrtho - normalizedMouse);
      if (diff > 180) diff = 360 - diff;

      if (diff <= tolerance && diff < bestDiff) {
        bestDiff = diff;
        bestMatch = {
          bearing: orthogonalBearing,
          referenceBearing: guidelineBearing,
          referenceType: "extendedGuideline",
          guideline: guidelineInfo.guideline,
          angleFromReference: angle
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Check if clicking near an extended guideline intersection point.
 * This handles the logic for detecting when the cursor is near an intersection
 * between an extended guideline and another line feature.
 * Returns the intersection coordinate if found, or null otherwise.
 */
export function checkExtendedGuidelineIntersectionClick(ctx, map, state, e, getSnapInfoFn) {
  if (!state.extendedGuidelines || state.extendedGuidelines.length === 0) {
    return null;
  }

  const snapping = ctx.snapping;
  if (!snapping || !snapping.snappedFeature) {
    return null;
  }

  const isExtendedGuideline =
    snapping.snappedFeature.properties &&
    snapping.snappedFeature.properties.isExtendedGuideline;

  if (isExtendedGuideline) {
    // Snapping to extended guideline - check for intersections with other lines
    const snapInfo = getSnapInfoFn(e.lngLat);

    // Query all features at cursor point to find other lines
    const bufferLayers = snapping.bufferLayers.map(layerId => '_snap_buffer_' + layerId);
    const allFeaturesAtPoint = map.queryRenderedFeatures(e.point, {
      layers: bufferLayers
    });

    // Look for a non-extended-guideline line feature
    const otherLineFeature = allFeaturesAtPoint.find((feature) => {
      if (feature.properties && feature.properties.isExtendedGuideline) {
        return false;
      }
      const geomType = feature.geometry.type;
      return geomType === 'LineString' ||
             geomType === 'MultiLineString' ||
             geomType === 'Polygon' ||
             geomType === 'MultiPolygon';
    });

    if (otherLineFeature && snapInfo) {
      // Get the geometry of the other line
      let otherGeom = otherLineFeature.geometry;
      if (otherGeom.type === 'Polygon' || otherGeom.type === 'MultiPolygon') {
        otherGeom = turf.polygonToLine(otherGeom).geometry;
      }

      if (otherGeom.type === 'LineString' || otherGeom.type === 'MultiLineString') {
        const snapPoint = turf.point([e.lngLat.lng, e.lngLat.lat]);
        const coords = otherGeom.type === 'LineString' ? otherGeom.coordinates : otherGeom.coordinates.flat();

        const result = findNearestSegment(coords, snapPoint);
        if (result) {
          const otherLineSnapInfo = {
            type: 'line',
            coord: snapInfo.coord,
            bearing: turf.bearing(
              turf.point(result.segment.start),
              turf.point(result.segment.end)
            ),
            segment: result.segment,
            snappedFeature: otherLineFeature
          };

          const intersectionSnap = findExtendedGuidelineIntersection(
            state.extendedGuidelines,
            otherLineSnapInfo,
            e.lngLat,
            state.snapTolerance
          );

          if (intersectionSnap) {
            return intersectionSnap.coord;
          }
        }
      }
    }
  } else {
    // Snapping to something else - check if it's a line that intersects with extended guideline
    const tempSnapInfo = getSnapInfoFn(e.lngLat);
    if (tempSnapInfo && tempSnapInfo.type === 'line') {
      const intersectionSnap = findExtendedGuidelineIntersection(
        state.extendedGuidelines,
        tempSnapInfo,
        e.lngLat,
        state.snapTolerance
      );
      if (intersectionSnap) {
        return intersectionSnap.coord;
      }
    }
  }

  return null;
}

/**
 * Calculate the minimum pixel distance from cursor to any extended guideline.
 * This is used to determine if cursor is within the persistence zone.
 *
 * @param {Object} map - The Mapbox GL map instance
 * @param {Array} extendedGuidelines - Array of extended guideline GeoJSON features
 * @param {Object} cursorLngLat - Current cursor position {lng, lat}
 * @returns {number} Minimum pixel distance to any extended guideline, or Infinity if no guidelines
 */
export function calculatePixelDistanceToExtendedGuidelines(map, extendedGuidelines, cursorLngLat) {
  if (!map || !extendedGuidelines || extendedGuidelines.length === 0 || !cursorLngLat) {
    return Infinity;
  }

  const cursorPoint = map.project([cursorLngLat.lng, cursorLngLat.lat]);
  let minPixelDistance = Infinity;

  for (const guideline of extendedGuidelines) {
    if (!guideline.geometry || !guideline.geometry.coordinates) continue;

    const coords = guideline.geometry.coordinates;

    // For each segment of the guideline
    for (let i = 0; i < coords.length - 1; i++) {
      const start = map.project(coords[i]);
      const end = map.project(coords[i + 1]);

      // Calculate perpendicular distance from point to line segment
      const pixelDist = pointToLineSegmentDistance(
        cursorPoint.x, cursorPoint.y,
        start.x, start.y,
        end.x, end.y
      );

      if (pixelDist < minPixelDistance) {
        minPixelDistance = pixelDist;
      }
    }
  }

  return minPixelDistance;
}

/**
 * Calculate the distance from a point to a line segment (in pixels).
 * Uses standard point-to-line-segment distance formula.
 *
 * @param {number} px - Point x coordinate
 * @param {number} py - Point y coordinate
 * @param {number} x1 - Line segment start x
 * @param {number} y1 - Line segment start y
 * @param {number} x2 - Line segment end x
 * @param {number} y2 - Line segment end y
 * @returns {number} Distance in pixels
 */
function pointToLineSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    // Line segment is a point
    return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
  }

  // Calculate projection of point onto line segment
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t)); // Clamp to segment

  // Find closest point on segment
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  // Return distance
  return Math.sqrt((px - closestX) * (px - closestX) + (py - closestY) * (py - closestY));
}
