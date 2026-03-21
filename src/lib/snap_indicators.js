import { fastDestination } from './fast_math.js';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Create all snap indicator sources and layers once.
 * Call this during mode setup. Uses empty data initially.
 */
export function setupSnapIndicatorSources(map) {
  if (!map) return;

  if (!map.getSource('right-angle-indicator')) {
    map.addSource('right-angle-indicator', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'right-angle-indicator',
      type: 'line',
      source: 'right-angle-indicator',
      paint: {
        'line-color': '#000000',
        'line-width': 1,
        'line-opacity': 1.0
      }
    });
  }

  if (!map.getSource('collinear-snap-line')) {
    map.addSource('collinear-snap-line', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'collinear-snap-line',
      type: 'line',
      source: 'collinear-snap-line',
      paint: {
        'line-color': '#000000',
        'line-width': 1,
        'line-opacity': 0.3,
        'line-dasharray': [4, 4]
      }
    });
  }

  if (!map.getSource('parallel-line-indicator')) {
    map.addSource('parallel-line-indicator', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'parallel-line-indicator',
      type: 'line',
      source: 'parallel-line-indicator',
      paint: {
        'line-color': '#0066ff',
        'line-width': 1,
        'line-opacity': 0.5,
        'line-dasharray': [4, 4]
      }
    });
  }
}

/**
 * Remove all snap indicator sources and layers (cleanup on mode exit).
 */
export function teardownSnapIndicatorSources(map) {
  if (!map) return;

  for (const id of ['right-angle-indicator', 'collinear-snap-line', 'parallel-line-indicator']) {
    if (map.getLayer && map.getLayer(id)) map.removeLayer(id);
    if (map.getSource && map.getSource(id)) map.removeSource(id);
  }
}

/**
 * Show a right-angle indicator (L-shaped) at a corner vertex
 */
export function showRightAngleIndicator(map, cornerVertex, referenceBearing, nextBearing, flipInside = false) {
  if (!map) return;
  if (!map.getSource('right-angle-indicator')) return;

  const refOffset = flipInside ? 0 : 180;
  const nextOffset = flipInside ? 180 : 0;

  const point1 = fastDestination(cornerVertex, 2, referenceBearing + refOffset);
  const point2 = fastDestination(point1, 2, nextBearing + nextOffset);
  const point3 = fastDestination(cornerVertex, 2, nextBearing + nextOffset);

  map.getSource('right-angle-indicator').setData({
    type: 'Feature',
    properties: { isRightAngleIndicator: true },
    geometry: {
      type: 'LineString',
      coordinates: [point1, point2, point3]
    }
  });
}

/**
 * Hide the right-angle indicator
 */
export function removeRightAngleIndicator(map) {
  if (!map) return;
  const src = map.getSource && map.getSource('right-angle-indicator');
  if (src) src.setData(EMPTY_FC);
}

/**
 * Show a collinear snap line (dashed line extending from vertex)
 */
export function showCollinearSnapLine(map, vertex, bearing) {
  if (!map) return;
  if (!map.getSource('collinear-snap-line')) return;

  const extendedBackward = fastDestination(vertex, 200, bearing + 180);
  const extendedForward = fastDestination(vertex, 200, bearing);

  map.getSource('collinear-snap-line').setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { isCollinearLine: true },
      geometry: {
        type: 'LineString',
        coordinates: [extendedBackward, extendedForward]
      }
    }]
  });
}

/**
 * Hide the collinear snap line
 */
export function removeCollinearSnapLine(map) {
  if (!map) return;
  const src = map.getSource && map.getSource('collinear-snap-line');
  if (src) src.setData(EMPTY_FC);
}

/**
 * Show a parallel line indicator (dashed line showing parallel direction)
 */
export function showParallelLineIndicator(map, startVertex, bearing) {
  if (!map) return;
  if (!map.getSource('parallel-line-indicator')) return;

  const extendedPoint = fastDestination(startVertex, 200, bearing);

  map.getSource('parallel-line-indicator').setData({
    type: 'Feature',
    properties: { isParallelIndicator: true },
    geometry: {
      type: 'LineString',
      coordinates: [startVertex, extendedPoint]
    }
  });
}

/**
 * Hide the parallel line indicator
 */
export function removeParallelLineIndicator(map) {
  if (!map) return;
  const src = map.getSource && map.getSource('parallel-line-indicator');
  if (src) src.setData(EMPTY_FC);
}

/**
 * Hide all snap indicators
 */
export function removeAllSnapIndicators(map) {
  removeRightAngleIndicator(map);
  removeCollinearSnapLine(map);
  removeParallelLineIndicator(map);
}
