// @ts-check
/// <reference path="./types.js" />

(function () {
  'use strict';

  const Geo = window.SplitMergeGeometry;
  const Ops = window.SplitMergeImageOps;
  const Seam = window.SplitMergeSeam;
  const SkinPost = window.SplitMergeSkinPost;
  const Prompts = window.SplitMergePrompts;
  const ViewportClass = window.SplitMergeViewport;

  // ===========================================================================
  // Application State
  // ===========================================================================
  const state = {
    activeStep: 1, // 1..6
    showGuides: true,
    targetDataFolder: '4', // Default subfolder in /data
    step6Subtab: 'engine', // 'engine' | 'fine' | 'samples'

    // --- Step 1: imagem1 (Cortar e isolar corpo + definir Corpo vs Face fixo) ---
    /** @type {LoadedImage | null} */
    img1: null,
    /** @type {HTMLCanvasElement | null} */
    img1Canvas: null,
    /** @type {SelectionShape | null} */
    selection1: null,
    /** @type {Uint8Array | null} */
    rawMask1: null,
    faceIsOne1: true, // Fixed role choice shared between imagem1 and imagem2!
    /** @type {Uint8Array | null} */
    faceMask1: null, // 1 = Face, 0 = Corpo
    /** @type {Float32Array | null} */
    edtFace1OutSq: null,
    /** @type {Float32Array | null} */
    edtFace1InSq: null,
    /** @type {HTMLCanvasElement | null} */
    corpo1Canvas: null,
    /** @type {HTMLCanvasElement | null} */
    face1Canvas: null,
    /** @type {HTMLCanvasElement | null} */
    mask1OverlayCanvas: null,
    faceCentroid1: { x: 0, y: 0, count: 0 },
    bodyCentroid1: { x: 0, y: 0, count: 0 },
    /** @type {'split' | 'body' | 'face'} */
    step1View: 'split',
    /** @type {'cut' | 'pan'} */
    step1Tool: 'cut',

    // --- Step 2: imagem2 (Padding transparente + ajuste manual + isolar face) ---
    /** @type {LoadedImage | null} */
    img2: null,
    /** @type {LayerTransform} */
    img2Transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    img2OnionOpacity: 0.35,
    showAnatomicGuides: false,
    flickerActive: false,
    /** @type {{ eye1L: Point | null, eye1R: Point | null, eye2L: Point | null, eye2R: Point | null }} */
    eyeCalib: { eye1L: null, eye1R: null, eye2L: null, eye2R: null },
    /** @type {HTMLCanvasElement | null} */
    img2AlignedCanvas: null,
    /** @type {ReturnType<typeof Ops.computeFittedPlacement> | null} */
    img2Placement: null,
    /** @type {HTMLCanvasElement | null} */
    face2Canvas: null,
    /** @type {'align' | 'face' | 'split'} */
    step2View: 'align',

    // --- Step 3: imagemMerge (Unir corpo + face & isolar face+bordas imprecisas / corpo sem bordas) ---
    /** @type {HTMLCanvasElement | null} */
    imgMergeCanvas: null,
    /** @type {'expand' | 'custom'} */
    mergeRegionMode: 'expand',
    expandPx: 36,
    /** @type {SelectionShape | null} */
    customSelection2: null,
    /** @type {Uint8Array | null} */
    customRawMask2: null,
    customFaceIsOne2: true,
    customExtraExpandPx: 0,
    /** @type {Float32Array | null} */
    edtCustomOutSq: null,
    /** @type {Float32Array | null} */
    edtCustomInSq: null,
    /** @type {Uint8Array | null} */
    mergeFaceMask: null, // 1 = (face + bordas imprecisas), 0 = (corpo sem bordas imprecisas)
    /** @type {Float32Array | null} */
    edtMergeInsideSq: null,
    /** @type {RectBox | null} */
    mergeFaceBox: null,
    exportCroppedMode: false,
    /** @type {HTMLCanvasElement | null} */
    faceImprecisaCanvas: null,
    /** @type {HTMLCanvasElement | null} */
    corpoSemBordasCanvas: null,
    /** @type {HTMLCanvasElement | null} */
    mergeOverlayCanvas: null,
    mergeFaceCentroid: { x: 0, y: 0, count: 0 },
    mergeBodyCentroid: { x: 0, y: 0, count: 0 },
    /** @type {'split' | 'face-imp' | 'body-clean'} */
    step3View: 'split',
    /** @type {'cut' | 'pan'} */
    step3Tool: 'cut',

    // --- Step 4: IA + (face + bordas imprecisas) = (face + bordas precisas) ---
    /** @type {LoadedImage | null} */
    imgRefined: null,
    /** @type {'full' | 'cropbox'} */
    refinedTargetMode: 'full',
    /** @type {LayerTransform} */
    refinedTransform: { x: 0, y: 0, scale: 1 },
    refinedOnionOpacity: 0.32,
    /** @type {HTMLCanvasElement | null} */
    refinedAlignedCanvas: null,
    /** @type {ReturnType<typeof Ops.computeFittedPlacement> | null} */
    refinedPlacement: null,
    /** @type {HTMLCanvasElement | null} */
    facePrecisaCanvas: null,
    /** @type {'align' | 'isolated'} */
    step4View: 'align',

    // --- Step 5: (face + bordas precisas) + (corpo sem bordas imprecisas) = imagemFinal ---
    /** @type {FinalMergeOptions} */
    finalMerge: {
      mode: 'none',
      radiusPx: 28,
      colorMatchStrength: 0,
      prioritizeSkin: true,
      poissonReach: 0.75,
      protectCoreFace: true,
    },
    /** @type {HTMLCanvasElement | null} */
    imgFinalUnblendedCanvas: null,
    /** @type {HTMLCanvasElement | null} */
    imgFinalCanvas: null,
    /** @type {'final' | 'compare-raw' | 'compare-merge' | 'compare-img1'} */
    step5View: 'final',
    compareRatio: 0.5,

    // --- Step 6: Pós-Processamento — Igualar Tom de Pele (Face × Corpo) ---
    /** @type {SkinPostOptions} */
    skinPost: {
      enabled: true,
      method: 'oklab_ot',
      direction: 'face_to_body',
      strength: 1.0,
      lumaMatch: 0.88,
      chromaMatch: 1.0,
      maskSelectivity: 0.72,
      protectFeatures: true,
      seamEqualizePx: 14,
      tempOffset: 0,
      tintOffset: 0,
      lightOffset: 0,
      satScale: 1.0,
    },
    /** @type {Point[]} */
    skinSamplesFace: [],
    /** @type {Point[]} */
    skinSamplesBody: [],
    /** @type {'pan' | 'sample-face' | 'sample-body'} */
    step6Tool: 'pan',
    /** @type {'post' | 'compare-pre' | 'compare-raw' | 'compare-img1' | 'skin-mask'} */
    step6View: 'post',
    /** @type {HTMLCanvasElement | null} */
    imgPostCanvas: null,
    /** @type {HTMLCanvasElement | null} */
    skinMaskPreviewCanvas: null,
    /** @type {SkinDiagnostics | null} */
    skinDiagnostics: null,
  };

  // ===========================================================================
  // DOM References & Viewport Initialization
  // ===========================================================================
  const mainCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mainCanvas'));
  const canvasDropWrap = /** @type {HTMLElement} */ (document.getElementById('canvasDropWrap'));
  const stepperNav = /** @type {HTMLElement} */ (document.getElementById('stepperNav'));
  const stageModeToolbar = /** @type {HTMLElement} */ (document.getElementById('stageModeToolbar'));
  const sidebarContent = /** @type {HTMLElement} */ (document.getElementById('sidebarContent'));
  const stageHintText = /** @type {HTMLElement} */ (document.getElementById('stageHintText'));
  const zoomReadout = /** @type {HTMLElement} */ (document.getElementById('zoomReadout'));
  const btnToggleOverlay = /** @type {HTMLButtonElement} */ (document.getElementById('btnToggleOverlay'));
  const btnZoomIn = /** @type {HTMLButtonElement} */ (document.getElementById('btnZoomIn'));
  const btnZoomOut = /** @type {HTMLButtonElement} */ (document.getElementById('btnZoomOut'));
  const btnZoomFit = /** @type {HTMLButtonElement} */ (document.getElementById('btnZoomFit'));
  const btnLoadDemo = /** @type {HTMLButtonElement} */ (document.getElementById('btnLoadDemo'));
  const btnResetAll = /** @type {HTMLButtonElement} */ (document.getElementById('btnResetAll'));

  const fileInputImg1 = /** @type {HTMLInputElement} */ (document.getElementById('fileInputImg1'));
  const fileInputImg2 = /** @type {HTMLInputElement} */ (document.getElementById('fileInputImg2'));
  const fileInputRefined = /** @type {HTMLInputElement} */ (document.getElementById('fileInputRefined'));
  const fileInputAutoPair = /** @type {HTMLInputElement} */ (document.getElementById('fileInputAutoPair'));
  const fileInputAutoImg1 = /** @type {HTMLInputElement} */ (document.getElementById('fileInputAutoImg1'));
  const fileInputAutoFace = /** @type {HTMLInputElement} */ (document.getElementById('fileInputAutoFace'));
  const modalAutoSelect = /** @type {HTMLElement} */ (document.getElementById('modalAutoSelect'));
  const toastContainer = /** @type {HTMLElement} */ (document.getElementById('toastContainer'));

  let autoModalState = {
    /** @type {LoadedImage | null} */
    imgComplete: null,
    /** @type {LoadedImage | null} */
    imgFace: null,
  };

  const viewport = new ViewportClass(mainCanvas, {
    onSelectionComplete: handleSelectionComplete,
    onRegionClick: handleViewportRegionClick,
    onTransformChange: handleViewportTransformChange,
    onZoomChange: (z) => {
      zoomReadout.textContent = `${Math.round(z * 100)}%`;
    },
    onCompareChange: (r) => {
      state.compareRatio = r;
    },
  });

  // ===========================================================================
  // Toast Notifications
  // ===========================================================================
  function showToast(msg, isError = false) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 3100);
  }

  // ===========================================================================
  // Reactive Pipeline Recomputation
  // ===========================================================================

  /**
   * Recomputes faceMask1, EDT fields, and isolated pieces of imagem1.
   */
  function recomputeStep1Outputs(recomputeEDT = true) {
    if (!state.img1Canvas || !state.rawMask1) {
      state.faceMask1 = null;
      state.edtFace1OutSq = null;
      state.edtFace1InSq = null;
      state.corpo1Canvas = null;
      state.face1Canvas = null;
      state.mask1OverlayCanvas = null;
      recomputeStep2Outputs();
      return;
    }

    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;
    const n = W * H;
    const faceMask = new Uint8Array(n);
    const targetVal = state.faceIsOne1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      faceMask[i] = state.rawMask1[i] === targetVal ? 1 : 0;
    }
    state.faceMask1 = faceMask;

    if (recomputeEDT) {
      state.edtFace1OutSq = Geo.computeEDT2DSq(faceMask, 1, W, H);
      state.edtFace1InSq = Geo.computeEDT2DSq(faceMask, 0, W, H);
    }

    state.face1Canvas = Ops.isolateByMask(state.img1Canvas, faceMask, 1);
    state.corpo1Canvas = Ops.isolateByMask(state.img1Canvas, faceMask, 0);
    state.mask1OverlayCanvas = Ops.createMaskOverlayCanvas(faceMask, W, H, {
      tintOne: [56, 189, 248, 46],
      tintZero: [245, 158, 11, 28],
      borderColor: [56, 189, 248, 250],
      borderThickness: 2,
    });

    state.faceCentroid1 = Geo.computeMaskCentroid(faceMask, 1, W, H);
    state.bodyCentroid1 = Geo.computeMaskCentroid(faceMask, 0, W, H);

    recomputeStep2Outputs();
  }

  /**
   * Recomputes normalized/padded imagem2 and its isolated Face using the SAME selection & role from imagem1.
   */
  function recomputeStep2Outputs() {
    if (!state.img1Canvas || !state.img2) {
      state.img2AlignedCanvas = null;
      state.img2Placement = null;
      state.face2Canvas = null;
      recomputeStep3Outputs(true);
      return;
    }

    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;
    const fullBox = { x: 0, y: 0, w: W, h: H };

    const { canvas, placement } = Ops.renderFittedWithPadding(
      state.img2,
      fullBox,
      W,
      H,
      state.img2Transform
    );
    state.img2AlignedCanvas = canvas;
    state.img2Placement = placement;

    if (state.faceMask1) {
      state.face2Canvas = Ops.isolateByMask(canvas, state.faceMask1, 1);
    } else {
      state.face2Canvas = null;
    }

    recomputeStep3Outputs(true);
  }

  /**
   * Recomputes imagemMerge and splits it into:
   * - (face + bordas imprecisas)
   * - (corpo sem bordas imprecisas)
   *
   * @param {boolean} [rebuildMergeBase=true]
   */
  function recomputeStep3Outputs(rebuildMergeBase = true) {
    if (!state.img1Canvas || !state.corpo1Canvas || !state.face2Canvas || !state.faceMask1) {
      state.imgMergeCanvas = null;
      state.mergeFaceMask = null;
      state.edtMergeInsideSq = null;
      state.mergeFaceBox = null;
      state.faceImprecisaCanvas = null;
      state.corpoSemBordasCanvas = null;
      state.mergeOverlayCanvas = null;
      recomputeStep4Outputs();
      return;
    }

    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;

    if (rebuildMergeBase || !state.imgMergeCanvas) {
      state.imgMergeCanvas = Ops.uniteByComplementaryMask(
        state.face2Canvas,
        state.corpo1Canvas,
        state.faceMask1
      );
    }

    /** @type {Uint8Array | null} */
    let mMask = null;

    if (state.mergeRegionMode === 'expand') {
      if (state.edtFace1OutSq) {
        mMask = Geo.dilateMaskWithEDT(
          state.faceMask1,
          state.edtFace1OutSq,
          state.edtFace1InSq,
          state.expandPx
        );
      }
    } else if (state.mergeRegionMode === 'custom') {
      if (state.customRawMask2) {
        const n = W * H;
        const baseCustom = new Uint8Array(n);
        const want = state.customFaceIsOne2 ? 1 : 0;
        for (let i = 0; i < n; i++) {
          baseCustom[i] = state.customRawMask2[i] === want ? 1 : 0;
        }
        if (state.customExtraExpandPx !== 0 && state.edtCustomOutSq) {
          mMask = Geo.dilateMaskWithEDT(
            baseCustom,
            state.edtCustomOutSq,
            state.edtCustomInSq,
            state.customExtraExpandPx
          );
        } else {
          mMask = baseCustom;
        }
      } else if (state.edtFace1OutSq) {
        // Fallback before custom stroke is drawn: show unexpanded faceMask1
        mMask = new Uint8Array(state.faceMask1);
      }
    }

    state.mergeFaceMask = mMask;

    if (!mMask) {
      state.faceImprecisaCanvas = null;
      state.corpoSemBordasCanvas = null;
      state.mergeOverlayCanvas = null;
      state.mergeFaceBox = null;
      state.edtMergeInsideSq = null;
      recomputeStep4Outputs();
      return;
    }

    state.mergeFaceBox = Geo.computeMaskBoundingBox(mMask, W, H, 0);
    state.faceImprecisaCanvas = Ops.isolateByMask(state.imgMergeCanvas, mMask, 1);
    state.corpoSemBordasCanvas = Ops.isolateByMask(state.imgMergeCanvas, mMask, 0);

    state.mergeOverlayCanvas = Ops.createMaskOverlayCanvas(mMask, W, H, {
      tintOne: [167, 139, 250, 46],   // Violet tint for Face + Imprecise Borders
      tintZero: [16, 185, 129, 24],   // Emerald tint for Clean Body
      borderColor: [167, 139, 250, 250],
      borderThickness: 2,
    });

    state.mergeFaceCentroid = Geo.computeMaskCentroid(mMask, 1, W, H);
    state.mergeBodyCentroid = Geo.computeMaskCentroid(mMask, 0, W, H);

    // Invalidate cached inside-EDT so Step 5 & Step 6 recompute it cleanly on demand
    state.edtMergeInsideSq = null;

    recomputeStep4Outputs();
  }

  /**
   * Recomputes aligned AI-refined face image and isolates (face + bordas precisas).
   */
  function recomputeStep4Outputs() {
    if (!state.img1Canvas || !state.mergeFaceMask || !state.imgRefined) {
      state.refinedAlignedCanvas = null;
      state.refinedPlacement = null;
      state.facePrecisaCanvas = null;
      recomputeStep5Outputs();
      return;
    }

    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;
    const targetBox =
      state.refinedTargetMode === 'cropbox' && state.mergeFaceBox
        ? state.mergeFaceBox
        : { x: 0, y: 0, w: W, h: H };

    const { canvas, placement } = Ops.renderFittedWithPadding(
      state.imgRefined,
      targetBox,
      W,
      H,
      state.refinedTransform
    );
    state.refinedAlignedCanvas = canvas;
    state.refinedPlacement = placement;
    state.facePrecisaCanvas = Ops.isolateByMask(canvas, state.mergeFaceMask, 1);

    recomputeStep5Outputs();
  }

  /**
   * Recomputes imagemFinal = (face + bordas precisas) + (corpo sem bordas imprecisas)
   * with the selected seam & skin-tone merge technique.
   */
  function recomputeStep5Outputs() {
    if (
      !state.facePrecisaCanvas ||
      !state.corpoSemBordasCanvas ||
      !state.mergeFaceMask ||
      !state.img1Canvas
    ) {
      state.imgFinalUnblendedCanvas = null;
      state.imgFinalCanvas = null;
      recomputeStep6Outputs();
      return;
    }

    state.imgFinalUnblendedCanvas = Ops.uniteByComplementaryMask(
      state.facePrecisaCanvas,
      state.corpoSemBordasCanvas,
      state.mergeFaceMask
    );

    const fm = state.finalMerge;
    const needsAdvanced = fm.mode !== 'none' || fm.colorMatchStrength > 0.001;

    if (!needsAdvanced) {
      state.imgFinalCanvas = state.imgFinalUnblendedCanvas;
      recomputeStep6Outputs();
      return;
    }

    if (!state.edtMergeInsideSq) {
      state.edtMergeInsideSq = Geo.computeEDT2DSq(
        state.mergeFaceMask,
        0,
        state.img1Canvas.width,
        state.img1Canvas.height
      );
    }

    state.imgFinalCanvas = Seam.mergeFinalAdvanced({
      facePreciseCanvas: state.facePrecisaCanvas,
      corpoSemBordasCanvas: state.corpoSemBordasCanvas,
      origFullCanvas: state.img1Canvas,
      mergeFaceMask: state.mergeFaceMask,
      origFaceMask1: state.faceMask1,
      edtToOutsideSq: state.edtMergeInsideSq,
      edtInsideOrigFaceSq: state.edtFace1InSq,
      mergeBox: state.mergeFaceBox,
      options: fm,
    });

    recomputeStep6Outputs();
  }

  /**
   * Recomputes Stage 6 Post-Processing Skin Color Matching after imagemFinal.
   */
  function recomputeStep6Outputs() {
    if (!state.imgFinalCanvas || !state.img1Canvas || !state.mergeFaceMask) {
      state.imgPostCanvas = null;
      state.skinMaskPreviewCanvas = null;
      state.skinDiagnostics = null;
      return;
    }

    if (!state.edtMergeInsideSq) {
      state.edtMergeInsideSq = Geo.computeEDT2DSq(
        state.mergeFaceMask,
        0,
        state.img1Canvas.width,
        state.img1Canvas.height
      );
    }

    const res = SkinPost.applySkinPostProcess({
      inputFinalCanvas: state.imgFinalCanvas,
      origImg1Canvas: state.img1Canvas,
      mergeFaceMask: state.mergeFaceMask,
      origFaceMask1: state.faceMask1,
      edtToOutsideSq: state.edtMergeInsideSq,
      faceSamples: state.skinSamplesFace,
      bodySamples: state.skinSamplesBody,
      options: state.skinPost,
    });

    state.imgPostCanvas = res.canvas;
    state.skinMaskPreviewCanvas = res.maskPreviewCanvas;
    state.skinDiagnostics = res.diagnostics;
  }

  /**
   * Handles eyedropper clicks on canvas in Stage 6 (sample-face / sample-body).
   * @param {Point} pt
   */
  function handleViewportRegionClick(pt) {
    if (state.activeStep !== 6 || !state.imgFinalCanvas) return;
    const rounded = { x: Math.round(pt.x), y: Math.round(pt.y) };

    if (state.step6Tool === 'sample-face') {
      state.skinSamplesFace.push(rounded);
      if (state.skinSamplesFace.length > 6) state.skinSamplesFace.shift();
      recomputeStep6Outputs();
      syncAllUI();
      showToast(`Amostra da pele da Face F${state.skinSamplesFace.length} registrada!`);
    } else if (state.step6Tool === 'sample-body') {
      state.skinSamplesBody.push(rounded);
      if (state.skinSamplesBody.length > 6) state.skinSamplesBody.shift();
      recomputeStep6Outputs();
      syncAllUI();
      showToast(`Amostra da pele do Corpo C${state.skinSamplesBody.length} registrada!`);
    }
  }

  // ===========================================================================
  // Selection & Transform Event Handlers
  // ===========================================================================

  /**
   * @param {SelectionShape} sel
   */
  function handleSelectionComplete(sel) {
    if (!state.img1Canvas) return;
    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;

    if (state.activeStep === 1) {
      state.selection1 = sel;
      state.rawMask1 = Geo.rasterizePolygonMask(sel.polygon, W, H);
      // If first time cutting, pick smart default for Face vs Corpo;
      // user can invert anytime and it stays fixed across imagem1 & imagem2!
      state.faceIsOne1 = Geo.guessFaceIsOne(state.rawMask1, W, H);
      state.step1View = 'split';
      recomputeStep1Outputs(true);
      syncAllUI();
      showToast(
        sel.type === 'border-cut'
          ? 'Corte de 2 bordas concluído! Verifique Corpo e Face.'
          : 'Laço fechado concluído! Verifique Corpo e Face.'
      );
    } else if (state.activeStep === 3 && state.mergeRegionMode === 'custom') {
      state.customSelection2 = sel;
      state.customRawMask2 = Geo.rasterizePolygonMask(sel.polygon, W, H);
      state.customFaceIsOne2 = state.faceMask1
        ? Geo.matchMaskSideToReference(state.customRawMask2, state.faceMask1)
        : Geo.guessFaceIsOne(state.customRawMask2, W, H);
      // Precompute EDT on normalized custom mask in case user tweaks extra expansion
      const normCustom = new Uint8Array(W * H);
      const want = state.customFaceIsOne2 ? 1 : 0;
      for (let i = 0; i < normCustom.length; i++) {
        normCustom[i] = state.customRawMask2[i] === want ? 1 : 0;
      }
      state.edtCustomOutSq = Geo.computeEDT2DSq(normCustom, 1, W, H);
      state.edtCustomInSq = Geo.computeEDT2DSq(normCustom, 0, W, H);

      state.step3View = 'split';
      recomputeStep3Outputs(false);
      syncAllUI();
      showToast('Nova seleção de (face + bordas imprecisas) aplicada!');
    }
  }

  function handleViewportTransformChange(tx, ty, scale, rotation, isDragging) {
    if (typeof rotation === 'boolean' && isDragging === undefined) {
      isDragging = rotation;
      rotation = undefined;
    }
    if (state.activeStep === 2 && state.img2) {
      const rot = Number.isFinite(rotation) ? rotation : state.img2Transform.rotation || 0;
      state.img2Transform = {
        x: Math.round(tx * 10) / 10,
        y: Math.round(ty * 10) / 10,
        scale,
        rotation: rot,
      };
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      if (!isDragging) updateSidebarThumbnails();
    } else if (state.activeStep === 4 && state.imgRefined) {
      state.refinedTransform = { x: Math.round(tx * 10) / 10, y: Math.round(ty * 10) / 10, scale };
      recomputeStep4Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      if (!isDragging) updateSidebarThumbnails();
    }
  }

  function flipCorpoAndFaceRole() {
    if (!state.rawMask1) return;
    state.faceIsOne1 = !state.faceIsOne1;
    recomputeStep1Outputs(true);
    syncAllUI();
    showToast('Papéis Corpo ↔ Face invertidos (mantido fixo na imagem1 e imagem2).');
  }

  function flipCustomMergeRole() {
    if (!state.customRawMask2 || !state.img1Canvas) return;
    state.customFaceIsOne2 = !state.customFaceIsOne2;
    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;
    const normCustom = new Uint8Array(W * H);
    const want = state.customFaceIsOne2 ? 1 : 0;
    for (let i = 0; i < normCustom.length; i++) {
      normCustom[i] = state.customRawMask2[i] === want ? 1 : 0;
    }
    state.edtCustomOutSq = Geo.computeEDT2DSq(normCustom, 1, W, H);
    state.edtCustomInSq = Geo.computeEDT2DSq(normCustom, 0, W, H);
    recomputeStep3Outputs(false);
    syncAllUI();
  }

  // ===========================================================================
  // Importing Images (Upload, Drag & Drop, Ctrl+V Paste)
  // ===========================================================================

  /**
   * @param {LoadedImage} loaded
   * @param {1 | 2 | 4} targetSlot
   */
  function applyLoadedImage(loaded, targetSlot) {
    if (targetSlot === 1) {
      const dimChanged =
        !state.img1 || state.img1.width !== loaded.width || state.img1.height !== loaded.height;
      state.img1 = loaded;
      state.img1Canvas = Ops.sourceToCanvas(loaded.img);
      if (dimChanged) {
        state.selection1 = null;
        state.rawMask1 = null;
        state.customSelection2 = null;
        state.customRawMask2 = null;
      }
      viewport.setDocumentSize(loaded.width, loaded.height, true);
      recomputeStep1Outputs(true);
      state.activeStep = 1;
      syncAllUI();
      showToast(`imagem1 carregada (${loaded.width} × ${loaded.height} px).`);
    } else if (targetSlot === 2) {
      if (!state.img1Canvas) {
        showToast('Importe primeiro a imagem1 na Etapa 1 para definir a proporção base.', true);
        state.activeStep = 1;
        syncAllUI();
        return;
      }
      state.img2 = loaded;
      state.img2Transform = { x: 0, y: 0, scale: 1, rotation: 0 };
      state.step2View = 'align';
      recomputeStep2Outputs();
      state.activeStep = 2;
      syncAllUI();

      const sameRatio =
        Math.abs(loaded.width / loaded.height - state.img1Canvas.width / state.img1Canvas.height) <
        0.004;
      showToast(
        sameRatio
          ? `imagem2 carregada (${loaded.width} × ${loaded.height} px) — mesma proporção!`
          : `imagem2 carregada (${loaded.width} × ${loaded.height} px) — centralizada com padding transparente!`
      );
    } else if (targetSlot === 4) {
      if (!state.imgMergeCanvas || !state.mergeFaceMask) {
        showToast('Conclua até a imagemMerge (Etapa 3) antes de importar a face refinada.', true);
        return;
      }
      state.imgRefined = loaded;
      state.refinedTransform = { x: 0, y: 0, scale: 1 };

      // Smart target mode: if user exported cropped box OR image aspect closely matches crop box, snap to cropbox!
      if (state.exportCroppedMode && state.mergeFaceBox) {
        state.refinedTargetMode = 'cropbox';
      } else if (state.mergeFaceBox && state.img1Canvas) {
        const fullRatio = state.img1Canvas.width / state.img1Canvas.height;
        const boxRatio = state.mergeFaceBox.w / state.mergeFaceBox.h;
        const imgRatio = loaded.width / loaded.height;
        if (
          Math.abs(imgRatio - boxRatio) < 0.03 &&
          Math.abs(imgRatio - fullRatio) > 0.08 &&
          loaded.width <= state.mergeFaceBox.w * 1.6
        ) {
          state.refinedTargetMode = 'cropbox';
        } else {
          state.refinedTargetMode = 'full';
        }
      } else {
        state.refinedTargetMode = 'full';
      }

      state.step4View = 'align';
      recomputeStep4Outputs();
      state.activeStep = 4;
      syncAllUI();
      showToast('Resultado da IA (face + bordas precisas) importado!');
    }
  }

  /**
   * Determines which image slot receives a Ctrl+V paste or canvas drop based on activeStep.
   * @returns {1 | 2 | 4}
   */
  function currentImportSlot() {
    if (!state.img1) return 1;
    if (state.activeStep === 1) return 1;
    if (state.activeStep === 2) return 2;
    if (state.activeStep === 3) return state.img2 ? 4 : 2;
    return 4;
  }

  // File input listeners
  fileInputImg1.addEventListener('change', async () => {
    const f = fileInputImg1.files && fileInputImg1.files[0];
    fileInputImg1.value = '';
    if (!f) return;
    try {
      const loaded = await Ops.loadImageFromBlob(f, f.name);
      applyLoadedImage(loaded, 1);
    } catch (err) {
      showToast(err.message || 'Erro ao abrir imagem1.', true);
    }
  });

  fileInputImg2.addEventListener('change', async () => {
    const f = fileInputImg2.files && fileInputImg2.files[0];
    fileInputImg2.value = '';
    if (!f) return;
    try {
      const loaded = await Ops.loadImageFromBlob(f, f.name);
      applyLoadedImage(loaded, 2);
    } catch (err) {
      showToast(err.message || 'Erro ao abrir imagem2.', true);
    }
  });

  fileInputRefined.addEventListener('change', async () => {
    const f = fileInputRefined.files && fileInputRefined.files[0];
    fileInputRefined.value = '';
    if (!f) return;
    try {
      const loaded = await Ops.loadImageFromBlob(f, f.name);
      applyLoadedImage(loaded, 4);
    } catch (err) {
      showToast(err.message || 'Erro ao abrir imagem refinada.', true);
    }
  });

  // Global Ctrl+V Paste listener
  window.addEventListener('paste', async (e) => {
    try {
      const loaded = await Ops.extractImageFromPasteEvent(e);
      if (loaded) {
        e.preventDefault();
        applyLoadedImage(loaded, currentImportSlot());
      }
    } catch (err) {
      showToast(err.message || 'Falha ao colar imagem.', true);
    }
  });

  // Drag & drop onto canvas wrapper
  canvasDropWrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    canvasDropWrap.classList.add('drag-over');
  });
  canvasDropWrap.addEventListener('dragleave', () => {
    canvasDropWrap.classList.remove('drag-over');
  });
  canvasDropWrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    canvasDropWrap.classList.remove('drag-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !f.type.startsWith('image/')) return;
    try {
      const loaded = await Ops.loadImageFromBlob(f, f.name);
      applyLoadedImage(loaded, currentImportSlot());
    } catch (err) {
      showToast(err.message || 'Falha ao soltar imagem.', true);
    }
  });

  // ===========================================================================
  // Sync Viewport Scene & Stage Toolbar
  // ===========================================================================

  function syncViewportScene() {
    const rs = viewport.renderState;
    rs.onionCanvas = null;
    rs.onionOpacity = 0;
    rs.maskOverlayCanvas = null;
    rs.showMaskOverlay = state.showGuides;
    rs.guideCutPath = null;
    rs.guideIsLasso = false;
    rs.badges = [];
    rs.samplePins = [];
    rs.alignBox = null;
    rs.targetSubBox = null;
    rs.compareBeforeCanvas = null;

    if (!state.img1Canvas) {
      viewport.mode = 'cut';
      rs.primaryCanvas = null;
      rs.emptyHintTitle = 'Importe ou cole a imagem1 (Ctrl+V)';
      rs.emptyHintSub = 'Arraste um arquivo para cá, clique em Escolher Arquivo ou pressione Ctrl+V';
      viewport.requestRender();
      return;
    }

    const W = state.img1Canvas.width;
    const H = state.img1Canvas.height;
    if (viewport.docW !== W || viewport.docH !== H) {
      viewport.setDocumentSize(W, H, true);
    }

    if (state.activeStep === 1) {
      viewport.mode = state.step1Tool === 'pan' ? 'pan' : 'cut';
      if (state.step1View === 'body' && state.corpo1Canvas) {
        rs.primaryCanvas = state.corpo1Canvas;
      } else if (state.step1View === 'face' && state.face1Canvas) {
        rs.primaryCanvas = state.face1Canvas;
      } else {
        rs.primaryCanvas = state.img1Canvas;
        rs.maskOverlayCanvas = state.mask1OverlayCanvas;
      }

      if (state.showGuides && state.faceMask1 && state.step1View === 'split') {
        if (state.faceCentroid1.count > 0) {
          rs.badges.push({
            x: state.faceCentroid1.x,
            y: state.faceCentroid1.y,
            text: 'FACE (fixo img1/img2)',
            color: '#38bdf8',
          });
        }
        if (state.bodyCentroid1.count > 0) {
          rs.badges.push({
            x: state.bodyCentroid1.x,
            y: state.bodyCentroid1.y,
            text: 'CORPO (fixo img1/img2)',
            color: '#f59e0b',
          });
        }
      }
      stageHintText.textContent =
        'Etapa 1: Segure o mouse para cortar tocando 2 bordas (pode vir de fora da imagem) ou fechar um laço.';
    } else if (state.activeStep === 2) {
      if (!state.img2 || !state.img2AlignedCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = null;
        rs.emptyHintTitle = 'Aguardando imagem2 (gerada com IA + referências)';
        rs.emptyHintSub = 'Importe ou cole (Ctrl+V) a imagem2 — o padding transparente será aplicado automaticamente';
      } else if (state.step2View === 'face' && state.face2Canvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = state.face2Canvas;
        if (state.showGuides && state.selection1) {
          rs.guideCutPath = state.selection1.cutPath;
          rs.guideIsLasso = state.selection1.type === 'lasso';
        }
      } else if (state.step2View === 'split') {
        viewport.mode = 'view';
        rs.primaryCanvas = state.img2AlignedCanvas;
        rs.maskOverlayCanvas = state.mask1OverlayCanvas;
        if (state.showGuides && state.faceMask1) {
          rs.badges.push(
            { x: state.faceCentroid1.x, y: state.faceCentroid1.y, text: 'FACE (isolar da imagem2)', color: '#38bdf8' },
            { x: state.bodyCentroid1.x, y: state.bodyCentroid1.y, text: 'CORPO (descartado na imagem2)', color: '#64748b' }
          );
        }
      } else {
        // Align mode!
        viewport.mode = 'align';
        viewport.alignBaseTransform = { ...state.img2Transform };
        if (state.flickerActive) {
          // Flicker mode: displays pure imagem1 for instant A/B brain perception
          rs.primaryCanvas = state.img1Canvas;
          rs.onionCanvas = null;
          rs.onionOpacity = 0;
          rs.alignBox = null;
        } else {
          rs.primaryCanvas = state.img2AlignedCanvas;
          rs.onionCanvas = state.img1Canvas;
          rs.onionOpacity = state.img2OnionOpacity;
          rs.alignBox = state.img2Placement;
          rs.showAnatomicGuides = state.showAnatomicGuides;
          rs.faceCenter = state.faceCentroid1;
          rs.estimatedHeadWidth = state.faceCentroid1 && state.faceCentroid1.count > 100
            ? Math.sqrt(state.faceCentroid1.count) * 1.15
            : null;
        }
        if (state.showGuides && state.selection1) {
          rs.guideCutPath = state.selection1.cutPath;
          rs.guideIsLasso = state.selection1.type === 'lasso';
        }
      }
      stageHintText.textContent =
        'Etapa 2: Arraste para mover • Alça azul no topo gira • Cantos escalam • Segure F para piscar A/B.';
    } else if (state.activeStep === 3) {
      if (!state.imgMergeCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = null;
        rs.emptyHintTitle = 'Conclua o corte na imagem1 e importe a imagem2';
        rs.emptyHintSub = 'A imagemMerge unirá automaticamente o Corpo (imagem1) + Face (imagem2)';
      } else {
        viewport.mode =
          state.mergeRegionMode === 'custom' && state.step3Tool === 'cut' ? 'cut' : 'pan';

        if (state.step3View === 'face-imp' && state.faceImprecisaCanvas) {
          rs.primaryCanvas = state.faceImprecisaCanvas;
        } else if (state.step3View === 'body-clean' && state.corpoSemBordasCanvas) {
          rs.primaryCanvas = state.corpoSemBordasCanvas;
        } else {
          rs.primaryCanvas = state.imgMergeCanvas;
          rs.maskOverlayCanvas = state.mergeOverlayCanvas;
        }

        if (state.showGuides) {
          // Always show original seam in dashed pink so user sees the "bordas imprecisas" inside the expanded zone!
          if (state.selection1) {
            rs.guideCutPath = state.selection1.cutPath;
            rs.guideIsLasso = state.selection1.type === 'lasso';
          }
          if (state.exportCroppedMode && state.mergeFaceBox) {
            rs.targetSubBox = state.mergeFaceBox;
          }
          if (state.step3View === 'split' && state.mergeFaceMask) {
            if (state.mergeFaceCentroid.count > 0) {
              rs.badges.push({
                x: state.mergeFaceCentroid.x,
                y: state.mergeFaceCentroid.y,
                text: 'FACE + BORDAS IMPRECISAS',
                color: '#a78bfa',
              });
            }
            if (state.mergeBodyCentroid.count > 0) {
              rs.badges.push({
                x: state.mergeBodyCentroid.x,
                y: state.mergeBodyCentroid.y,
                text: 'CORPO SEM BORDAS IMPRECISAS',
                color: '#10b981',
              });
            }
          }
        }
      }
      stageHintText.textContent =
        state.mergeRegionMode === 'expand'
          ? 'Etapa 3: Ajuste a expansão automática para cobrir a junção tracejada (bordas imprecisas) ou mude para Novo Corte/Laço.'
          : 'Etapa 3 (Novo Corte/Laço): Segure o mouse para cortar tocando 2 bordas ou fechar um laço ao redor da face + bordas imprecisas.';
    } else if (state.activeStep === 4) {
      if (!state.imgRefined || !state.refinedAlignedCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = state.faceImprecisaCanvas || null;
        if (!rs.primaryCanvas) {
          rs.emptyHintTitle = 'Aguardando (face + bordas precisas) da IA';
          rs.emptyHintSub = 'Copie (face + bordas imprecisas) na Etapa 3, refine na IA e cole (Ctrl+V) aqui';
        } else if (state.showGuides && state.exportCroppedMode && state.mergeFaceBox) {
          rs.targetSubBox = state.mergeFaceBox;
        }
      } else if (state.step4View === 'isolated' && state.facePrecisaCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = state.facePrecisaCanvas;
      } else {
        viewport.mode = 'align';
        viewport.alignBaseTransform = { ...state.refinedTransform };
        rs.primaryCanvas = state.refinedAlignedCanvas;
        rs.onionCanvas = state.imgMergeCanvas;
        rs.onionOpacity = state.refinedOnionOpacity;
        rs.alignBox = state.refinedPlacement;
        rs.maskOverlayCanvas = state.mergeOverlayCanvas;
        if (state.refinedTargetMode === 'cropbox' && state.mergeFaceBox) {
          rs.targetSubBox = state.mergeFaceBox;
        }
      }
      stageHintText.textContent =
        'Etapa 4: Cole (Ctrl+V) o resultado da IA e ajuste posição/escala se necessário para isolar (face + bordas precisas).';
    } else if (state.activeStep === 5) {
      if (!state.imgFinalCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = state.imgMergeCanvas || null;
        rs.emptyHintTitle = 'Importe (face + bordas precisas) na Etapa 4 para gerar a imagemFinal';
        rs.emptyHintSub = '(face + bordas precisas) + (corpo sem bordas imprecisas) = imagemFinal';
      } else if (state.step5View === 'compare-raw' && state.imgFinalUnblendedCanvas) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgFinalCanvas;
        rs.compareBeforeCanvas = state.imgFinalUnblendedCanvas;
        rs.compareLabelBefore = 'Antes: Corte Seco (Sem Suavização)';
        rs.compareLabelAfter = 'Depois: Merge & Tom de Pele';
        rs.compareRatio = state.compareRatio;
      } else if (state.step5View === 'compare-merge' && state.imgMergeCanvas) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgFinalCanvas;
        rs.compareBeforeCanvas = state.imgMergeCanvas;
        rs.compareLabelBefore = 'Antes: imagemMerge';
        rs.compareLabelAfter = 'Depois: imagemFinal';
        rs.compareRatio = state.compareRatio;
      } else if (state.step5View === 'compare-img1' && state.img1Canvas) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgFinalCanvas;
        rs.compareBeforeCanvas = state.img1Canvas;
        rs.compareLabelBefore = 'Antes: imagem1';
        rs.compareLabelAfter = 'Depois: imagemFinal';
        rs.compareRatio = state.compareRatio;
      } else {
        viewport.mode = 'pan';
        rs.primaryCanvas = state.imgFinalCanvas;
      }
      stageHintText.textContent =
        'Etapa 5: Escolha a técnica de merge/pele à direita ou avance para a Etapa 6 (Pós-Processamento de Pele).';
    } else if (state.activeStep === 6) {
      const isSampling =
        state.step6Tool === 'sample-face' || state.step6Tool === 'sample-body';

      if (state.showGuides) {
        state.skinSamplesFace.forEach((pt, idx) => {
          rs.samplePins.push({
            x: pt.x,
            y: pt.y,
            label: `F${idx + 1}`,
            color: '#38bdf8',
          });
        });
        state.skinSamplesBody.forEach((pt, idx) => {
          rs.samplePins.push({
            x: pt.x,
            y: pt.y,
            label: `C${idx + 1}`,
            color: '#f59e0b',
          });
        });
      }

      if (!state.imgPostCanvas || !state.imgFinalCanvas) {
        viewport.mode = 'view';
        rs.primaryCanvas = state.imgMergeCanvas || null;
        rs.emptyHintTitle = 'Conclua até a imagemFinal (Etapa 5) para igualar o tom de pele';
        rs.emptyHintSub =
          'O pós-processamento analisa e iguala cientificamente a pele da Face × Corpo';
      } else if (state.step6View === 'compare-pre' && !isSampling) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgPostCanvas;
        rs.compareBeforeCanvas = state.imgFinalCanvas;
        rs.compareLabelBefore = 'Antes: imagemFinal (Pré-Pós)';
        rs.compareLabelAfter = 'Depois: Tom de Pele Igualado';
        rs.compareRatio = state.compareRatio;
      } else if (
        state.step6View === 'compare-raw' &&
        state.imgFinalUnblendedCanvas &&
        !isSampling
      ) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgPostCanvas;
        rs.compareBeforeCanvas = state.imgFinalUnblendedCanvas;
        rs.compareLabelBefore = 'Antes: Corte Seco (Bruto)';
        rs.compareLabelAfter = 'Depois: Merge + Pós de Pele';
        rs.compareRatio = state.compareRatio;
      } else if (state.step6View === 'compare-img1' && state.img1Canvas && !isSampling) {
        viewport.mode = 'compare';
        rs.primaryCanvas = state.imgPostCanvas;
        rs.compareBeforeCanvas = state.img1Canvas;
        rs.compareLabelBefore = 'Antes: imagem1 (Original)';
        rs.compareLabelAfter = 'Depois: Pós de Pele';
        rs.compareRatio = state.compareRatio;
      } else if (state.step6View === 'skin-mask' && state.skinMaskPreviewCanvas) {
        viewport.mode = isSampling ? 'sample' : 'pan';
        rs.primaryCanvas = state.skinMaskPreviewCanvas;
        if (state.showGuides && state.selection1) {
          rs.guideCutPath = state.selection1.cutPath;
          rs.guideIsLasso = state.selection1.type === 'lasso';
        }
      } else {
        viewport.mode = isSampling ? 'sample' : 'pan';
        rs.primaryCanvas = state.imgPostCanvas;
      }

      if (state.step6Tool === 'sample-face') {
        stageHintText.textContent =
          'Conta-Gotas (Face): Clique em áreas de pele limpa na Face (bochecha, testa, queixo) para calibrar.';
      } else if (state.step6Tool === 'sample-body') {
        stageHintText.textContent =
          'Conta-Gotas (Corpo): Clique em áreas de pele limpa no Corpo/Pescoço/Colo para calibrar o alvo.';
      } else if (state.step6View === 'skin-mask') {
        stageHintText.textContent =
          'Mapa Seletivo de Pele: Ciano = pele da Face | Âmbar = pele do Corpo | Cinza = olhos, lábios, cabelo e roupas protegidos.';
      } else {
        stageHintText.textContent =
          'Etapa 6 (Pós): Iguale o tom de pele entre as 2 versões (Face × Corpo) usando Transporte Ótimo Oklab, Curvas CDF ou Melanina×Hemoglobina.';
      }
    }

    viewport._updateCursor();
    viewport.requestRender();
  }

  // ===========================================================================
  // Stepper & Toolbar Rendering
  // ===========================================================================

  function renderStepper() {
    const steps = [
      { id: 1, label: 'imagem1 • Corpo', done: !!(state.img1 && state.faceMask1) },
      { id: 2, label: 'IA → imagem2 • Face', done: !!(state.img2 && state.face2Canvas) },
      { id: 3, label: 'imagemMerge • Bordas', done: !!(state.imgMergeCanvas && state.faceImprecisaCanvas) },
      { id: 4, label: 'IA → Bordas Precisas', done: !!state.facePrecisaCanvas },
      { id: 5, label: 'imagemFinal', done: !!state.imgFinalCanvas },
      { id: 6, label: 'Pós • Tom de Pele', done: !!(state.imgPostCanvas && state.skinPost.enabled) },
    ];

    stepperNav.innerHTML = '';
    steps.forEach((s, idx) => {
      const btn = document.createElement('button');
      btn.className = `step-btn${state.activeStep === s.id ? ' active' : ''}${s.done ? ' done' : ''}`;
      btn.innerHTML = `<span class="step-num">${s.done && state.activeStep !== s.id ? '✓' : s.id}</span><span>${s.label}</span>`;
      btn.addEventListener('click', () => {
        state.activeStep = s.id;
        syncAllUI();
      });
      stepperNav.appendChild(btn);

      if (idx < steps.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'step-arrow';
        arrow.textContent = '›';
        stepperNav.appendChild(arrow);
      }
    });
  }

  function renderStageToolbar() {
    stageModeToolbar.innerHTML = '';

    /**
     * @param {string} label
     * @param {boolean} active
     * @param {() => void} onClick
     */
    const addPill = (label, active, onClick) => {
      const b = document.createElement('button');
      b.className = `tool-pill${active ? ' active' : ''}`;
      b.textContent = label;
      b.addEventListener('click', onClick);
      stageModeToolbar.appendChild(b);
      return b;
    };

    if (state.activeStep === 1) {
      addPill('✂ Cortar / Laço', state.step1Tool === 'cut', () => {
        state.step1Tool = 'cut';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('✨ Auto Selecionar', false, () => {
        openAutoSelectModal();
      });
      addPill('✋ Mover Vista', state.step1Tool === 'pan', () => {
        state.step1Tool = 'pan';
        syncViewportScene();
        renderStageToolbar();
      });
      if (state.faceMask1) {
        addPill('⇄ Inverter Corpo/Face', false, flipCorpoAndFaceRole);
        addPill('Divisão', state.step1View === 'split', () => {
          state.step1View = 'split';
          syncViewportScene();
          renderStageToolbar();
        });
        addPill('Só Corpo', state.step1View === 'body', () => {
          state.step1View = 'body';
          syncViewportScene();
          renderStageToolbar();
        });
        addPill('Só Face', state.step1View === 'face', () => {
          state.step1View = 'face';
          syncViewportScene();
          renderStageToolbar();
        });
      }
    } else if (state.activeStep === 2) {
      addPill('✥ Ajustar Manual', state.step2View === 'align', () => {
        state.step2View = 'align';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('🎯 Alinhar Olhos (IPD)', false, () => {
        openEyeCalibrateModal();
      });
      addPill('📏 Guias Cranianas', state.showAnatomicGuides, () => {
        state.showAnatomicGuides = !state.showAnatomicGuides;
        syncViewportScene();
        renderStageToolbar();
      });
      const flickPill = addPill('👁️ Piscar A/B (F)', state.flickerActive, () => {
        state.flickerActive = !state.flickerActive;
        syncViewportScene();
        renderStageToolbar();
      });
      flickPill.title = 'Segure para piscar com a imagem original (Atalho: Tecla F)';
      flickPill.addEventListener('mousedown', () => {
        state.flickerActive = true;
        syncViewportScene();
      });
      addPill('↶ -90°', false, () => {
        state.img2Transform.rotation =
          Math.round(((state.img2Transform.rotation || 0) - 90) * 10) / 10;
        recomputeStep2Outputs();
        syncViewportScene();
        updateSidebarLiveValues();
        showToast(`Imagem 2 girada para ${(state.img2Transform.rotation || 0).toFixed(1)}°`);
      });
      addPill('↷ +90°', false, () => {
        state.img2Transform.rotation =
          Math.round(((state.img2Transform.rotation || 0) + 90) * 10) / 10;
        recomputeStep2Outputs();
        syncViewportScene();
        updateSidebarLiveValues();
        showToast(`Imagem 2 girada para ${(state.img2Transform.rotation || 0).toFixed(1)}°`);
      });
      addPill('Divisão c/ Seleção', state.step2View === 'split', () => {
        state.step2View = 'split';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('Só Face Isolada', state.step2View === 'face', () => {
        state.step2View = 'face';
        syncViewportScene();
        renderStageToolbar();
      });
      if (state.faceMask1) {
        addPill('⇄ Inverter Corpo/Face', false, flipCorpoAndFaceRole);
      }
    } else if (state.activeStep === 3) {
      if (state.mergeRegionMode === 'custom') {
        addPill('✂ Desenhar Corte/Laço', state.step3Tool === 'cut', () => {
          state.step3Tool = 'cut';
          syncViewportScene();
          renderStageToolbar();
        });
        addPill('✋ Mover Vista', state.step3Tool === 'pan', () => {
          state.step3Tool = 'pan';
          syncViewportScene();
          renderStageToolbar();
        });
      }
      addPill('União + Seleção', state.step3View === 'split', () => {
        state.step3View = 'split';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('Face + Bordas Imprecisas', state.step3View === 'face-imp', () => {
        state.step3View = 'face-imp';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('Corpo s/ Bordas', state.step3View === 'body-clean', () => {
        state.step3View = 'body-clean';
        syncViewportScene();
        renderStageToolbar();
      });
    } else if (state.activeStep === 4) {
      addPill('✥ Ajustar Posição/Escala', state.step4View === 'align', () => {
        state.step4View = 'align';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('Ver Face + Bordas Precisas', state.step4View === 'isolated', () => {
        state.step4View = 'isolated';
        syncViewportScene();
        renderStageToolbar();
      });
    } else if (state.activeStep === 5) {
      addPill('✨ imagemFinal', state.step5View === 'final', () => {
        state.step5View = 'final';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('↔ vs Corte Seco', state.step5View === 'compare-raw', () => {
        state.step5View = 'compare-raw';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('↔ vs imagemMerge', state.step5View === 'compare-merge', () => {
        state.step5View = 'compare-merge';
        syncViewportScene();
        renderStageToolbar();
      });
      addPill('↔ vs imagem1', state.step5View === 'compare-img1', () => {
        state.step5View = 'compare-img1';
        syncViewportScene();
        renderStageToolbar();
      });
    } else if (state.activeStep === 6) {
      addPill('✨ Pós-Processado', state.step6View === 'post' && state.step6Tool === 'pan', () => {
        state.step6Tool = 'pan';
        state.step6View = 'post';
        syncAllUI();
      });
      addPill('↔ vs Pré-Pós', state.step6View === 'compare-pre' && state.step6Tool === 'pan', () => {
        state.step6Tool = 'pan';
        state.step6View = 'compare-pre';
        syncAllUI();
      });
      addPill('👁 Mapa de Pele', state.step6View === 'skin-mask', () => {
        state.step6View = 'skin-mask';
        syncAllUI();
      });
      addPill('🎯 Amostrar Face', state.step6Tool === 'sample-face', () => {
        state.step6Tool = state.step6Tool === 'sample-face' ? 'pan' : 'sample-face';
        if (state.step6Tool !== 'pan' && state.step6View.startsWith('compare')) {
          state.step6View = 'post';
        }
        syncAllUI();
      });
      addPill('🎯 Amostrar Corpo', state.step6Tool === 'sample-body', () => {
        state.step6Tool = state.step6Tool === 'sample-body' ? 'pan' : 'sample-body';
        if (state.step6Tool !== 'pan' && state.step6View.startsWith('compare')) {
          state.step6View = 'post';
        }
        syncAllUI();
      });
      if (state.skinSamplesFace.length > 0 || state.skinSamplesBody.length > 0) {
        addPill('↺ Limpar Amostras', false, () => {
          state.skinSamplesFace = [];
          state.skinSamplesBody = [];
          state.step6Tool = 'pan';
          recomputeStep6Outputs();
          syncAllUI();
          showToast('Amostragem restaurada para detecção automática de pele.');
        });
      }
    }

    btnToggleOverlay.classList.toggle('active', state.showGuides);
  }

  // ===========================================================================
  // Right Sidebar Inspector Rendering
  // ===========================================================================

  /**
   * Renders a thumbnail preview canvas inside a container element.
   * @param {HTMLElement | null} wrap
   * @param {HTMLCanvasElement | null} sourceCanvas
   */
  function mountThumb(wrap, sourceCanvas) {
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!sourceCanvas) {
      const span = document.createElement('span');
      span.style.color = '#64748b';
      span.style.fontSize = '11px';
      span.textContent = 'Pendente';
      wrap.appendChild(span);
      return;
    }
    const maxW = 320;
    const maxH = 150;
    const s = Math.min(1, maxW / sourceCanvas.width, maxH / sourceCanvas.height);
    const tc = Ops.createCanvas(
      Math.max(1, Math.round(sourceCanvas.width * s)),
      Math.max(1, Math.round(sourceCanvas.height * s))
    );
    const ctx = tc.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sourceCanvas, 0, 0, tc.width, tc.height);
    }
    wrap.appendChild(tc);
  }

  /**
   * Helper to get the canvas to export for (face + bordas imprecisas) honoring full vs cropped mode.
   */
  function getFaceImprecisaExportCanvas() {
    if (!state.faceImprecisaCanvas) return null;
    if (state.exportCroppedMode && state.mergeFaceBox) {
      return Ops.cropCanvas(state.faceImprecisaCanvas, state.mergeFaceBox);
    }
    return state.faceImprecisaCanvas;
  }

  function renderSidebar() {
    sidebarContent.innerHTML = '';

    if (state.activeStep === 1) {
      renderSidebarStep1();
    } else if (state.activeStep === 2) {
      renderSidebarStep2();
    } else if (state.activeStep === 3) {
      renderSidebarStep3();
    } else if (state.activeStep === 4) {
      renderSidebarStep4();
    } else if (state.activeStep === 5) {
      renderSidebarStep5();
    } else if (state.activeStep === 6) {
      renderSidebarStep6();
    }

    updateSidebarThumbnails();
    updateSidebarLiveValues();
  }

  function renderSidebarStep1() {
    const dimBadge = state.img1
      ? `<span class="badge cyan">${state.img1.width} × ${state.img1.height} px</span>`
      : `<span class="badge">Não carregada</span>`;

    const selBadge = state.selection1
      ? `<span class="badge emerald">${
          state.selection1.type === 'border-cut'
            ? 'Corte 2 Bordas'
            : state.selection1.type === 'auto-face'
            ? 'Auto (Rosto Pronto)'
            : 'Laço'
        }</span>`
      : `<span class="badge amber">Desenhe ou Auto</span>`;

    sidebarContent.innerHTML = `
      <div class="panel-card highlight-cyan">
        <div class="card-header">
          <div class="card-title">1. imagem1 — Cortar e Isolar Corpo</div>
          ${dimBadge}
        </div>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" style="flex:1" id="sbImportImg1">📂 Escolher imagem1</button>
          <button class="btn btn-sm" style="flex:1" id="sbPasteImg1">📋 Colar (Ctrl+V)</button>
        </div>
        <div class="btn-row" style="margin-top:2px">
          <button class="btn btn-prompt" style="flex:1" id="btnPromptOrigHair" title="Copiar prompt: estrita preservação do cabelo original na IA">
            📋 prompt; cabelo original
          </button>
          <button class="btn btn-prompt" style="flex:1" id="btnPromptRefHair" title="Copiar prompt: substituir cabelo pela referência na IA">
            📋 prompt; cabelo referencia
          </button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Seleção &amp; Papel Fixo</div>
          ${selBadge}
        </div>
        <div class="btn-row">
          <button class="btn btn-cyan btn-sm" style="flex:1.4;font-weight:700" id="btnAutoSelectFace" title="Auto selecionar caso já possua imagem completa e rosto já isolado (complemento vira corpo)">
            ✨ Auto Selecionar
          </button>
          <button class="btn btn-amber btn-sm" style="flex:1" id="sbFlipRole1" ${!state.faceMask1 ? 'disabled' : ''}>
            ⇄ Inverter
          </button>
          <button class="btn btn-ghost btn-sm" id="sbClearCut1" ${!state.faceMask1 ? 'disabled' : ''}>
            Limpar
          </button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Peças da imagem1</div>
          <button class="btn btn-xs btn-ghost" id="copyOrigImg1" ${!state.img1Canvas ? 'disabled' : ''}>📋 Copiar img1</button>
        </div>
        <div class="piece-grid">
          <div class="piece-card featured">
            <div class="piece-title"><span>Corpo Isolado</span><span class="badge amber">Corpo</span></div>
            <div class="piece-thumb-wrap" id="thumbCorpo1"></div>
            <div class="piece-actions">
              <button class="btn" id="copyCorpo1" ${!state.corpo1Canvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlCorpo1" ${!state.corpo1Canvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
          <div class="piece-card">
            <div class="piece-title"><span>Face Isolada</span><span class="badge cyan">Face</span></div>
            <div class="piece-thumb-wrap" id="thumbFace1"></div>
            <div class="piece-actions">
              <button class="btn" id="copyFace1" ${!state.face1Canvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlFace1" ${!state.face1Canvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="sbNextTo2" ${!state.img1Canvas ? 'disabled' : ''}>
        Avançar para Etapa 2 (imagem2) →
      </button>
    `;

    document.getElementById('sbImportImg1')?.addEventListener('click', () => fileInputImg1.click());
    document.getElementById('sbPasteImg1')?.addEventListener('click', () => triggerClipboardPaste(1));
    document.getElementById('btnAutoSelectFace')?.addEventListener('click', openAutoSelectModal);
    document.getElementById('sbFlipRole1')?.addEventListener('click', flipCorpoAndFaceRole);
    document.getElementById('sbClearCut1')?.addEventListener('click', () => {
      state.selection1 = null;
      state.rawMask1 = null;
      recomputeStep1Outputs(true);
      syncAllUI();
    });

    document.getElementById('btnPromptOrigHair')?.addEventListener('click', async () => {
      try {
        const txt = (Prompts && Prompts.originalHair) || '';
        await navigator.clipboard.writeText(txt);
        showToast('prompt; cabelo original copiado para a área de transferência!');
      } catch (err) {
        showToast('Falha ao copiar prompt: ' + err.message, true);
      }
    });

    document.getElementById('btnPromptRefHair')?.addEventListener('click', async () => {
      try {
        const txt = (Prompts && Prompts.referenceHair) || '';
        await navigator.clipboard.writeText(txt);
        showToast('prompt; cabelo referencia copiado para a área de transferência!');
      } catch (err) {
        showToast('Falha ao copiar prompt: ' + err.message, true);
      }
    });

    bindCopyDownload('copyCorpo1', 'dlCorpo1', () => state.corpo1Canvas, 'imagem1_corpo_isolado.png');
    bindCopyDownload('copyFace1', 'dlFace1', () => state.face1Canvas, 'imagem1_face_isolada.png');
    document.getElementById('copyOrigImg1')?.addEventListener('click', () => {
      if (state.img1Canvas) copyWithToast(state.img1Canvas, 'imagem1 copiada!');
    });
    document.getElementById('sbNextTo2')?.addEventListener('click', () => {
      if (!state.faceMask1) {
        showToast('Dica: desenhe o corte na imagem1 agora ou volte depois — ela sincroniza automaticamente!');
      }
      state.activeStep = 2;
      syncAllUI();
    });
  }

  function renderSidebarStep2() {
    const w1 = state.img1Canvas ? state.img1Canvas.width : 0;
    const h1 = state.img1Canvas ? state.img1Canvas.height : 0;
    const hasDiffRatio =
      state.img2 && w1 > 0
        ? Math.abs(state.img2.width / state.img2.height - w1 / h1) >= 0.004
        : false;

    const img2Badge = state.img2
      ? `<span class="badge ${hasDiffRatio ? 'amber' : 'emerald'}">${state.img2.width}×${state.img2.height}</span>`
      : `<span class="badge">Pendente</span>`;

    sidebarContent.innerHTML = `
      <div class="panel-card highlight-cyan">
        <div class="card-header">
          <div class="card-title">2. imagem2 — Padding &amp; Face</div>
          ${img2Badge}
        </div>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" style="flex:1" id="sbImportImg2">📂 Escolher imagem2</button>
          <button class="btn btn-sm" style="flex:1" id="sbPasteImg2">📋 Colar (Ctrl+V)</button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Ajuste Manual e Anatômico</div>
          <div style="display:flex;gap:3px">
            <button class="btn btn-xs btn-primary" id="btnSbEyeCalib" ${!state.img2 ? 'disabled' : ''} title="Calibrador matemático por 2 cliques nos olhos (IPD)">🎯 Olhos</button>
            <button class="btn btn-xs ${state.showAnatomicGuides ? 'btn-amber' : ''}" id="btnSbAnatomic" ${!state.img2 ? 'disabled' : ''} title="Alternar guias anatômicas cranianas e ombros">📏 Guias</button>
            <button class="btn btn-xs" id="btnSbFlicker" ${!state.img2 ? 'disabled' : ''} title="Segure para piscar/alternar com o original (Tecla F)">👁️ Piscar</button>
          </div>
        </div>
        <div class="control-row">
          <div class="control-label">
            <span>Escala</span>
            <span class="control-val" id="valImg2Scale">100%</span>
          </div>
          <div class="slider-line">
            <input type="range" id="rngImg2Scale" min="20" max="300" step="0.5" value="${state.img2Transform.scale * 100}" ${!state.img2 ? 'disabled' : ''} />
            <input type="number" class="num-input" id="numImg2Scale" step="1" value="${Math.round(state.img2Transform.scale * 100)}" ${!state.img2 ? 'disabled' : ''} />
          </div>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Rotação</span>
            <span class="control-val" id="valImg2Rot">${(state.img2Transform.rotation || 0).toFixed(1)}°</span>
          </div>
          <div class="slider-line">
            <input type="range" id="rngImg2Rot" min="-180" max="180" step="0.5" value="${state.img2Transform.rotation || 0}" ${!state.img2 ? 'disabled' : ''} />
            <input type="number" class="num-input" style="width:48px" id="numImg2Rot" step="0.5" value="${(state.img2Transform.rotation || 0).toFixed(1)}" ${!state.img2 ? 'disabled' : ''} />
            <button class="btn btn-xs" id="btnRotNudgeLeft" ${!state.img2 ? 'disabled' : ''} title="Girar -1°">↶-1°</button>
            <button class="btn btn-xs" id="btnRotReset" ${!state.img2 ? 'disabled' : ''} title="Zerar Rotação">↺0°</button>
            <button class="btn btn-xs" id="btnRotNudgeRight" ${!state.img2 ? 'disabled' : ''} title="Girar +1°">↷+1°</button>
          </div>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Posição X / Y (px)</span>
            <span class="control-val" id="valImg2XY">0, 0</span>
          </div>
          <div class="slider-line">
            <input type="number" class="num-input" style="flex:1" id="numImg2X" step="1" value="${Math.round(state.img2Transform.x)}" ${!state.img2 ? 'disabled' : ''} title="Deslocamento X" />
            <input type="number" class="num-input" style="flex:1" id="numImg2Y" step="1" value="${Math.round(state.img2Transform.y)}" ${!state.img2 ? 'disabled' : ''} title="Deslocamento Y" />
            <button class="btn btn-xs" id="btnImg2ResetContain" ${!state.img2 ? 'disabled' : ''} title="Centralizar">🎯 Centralizar</button>
            <button class="btn btn-xs" id="btnImg2Cover" ${!state.img2 ? 'disabled' : ''} title="Preencher">⛶ Preencher</button>
          </div>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Sobreposição imagem1</span>
            <span class="control-val" id="valImg2Onion">${Math.round(state.img2OnionOpacity * 100)}%</span>
          </div>
          <input type="range" id="rngImg2Onion" min="0" max="100" step="1" value="${Math.round(state.img2OnionOpacity * 100)}" ${!state.img2 ? 'disabled' : ''} />
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Face Isolada (Mesma Seleção)</div>
          <button class="btn btn-xs btn-amber" id="sbFlipRole2" ${!state.faceMask1 ? 'disabled' : ''}>⇄ Inverter</button>
        </div>
        <div class="piece-grid">
          <div class="piece-card featured">
            <div class="piece-title"><span>Face (img2)</span><span class="badge cyan">Face</span></div>
            <div class="piece-thumb-wrap" id="thumbFace2"></div>
            <div class="piece-actions">
              <button class="btn" id="copyFace2" ${!state.face2Canvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlFace2" ${!state.face2Canvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
          <div class="piece-card">
            <div class="piece-title"><span>img2 c/ Padding</span></div>
            <div class="piece-thumb-wrap" id="thumbImg2Pad"></div>
            <div class="piece-actions">
              <button class="btn" id="copyImg2Pad" ${!state.img2AlignedCanvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlImg2Pad" ${!state.img2AlignedCanvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="sbNextTo3" ${!(state.face2Canvas && state.corpo1Canvas) ? 'disabled' : ''}>
        Unir Corpo + Face → Etapa 3 (imagemMerge) →
      </button>
    `;

    document.getElementById('sbImportImg2')?.addEventListener('click', () => fileInputImg2.click());
    document.getElementById('sbPasteImg2')?.addEventListener('click', () => triggerClipboardPaste(2));
    document.getElementById('sbFlipRole2')?.addEventListener('click', flipCorpoAndFaceRole);

    document.getElementById('btnSbEyeCalib')?.addEventListener('click', openEyeCalibrateModal);
    document.getElementById('btnSbAnatomic')?.addEventListener('click', () => {
      state.showAnatomicGuides = !state.showAnatomicGuides;
      syncViewportScene();
      renderSidebar();
      renderStageToolbar();
    });
    const sbFlick = document.getElementById('btnSbFlicker');
    sbFlick?.addEventListener('mousedown', () => {
      state.flickerActive = true;
      syncViewportScene();
    });
    sbFlick?.addEventListener('click', () => {
      state.flickerActive = !state.flickerActive;
      syncViewportScene();
    });

    const rngScale = /** @type {HTMLInputElement | null} */ (document.getElementById('rngImg2Scale'));
    const numScale = /** @type {HTMLInputElement | null} */ (document.getElementById('numImg2Scale'));
    const rngRot = /** @type {HTMLInputElement | null} */ (document.getElementById('rngImg2Rot'));
    const numRot = /** @type {HTMLInputElement | null} */ (document.getElementById('numImg2Rot'));
    const numX = /** @type {HTMLInputElement | null} */ (document.getElementById('numImg2X'));
    const numY = /** @type {HTMLInputElement | null} */ (document.getElementById('numImg2Y'));
    const rngOnion = /** @type {HTMLInputElement | null} */ (document.getElementById('rngImg2Onion'));

    rngScale?.addEventListener('input', () => {
      state.step2View = 'align';
      state.img2Transform.scale = Math.max(0.1, Number(rngScale.value) / 100);
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
    });
    rngScale?.addEventListener('change', () => updateSidebarThumbnails());

    numScale?.addEventListener('change', () => {
      state.step2View = 'align';
      state.img2Transform.scale = Math.max(0.1, Math.min(8, (Number(numScale.value) || 100) / 100));
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    rngRot?.addEventListener('input', () => {
      state.step2View = 'align';
      state.img2Transform.rotation = Number(rngRot.value) || 0;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
    });
    rngRot?.addEventListener('change', () => updateSidebarThumbnails());

    numRot?.addEventListener('change', () => {
      state.step2View = 'align';
      state.img2Transform.rotation = Number(numRot.value) || 0;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    document.getElementById('btnRotNudgeLeft')?.addEventListener('click', () => {
      state.step2View = 'align';
      state.img2Transform.rotation =
        Math.round(((state.img2Transform.rotation || 0) - 1) * 10) / 10;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    document.getElementById('btnRotReset')?.addEventListener('click', () => {
      state.step2View = 'align';
      state.img2Transform.rotation = 0;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    document.getElementById('btnRotNudgeRight')?.addEventListener('click', () => {
      state.step2View = 'align';
      state.img2Transform.rotation =
        Math.round(((state.img2Transform.rotation || 0) + 1) * 10) / 10;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    const onXYChange = () => {
      state.step2View = 'align';
      state.img2Transform.x = Number(numX?.value) || 0;
      state.img2Transform.y = Number(numY?.value) || 0;
      recomputeStep2Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    };
    numX?.addEventListener('input', onXYChange);
    numY?.addEventListener('input', onXYChange);

    rngOnion?.addEventListener('input', () => {
      state.step2View = 'align';
      state.img2OnionOpacity = Number(rngOnion.value) / 100;
      syncViewportScene();
      updateSidebarLiveValues();
    });

    document.getElementById('btnImg2ResetContain')?.addEventListener('click', () => {
      state.img2Transform = { x: 0, y: 0, scale: 1, rotation: 0 };
      state.step2View = 'align';
      recomputeStep2Outputs();
      syncAllUI();
    });

    document.getElementById('btnImg2Cover')?.addEventListener('click', () => {
      if (!state.img2 || !state.img1Canvas) return;
      const W1 = state.img1Canvas.width;
      const H1 = state.img1Canvas.height;
      const fitS = Math.min(W1 / state.img2.width, H1 / state.img2.height);
      const coverS = Math.max(W1 / state.img2.width, H1 / state.img2.height);
      state.img2Transform = { x: 0, y: 0, scale: coverS / fitS };
      state.step2View = 'align';
      recomputeStep2Outputs();
      syncAllUI();
    });

    bindCopyDownload('copyFace2', 'dlFace2', () => state.face2Canvas, 'imagem2_face_isolada.png');
    bindCopyDownload('copyImg2Pad', 'dlImg2Pad', () => state.img2AlignedCanvas, 'imagem2_padding_alinhada.png');

    document.getElementById('sbNextTo3')?.addEventListener('click', () => {
      state.activeStep = 3;
      syncAllUI();
    });
  }

  function renderSidebarStep3() {
    const maxExpand = state.img1Canvas
      ? Math.round(Math.max(180, Math.min(state.img1Canvas.width, state.img1Canvas.height) * 0.35))
      : 250;

    sidebarContent.innerHTML = `
      <div class="panel-card highlight-cyan">
        <div class="card-header">
          <div class="card-title">3. imagemMerge — Unir &amp; Bordas</div>
          <span class="badge emerald">Corpo + Face</span>
        </div>
        <div class="btn-row">
          <button class="btn btn-sm" style="flex:1" id="copyMergeFull" ${!state.imgMergeCanvas ? 'disabled' : ''}>📋 Copiar imagemMerge</button>
          <button class="btn btn-sm" style="flex:1" id="dlMergeFull" ${!state.imgMergeCanvas ? 'disabled' : ''}>⬇ Salvar PNG</button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Região (Face + Bordas Imprecisas)</div>
        </div>
        <div class="segmented">
          <button class="seg-btn ${state.mergeRegionMode === 'expand' ? 'active' : ''}" id="segModeExpand">
            Expansão Automática
          </button>
          <button class="seg-btn ${state.mergeRegionMode === 'custom' ? 'active' : ''}" id="segModeCustom">
            Novo Corte / Laço
          </button>
        </div>

        ${
          state.mergeRegionMode === 'expand'
            ? `
          <div class="control-row" style="margin-top:4px">
            <div class="control-label">
              <span>Expansão da Face sobre Corpo</span>
              <span class="control-val" id="valExpandPx">+${state.expandPx} px</span>
            </div>
            <div class="slider-line">
              <input type="range" id="rngExpandPx" min="-20" max="${maxExpand}" step="1" value="${state.expandPx}" ${!state.imgMergeCanvas ? 'disabled' : ''} />
              <input type="number" class="num-input" id="numExpandPx" min="-50" max="${maxExpand}" value="${state.expandPx}" ${!state.imgMergeCanvas ? 'disabled' : ''} />
            </div>
          </div>
        `
            : `
          <div class="btn-row" style="margin-top:4px">
            <button class="btn btn-xs btn-amber" style="flex:1" id="btnFlipCustom2" ${!state.customRawMask2 ? 'disabled' : ''}>
              ⇄ Inverter
            </button>
            <button class="btn btn-xs btn-ghost" id="btnClearCustom2" ${!state.customRawMask2 ? 'disabled' : ''}>
              Limpar
            </button>
          </div>
          <div class="control-row">
            <div class="control-label">
              <span>Ajuste fino extra</span>
              <span class="control-val" id="valCustomExtraPx">${state.customExtraExpandPx >= 0 ? '+' : ''}${state.customExtraExpandPx} px</span>
            </div>
            <input type="range" id="rngCustomExtraPx" min="-30" max="150" step="1" value="${state.customExtraExpandPx}" ${!state.customRawMask2 ? 'disabled' : ''} />
          </div>
        `
        }
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Peças Isoladas da imagemMerge</div>
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="chkExportCrop" ${state.exportCroppedMode ? 'checked' : ''} />
            <span>Recorte Focado</span>
          </label>
        </div>

        <div class="piece-grid">
          <div class="piece-card featured">
            <div class="piece-title">
              <span>Face + Bordas Imp.</span>
              <span class="badge cyan">Para IA</span>
            </div>
            <div class="piece-thumb-wrap" id="thumbFaceImp"></div>
            <div class="piece-actions">
              <button class="btn btn-primary" id="copyFaceImp" ${!state.faceImprecisaCanvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlFaceImp" ${!state.faceImprecisaCanvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>

          <div class="piece-card">
            <div class="piece-title">
              <span>Corpo s/ Bordas</span>
            </div>
            <div class="piece-thumb-wrap" id="thumbCorpoClean"></div>
            <div class="piece-actions">
              <button class="btn" id="copyCorpoClean" ${!state.corpoSemBordasCanvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlCorpoClean" ${!state.corpoSemBordasCanvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="sbNextTo4" ${!state.faceImprecisaCanvas ? 'disabled' : ''}>
        Ir para Etapa 4: IA → Face + Bordas Precisas →
      </button>
    `;

    bindCopyDownload('copyMergeFull', 'dlMergeFull', () => state.imgMergeCanvas, 'imagemMerge.png');

    document.getElementById('segModeExpand')?.addEventListener('click', () => {
      state.mergeRegionMode = 'expand';
      recomputeStep3Outputs(false);
      syncAllUI();
    });

    document.getElementById('segModeCustom')?.addEventListener('click', () => {
      state.mergeRegionMode = 'custom';
      state.step3Tool = 'cut';
      state.step3View = 'split';
      recomputeStep3Outputs(false);
      syncAllUI();
    });

    const rngExpand = /** @type {HTMLInputElement | null} */ (document.getElementById('rngExpandPx'));
    const numExpand = /** @type {HTMLInputElement | null} */ (document.getElementById('numExpandPx'));

    rngExpand?.addEventListener('input', () => {
      state.expandPx = Number(rngExpand.value) || 0;
      recomputeStep3Outputs(false);
      syncViewportScene();
      updateSidebarLiveValues();
    });
    rngExpand?.addEventListener('change', () => updateSidebarThumbnails());

    numExpand?.addEventListener('change', () => {
      state.expandPx = Number(numExpand.value) || 0;
      recomputeStep3Outputs(false);
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    document.getElementById('btnFlipCustom2')?.addEventListener('click', flipCustomMergeRole);
    document.getElementById('btnClearCustom2')?.addEventListener('click', () => {
      state.customSelection2 = null;
      state.customRawMask2 = null;
      state.customExtraExpandPx = 0;
      recomputeStep3Outputs(false);
      syncAllUI();
    });

    const rngCustomExtra = /** @type {HTMLInputElement | null} */ (
      document.getElementById('rngCustomExtraPx')
    );
    rngCustomExtra?.addEventListener('input', () => {
      state.customExtraExpandPx = Number(rngCustomExtra.value) || 0;
      recomputeStep3Outputs(false);
      syncViewportScene();
      updateSidebarLiveValues();
    });
    rngCustomExtra?.addEventListener('change', () => updateSidebarThumbnails());

    const chkCrop = /** @type {HTMLInputElement | null} */ (document.getElementById('chkExportCrop'));
    chkCrop?.addEventListener('change', () => {
      state.exportCroppedMode = chkCrop.checked;
      state.refinedTargetMode = chkCrop.checked ? 'cropbox' : 'full';
      recomputeStep4Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    bindCopyDownload(
      'copyFaceImp',
      'dlFaceImp',
      getFaceImprecisaExportCanvas,
      'face_mais_bordas_imprecisas.png'
    );
    bindCopyDownload(
      'copyCorpoClean',
      'dlCorpoClean',
      () => state.corpoSemBordasCanvas,
      'corpo_sem_bordas_imprecisas.png'
    );

    document.getElementById('sbNextTo4')?.addEventListener('click', () => {
      state.activeStep = 4;
      syncAllUI();
    });
  }

  function renderSidebarStep4() {
    sidebarContent.innerHTML = `
      <div class="panel-card highlight-cyan">
        <div class="card-header">
          <div class="card-title">4. IA → Face + Bordas Precisas</div>
          ${state.imgRefined ? `<span class="badge emerald">${state.imgRefined.width}×${state.imgRefined.height}</span>` : `<span class="badge">Pendente</span>`}
        </div>
        <div class="btn-row">
          <button class="btn btn-sm btn-ghost" style="flex:1.2" id="sbQuickCopyImp" ${!state.faceImprecisaCanvas ? 'disabled' : ''}>
            📋 Copiar p/ IA
          </button>
          <button class="btn btn-primary btn-sm" style="flex:1" id="sbImportRefined">📂 Abrir</button>
          <button class="btn btn-sm" style="flex:1" id="sbPasteRefined">📋 Colar</button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Encaixe &amp; Ajuste Manual</div>
        </div>
        <div class="segmented">
          <button class="seg-btn ${state.refinedTargetMode === 'full' ? 'active' : ''}" id="segRefFull">
            Quadro Completo
          </button>
          <button class="seg-btn ${state.refinedTargetMode === 'cropbox' ? 'active' : ''}" id="segRefCrop">
            Recorte da Seleção
          </button>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Escala</span>
            <span class="control-val" id="valRefScale">100%</span>
          </div>
          <div class="slider-line">
            <input type="range" id="rngRefScale" min="20" max="300" step="0.5" value="${state.refinedTransform.scale * 100}" ${!state.imgRefined ? 'disabled' : ''} />
            <input type="number" class="num-input" id="numRefScale" step="1" value="${Math.round(state.refinedTransform.scale * 100)}" ${!state.imgRefined ? 'disabled' : ''} />
          </div>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Posição X / Y (px)</span>
            <span class="control-val" id="valRefXY">0, 0</span>
          </div>
          <div class="slider-line">
            <input type="number" class="num-input" style="flex:1" id="numRefX" step="1" value="${Math.round(state.refinedTransform.x)}" ${!state.imgRefined ? 'disabled' : ''} />
            <input type="number" class="num-input" style="flex:1" id="numRefY" step="1" value="${Math.round(state.refinedTransform.y)}" ${!state.imgRefined ? 'disabled' : ''} />
          </div>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Sobreposição imagemMerge</span>
            <span class="control-val" id="valRefOnion">${Math.round(state.refinedOnionOpacity * 100)}%</span>
          </div>
          <input type="range" id="rngRefOnion" min="0" max="100" step="1" value="${Math.round(state.refinedOnionOpacity * 100)}" ${!state.imgRefined ? 'disabled' : ''} />
        </div>

        <div class="btn-row">
          <button class="btn btn-sm" style="flex:1" id="btnRefReset" ${!state.imgRefined ? 'disabled' : ''}>
            🎯 Centralizar
          </button>
          <button class="btn btn-sm" style="flex:1" id="btnRefCover" ${!state.imgRefined ? 'disabled' : ''}>
            ⛶ Preencher
          </button>
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Peça Isolada (Face + Bordas Precisas)</div>
        </div>
        <div class="piece-grid single">
          <div class="piece-card featured">
            <div class="piece-title">
              <span>Face + Bordas Precisas</span>
              <span class="badge emerald">Refinada</span>
            </div>
            <div class="piece-thumb-wrap" id="thumbFacePrec"></div>
            <div class="piece-actions">
              <button class="btn" id="copyFacePrec" ${!state.facePrecisaCanvas ? 'disabled' : ''}>📋 Copiar</button>
              <button class="btn" id="dlFacePrec" ${!state.facePrecisaCanvas ? 'disabled' : ''}>⬇ Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <button class="btn btn-emerald btn-block" id="sbNextTo5" ${!state.imgFinalCanvas ? 'disabled' : ''}>
        ✨ Ver imagemFinal (União Completa) →
      </button>
    `;

    document.getElementById('sbQuickCopyImp')?.addEventListener('click', () => {
      const c = getFaceImprecisaExportCanvas();
      if (c) copyWithToast(c, '(Face + bordas imprecisas) copiada para a área de transferência!');
    });

    document.getElementById('sbImportRefined')?.addEventListener('click', () => fileInputRefined.click());
    document.getElementById('sbPasteRefined')?.addEventListener('click', () => triggerClipboardPaste(4));

    document.getElementById('segRefFull')?.addEventListener('click', () => {
      state.refinedTargetMode = 'full';
      state.refinedTransform = { x: 0, y: 0, scale: 1 };
      recomputeStep4Outputs();
      syncAllUI();
    });
    document.getElementById('segRefCrop')?.addEventListener('click', () => {
      state.refinedTargetMode = 'cropbox';
      state.refinedTransform = { x: 0, y: 0, scale: 1 };
      recomputeStep4Outputs();
      syncAllUI();
    });

    const rngScale = /** @type {HTMLInputElement | null} */ (document.getElementById('rngRefScale'));
    const numScale = /** @type {HTMLInputElement | null} */ (document.getElementById('numRefScale'));
    const numX = /** @type {HTMLInputElement | null} */ (document.getElementById('numRefX'));
    const numY = /** @type {HTMLInputElement | null} */ (document.getElementById('numRefY'));
    const rngOnion = /** @type {HTMLInputElement | null} */ (document.getElementById('rngRefOnion'));

    rngScale?.addEventListener('input', () => {
      state.step4View = 'align';
      state.refinedTransform.scale = Math.max(0.1, Number(rngScale.value) / 100);
      recomputeStep4Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
    });
    rngScale?.addEventListener('change', () => updateSidebarThumbnails());

    numScale?.addEventListener('change', () => {
      state.step4View = 'align';
      state.refinedTransform.scale = Math.max(0.1, Math.min(8, (Number(numScale.value) || 100) / 100));
      recomputeStep4Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    });

    const onRefXY = () => {
      state.step4View = 'align';
      state.refinedTransform.x = Number(numX?.value) || 0;
      state.refinedTransform.y = Number(numY?.value) || 0;
      recomputeStep4Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
      updateSidebarThumbnails();
    };
    numX?.addEventListener('input', onRefXY);
    numY?.addEventListener('input', onRefXY);

    rngOnion?.addEventListener('input', () => {
      state.step4View = 'align';
      state.refinedOnionOpacity = Number(rngOnion.value) / 100;
      syncViewportScene();
      updateSidebarLiveValues();
    });

    document.getElementById('btnRefReset')?.addEventListener('click', () => {
      state.refinedTransform = { x: 0, y: 0, scale: 1 };
      state.step4View = 'align';
      recomputeStep4Outputs();
      syncAllUI();
    });

    document.getElementById('btnRefCover')?.addEventListener('click', () => {
      if (!state.imgRefined || !state.img1Canvas) return;
      const box =
        state.refinedTargetMode === 'cropbox' && state.mergeFaceBox
          ? state.mergeFaceBox
          : { x: 0, y: 0, w: state.img1Canvas.width, h: state.img1Canvas.height };
      const fitS = Math.min(box.w / state.imgRefined.width, box.h / state.imgRefined.height);
      const coverS = Math.max(box.w / state.imgRefined.width, box.h / state.imgRefined.height);
      state.refinedTransform = { x: 0, y: 0, scale: coverS / fitS };
      state.step4View = 'align';
      recomputeStep4Outputs();
      syncAllUI();
    });

    bindCopyDownload('copyFacePrec', 'dlFacePrec', () => state.facePrecisaCanvas, 'face_mais_bordas_precisas.png');

    document.getElementById('sbNextTo5')?.addEventListener('click', () => {
      state.activeStep = 5;
      syncAllUI();
    });
  }

  let _step5RafPending = false;
  function scheduleStep5LiveUpdate() {
    updateSidebarLiveValues();
    if (_step5RafPending) return;
    _step5RafPending = true;
    requestAnimationFrame(() => {
      _step5RafPending = false;
      recomputeStep5Outputs();
      syncViewportScene();
    });
  }

  function renderSidebarStep5() {
    const dimText = state.imgFinalCanvas
      ? `${state.imgFinalCanvas.width} × ${state.imgFinalCanvas.height} px`
      : 'Pendente';

    const fm = state.finalMerge;
    const disabledAttr = !state.facePrecisaCanvas ? 'disabled' : '';

    /** @type {{ id: FinalMergeMode, title: string, sub: string, span2?: boolean }[]} */
    const techniques = [
      { id: 'none', title: 'Corte Exato', sub: 'Sem suavização' },
      { id: 'feather', title: 'Feather', sub: 'Cross-fade clássico' },
      { id: 'multiband', title: 'Multi-Band ★', sub: 'Pirâmide nitidez' },
      { id: 'poisson', title: 'Poisson Clone ★', sub: 'Gradiente de luz/cor' },
      { id: 'lab_skin', title: 'Pele CIE LAB ★', sub: 'Iguala tom/calor' },
      { id: 'luma_chroma', title: 'Luma × Chroma', sub: 'Cor ampla • Detalhe firme' },
      { id: 'edge_aware', title: 'Adaptativo (Pele × Roupa)', sub: 'Suave na pele, firme na roupa', span2: true },
    ];

    const techButtonsHtml = techniques
      .map(
        (t) => `
        <button class="tech-btn ${fm.mode === t.id ? 'active' : ''}" data-tech="${t.id}" ${
          t.span2 ? 'style="grid-column: span 2"' : ''
        } ${disabledAttr}>
          <span class="tech-btn-title">${t.title}</span>
          <span class="tech-btn-sub">${t.sub}</span>
        </button>`
      )
      .join('');

    sidebarContent.innerHTML = `
      <div class="panel-card highlight-emerald">
        <div class="card-header">
          <div class="card-title">5. imagemFinal — Resultado Unido</div>
          <span class="badge emerald">${dimText}</span>
        </div>
        <div class="piece-grid single">
          <div class="piece-card featured" style="border-color:rgba(16,185,129,0.5)">
            <div class="piece-thumb-wrap" id="thumbFinal"></div>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-emerald btn-sm" style="flex:1" id="copyImgFinal" ${disabledAttr}>
            📋 Copiar
          </button>
          <button class="btn btn-primary btn-sm" style="flex:1" id="dlImgFinal" ${disabledAttr}>
            ⬇ Salvar PNG
          </button>
        </div>
      </div>

      <div class="panel-card highlight-cyan">
        <div class="card-header">
          <div class="card-title">Técnicas de Fusão &amp; Pele</div>
          <span class="badge cyan">IA × Original</span>
        </div>

        <div class="tech-grid" id="techGrid">
          ${techButtonsHtml}
        </div>

        ${
          fm.mode !== 'none'
            ? `
          <div class="control-row">
            <div class="control-label">
              <span>${fm.mode === 'poisson' ? 'Suavização micro' : 'Raio de fusão'}</span>
              <span class="control-val" id="valFinalRadius">${fm.radiusPx} px</span>
            </div>
            <input type="range" id="rngFinalRadius" min="1" max="110" step="1" value="${fm.radiusPx}" ${disabledAttr} />
          </div>
        `
            : ''
        }

        ${
          fm.mode === 'poisson'
            ? `
          <div class="control-row">
            <div class="control-label">
              <span>Alcance na pele</span>
              <span class="control-val" id="valPoissonReach">${Math.round(fm.poissonReach * 100)}%</span>
            </div>
            <input type="range" id="rngPoissonReach" min="10" max="100" step="1" value="${Math.round(fm.poissonReach * 100)}" ${disabledAttr} />
          </div>
        `
            : ''
        }

        <div class="control-row">
          <div class="control-label">
            <span>Harmonizar Tom de Pele (CIE LAB)</span>
            <span class="control-val" id="valColorMatch">${
              fm.mode === 'lab_skin'
                ? `${Math.round(Math.max(0.85, fm.colorMatchStrength) * 100)}%`
                : `${Math.round(fm.colorMatchStrength * 100)}%`
            }</span>
          </div>
          <input type="range" id="rngColorMatch" min="0" max="100" step="1" value="${
            fm.mode === 'lab_skin'
              ? Math.round(Math.max(0.85, fm.colorMatchStrength) * 100)
              : Math.round(fm.colorMatchStrength * 100)
          }" ${disabledAttr} />
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="chkPrioritizeSkin" ${fm.prioritizeSkin ? 'checked' : ''} ${disabledAttr} />
            <span>Priorizar tons de pele</span>
          </label>
          ${
            fm.mode !== 'none' && fm.mode !== 'poisson'
              ? `
            <label class="checkbox-row" style="margin:0">
              <input type="checkbox" id="chkProtectCore" ${fm.protectCoreFace ? 'checked' : ''} ${disabledAttr} />
              <span>Proteger face central</span>
            </label>
          `
              : ''
          }
        </div>
      </div>

      <div class="panel-card">
        <div class="card-header">
          <div class="card-title">Comparar &amp; Avançar</div>
        </div>
        <div class="segmented">
          <button class="seg-btn ${state.step5View === 'final' ? 'active' : ''}" id="segCmpNone">Final</button>
          <button class="seg-btn ${state.step5View === 'compare-raw' ? 'active' : ''}" id="segCmpRaw" title="Comparar com corte seco">vs Seco</button>
          <button class="seg-btn ${state.step5View === 'compare-merge' ? 'active' : ''}" id="segCmpMerge">vs Merge</button>
          <button class="seg-btn ${state.step5View === 'compare-img1' ? 'active' : ''}" id="segCmpImg1">vs img1</button>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:2px" id="sbNextTo6" ${disabledAttr}>
          Ir para Etapa 6: Pós-Processamento (Igualar Pele) →
        </button>
      </div>
    `;

    bindCopyDownload('copyImgFinal', 'dlImgFinal', () => state.imgFinalCanvas, 'imagemFinal.png');

    document.getElementById('sbNextTo6')?.addEventListener('click', () => {
      state.activeStep = 6;
      syncAllUI();
    });

    document.querySelectorAll('#techGrid .tech-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = /** @type {FinalMergeMode} */ (btn.getAttribute('data-tech') || 'none');
        state.finalMerge.mode = nextMode;
        if (nextMode !== 'none' && state.finalMerge.radiusPx <= 0) {
          state.finalMerge.radiusPx = 28;
        }
        if (nextMode === 'lab_skin' && state.finalMerge.colorMatchStrength < 0.85) {
          state.finalMerge.colorMatchStrength = 0.85;
        }
        recomputeStep5Outputs();
        syncAllUI();
      });
    });

    const rngRadius = /** @type {HTMLInputElement | null} */ (document.getElementById('rngFinalRadius'));
    rngRadius?.addEventListener('input', () => {
      state.finalMerge.radiusPx = Number(rngRadius.value) || 1;
      scheduleStep5LiveUpdate();
    });
    rngRadius?.addEventListener('change', () => {
      recomputeStep5Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    const rngPoisson = /** @type {HTMLInputElement | null} */ (document.getElementById('rngPoissonReach'));
    rngPoisson?.addEventListener('input', () => {
      state.finalMerge.poissonReach = (Number(rngPoisson.value) || 75) / 100;
      scheduleStep5LiveUpdate();
    });
    rngPoisson?.addEventListener('change', () => {
      recomputeStep5Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    const rngColor = /** @type {HTMLInputElement | null} */ (document.getElementById('rngColorMatch'));
    rngColor?.addEventListener('input', () => {
      const val = (Number(rngColor.value) || 0) / 100;
      state.finalMerge.colorMatchStrength = val;
      if (state.finalMerge.mode === 'lab_skin' && val < 0.85) {
        state.finalMerge.mode = 'feather';
      }
      scheduleStep5LiveUpdate();
    });
    rngColor?.addEventListener('change', () => {
      recomputeStep5Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    const chkSkin = /** @type {HTMLInputElement | null} */ (document.getElementById('chkPrioritizeSkin'));
    chkSkin?.addEventListener('change', () => {
      state.finalMerge.prioritizeSkin = chkSkin.checked;
      recomputeStep5Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    const chkCore = /** @type {HTMLInputElement | null} */ (document.getElementById('chkProtectCore'));
    chkCore?.addEventListener('change', () => {
      state.finalMerge.protectCoreFace = chkCore.checked;
      recomputeStep5Outputs();
      syncViewportScene();
      updateSidebarThumbnails();
    });

    document.getElementById('segCmpNone')?.addEventListener('click', () => {
      state.step5View = 'final';
      syncAllUI();
    });
    document.getElementById('segCmpRaw')?.addEventListener('click', () => {
      state.step5View = 'compare-raw';
      syncAllUI();
    });
    document.getElementById('segCmpMerge')?.addEventListener('click', () => {
      state.step5View = 'compare-merge';
      syncAllUI();
    });
    document.getElementById('segCmpImg1')?.addEventListener('click', () => {
      state.step5View = 'compare-img1';
      syncAllUI();
    });
  }

  let _step6RafPending = false;
  function scheduleStep6LiveUpdate() {
    updateSidebarLiveValues();
    if (_step6RafPending) return;
    _step6RafPending = true;
    requestAnimationFrame(() => {
      _step6RafPending = false;
      recomputeStep6Outputs();
      syncViewportScene();
      updateSidebarLiveValues();
    });
  }

  /**
   * Formats an RGB tuple as CSS rgb(...) string.
   * @param {[number, number, number] | undefined} rgb
   * @param {string} fallback
   */
  function fmtRgbCss(rgb, fallback = '#334155') {
    if (!rgb) return fallback;
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function renderSidebarStep6() {
    const dimText = state.imgPostCanvas
      ? `${state.imgPostCanvas.width} × ${state.imgPostCanvas.height} px`
      : 'Pendente';

    const sp = state.skinPost;
    const diag = state.skinDiagnostics;
    const disabledAttr = !state.imgFinalCanvas ? 'disabled' : '';

    /** @type {{ id: SkinPostMethod, title: string, sub: string, span2?: boolean }[]} */
    const skinMethods = [
      { id: 'oklab_ot', title: 'Oklab 3×3 OT ★', sub: 'Transporte Ótimo 3D' },
      { id: 'cdf_curves', title: 'Curvas CDF ★', sub: 'Sombras • Meios • Altas' },
      { id: 'melanin_hemo', title: 'Melanina × Hemo ★', sub: 'Biofísico (Tom + Rubor)' },
      { id: 'zones_lgg', title: 'Lift / Gamma / Gain', sub: '3 Zonas Tonais' },
      {
        id: 'spatial_oklab',
        title: 'Espacial + Oklab 3×3',
        sub: 'Global + local costura',
        span2: true,
      },
    ];

    const methodBtnsHtml = skinMethods
      .map(
        (m) => `
        <button class="tech-btn ${sp.method === m.id ? 'active' : ''}" data-skin-method="${m.id}" ${
          m.span2 ? 'style="grid-column: span 2"' : ''
        } ${disabledAttr}>
          <span class="tech-btn-title">${m.title}</span>
          <span class="tech-btn-sub">${m.sub}</span>
        </button>`
      )
      .join('');

    const fBeforeCss = diag?.valid ? fmtRgbCss(diag.faceRgbBefore) : '#475569';
    const bBeforeCss = diag?.valid ? fmtRgbCss(diag.bodyRgbBefore) : '#475569';
    const fAfterCss = diag?.valid ? fmtRgbCss(diag.faceRgbAfter) : '#475569';
    const bAfterCss = diag?.valid ? fmtRgbCss(diag.bodyRgbAfter) : '#475569';

    const dBefore = diag?.valid ? diag.deltaEBefore.toFixed(1) : '—';
    const dAfter = diag?.valid ? diag.deltaEAfter.toFixed(1) : '—';
    const deltaClass = !diag?.valid
      ? ''
      : diag.deltaEAfter < 1.8
      ? 'emerald'
      : diag.deltaEAfter < 4.0
      ? 'amber'
      : 'cyan';

    const faceSampleLabel =
      state.skinSamplesFace.length > 0 ? `Face (${state.skinSamplesFace.length})` : 'Face (Auto)';
    const bodySampleLabel =
      state.skinSamplesBody.length > 0 ? `Corpo (${state.skinSamplesBody.length})` : 'Corpo (Auto)';

    let subtabHtml = '';
    if (state.step6Subtab === 'engine') {
      subtabHtml = `
        <div class="control-row">
          <div class="control-label"><span>Direção da Igualação</span></div>
          <div class="segmented">
            <button class="seg-btn ${sp.direction === 'face_to_body' ? 'active' : ''}" id="segDirF2B" ${disabledAttr}>Face → Corpo</button>
            <button class="seg-btn ${sp.direction === 'body_to_face' ? 'active' : ''}" id="segDirB2F" ${disabledAttr}>Corpo → Face</button>
            <button class="seg-btn ${sp.direction === 'mutual' ? 'active' : ''}" id="segDirMut" ${disabledAttr}>Mútuo 50/50</button>
          </div>
        </div>

        <div class="tech-grid" id="skinMethodGrid" style="margin-top:2px">
          ${methodBtnsHtml}
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Intensidade Geral</span>
            <span class="control-val" id="valSkinStrength">${Math.round(sp.strength * 100)}%</span>
          </div>
          <input type="range" id="rngSkinStrength" min="0" max="150" step="1" value="${Math.round(sp.strength * 100)}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Igualar Luminosidade / Exposição</span>
            <span class="control-val" id="valSkinLuma">${Math.round(sp.lumaMatch * 100)}%</span>
          </div>
          <input type="range" id="rngSkinLuma" min="0" max="120" step="1" value="${Math.round(sp.lumaMatch * 100)}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Igualar Cor / Subtom (Matiz &amp; Croma)</span>
            <span class="control-val" id="valSkinChroma">${Math.round(sp.chromaMatch * 100)}%</span>
          </div>
          <input type="range" id="rngSkinChroma" min="0" max="120" step="1" value="${Math.round(sp.chromaMatch * 100)}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Polimento Local na Costura</span>
            <span class="control-val" id="valSkinSeamPx">${sp.seamEqualizePx} px</span>
          </div>
          <input type="range" id="rngSkinSeamPx" min="0" max="50" step="1" value="${sp.seamEqualizePx}" ${disabledAttr} />
        </div>

        <label class="checkbox-row" style="margin-top:2px">
          <input type="checkbox" id="chkSkinProtect" ${sp.protectFeatures ? 'checked' : ''} ${disabledAttr} />
          <span>Proteger olhos, dentes, boca, cabelo e roupas</span>
        </label>
      `;
    } else if (state.step6Subtab === 'fine') {
      subtabHtml = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
          <span style="font-size:10.5px;color:var(--text-secondary);font-weight:600">Ajuste Manual dos Subtons</span>
          <button class="btn btn-xs btn-ghost" id="btnResetFineSkin" ${disabledAttr}>↺ Resetar</button>
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Temperatura (Frio ↔ Dourado/Quente)</span>
            <span class="control-val" id="valSkinTemp">${sp.tempOffset > 0 ? '+' : ''}${sp.tempOffset}</span>
          </div>
          <input type="range" id="rngSkinTemp" min="-50" max="50" step="1" value="${sp.tempOffset}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Subtom (Oliva ↔ Rosado/Magenta)</span>
            <span class="control-val" id="valSkinTint">${sp.tintOffset > 0 ? '+' : ''}${sp.tintOffset}</span>
          </div>
          <input type="range" id="rngSkinTint" min="-50" max="50" step="1" value="${sp.tintOffset}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Brilho Seletivo da Pele</span>
            <span class="control-val" id="valSkinLight">${sp.lightOffset > 0 ? '+' : ''}${sp.lightOffset}</span>
          </div>
          <input type="range" id="rngSkinLight" min="-50" max="50" step="1" value="${sp.lightOffset}" ${disabledAttr} />
        </div>

        <div class="control-row">
          <div class="control-label">
            <span>Saturação da Pele</span>
            <span class="control-val" id="valSkinSat">${Math.round(sp.satScale * 100)}%</span>
          </div>
          <input type="range" id="rngSkinSat" min="50" max="150" step="1" value="${Math.round(sp.satScale * 100)}" ${disabledAttr} />
        </div>
      `;
    } else if (state.step6Subtab === 'samples') {
      subtabHtml = `
        <div class="btn-row">
          <button class="btn btn-sm ${state.step6Tool === 'sample-face' ? 'btn-primary' : ''}" style="flex:1" id="btnSampleFace" ${disabledAttr} title="Clique na pele da Face para calibrar">
            🎯 ${faceSampleLabel}
          </button>
          <button class="btn btn-sm ${state.step6Tool === 'sample-body' ? 'btn-amber' : ''}" style="flex:1" id="btnSampleBody" ${disabledAttr} title="Clique na pele do Corpo para calibrar">
            🎯 ${bodySampleLabel}
          </button>
          <button class="btn btn-sm btn-ghost" id="btnClearSkinSamples" ${
            state.skinSamplesFace.length === 0 && state.skinSamplesBody.length === 0 ? 'disabled' : ''
          } title="Detecção automática">
            ↺ Auto
          </button>
        </div>

        <div class="control-row" style="margin-top:4px">
          <div class="control-label">
            <span>Seletividade da Detecção de Pele</span>
            <span class="control-val" id="valSkinSelectivity">${Math.round(sp.maskSelectivity * 100)}%</span>
          </div>
          <input type="range" id="rngSkinSelectivity" min="0" max="100" step="1" value="${Math.round(sp.maskSelectivity * 100)}" ${disabledAttr} />
        </div>

        <div class="control-row" style="margin-top:4px">
          <div class="control-label"><span>Visualização &amp; Comparação</span></div>
          <div class="segmented">
            <button class="seg-btn ${state.step6View === 'post' ? 'active' : ''}" id="segS6Post">Pós</button>
            <button class="seg-btn ${state.step6View === 'compare-pre' ? 'active' : ''}" id="segS6Pre" title="Comparar Pré vs Pós">vs Pré</button>
            <button class="seg-btn ${state.step6View === 'compare-raw' ? 'active' : ''}" id="segS6Raw" title="Comparar Corte Seco vs Pós">vs Seco</button>
            <button class="seg-btn ${state.step6View === 'skin-mask' ? 'active' : ''}" id="segS6Mask" title="Visualizar máscara de pele">Mapa</button>
          </div>
        </div>
      `;
    }

    sidebarContent.innerHTML = `
      <div class="panel-card highlight-emerald">
        <div class="card-header">
          <div class="card-title">6. Pós • Tom de Pele</div>
          <span class="badge ${deltaClass} delta-pill" id="pillDeltaE">ΔE00: ${dBefore} → ${dAfter}</span>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="chkSkinEnabled" ${sp.enabled ? 'checked' : ''} ${disabledAttr} />
            <span style="font-weight:600">Ativar Pós-Processamento</span>
          </label>
          <span class="badge emerald">${dimText}</span>
        </div>

        <div style="display:flex;gap:6px;align-items:center;margin:2px 0">
          <div class="piece-thumb-wrap" id="thumbPostFinal" style="flex:1;height:54px"></div>
          <div class="skin-meter" style="flex:1.2;padding:3px 5px">
            <div class="swatch-col">
              <div class="swatch-dot" id="swFaceBefore" style="background:${fBeforeCss}"></div>
              <div class="swatch-caption">Face Antes</div>
            </div>
            <div class="swatch-col" style="flex:1.2">
              <div class="swatch-Split" title="Esquerda: Face Pós | Direita: Corpo Pós">
                <div class="swatch-half" id="swHalfFaceAfter" style="background:${fAfterCss}"></div>
                <div class="swatch-half" id="swHalfBodyAfter" style="background:${bAfterCss}"></div>
              </div>
              <div class="swatch-caption">Depois (F | C)</div>
            </div>
            <div class="swatch-col">
              <div class="swatch-dot" id="swBodyTarget" style="background:${bBeforeCss}"></div>
              <div class="swatch-caption">Corpo Ref.</div>
            </div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-emerald btn-sm" style="flex:1" id="copyImgPost" ${disabledAttr}>
            📋 Copiar Final
          </button>
          <button class="btn btn-primary btn-sm" style="flex:1" id="dlImgPost" ${disabledAttr}>
            ⬇ Salvar PNG
          </button>
        </div>
      </div>

      <div class="panel-card highlight-cyan" style="display:flex;flex-direction:column;gap:5px">
        <div class="subtabs-nav">
          <button class="subtab-btn ${state.step6Subtab === 'engine' ? 'active' : ''}" id="btnSubtabEngine">⚙ Motor</button>
          <button class="subtab-btn ${state.step6Subtab === 'fine' ? 'active' : ''}" id="btnSubtabFine">🎨 Ajuste Fino</button>
          <button class="subtab-btn ${state.step6Subtab === 'samples' ? 'active' : ''}" id="btnSubtabSamples">🎯 Amostras</button>
        </div>
        <div id="subtabBox">
          ${subtabHtml}
        </div>
      </div>
    `;

    bindCopyDownload(
      'copyImgPost',
      'dlImgPost',
      () => state.imgPostCanvas,
      'imagemFinal_pele_igualada.png'
    );

    const chkEnabled = /** @type {HTMLInputElement | null} */ (document.getElementById('chkSkinEnabled'));
    chkEnabled?.addEventListener('change', () => {
      state.skinPost.enabled = chkEnabled.checked;
      recomputeStep6Outputs();
      syncAllUI();
    });

    document.getElementById('btnSubtabEngine')?.addEventListener('click', () => {
      state.step6Subtab = 'engine';
      renderSidebarStep6();
      updateSidebarThumbnails();
      updateSidebarLiveValues();
    });
    document.getElementById('btnSubtabFine')?.addEventListener('click', () => {
      state.step6Subtab = 'fine';
      renderSidebarStep6();
      updateSidebarThumbnails();
      updateSidebarLiveValues();
    });
    document.getElementById('btnSubtabSamples')?.addEventListener('click', () => {
      state.step6Subtab = 'samples';
      renderSidebarStep6();
      updateSidebarThumbnails();
      updateSidebarLiveValues();
    });

    /**
     * Helper to bind a Step 6 slider with live rAF preview + thumbnail update on release.
     * @param {string} id
     * @param {(val: number) => void} applyVal
     */
    const bindStep6Range = (id, applyVal) => {
      const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
      if (!el) return;
      el.addEventListener('input', () => {
        applyVal(Number(el.value));
        scheduleStep6LiveUpdate();
      });
      el.addEventListener('change', () => {
        recomputeStep6Outputs();
        syncViewportScene();
        updateSidebarLiveValues();
        updateSidebarThumbnails();
      });
    };

    if (state.step6Subtab === 'engine') {
      const setDir = (/** @type {SkinMatchDirection} */ dir) => {
        state.skinPost.direction = dir;
        recomputeStep6Outputs();
        syncAllUI();
      };
      document.getElementById('segDirF2B')?.addEventListener('click', () => setDir('face_to_body'));
      document.getElementById('segDirB2F')?.addEventListener('click', () => setDir('body_to_face'));
      document.getElementById('segDirMut')?.addEventListener('click', () => setDir('mutual'));

      document.querySelectorAll('#skinMethodGrid .tech-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const m = /** @type {SkinPostMethod} */ (btn.getAttribute('data-skin-method') || 'oklab_ot');
          state.skinPost.method = m;
          recomputeStep6Outputs();
          syncAllUI();
        });
      });

      bindStep6Range('rngSkinStrength', (v) => {
        state.skinPost.strength = v / 100;
      });
      bindStep6Range('rngSkinLuma', (v) => {
        state.skinPost.lumaMatch = v / 100;
      });
      bindStep6Range('rngSkinChroma', (v) => {
        state.skinPost.chromaMatch = v / 100;
      });
      bindStep6Range('rngSkinSeamPx', (v) => {
        state.skinPost.seamEqualizePx = Math.round(v);
      });

      const chkProt = /** @type {HTMLInputElement | null} */ (document.getElementById('chkSkinProtect'));
      chkProt?.addEventListener('change', () => {
        state.skinPost.protectFeatures = chkProt.checked;
        recomputeStep6Outputs();
        syncViewportScene();
        updateSidebarLiveValues();
        updateSidebarThumbnails();
      });
    } else if (state.step6Subtab === 'fine') {
      bindStep6Range('rngSkinTemp', (v) => {
        state.skinPost.tempOffset = Math.round(v);
      });
      bindStep6Range('rngSkinTint', (v) => {
        state.skinPost.tintOffset = Math.round(v);
      });
      bindStep6Range('rngSkinLight', (v) => {
        state.skinPost.lightOffset = Math.round(v);
      });
      bindStep6Range('rngSkinSat', (v) => {
        state.skinPost.satScale = v / 100;
      });

      document.getElementById('btnResetFineSkin')?.addEventListener('click', () => {
        state.skinPost.tempOffset = 0;
        state.skinPost.tintOffset = 0;
        state.skinPost.lightOffset = 0;
        state.skinPost.satScale = 1.0;
        recomputeStep6Outputs();
        syncAllUI();
      });
    } else if (state.step6Subtab === 'samples') {
      document.getElementById('btnSampleFace')?.addEventListener('click', () => {
        state.step6Tool = state.step6Tool === 'sample-face' ? 'pan' : 'sample-face';
        if (state.step6Tool !== 'pan' && state.step6View.startsWith('compare')) {
          state.step6View = 'post';
        }
        syncAllUI();
      });

      document.getElementById('btnSampleBody')?.addEventListener('click', () => {
        state.step6Tool = state.step6Tool === 'sample-body' ? 'pan' : 'sample-body';
        if (state.step6Tool !== 'pan' && state.step6View.startsWith('compare')) {
          state.step6View = 'post';
        }
        syncAllUI();
      });

      document.getElementById('btnClearSkinSamples')?.addEventListener('click', () => {
        state.skinSamplesFace = [];
        state.skinSamplesBody = [];
        state.step6Tool = 'pan';
        recomputeStep6Outputs();
        syncAllUI();
        showToast('Amostragem restaurada para detecção automática de pele.');
      });

      bindStep6Range('rngSkinSelectivity', (v) => {
        state.skinPost.maskSelectivity = v / 100;
      });

      document.getElementById('segS6Post')?.addEventListener('click', () => {
        state.step6Tool = 'pan';
        state.step6View = 'post';
        syncAllUI();
      });
      document.getElementById('segS6Pre')?.addEventListener('click', () => {
        state.step6Tool = 'pan';
        state.step6View = 'compare-pre';
        syncAllUI();
      });
      document.getElementById('segS6Raw')?.addEventListener('click', () => {
        state.step6Tool = 'pan';
        state.step6View = 'compare-raw';
        syncAllUI();
      });
      document.getElementById('segS6Mask')?.addEventListener('click', () => {
        state.step6View = 'skin-mask';
        syncAllUI();
      });
    }
  }

  /**
   * Updates numeric labels & input values without replacing DOM nodes (preserves slider drag focus!).
   */
  function updateSidebarLiveValues() {
    const setTxt = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const setVal = (id, val) => {
      const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
      if (el && document.activeElement !== el) el.value = String(val);
    };

    if (state.activeStep === 2) {
      const pct = Math.round(state.img2Transform.scale * 100);
      const rot = (state.img2Transform.rotation || 0).toFixed(1);
      setTxt('valImg2Scale', `${pct}%`);
      setVal('rngImg2Scale', state.img2Transform.scale * 100);
      setVal('numImg2Scale', pct);
      setTxt('valImg2Rot', `${rot}°`);
      setVal('rngImg2Rot', state.img2Transform.rotation || 0);
      setVal('numImg2Rot', rot);
      setTxt('valImg2XY', `${Math.round(state.img2Transform.x)}, ${Math.round(state.img2Transform.y)}`);
      setVal('numImg2X', Math.round(state.img2Transform.x));
      setVal('numImg2Y', Math.round(state.img2Transform.y));
      setTxt('valImg2Onion', `${Math.round(state.img2OnionOpacity * 100)}%`);
    } else if (state.activeStep === 3) {
      setTxt('valExpandPx', `${state.expandPx >= 0 ? '+' : ''}${state.expandPx} px`);
      setVal('rngExpandPx', state.expandPx);
      setVal('numExpandPx', state.expandPx);
      setTxt(
        'valCustomExtraPx',
        `${state.customExtraExpandPx >= 0 ? '+' : ''}${state.customExtraExpandPx} px`
      );
    } else if (state.activeStep === 4) {
      const pct = Math.round(state.refinedTransform.scale * 100);
      setTxt('valRefScale', `${pct}%`);
      setVal('rngRefScale', state.refinedTransform.scale * 100);
      setVal('numRefScale', pct);
      setTxt(
        'valRefXY',
        `${Math.round(state.refinedTransform.x)}, ${Math.round(state.refinedTransform.y)}`
      );
      setVal('numRefX', Math.round(state.refinedTransform.x));
      setVal('numRefY', Math.round(state.refinedTransform.y));
      setTxt('valRefOnion', `${Math.round(state.refinedOnionOpacity * 100)}%`);
    } else if (state.activeStep === 5) {
      setTxt('valFinalRadius', `${state.finalMerge.radiusPx} px`);
      setTxt('valPoissonReach', `${Math.round(state.finalMerge.poissonReach * 100)}%`);
      const effC =
        state.finalMerge.mode === 'lab_skin'
          ? Math.max(0.85, state.finalMerge.colorMatchStrength)
          : state.finalMerge.colorMatchStrength;
      setTxt('valColorMatch', `${Math.round(effC * 100)}%`);
    } else if (state.activeStep === 6) {
      const sp = state.skinPost;
      setTxt('valSkinStrength', `${Math.round(sp.strength * 100)}%`);
      setTxt('valSkinLuma', `${Math.round(sp.lumaMatch * 100)}%`);
      setTxt('valSkinChroma', `${Math.round(sp.chromaMatch * 100)}%`);
      setTxt('valSkinSelectivity', `${Math.round(sp.maskSelectivity * 100)}%`);
      setTxt('valSkinSeamPx', `${sp.seamEqualizePx} px`);
      setTxt('valSkinTemp', `${sp.tempOffset > 0 ? '+' : ''}${sp.tempOffset}`);
      setTxt('valSkinTint', `${sp.tintOffset > 0 ? '+' : ''}${sp.tintOffset}`);
      setTxt('valSkinLight', `${sp.lightOffset > 0 ? '+' : ''}${sp.lightOffset}`);
      setTxt('valSkinSat', `${Math.round(sp.satScale * 100)}%`);

      const diag = state.skinDiagnostics;
      if (diag && diag.valid) {
        const swFB = document.getElementById('swFaceBefore');
        const swBT = document.getElementById('swBodyTarget');
        const swFA = document.getElementById('swHalfFaceAfter');
        const swBA = document.getElementById('swHalfBodyAfter');
        if (swFB) swFB.style.background = fmtRgbCss(diag.faceRgbBefore);
        if (swBT) swBT.style.background = fmtRgbCss(diag.bodyRgbBefore);
        if (swFA) swFA.style.background = fmtRgbCss(diag.faceRgbAfter);
        if (swBA) swBA.style.background = fmtRgbCss(diag.bodyRgbAfter);

        const pill = document.getElementById('pillDeltaE');
        if (pill) {
          pill.textContent = `ΔE00: ${diag.deltaEBefore.toFixed(1)} → ${diag.deltaEAfter.toFixed(1)}`;
          const cls =
            diag.deltaEAfter < 1.8 ? 'emerald' : diag.deltaEAfter < 4.0 ? 'amber' : 'cyan';
          pill.className = `badge ${cls} delta-pill`;
        }
      }
    }
  }

  function updateSidebarThumbnails() {
    if (state.activeStep === 1) {
      mountThumb(document.getElementById('thumbCorpo1'), state.corpo1Canvas);
      mountThumb(document.getElementById('thumbFace1'), state.face1Canvas);
    } else if (state.activeStep === 2) {
      mountThumb(document.getElementById('thumbFace2'), state.face2Canvas);
      mountThumb(document.getElementById('thumbImg2Pad'), state.img2AlignedCanvas);
    } else if (state.activeStep === 3) {
      mountThumb(document.getElementById('thumbFaceImp'), getFaceImprecisaExportCanvas());
      mountThumb(document.getElementById('thumbCorpoClean'), state.corpoSemBordasCanvas);
    } else if (state.activeStep === 4) {
      mountThumb(document.getElementById('thumbFacePrec'), state.facePrecisaCanvas);
    } else if (state.activeStep === 5) {
      mountThumb(document.getElementById('thumbFinal'), state.imgFinalCanvas);
    } else if (state.activeStep === 6) {
      mountThumb(document.getElementById('thumbPostFinal'), state.imgPostCanvas);
    }
  }

  /**
   * @param {string} copyId
   * @param {string} dlId
   * @param {() => HTMLCanvasElement | null} getCanvas
   * @param {string} filename
   */
  function bindCopyDownload(copyId, dlId, getCanvas, filename) {
    document.getElementById(copyId)?.addEventListener('click', () => {
      const c = getCanvas();
      if (c) copyWithToast(c, `${filename} copiado para a área de transferência!`);
    });
    document.getElementById(dlId)?.addEventListener('click', async () => {
      const c = getCanvas();
      if (c) {
        const res = await Ops.saveCanvasToData(c, filename, state.targetDataFolder);
        if (res.viaApi) {
          showToast(`Salvo com sucesso em /${res.path}!`);
        } else {
          showToast(`Download de ${filename} concluído (salvar em /data/${state.targetDataFolder || ''})`);
        }
      }
    });
  }

  async function initDataFolderControl() {
    const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('selDataFolder'));
    const btnOpen = document.getElementById('btnOpenDataFolder');
    if (!sel) return;

    try {
      const res = await Ops.getDataFolders();
      sel.innerHTML = '';
      const rootOpt = document.createElement('option');
      rootOpt.value = '';
      rootOpt.textContent = '/data (raiz)';
      sel.appendChild(rootOpt);

      if (res && res.folders && res.folders.length > 0) {
        res.folders.forEach((f) => {
          const opt = document.createElement('option');
          opt.value = f;
          opt.textContent = `/data/${f}`;
          sel.appendChild(opt);
        });
        if (res.defaultFolder) {
          state.targetDataFolder = res.defaultFolder;
          sel.value = res.defaultFolder;
        }
      } else {
        const opt4 = document.createElement('option');
        opt4.value = '4';
        opt4.textContent = '/data/4';
        sel.appendChild(opt4);
        state.targetDataFolder = '4';
        sel.value = '4';
      }

      const newOpt = document.createElement('option');
      newOpt.value = '__new__';
      newOpt.textContent = '+ Nova pasta...';
      sel.appendChild(newOpt);
    } catch (e) {
      sel.innerHTML = '<option value="4">/data/4</option><option value="">/data</option>';
      state.targetDataFolder = '4';
    }

    sel.addEventListener('change', () => {
      if (sel.value === '__new__') {
        const name = prompt('Nome da nova pasta em /data:', '5');
        if (name && name.trim()) {
          const clean = name.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
          const opt = document.createElement('option');
          opt.value = clean;
          opt.textContent = `/data/${clean}`;
          sel.insertBefore(opt, sel.lastChild);
          sel.value = clean;
          state.targetDataFolder = clean;
          showToast(`Pasta /data/${clean} selecionada como padrão.`);
        } else {
          sel.value = state.targetDataFolder;
        }
      } else {
        state.targetDataFolder = sel.value;
        showToast(`Destino padrão de download: /data${state.targetDataFolder ? '/' + state.targetDataFolder : ''}`);
      }
    });

    btnOpen?.addEventListener('click', () => {
      Ops.openDataFolder(state.targetDataFolder);
    });
  }

  async function copyWithToast(canvas, successMsg) {
    try {
      await Ops.copyCanvasToClipboard(canvas);
      showToast(successMsg);
    } catch (err) {
      showToast(err.message || 'Erro ao copiar imagem.', true);
    }
  }

  async function triggerClipboardPaste(slot) {
    try {
      const loaded = await Ops.readImageFromClipboardAPI();
      if (!loaded) {
        showToast('Nenhuma imagem encontrada na área de transferência. Use Ctrl+V!', true);
        return;
      }
      applyLoadedImage(loaded, slot);
    } catch (err) {
      showToast(err.message || 'Pressione Ctrl+V no teclado para colar a imagem.', true);
    }
  }

  // ===========================================================================
  // Modal: Auto Seleção com Rosto Isolado (Face + Complemento = Corpo)
  // ===========================================================================

  /**
   * Checks whether an image has meaningful transparent pixels (alpha < 240).
   * @param {LoadedImage | null} loaded
   * @returns {boolean}
   */
  function checkImageHasAlpha(loaded) {
    if (!loaded || !loaded.img) return false;
    const canvas = Ops.sourceToCanvas(loaded.img);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const len = data.length;
    let transparentCount = 0;
    const step = len > 4000000 ? 16 : 4;
    for (let i = 3; i < len; i += step) {
      if (data[i] < 240) {
        transparentCount++;
        if (transparentCount > 40) return true;
      }
    }
    return transparentCount > 8;
  }

  function openAutoSelectModal() {
    if (state.img1 && !autoModalState.imgComplete) {
      autoModalState.imgComplete = state.img1;
    }
    updateAutoModalUI();
    modalAutoSelect?.classList.add('open');
  }

  function closeAutoSelectModal() {
    modalAutoSelect?.classList.remove('open');
  }

  function renderAutoThumb(container, loaded, emptyLabel) {
    if (!container) return;
    container.innerHTML = '';
    if (!loaded || !loaded.img) {
      container.innerHTML = `<span style="color:#64748b;font-size:10px">${emptyLabel}</span>`;
      return;
    }
    const thumbCanvas = document.createElement('canvas');
    const aspect = (loaded.width || 1) / (loaded.height || 1);
    const maxH = 52;
    const maxW = 90;
    let tw = maxH * aspect;
    let th = maxH;
    if (tw > maxW) {
      tw = maxW;
      th = maxW / aspect;
    }
    thumbCanvas.width = Math.max(1, Math.round(tw));
    thumbCanvas.height = Math.max(1, Math.round(th));
    thumbCanvas.style.maxHeight = '100%';
    thumbCanvas.style.maxWidth = '100%';
    thumbCanvas.style.objectFit = 'contain';
    thumbCanvas.style.borderRadius = '3px';
    const ctx = thumbCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(loaded.img, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }
    container.appendChild(thumbCanvas);
  }

  function updateAutoModalUI() {
    const badgeImg1 = document.getElementById('badgeAutoImg1');
    const thumbImg1 = document.getElementById('thumbAutoImg1');
    const badgeFace = document.getElementById('badgeAutoFace');
    const thumbFace = document.getElementById('thumbAutoFace');
    const btnApply = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('btnAutoApply')
    );

    if (badgeImg1 && thumbImg1) {
      if (autoModalState.imgComplete) {
        badgeImg1.className = 'badge emerald';
        badgeImg1.textContent = `${autoModalState.imgComplete.width} × ${autoModalState.imgComplete.height}`;
        renderAutoThumb(thumbImg1, autoModalState.imgComplete, 'Nenhuma imagem');
      } else {
        badgeImg1.className = 'badge';
        badgeImg1.textContent = 'Pendente';
        thumbImg1.innerHTML = '<span style="color:#64748b;font-size:10px">Nenhuma imagem</span>';
      }
    }

    if (badgeFace && thumbFace) {
      if (autoModalState.imgFace) {
        badgeFace.className = 'badge cyan';
        badgeFace.textContent = `${autoModalState.imgFace.width} × ${autoModalState.imgFace.height}`;
        renderAutoThumb(thumbFace, autoModalState.imgFace, 'Nenhum recorte');
      } else {
        badgeFace.className = 'badge';
        badgeFace.textContent = 'Pendente';
        thumbFace.innerHTML = '<span style="color:#64748b;font-size:10px">Nenhum recorte</span>';
      }
    }

    if (btnApply) {
      btnApply.disabled = !(autoModalState.imgComplete && autoModalState.imgFace);
    }
  }

  /**
   * Applies auto-separation: computes mask where face is 1, and complement is 0 (Corpo).
   * @param {LoadedImage | null} loadedComplete
   * @param {LoadedImage | null} loadedFace
   */
  function applyAutoSeparation(loadedComplete, loadedFace) {
    if (!loadedComplete || !loadedFace) {
      showToast('Selecione tanto a imagem completa quanto o rosto isolado.', true);
      return;
    }

    // Ensure complete image is set as imagem1
    if (!state.img1 || state.img1 !== loadedComplete) {
      applyLoadedImage(loadedComplete, 1);
    }

    if (!state.img1Canvas) {
      showToast('Erro ao carregar a imagem completa.', true);
      return;
    }

    const { mask, facePixelCount, bodyPixelCount } = Ops.createMaskFromIsolatedFace(
      state.img1Canvas,
      loadedFace.img
    );

    if (facePixelCount === 0) {
      showToast(
        'Não foi possível isolar o rosto. Certifique-se que o rosto possui fundo transparente ou corresponde ao original.',
        true
      );
      return;
    }

    state.rawMask1 = mask;
    state.faceIsOne1 = true; // Face = 1, Complement = 0 (Corpo)
    state.selection1 = {
      type: 'auto-face',
      polygon: [],
      cutPath: [],
    };
    state.step1View = 'split';
    recomputeStep1Outputs(true);
    closeAutoSelectModal();
    syncAllUI();
    showToast(
      `✨ Auto seleção concluída! Rosto isolado (${facePixelCount.toLocaleString()} px) e Corpo (${bodyPixelCount.toLocaleString()} px).`
    );
  }

  /**
   * Handles multi-file Explorer selection (Ctrl+Click or Drag 2 files).
   * @param {FileList} files
   */
  async function handleAutoPairFiles(files) {
    if (!files || files.length === 0) return;

    try {
      showToast('Analisando imagens...');
      if (files.length === 1 && state.img1) {
        const loadedFace = await Ops.loadImageFromBlob(files[0], files[0].name);
        autoModalState.imgComplete = state.img1;
        autoModalState.imgFace = loadedFace;
        updateAutoModalUI();
        applyAutoSeparation(state.img1, loadedFace);
        return;
      }

      if (files.length < 2) {
        showToast('Selecione 2 imagens no Explorer (original + rosto isolado).', true);
        return;
      }

      const loadedA = await Ops.loadImageFromBlob(files[0], files[0].name);
      const loadedB = await Ops.loadImageFromBlob(files[1], files[1].name);

      const aHasAlpha = checkImageHasAlpha(loadedA);
      const bHasAlpha = checkImageHasAlpha(loadedB);

      let comp = null;
      let face = null;

      if (aHasAlpha && !bHasAlpha) {
        face = loadedA;
        comp = loadedB;
      } else if (!aHasAlpha && bHasAlpha) {
        comp = loadedA;
        face = loadedB;
      } else {
        const nameA = (files[0].name || '').toLowerCase();
        const nameB = (files[1].name || '').toLowerCase();
        const faceKeys = ['face', 'rosto', 'crop', 'cut', 'isola', 'head', 'recorte'];
        const aIsFace = faceKeys.some((k) => nameA.includes(k));
        const bIsFace = faceKeys.some((k) => nameB.includes(k));

        if (aIsFace && !bIsFace) {
          face = loadedA;
          comp = loadedB;
        } else if (!aIsFace && bIsFace) {
          comp = loadedA;
          face = loadedB;
        } else {
          comp = loadedA;
          face = loadedB;
        }
      }

      autoModalState.imgComplete = comp;
      autoModalState.imgFace = face;
      updateAutoModalUI();
      applyAutoSeparation(comp, face);
    } catch (err) {
      showToast(err.message || 'Erro ao processar par de imagens.', true);
    }
  }

  function initAutoSelectModal() {
    const btnClose = document.getElementById('btnCloseAutoModal');
    const btnCancel = document.getElementById('btnAutoCancel');
    const btnPickBoth = document.getElementById('btnAutoPickBoth');
    const btnChooseImg1 = document.getElementById('btnAutoChooseImg1');
    const btnPasteImg1 = document.getElementById('btnAutoPasteImg1');
    const btnChooseFace = document.getElementById('btnAutoChooseFace');
    const btnPasteFace = document.getElementById('btnAutoPasteFace');
    const btnApply = document.getElementById('btnAutoApply');

    btnClose?.addEventListener('click', closeAutoSelectModal);
    btnCancel?.addEventListener('click', closeAutoSelectModal);
    modalAutoSelect?.addEventListener('click', (e) => {
      if (e.target === modalAutoSelect) closeAutoSelectModal();
    });

    btnPickBoth?.addEventListener('click', () => {
      if (fileInputAutoPair) {
        fileInputAutoPair.value = '';
        fileInputAutoPair.click();
      }
    });

    fileInputAutoPair?.addEventListener('change', (e) => {
      const files = /** @type {HTMLInputElement} */ (e.target).files;
      if (files && files.length > 0) {
        handleAutoPairFiles(files);
      }
    });

    btnChooseImg1?.addEventListener('click', () => {
      if (fileInputAutoImg1) {
        fileInputAutoImg1.value = '';
        fileInputAutoImg1.click();
      }
    });

    fileInputAutoImg1?.addEventListener('change', async (e) => {
      const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
      if (file) {
        try {
          autoModalState.imgComplete = await Ops.loadImageFromBlob(file, file.name);
          updateAutoModalUI();
        } catch (err) {
          showToast(err.message || 'Erro ao carregar imagem.', true);
        }
      }
    });

    btnPasteImg1?.addEventListener('click', async () => {
      try {
        const loaded = await Ops.readImageFromClipboardAPI();
        if (loaded) {
          autoModalState.imgComplete = loaded;
          updateAutoModalUI();
          showToast('Imagem completa colada!');
        } else {
          showToast('Nenhuma imagem na área de transferência.', true);
        }
      } catch (err) {
        showToast(err.message || 'Pressione Ctrl+V para colar.', true);
      }
    });

    btnChooseFace?.addEventListener('click', () => {
      if (fileInputAutoFace) {
        fileInputAutoFace.value = '';
        fileInputAutoFace.click();
      }
    });

    fileInputAutoFace?.addEventListener('change', async (e) => {
      const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
      if (file) {
        try {
          autoModalState.imgFace = await Ops.loadImageFromBlob(file, file.name);
          updateAutoModalUI();
        } catch (err) {
          showToast(err.message || 'Erro ao carregar rosto.', true);
        }
      }
    });

    btnPasteFace?.addEventListener('click', async () => {
      try {
        const loaded = await Ops.readImageFromClipboardAPI();
        if (loaded) {
          autoModalState.imgFace = loaded;
          updateAutoModalUI();
          showToast('Rosto isolado colado!');
        } else {
          showToast('Nenhuma imagem na área de transferência.', true);
        }
      } catch (err) {
        showToast(err.message || 'Pressione Ctrl+V para colar.', true);
      }
    });

    btnApply?.addEventListener('click', () => {
      applyAutoSeparation(autoModalState.imgComplete, autoModalState.imgFace);
    });
  }

  // ===========================================================================
  // Modal: Alinhamento por Olhos (Calibrador IPD)
  // ===========================================================================
  const modalEyeCalibrate = /** @type {HTMLElement | null} */ (
    document.getElementById('modalEyeCalibrate')
  );
  const canvasEyeImg1 = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById('canvasEyeImg1')
  );
  const canvasEyeImg2 = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById('canvasEyeImg2')
  );

  let eyeCalibState = {
    /** @type {Point | null} */
    p1L: null,
    /** @type {Point | null} */
    p1R: null,
    /** @type {Point | null} */
    p2L: null,
    /** @type {Point | null} */
    p2R: null,
    calcResult: null,
  };

  function openEyeCalibrateModal() {
    if (!state.img1Canvas || !state.img2) {
      showToast('Importe ou cole a imagem2 antes de alinhar por olhos.', true);
      return;
    }
    renderEyeCalibCanvases();
    updateEyeCalibUI();
    modalEyeCalibrate?.classList.add('open');
  }

  function closeEyeCalibrateModal() {
    modalEyeCalibrate?.classList.remove('open');
  }

  function resetEyePoints() {
    eyeCalibState.p1L = null;
    eyeCalibState.p1R = null;
    eyeCalibState.p2L = null;
    eyeCalibState.p2R = null;
    eyeCalibState.calcResult = null;
    renderEyeCalibCanvases();
    updateEyeCalibUI();
  }

  function renderEyeCalibCanvases() {
    if (canvasEyeImg1 && state.img1Canvas) {
      const c = canvasEyeImg1;
      c.width = state.img1Canvas.width;
      c.height = state.img1Canvas.height;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(state.img1Canvas, 0, 0);
        drawEyePins(ctx, eyeCalibState.p1L, eyeCalibState.p1R, '#38bdf8', 'L1', 'R1');
      }
    }

    if (canvasEyeImg2 && state.img2) {
      const c = canvasEyeImg2;
      c.width = state.img2.width;
      c.height = state.img2.height;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(state.img2.img, 0, 0);
        drawEyePins(ctx, eyeCalibState.p2L, eyeCalibState.p2R, '#f59e0b', 'L2', 'R2');
      }
    }
  }

  function drawEyePins(ctx, pL, pR, color, labelL, labelR) {
    ctx.save();
    if (pL && pR) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(pL.x, pL.y);
      ctx.lineTo(pR.x, pR.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const drawPin = (p, label) => {
      if (!p) return;
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y);
      ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7);
      ctx.lineTo(p.x, p.y + 7);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(label, p.x + 14, p.y + 4);
    };

    drawPin(pL, labelL);
    drawPin(pR, labelR);
    ctx.restore();
  }

  function updateEyeCalibUI() {
    const badge1 = document.getElementById('badgeEyeImg1');
    const badge2 = document.getElementById('badgeEyeImg2');
    const stats1 = document.getElementById('statsEyeImg1');
    const stats2 = document.getElementById('statsEyeImg2');
    const banner = document.getElementById('eyeCalcStatus');
    const btnApply = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('btnEyeApply')
    );

    if (badge1 && stats1) {
      if (!eyeCalibState.p1L) {
        badge1.className = 'badge cyan';
        badge1.textContent = 'Clique Olho Esquerdo';
        stats1.textContent = 'IPD: —';
      } else if (!eyeCalibState.p1R) {
        badge1.className = 'badge amber';
        badge1.textContent = 'Clique Olho Direito';
        stats1.textContent = 'Marcado Olho Esquerdo...';
      } else {
        const ipd1 = Math.round(Geo.dist(eyeCalibState.p1L, eyeCalibState.p1R));
        badge1.className = 'badge emerald';
        badge1.textContent = '✓ 2 Olhos Marcados';
        stats1.textContent = `IPD: ${ipd1} px`;
      }
    }

    if (badge2 && stats2) {
      if (!eyeCalibState.p2L) {
        badge2.className = 'badge';
        badge2.textContent = 'Clique Olho Esquerdo';
        stats2.textContent = 'IPD: —';
      } else if (!eyeCalibState.p2R) {
        badge2.className = 'badge amber';
        badge2.textContent = 'Clique Olho Direito';
        stats2.textContent = 'Marcado Olho Esquerdo...';
      } else {
        const ipd2 = Math.round(Geo.dist(eyeCalibState.p2L, eyeCalibState.p2R));
        badge2.className = 'badge emerald';
        badge2.textContent = '✓ 2 Olhos Marcados';
        stats2.textContent = `IPD: ${ipd2} px`;
      }
    }

    const ready = eyeCalibState.p1L && eyeCalibState.p1R && eyeCalibState.p2L && eyeCalibState.p2R;
    if (ready && state.img1Canvas && state.img2) {
      const res = Geo.computeSimilarityTransformFromEyes(
        eyeCalibState.p1L,
        eyeCalibState.p1R,
        eyeCalibState.p2L,
        eyeCalibState.p2R,
        state.img2.width,
        state.img2.height,
        state.img1Canvas.width,
        state.img1Canvas.height
      );
      eyeCalibState.calcResult = res;
      if (banner) {
        banner.textContent = `✨ IPD Base: ${res.ipd1}px | IPD Ref: ${res.ipd2}px | Escala: ${Math.round(res.scale * 100)}% | Rotação: ${res.rotation > 0 ? '+' : ''}${res.rotation.toFixed(1)}° | Translação: (${res.x}, ${res.y})`;
      }
      if (btnApply) btnApply.disabled = false;
    } else {
      eyeCalibState.calcResult = null;
      if (banner) {
        banner.textContent = 'Posicione os 2 olhos na imagem1 e os 2 olhos na imagem2';
      }
      if (btnApply) btnApply.disabled = true;
    }
  }

  function handleEyeCanvasClick(which, e) {
    const canvas = which === 1 ? canvasEyeImg1 : canvasEyeImg2;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    const pt = { x, y };

    if (which === 1) {
      if (!eyeCalibState.p1L || (eyeCalibState.p1L && eyeCalibState.p1R)) {
        eyeCalibState.p1L = pt;
        eyeCalibState.p1R = null;
      } else {
        eyeCalibState.p1R = pt;
      }
    } else {
      if (!eyeCalibState.p2L || (eyeCalibState.p2L && eyeCalibState.p2R)) {
        eyeCalibState.p2L = pt;
        eyeCalibState.p2R = null;
      } else {
        eyeCalibState.p2R = pt;
      }
    }

    renderEyeCalibCanvases();
    updateEyeCalibUI();
  }

  function initEyeCalibrateModal() {
    const btnClose = document.getElementById('btnCloseEyeModal');
    const btnCancel = document.getElementById('btnEyeCancel');
    const btnReset = document.getElementById('btnEyeResetPoints');
    const btnApply = document.getElementById('btnEyeApply');

    btnClose?.addEventListener('click', closeEyeCalibrateModal);
    btnCancel?.addEventListener('click', closeEyeCalibrateModal);
    btnReset?.addEventListener('click', resetEyePoints);

    modalEyeCalibrate?.addEventListener('click', (e) => {
      if (e.target === modalEyeCalibrate) closeEyeCalibrateModal();
    });

    canvasEyeImg1?.addEventListener('click', (e) => handleEyeCanvasClick(1, e));
    canvasEyeImg2?.addEventListener('click', (e) => handleEyeCanvasClick(2, e));

    btnApply?.addEventListener('click', () => {
      if (!eyeCalibState.calcResult) return;
      const { scale, rotation, x, y } = eyeCalibState.calcResult;
      state.img2Transform = { x, y, scale, rotation };
      state.step2View = 'align';
      recomputeStep2Outputs();
      syncAllUI();
      closeEyeCalibrateModal();
      showToast(
        `🎯 Alinhamento por olhos aplicado: Escala ${Math.round(scale * 100)}%, Rotação ${rotation.toFixed(1)}°!`
      );
    });

    // Global keyboard hotkeys for Step 2
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && /** @type {HTMLElement} */ (e.target).tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (state.activeStep === 2) {
        if (e.code === 'KeyF' && !state.flickerActive) {
          state.flickerActive = true;
          syncViewportScene();
        } else if (e.key === '[') {
          state.img2Transform.rotation =
            Math.round(((state.img2Transform.rotation || 0) - 1) * 10) / 10;
          recomputeStep2Outputs();
          syncViewportScene();
          updateSidebarLiveValues();
        } else if (e.key === ']') {
          state.img2Transform.rotation =
            Math.round(((state.img2Transform.rotation || 0) + 1) * 10) / 10;
          recomputeStep2Outputs();
          syncViewportScene();
          updateSidebarLiveValues();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyF' && state.flickerActive) {
        state.flickerActive = false;
        syncViewportScene();
      }
    });
  }

  function syncAllUI() {
    renderStepper();
    renderStageToolbar();
    renderSidebar();
    syncViewportScene();
  }

  // ===========================================================================
  // Top Toolbar & Demo Controls
  // ===========================================================================
  btnToggleOverlay.addEventListener('click', () => {
    state.showGuides = !state.showGuides;
    btnToggleOverlay.classList.toggle('active', state.showGuides);
    syncViewportScene();
  });

  btnZoomIn.addEventListener('click', () => viewport.setZoom(viewport.zoom * 1.25));
  btnZoomOut.addEventListener('click', () => viewport.setZoom(viewport.zoom / 1.25));
  btnZoomFit.addEventListener('click', () => viewport.fitToViewport());

  btnResetAll.addEventListener('click', () => {
    if (state.img1 && !confirm('Deseja limpar todo o projeto atual?')) return;
    state.activeStep = 1;
    state.img1 = null;
    state.img1Canvas = null;
    state.selection1 = null;
    state.rawMask1 = null;
    state.faceMask1 = null;
    state.img2 = null;
    state.img2Transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    state.customSelection2 = null;
    state.customRawMask2 = null;
    state.imgRefined = null;
    state.refinedTransform = { x: 0, y: 0, scale: 1 };
    state.finalMerge = {
      mode: 'none',
      radiusPx: 28,
      colorMatchStrength: 0,
      prioritizeSkin: true,
      poissonReach: 0.75,
      protectCoreFace: true,
    };
    state.skinSamplesFace = [];
    state.skinSamplesBody = [];
    state.step6Tool = 'pan';
    state.step6View = 'post';
    state.skinPost = {
      enabled: true,
      method: 'oklab_ot',
      direction: 'face_to_body',
      strength: 1.0,
      lumaMatch: 0.88,
      chromaMatch: 1.0,
      maskSelectivity: 0.72,
      protectFeatures: true,
      seamEqualizePx: 14,
      tempOffset: 0,
      tintOffset: 0,
      lightOffset: 0,
      satScale: 1.0,
    };
    recomputeStep1Outputs(true);
    viewport.setDocumentSize(0, 0, false);
    syncAllUI();
    showToast('Projeto reiniciado.');
  });

  async function loadDemoProject(initialStep = 1, compareMode = false) {
    try {
      const demo = await Ops.generateDemoAssets();
      state.img1 = demo.img1;
      state.img1Canvas = Ops.sourceToCanvas(demo.img1.img);
      const W = demo.img1.width;
      const H = demo.img1.height;

      // Build a natural curved border-to-border neck cut across left->right borders
      const cutPath = [
        { x: 0, y: H * 0.43 },
        { x: W * 0.28, y: H * 0.44 },
        { x: W * 0.5, y: H * 0.47 },
        { x: W * 0.72, y: H * 0.44 },
        { x: W, y: H * 0.43 },
      ];
      const poly = Geo.buildBorderCutPolygon(cutPath, W, H);
      state.selection1 = {
        type: 'border-cut',
        polygon: poly,
        cutPath,
        pIn: cutPath[0],
        pOut: cutPath[cutPath.length - 1],
      };
      state.rawMask1 = Geo.rasterizePolygonMask(poly, W, H);
      state.faceIsOne1 = Geo.guessFaceIsOne(state.rawMask1, W, H);

      // Load square AI imagem2 (860x860 -> padded & aligned over portrait 720x920)
      state.img2 = demo.img2;
      state.img2Transform = { x: 0, y: -38, scale: 1 };

      state.mergeRegionMode = 'expand';
      state.expandPx = 42;
      state.exportCroppedMode = false;
      state.refinedTargetMode = 'full';
      state.refinedTransform = { x: 0, y: 0, scale: 1 };
      state.finalMerge = {
        mode: 'multiband',
        radiusPx: 26,
        colorMatchStrength: initialStep === 6 ? 0 : 0.75,
        prioritizeSkin: true,
        poissonReach: 0.75,
        protectCoreFace: true,
      };
      state.skinSamplesFace = [];
      state.skinSamplesBody = [];
      state.step6Tool = 'pan';
      state.skinPost = {
        enabled: true,
        method: 'oklab_ot',
        direction: 'face_to_body',
        strength: 1.0,
        lumaMatch: 0.92,
        chromaMatch: 1.0,
        maskSelectivity: 0.72,
        protectFeatures: true,
        seamEqualizePx: 14,
        tempOffset: 0,
        tintOffset: 0,
        lightOffset: 0,
        satScale: 1.0,
      };

      recomputeStep1Outputs(true);
      state.imgRefined = await demo.refinedSample(null);
      recomputeStep4Outputs();

      viewport.setDocumentSize(W, H, true);
      state.activeStep = initialStep;
      if (compareMode) {
        state.step5View = 'compare-raw';
        state.step6View = 'compare-pre';
      } else if (urlParams.get('view') === 'mask') {
        state.step6View = 'skin-mask';
      }
      syncAllUI();
      viewport._draw();
      showToast('Exemplo completo carregado! Navegue pelas Etapas 1 a 6 ou ajuste o tom de pele.');
    } catch (err) {
      showToast(err.message || 'Erro ao gerar exemplo.', true);
    }
  }

  btnLoadDemo.addEventListener('click', () => loadDemoProject(1, false));

  // Initial render (and optional ?demo=1&step=N deep link)
  const urlParams = new URLSearchParams(window.location.search);
  initDataFolderControl();
  initAutoSelectModal();
  initEyeCalibrateModal();
  syncAllUI();

  if (urlParams.get('demo') === '1') {
    const reqStep = Number(urlParams.get('step'));
    const validStep = reqStep >= 1 && reqStep <= 6 ? reqStep : 1;
    loadDemoProject(validStep, urlParams.get('view') === 'compare');
  }
})();
