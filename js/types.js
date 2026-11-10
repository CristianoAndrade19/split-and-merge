// @ts-check

/**
 * @typedef {{ x: number, y: number }} Point
 *
 * @typedef {{ x: number, y: number, w: number, h: number }} RectBox
 *
 * @typedef {{ x: number, y: number, scale: number, rotation?: number }} LayerTransform
 *
 * @typedef {{
 *   type: 'border-cut' | 'lasso',
 *   polygon: Point[],
 *   cutPath: Point[],
 *   pIn?: Point,
 *   pOut?: Point
 * }} SelectionShape
 *
 * @typedef {{
 *   img: HTMLImageElement | HTMLCanvasElement,
 *   width: number,
 *   height: number,
 *   name: string
 * }} LoadedImage
 *
 * @typedef {'none' | 'feather' | 'multiband' | 'poisson' | 'lab_skin' | 'luma_chroma' | 'edge_aware'} FinalMergeMode
 *
 * @typedef {{
 *   mode: FinalMergeMode,
 *   radiusPx: number,
 *   colorMatchStrength: number,
 *   prioritizeSkin: boolean,
 *   poissonReach: number,
 *   protectCoreFace: boolean
 * }} FinalMergeOptions
 *
 * @typedef {'oklab_ot' | 'cdf_curves' | 'melanin_hemo' | 'zones_lgg' | 'spatial_oklab'} SkinPostMethod
 *
 * @typedef {'face_to_body' | 'body_to_face' | 'mutual'} SkinMatchDirection
 *
 * @typedef {{
 *   enabled: boolean,
 *   method: SkinPostMethod,
 *   direction: SkinMatchDirection,
 *   strength: number,
 *   lumaMatch: number,
 *   chromaMatch: number,
 *   maskSelectivity: number,
 *   protectFeatures: boolean,
 *   seamEqualizePx: number,
 *   tempOffset: number,
 *   tintOffset: number,
 *   lightOffset: number,
 *   satScale: number
 * }} SkinPostOptions
 *
 * @typedef {{
 *   valid: boolean,
 *   faceRgbBefore: [number, number, number],
 *   bodyRgbBefore: [number, number, number],
 *   faceRgbAfter: [number, number, number],
 *   bodyRgbAfter: [number, number, number],
 *   deltaEBefore: number,
 *   deltaEAfter: number,
 *   faceSkinPixels: number,
 *   bodySkinPixels: number
 * }} SkinDiagnostics
 */
