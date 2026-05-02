import DirectSelect from './direct_select.js';
import * as Constants from '../constants.js';
import { isOfMetaType, isActiveFeature, isShiftDown } from '../lib/common_selectors.js';
import { removeMovementVector } from '../lib/movement_vector.js';
import bearing from '@turf/bearing';
import distance from '@turf/distance';
import destination from '@turf/destination';
import transformRotate from '@turf/transform-rotate';
import { point, lineString } from '@turf/helpers';
import createSupplementaryPoints from '../lib/create_supplementary_points.js';

const isVertex = isOfMetaType(Constants.meta.VERTEX);

function computeGeometricCenter(geojson) {
  const geom = geojson.geometry;
  const allCoords = [];
  if (geom.type === 'MultiLineString') {
    geom.coordinates.forEach((line) => line.forEach((c) => allCoords.push(c)));
  } else if (geom.type === 'LineString') {
    geom.coordinates.forEach((c) => allCoords.push(c));
  }
  if (allCoords.length === 0) return null;
  const sumLng = allCoords.reduce((s, c) => s + c[0], 0);
  const sumLat = allCoords.reduce((s, c) => s + c[1], 0);
  return [sumLng / allCoords.length, sumLat / allCoords.length];
}

function isRotatePoint(e) {
  if (!e.featureTarget) return false;
  const props = e.featureTarget.properties;
  return props.meta === Constants.meta.MIDPOINT && props.heading != null;
}

const DirectSelectRotate = { ...DirectSelect };

DirectSelectRotate.onSetup = function (opts) {
  const state = DirectSelect.onSetup.call(this, opts);
  state.isRotating = false;
  state.rotation = null;
  return state;
};

DirectSelectRotate.onStop = function (state) {
  this.removeRotationIndicator();
  DirectSelect.onStop.call(this, state);
};

DirectSelectRotate.toDisplayFeatures = function (state, geojson, push) {
  if (state.featureId === geojson.properties.id) {
    geojson.properties.active = Constants.activeStates.ACTIVE;
    push(geojson);

    const hideVertices =
      state.feature.properties.isEditGeometry &&
      (state.dragMoving || geojson.properties.user_hideVertices);

    if (!hideVertices && !state.isRotating) {
      const suppPoints = createSupplementaryPoints(geojson, {
        map: this.map,
        midpoints: true,
        selectedPaths: state.selectedCoordPaths,
      });
      suppPoints.forEach(push);
    }

    if (state.feature.properties.isEditGeometry) {
      const rotPoints = this.createBuildingRotationPoint(state, geojson);
      rotPoints.forEach(push);
    }
  } else {
    geojson.properties.active = Constants.activeStates.INACTIVE;
    push(geojson);
  }
  this.fireActionable(state);
};

DirectSelectRotate.createBuildingRotationPoint = function (state, geojson) {
  const featureId = geojson.properties && geojson.properties.id;
  const geom = geojson.geometry;

  if (geom.type !== 'MultiLineString' || geom.coordinates.length < 3) return [];

  const centerline = geom.coordinates[1];
  if (centerline.length < 2) return [];

  const centroid = computeGeometricCenter(geojson);
  if (!centroid) return [];

  const lineDir = bearing(point(centerline[0]), point(centerline[centerline.length - 1]));
  const perpDir = lineDir + 90;

  let allCoords = [];
  geom.coordinates.forEach((line) => line.forEach((c) => allCoords.push(c)));

  const perpRad = ((perpDir % 360) * Math.PI) / 180;
  const latRad = (centroid[1] * Math.PI) / 180;
  const lngScale = Math.cos(latRad);
  let maxPerpDist = 0;
  const centroidPt = point(centroid);
  for (const c of allCoords) {
    const dx = (c[0] - centroid[0]) * lngScale;
    const dy = c[1] - centroid[1];
    const projDist = Math.abs(dx * Math.sin(perpRad) + dy * Math.cos(perpRad));
    if (projDist > maxPerpDist) maxPerpDist = projDist;
  }
  const perpExtentKm = maxPerpDist * (Math.PI / 180) * 6371;
  const offsetDist = perpExtentKm + 0.005;

  const rotPointCoord = destination(centroidPt, offsetDist, perpDir, { units: 'kilometers' }).geometry.coordinates;

  return [
    {
      type: Constants.geojsonTypes.FEATURE,
      properties: {
        meta: Constants.meta.MIDPOINT,
        icon: 'rotate',
        parent: featureId,
        lng: rotPointCoord[0],
        lat: rotPointCoord[1],
        coord_path: '0.0',
        heading: perpDir,
      },
      geometry: {
        type: Constants.geojsonTypes.POINT,
        coordinates: rotPointCoord,
      },
    },
  ];
};

DirectSelectRotate.onTouchStart = DirectSelectRotate.onMouseDown = function (state, e) {
  if (isRotatePoint(e)) return this.onRotatePoint(state, e);
  if (isVertex(e)) return DirectSelect.onVertex.call(this, state, e);
  if (isActiveFeature(e)) return DirectSelect.onFeature.call(this, state, e);
  if (isOfMetaType(Constants.meta.MIDPOINT)(e)) return DirectSelect.onMidpoint.call(this, state, e);
  if (e.featureTarget?.properties?.user_isEditGeometry) {
    state.selectedCoordPaths = [];
    DirectSelect.startDragging.call(this, state, e);
    state.railEdge = null;
  }
};

DirectSelectRotate.onRotatePoint = function (state, e) {
  const geojson = state.feature.toGeoJSON();
  const centerCoord = computeGeometricCenter(geojson);
  if (!centerCoord) return;

  const mousePoint = point([e.lngLat.lng, e.lngLat.lat]);
  const heading0 = bearing(point(centerCoord), mousePoint);

  state.isRotating = true;
  state.rotation = {
    feature0: geojson,
    center: centerCoord,
    heading0: heading0,
  };

  this.initRotationIndicator();
  this.map.dragPan.disable();
  state.canDragMove = true;
  state.dragMoveLocation = e.lngLat;
  state.dragMoveStartLocation = e.lngLat;
  this.map.fire('draw.dragstart', { featureId: state.featureId });
};

DirectSelectRotate.onDrag = function (state, e) {
  if (state.canDragMove !== true) return;

  if (state.isRotating) {
    state.dragMoving = true;
    e.originalEvent.stopPropagation();
    this.dragRotatePoint(state, e);
    state.dragMoveLocation = e.lngLat;
    return;
  }

  return DirectSelect.onDrag.call(this, state, e);
};

DirectSelectRotate.dragRotatePoint = function (state, e) {
  if (!state.rotation) return;

  const mousePoint = point([e.lngLat.lng, e.lngLat.lat]);
  const rotCenter = point(state.rotation.center);

  const heading1 = bearing(rotCenter, mousePoint);
  let rotateAngle = heading1 - state.rotation.heading0;

  if (isShiftDown(e)) {
    rotateAngle = 5.0 * Math.round(rotateAngle / 5.0);
  }

  const snapTolerance = (this._ctx && this._ctx.options && this._ctx.options.orthogonalSnapTolerance) || 5;
  const nearestRight = 90 * Math.round(rotateAngle / 90);
  if (Math.abs(rotateAngle - nearestRight) <= snapTolerance) {
    rotateAngle = nearestRight;
  }

  this.updateRotationIndicator(state.rotation.center, state.rotation.heading0, rotateAngle, [
    e.lngLat.lng,
    e.lngLat.lat,
  ]);

  const rotatedFeature = transformRotate(state.rotation.feature0, rotateAngle, {
    pivot: rotCenter,
    mutate: false,
  });

  state.feature.incomingCoords(rotatedFeature.geometry.coordinates);
};

DirectSelectRotate.onTouchEnd = DirectSelectRotate.onMouseUp = function (state) {
  if (state.isRotating) {
    if (state.dragMoving) {
      this.fireUpdate();
    }
    this.stopRotating(state);
    return;
  }

  return DirectSelect.onMouseUp.call(this, state);
};

DirectSelectRotate.stopRotating = function (state) {
  this.map.dragPan.enable();
  state.isRotating = false;
  state.rotation = null;
  state.dragMoving = false;
  state.canDragMove = false;
  state.dragMoveLocation = null;
  state.dragMoveStartLocation = null;
  this.clearRotationIndicator();
  removeMovementVector(this.map);
};

DirectSelectRotate.onMouseMove = function (state, e) {
  if (isRotatePoint(e)) {
    this.updateUIClasses({ mouse: Constants.cursors.MOVE });
    if (state.dragMoving) this.fireUpdate();
    this.stopDragging(state);
    return true;
  }

  return DirectSelect.onMouseMove.call(this, state, e);
};

// Reuse rotation indicator methods from scale_rotate
DirectSelectRotate.initRotationIndicator = function () {
  const map = this.map;
  const emptyFC = { type: 'FeatureCollection', features: [] };

  if (!map.getSource('rotation-indicator-lines')) {
    map.addSource('rotation-indicator-lines', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'rotation-indicator-lines',
      type: 'line',
      source: 'rotation-indicator-lines',
      paint: {
        'line-color': '#000000',
        'line-width': 1,
        'line-opacity': 0.3,
        'line-dasharray': [4, 4],
      },
    });
  }

  if (!map.getSource('rotation-indicator-label')) {
    map.addSource('rotation-indicator-label', { type: 'geojson', data: emptyFC });
    map.addLayer({
      id: 'rotation-indicator-label',
      type: 'symbol',
      source: 'rotation-indicator-label',
      layout: {
        'text-field': ['get', 'angle'],
        'text-size': 10,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-anchor': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
      },
      paint: {
        'text-color': '#000000',
        'text-opacity': 1,
      },
    });
  }
};

DirectSelectRotate.updateRotationIndicator = function (centerCoord, heading0, rotateAngle, mouseCoord) {
  const map = this.map;

  let displayAngle = rotateAngle;
  while (displayAngle > 180) displayAngle -= 360;
  while (displayAngle < -180) displayAngle += 360;

  if (Math.abs(displayAngle) < 0.5) {
    this.clearRotationIndicator();
    return;
  }

  const centerPt = point(centerCoord);
  const dist = distance(centerPt, point(mouseCoord), { units: 'kilometers' });

  if (dist < 0.001) {
    this.clearRotationIndicator();
    return;
  }

  const originEnd = destination(centerPt, dist, heading0, { units: 'kilometers' });
  const originLine = lineString([centerCoord, originEnd.geometry.coordinates]);

  const currentBearing = heading0 + displayAngle;
  const currentEnd = destination(centerPt, dist, currentBearing, { units: 'kilometers' });
  const currentLine = lineString([centerCoord, currentEnd.geometry.coordinates]);

  const arcRadius = dist * 0.15;
  const arcSteps = Math.max(Math.round(Math.abs(displayAngle) / 3), 12);
  const arcCoords = [];
  for (let i = 0; i <= arcSteps; i++) {
    const t = i / arcSteps;
    const a = heading0 + t * displayAngle;
    const pt = destination(centerPt, arcRadius, a, { units: 'kilometers' });
    arcCoords.push(pt.geometry.coordinates);
  }
  const arcLine = lineString(arcCoords);

  map.getSource('rotation-indicator-lines').setData({
    type: 'FeatureCollection',
    features: [originLine, currentLine, arcLine],
  });

  const bisectorBearing = heading0 + displayAngle / 2;
  const labelDist = arcRadius * 1.8;
  const labelPt = destination(centerPt, labelDist, bisectorBearing, { units: 'kilometers' });

  map.getSource('rotation-indicator-label').setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { angle: `${Math.round(displayAngle)}°` },
        geometry: labelPt.geometry,
      },
    ],
  });
};

DirectSelectRotate.clearRotationIndicator = function () {
  const map = this.map;
  const emptyFC = { type: 'FeatureCollection', features: [] };
  if (map.getSource('rotation-indicator-lines')) {
    map.getSource('rotation-indicator-lines').setData(emptyFC);
  }
  if (map.getSource('rotation-indicator-label')) {
    map.getSource('rotation-indicator-label').setData(emptyFC);
  }
};

DirectSelectRotate.removeRotationIndicator = function () {
  const map = this.map;
  ['rotation-indicator-label', 'rotation-indicator-lines'].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });
};

export default DirectSelectRotate;
