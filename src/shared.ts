import * as THREE from 'three';

/**
 * Pixels per world unit at distance 1: drawingBufferHeight / (2·tan(fov/2)).
 * Point sprites use it so particle sizes are resolution- and DPI-independent.
 */
export const pixelScale: THREE.IUniform<number> = { value: 800 };

/** Drawing-buffer resolution shared by all fat-line (Line2) materials. */
/** Ray-march sample count for volumetric effects, set by the quality setting. */
export const volumeSamples: THREE.IUniform<number> = { value: 80 };

/** Drawing-buffer resolution shared by all fat-line (Line2) materials. */
export const lineResolution = new THREE.Vector2(1, 1);
