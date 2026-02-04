export const DRAWING_SUB_MODES = {
  FREE: 'free',
  RECTANGLE: 'rectangle',
  LINE: 'line',
};

const SUB_MODE_LABELS = {
  [DRAWING_SUB_MODES.FREE]: 'Freeform',
  [DRAWING_SUB_MODES.RECTANGLE]: 'Rect',
  [DRAWING_SUB_MODES.LINE]: 'Line',
};

const SUB_MODE_ORDER = [DRAWING_SUB_MODES.FREE, DRAWING_SUB_MODES.RECTANGLE, DRAWING_SUB_MODES.LINE];

/**
 * @param {Object} ctx - The draw context
 * @param {Object} state - The mode state
 * @param {Object} [options] - Configuration options
 * @param {Function} [options.onModeChange] - Callback called when sub-mode changes, receives new mode
 */
export function createDrawingModeSelector(ctx, state, options = {}) {
  const { onModeChange = null } = options;

  if (!ctx.options.useAngleDistanceInput) {
    return null;
  }

  // Restore previous sub-mode from context, or default to FREE
  state.drawingSubMode = ctx.lastDrawingSubMode || DRAWING_SUB_MODES.FREE;

  const container = document.createElement('div');
  container.className = 'mapbox-gl-draw-angle-distance-container';

  const [leftPos, topPos] = ctx.options.angleDistanceInputPosition;
  container.style.cssText = `
    position: absolute;
    top: ${topPos};
    left: ${leftPos};
  `;

  const section = document.createElement('div');
  section.className = 'mapbox-gl-draw-section';

  const modeLabel = document.createElement('span');
  modeLabel.className = 'mapbox-gl-draw-label';
  modeLabel.style.cursor = 'pointer';
  modeLabel.innerHTML = `<span class="key">M</span><span class="text">${SUB_MODE_LABELS[state.drawingSubMode]}</span>`;

  section.appendChild(modeLabel);
  container.appendChild(section);

  ctx.map.getContainer().appendChild(container);

  const updateLabel = () => {
    modeLabel.innerHTML = `<span class="key">M</span><span class="text">${SUB_MODE_LABELS[state.drawingSubMode]}</span>`;
  };

  const keyHandler = (e) => {
    if (e.key === 'm' || e.key === 'M') {
      if (state.vertices && state.vertices.length > 0) return;
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      e.preventDefault();
      e.stopPropagation();
      const currentIndex = SUB_MODE_ORDER.indexOf(state.drawingSubMode);
      state.drawingSubMode = SUB_MODE_ORDER[(currentIndex + 1) % SUB_MODE_ORDER.length];
      ctx.lastDrawingSubMode = state.drawingSubMode;
      updateLabel();
      if (onModeChange) {
        onModeChange(state.drawingSubMode);
      }
    }
  };
  document.addEventListener('keydown', keyHandler);

  const clickHandler = () => {
    if (state.vertices && state.vertices.length > 0) return;
    const currentIndex = SUB_MODE_ORDER.indexOf(state.drawingSubMode);
    state.drawingSubMode = SUB_MODE_ORDER[(currentIndex + 1) % SUB_MODE_ORDER.length];
    ctx.lastDrawingSubMode = state.drawingSubMode;
    updateLabel();
    if (onModeChange) {
      onModeChange(state.drawingSubMode);
    }
  };
  modeLabel.addEventListener('click', clickHandler);

  state.modeSelectorContainer = container;
  state.modeSelectorKeyHandler = keyHandler;
  state.modeSelectorClickHandler = clickHandler;
  state.modeSelectorLabel = modeLabel;

  // Call the callback with initial mode
  if (onModeChange) {
    onModeChange(state.drawingSubMode);
  }

  return { container, section, modeLabel, keyHandler, clickHandler };
}

export function hideDrawingModeSelector(state) {
  if (state.modeSelectorContainer) {
    state.modeSelectorContainer.style.display = 'none';
  }
}

export function showDrawingModeSelector(state) {
  if (state.modeSelectorContainer) {
    state.modeSelectorContainer.style.display = 'flex';
  }
}

export function removeDrawingModeSelector(state) {
  if (state.modeSelectorKeyHandler) {
    document.removeEventListener('keydown', state.modeSelectorKeyHandler);
    state.modeSelectorKeyHandler = null;
  }
  if (state.modeSelectorClickHandler && state.modeSelectorLabel) {
    state.modeSelectorLabel.removeEventListener('click', state.modeSelectorClickHandler);
    state.modeSelectorClickHandler = null;
  }
  if (state.modeSelectorContainer && state.modeSelectorContainer.parentNode) {
    state.modeSelectorContainer.parentNode.removeChild(state.modeSelectorContainer);
    state.modeSelectorContainer = null;
  }
  state.modeSelectorLabel = null;
}
