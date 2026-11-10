// @ts-check
/// <reference path="./types.js" />

(function (global) {
  'use strict';

  // ===========================================================================
  // Fast sRGB <-> CIE L*a*b* (D65) Lookup Tables & Conversions
  // ===========================================================================
  const SRGB_TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  const LIN_LUT_SIZE = 4096;
  const LIN_TO_SRGB = new Uint8Array(LIN_LUT_SIZE + 1);
  for (let i = 0; i <= LIN_LUT_SIZE; i++) {
    const c = i / LIN_LUT_SIZE;
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    LIN_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }

  const LAB_DELTA = 6 / 29;
  const LAB_DELTA3 = LAB_DELTA * LAB_DELTA * LAB_DELTA;
  const LAB_INV_3DELTA2 = 1 / (3 * LAB_DELTA * LAB_DELTA);
  const LAB_4_29 = 4 / 29;

  /**
   * @param {number} t
   */
  function labF(t) {
    return t > LAB_DELTA3 ? Math.cbrt(t) : t * LAB_INV_3DELTA2 + LAB_4_29;
  }

  /**
   * @param {number} u
   */
  function labFInv(u) {
    return u > LAB_DELTA ? u * u * u : 3 * LAB_DELTA * LAB_DELTA * (u - LAB_4_29);
  }

  /**
   * Converts sRGB [0..255] to CIE L*a*b* (L in [0..100], a,b in ~[-128..127]).
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {Float32Array} out3
   * @param {number} offset
   */
  function rgbToLabInto(r, g, b, out3, offset) {
    const rl = SRGB_TO_LIN[r];
    const gl = SRGB_TO_LIN[g];
    const bl = SRGB_TO_LIN[b];

    const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
    const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
    const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;

    const fx = labF(x);
    const fy = labF(y);
    const fz = labF(z);

    out3[offset] = 116 * fy - 16;
    out3[offset + 1] = 500 * (fx - fy);
    out3[offset + 2] = 200 * (fy - fz);
  }

  /**
   * Converts CIE L*a*b* back to sRGB [0..255] written into Uint8ClampedArray.
   * @param {number} L
   * @param {number} a
   * @param {number} b
   * @param {Uint8ClampedArray} outRgba
   * @param {number} rgbaOffset
   */
  function labToRgbInto(L, a, b, outRgba, rgbaOffset) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;

    const x = 0.95047 * labFInv(fx);
    const y = labFInv(fy);
    const z = 1.08883 * labFInv(fz);

    const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    const gl = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

    const ri = rl <= 0 ? 0 : rl >= 1 ? LIN_LUT_SIZE : (rl * LIN_LUT_SIZE + 0.5) | 0;
    const gi = gl <= 0 ? 0 : gl >= 1 ? LIN_LUT_SIZE : (gl * LIN_LUT_SIZE + 0.5) | 0;
    const bi = bl <= 0 ? 0 : bl >= 1 ? LIN_LUT_SIZE : (bl * LIN_LUT_SIZE + 0.5) | 0;

    outRgba[rgbaOffset] = LIN_TO_SRGB[ri];
    outRgba[rgbaOffset + 1] = LIN_TO_SRGB[gi];
    outRgba[rgbaOffset + 2] = LIN_TO_SRGB[bi];
  }

  /**
   * Perceptual skin-tone likelihood weight in CIE L*a*b* space.
   * Covers fair, olive, warm, stylised, and deep skin tones across [16°, 80°] hue angle.
   * @param {number} L
   * @param {number} a
   * @param {number} b
   */
  function computeSkinLikelihood(L, a, b) {
    if (L < 14 || L > 96) return 0.15;
    if (a < 1.0 || b < 2.5) return 0.2;
    const chroma = Math.hypot(a, b);
    if (chroma < 4.5 || chroma > 62) return 0.25;
    const hueDeg = (Math.atan2(b, a) * 180) / Math.PI;
    if (hueDeg >= 16 && hueDeg <= 80) {
      return 5.0;
    }
    return 0.25;
  }

  /**
   * Smoothstep on [edge0, edge1].
   * @param {number} edge0
   * @param {number} edge1
   * @param {number} x
   */
  function smoothstep(edge0, edge1, x) {
    if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // ===========================================================================
  // Collar Color / Skin-Tone Harmonization (CIE L*a*b* Reinhard Transfer)
  // ===========================================================================

  /**
   * Computes CIE L*a*b* color transfer parameters matching AI pixels to Original pixels
   * specifically over the shared overlap collar (M2 \ M1, or outer band of M2).
   *
   * @param {Float32Array} aiLab (N * 3)
   * @param {Float32Array} origLab (N * 3)
   * @param {Uint8Array} subMergeMask (N)
   * @param {Uint8Array | null} subOrigFaceMask (N)
   * @param {Float32Array} subDistOut (N) Euclidean distance to mergeFaceMask === 0
   * @param {number} collarWidthPx
   * @param {boolean} prioritizeSkin
   */
  function estimateCollarLabTransfer(
    aiLab,
    origLab,
    subMergeMask,
    subOrigFaceMask,
    subDistOut,
    collarWidthPx,
    prioritizeSkin
  ) {
    const n = subMergeMask.length;
    const bandMax = Math.max(12, collarWidthPx * 1.5);

    let wSum = 0;
    let meanAiL = 0, meanAiA = 0, meanAiB = 0;
    let meanOrL = 0, meanOrA = 0, meanOrB = 0;

    // Pass 1: Weighted means over overlap collar
    for (let i = 0; i < n; i++) {
      if (subMergeMask[i] !== 1) continue;
      const inCollar = subOrigFaceMask ? subOrigFaceMask[i] === 0 : subDistOut[i] <= bandMax;
      if (!inCollar && subDistOut[i] > bandMax) continue;

      const idx3 = i * 3;
      const aL = aiLab[idx3], aA = aiLab[idx3 + 1], aB = aiLab[idx3 + 2];
      const oL = origLab[idx3], oA = origLab[idx3 + 1], oB = origLab[idx3 + 2];

      // Downweight structural mismatches (e.g., hair strand over light background)
      const diffL = Math.abs(aL - oL);
      if (diffL > 38) continue;

      let w = diffL > 22 ? 0.35 : 1.0;
      if (prioritizeSkin) {
        const sw = Math.max(
          computeSkinLikelihood(oL, oA, oB),
          computeSkinLikelihood(aL, aA, aB)
        );
        w *= sw;
      }

      wSum += w;
      meanAiL += w * aL;
      meanAiA += w * aA;
      meanAiB += w * aB;
      meanOrL += w * oL;
      meanOrA += w * oA;
      meanOrB += w * oB;
    }

    if (wSum < 1e-3) {
      return {
        valid: false,
        meanAi: [50, 0, 0],
        meanOr: [50, 0, 0],
        scale: [1, 1, 1],
      };
    }

    meanAiL /= wSum; meanAiA /= wSum; meanAiB /= wSum;
    meanOrL /= wSum; meanOrA /= wSum; meanOrB /= wSum;

    // Pass 2: Weighted standard deviations
    let varAiL = 0, varAiA = 0, varAiB = 0;
    let varOrL = 0, varOrA = 0, varOrB = 0;

    for (let i = 0; i < n; i++) {
      if (subMergeMask[i] !== 1) continue;
      const inCollar = subOrigFaceMask ? subOrigFaceMask[i] === 0 : subDistOut[i] <= bandMax;
      if (!inCollar && subDistOut[i] > bandMax) continue;

      const idx3 = i * 3;
      const aL = aiLab[idx3], aA = aiLab[idx3 + 1], aB = aiLab[idx3 + 2];
      const oL = origLab[idx3], oA = origLab[idx3 + 1], oB = origLab[idx3 + 2];
      const diffL = Math.abs(aL - oL);
      if (diffL > 38) continue;

      let w = diffL > 22 ? 0.35 : 1.0;
      if (prioritizeSkin) {
        w *= Math.max(computeSkinLikelihood(oL, oA, oB), computeSkinLikelihood(aL, aA, aB));
      }

      varAiL += w * (aL - meanAiL) * (aL - meanAiL);
      varAiA += w * (aA - meanAiA) * (aA - meanAiA);
      varAiB += w * (aB - meanAiB) * (aB - meanAiB);

      varOrL += w * (oL - meanOrL) * (oL - meanOrL);
      varOrA += w * (oA - meanOrA) * (oA - meanOrA);
      varOrB += w * (oB - meanOrB) * (oB - meanOrB);
    }

    const clampRatio = (vOr, vAi, minS, maxS) => {
      const sAi = Math.sqrt(vAi / wSum + 1.5);
      const sOr = Math.sqrt(vOr / wSum + 1.5);
      return Math.max(minS, Math.min(maxS, sOr / sAi));
    };

    return {
      valid: true,
      meanAi: [meanAiL, meanAiA, meanAiB],
      meanOr: [meanOrL, meanOrA, meanOrB],
      scale: [
        clampRatio(varOrL, varAiL, 0.78, 1.25),
        clampRatio(varOrA, varAiA, 0.72, 1.32),
        clampRatio(varOrB, varAiB, 0.72, 1.32),
      ],
    };
  }

  /**
   * Applies partial or full CIE L*a*b* Reinhard color harmonization in-place on aiLab
   * and updates the corresponding aiRgba buffer inside subMergeMask.
   *
   * @param {Float32Array} aiLab
   * @param {Uint8ClampedArray} aiRgba
   * @param {Uint8Array} subMergeMask
   * @param {ReturnType<typeof estimateCollarLabTransfer>} stats
   * @param {number} strength 0..1
   */
  function applyLabColorTransfer(aiLab, aiRgba, subMergeMask, stats, strength) {
    if (!stats.valid || strength <= 0.001) return;
    const s = Math.max(0, Math.min(1, strength));
    const [mAiL, mAiA, mAiB] = stats.meanAi;
    const [mOrL, mOrA, mOrB] = stats.meanOr;
    const [sL, sA, sB] = stats.scale;

    const n = subMergeMask.length;
    for (let i = 0; i < n; i++) {
      if (subMergeMask[i] !== 1) continue;
      const idx3 = i * 3;
      const L0 = aiLab[idx3];
      const A0 = aiLab[idx3 + 1];
      const B0 = aiLab[idx3 + 2];

      const Lt = (L0 - mAiL) * sL + mOrL;
      const At = (A0 - mAiA) * sA + mOrA;
      const Bt = (B0 - mAiB) * sB + mOrB;

      const L1 = L0 + (Lt - L0) * s;
      const A1 = A0 + (At - A0) * s;
      const B1 = B0 + (Bt - B0) * s;

      aiLab[idx3] = L1;
      aiLab[idx3 + 1] = A1;
      aiLab[idx3 + 2] = B1;

      labToRgbInto(L1, A1, B1, aiRgba, i * 4);
    }
  }

  // ===========================================================================
  // Multi-Band Laplacian Pyramid Blending (Burt & Adelson)
  // ===========================================================================

  /**
   * Separable 5-tap [1, 4, 6, 4, 1]/16 blur + 2x downsample.
   * @param {Float32Array} src
   * @param {number} sw
   * @param {number} sh
   */
  function pyrDownPlane(src, sw, sh) {
    const dw = Math.max(1, (sw + 1) >> 1);
    const dh = Math.max(1, (sh + 1) >> 1);
    const tmp = new Float32Array(dw * sh);
    const dst = new Float32Array(dw * dh);

    // Horizontal pass
    for (let y = 0; y < sh; y++) {
      const rowIn = y * sw;
      const rowOut = y * dw;
      for (let dx = 0; dx < dw; dx++) {
        const x = dx * 2;
        const xm2 = Math.max(0, x - 2);
        const xm1 = Math.max(0, x - 1);
        const xp1 = Math.min(sw - 1, x + 1);
        const xp2 = Math.min(sw - 1, x + 2);
        tmp[rowOut + dx] =
          (src[rowIn + xm2] +
            4 * src[rowIn + xm1] +
            6 * src[rowIn + x] +
            4 * src[rowIn + xp1] +
            src[rowIn + xp2]) *
          0.0625;
      }
    }

    // Vertical pass
    for (let dy = 0; dy < dh; dy++) {
      const y = dy * 2;
      const ym2 = Math.max(0, y - 2) * dw;
      const ym1 = Math.max(0, y - 1) * dw;
      const y0 = y * dw;
      const yp1 = Math.min(sh - 1, y + 1) * dw;
      const yp2 = Math.min(sh - 1, y + 2) * dw;
      const rowOut = dy * dw;
      for (let dx = 0; dx < dw; dx++) {
        dst[rowOut + dx] =
          (tmp[ym2 + dx] +
            4 * tmp[ym1 + dx] +
            6 * tmp[y0 + dx] +
            4 * tmp[yp1 + dx] +
            tmp[yp2 + dx]) *
          0.0625;
      }
    }

    return { data: dst, w: dw, h: dh };
  }

  /**
   * Bilinear upsample of a coarse plane (sw x sh) to exact target dimensions (tw x th).
   * @param {Float32Array} src
   * @param {number} sw
   * @param {number} sh
   * @param {number} tw
   * @param {number} th
   */
  function pyrUpPlane(src, sw, sh, tw, th) {
    const dst = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
      const gy = y * 0.5;
      const y0 = Math.min(sh - 1, gy | 0);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fy = gy - y0;
      const row0 = y0 * sw;
      const row1 = y1 * sw;
      const outRow = y * tw;

      for (let x = 0; x < tw; x++) {
        const gx = x * 0.5;
        const x0 = Math.min(sw - 1, gx | 0);
        const x1 = Math.min(sw - 1, x0 + 1);
        const fx = gx - x0;

        const v0 = src[row0 + x0] + (src[row0 + x1] - src[row0 + x0]) * fx;
        const v1 = src[row1 + x0] + (src[row1 + x1] - src[row1 + x0]) * fx;
        dst[outRow + x] = v0 + (v1 - v0) * fy;
      }
    }
    return dst;
  }

  /**
   * Pull-Push boundary extrapolation: extends AI pixel colors smoothly outside subMergeMask
   * so coarse pyramid levels never pull dark/unrelated colors across the seam.
   *
   * @param {Float32Array} rPlane
   * @param {Float32Array} gPlane
   * @param {Float32Array} bPlane
   * @param {Uint8Array} validMask
   * @param {number} w
   * @param {number} h
   */
  function extrapolatePlanesPullPush(rPlane, gPlane, bPlane, validMask, w, h) {
    const levels = 5;
    const rPyr = [new Float32Array(w * h)];
    const gPyr = [new Float32Array(w * h)];
    const bPyr = [new Float32Array(w * h)];
    const wPyr = [new Float32Array(w * h)];
    const dims = [{ w, h }];

    for (let i = 0; i < w * h; i++) {
      if (validMask[i] === 1) {
        rPyr[0][i] = rPlane[i];
        gPyr[0][i] = gPlane[i];
        bPyr[0][i] = bPlane[i];
        wPyr[0][i] = 1;
      }
    }

    // Pull (downsample premultiplied)
    for (let lv = 0; lv < levels; lv++) {
      const cw = dims[lv].w;
      const ch = dims[lv].h;
      if (cw <= 2 || ch <= 2) break;
      const nr = pyrDownPlane(rPyr[lv], cw, ch);
      const ng = pyrDownPlane(gPyr[lv], cw, ch);
      const nb = pyrDownPlane(bPyr[lv], cw, ch);
      const nw = pyrDownPlane(wPyr[lv], cw, ch);
      rPyr.push(nr.data);
      gPyr.push(ng.data);
      bPyr.push(nb.data);
      wPyr.push(nw.data);
      dims.push({ w: nr.w, h: nr.h });
    }

    const top = dims.length - 1;
    for (let i = 0; i < rPyr[top].length; i++) {
      const wt = wPyr[top][i];
      if (wt > 1e-5) {
        rPyr[top][i] /= wt;
        gPyr[top][i] /= wt;
        bPyr[top][i] /= wt;
        wPyr[top][i] = 1;
      }
    }

    // Push (upsample & fill unnormalized regions)
    for (let lv = top - 1; lv >= 0; lv--) {
      const tw = dims[lv].w;
      const th = dims[lv].h;
      const cw = dims[lv + 1].w;
      const ch = dims[lv + 1].h;
      const upR = pyrUpPlane(rPyr[lv + 1], cw, ch, tw, th);
      const upG = pyrUpPlane(gPyr[lv + 1], cw, ch, tw, th);
      const upB = pyrUpPlane(bPyr[lv + 1], cw, ch, tw, th);

      const curR = rPyr[lv];
      const curG = gPyr[lv];
      const curB = bPyr[lv];
      const curW = wPyr[lv];

      for (let i = 0; i < tw * th; i++) {
        const wt = curW[i];
        if (wt >= 0.999) {
          curR[i] /= wt;
          curG[i] /= wt;
          curB[i] /= wt;
        } else if (wt > 1e-4) {
          curR[i] = (curR[i] / wt) * wt + upR[i] * (1 - wt);
          curG[i] = (curG[i] / wt) * wt + upG[i] * (1 - wt);
          curB[i] = (curB[i] / wt) * wt + upB[i] * (1 - wt);
        } else {
          curR[i] = upR[i];
          curG[i] = upG[i];
          curB[i] = upB[i];
        }
        curW[i] = 1;
      }
    }

    rPlane.set(rPyr[0]);
    gPlane.set(gPyr[0]);
    bPlane.set(bPyr[0]);
  }

  /**
   * Performs N-level Burt & Adelson Laplacian Pyramid Multi-Band blend on a single channel plane.
   * @param {Float32Array} planeA AI channel
   * @param {Float32Array} planeB Original channel
   * @param {Float32Array[]} weightGaussians Precomputed Gaussian pyramid of blend mask
   * @param {{ w: number, h: number }[]} dims
   */
  function blendSingleChannelPyramid(planeA, planeB, weightGaussians, dims) {
    const numLevels = dims.length;
    const gaussA = [planeA];
    const gaussB = [planeB];

    for (let lv = 0; lv < numLevels - 1; lv++) {
      gaussA.push(pyrDownPlane(gaussA[lv], dims[lv].w, dims[lv].h).data);
      gaussB.push(pyrDownPlane(gaussB[lv], dims[lv].w, dims[lv].h).data);
    }

    const lapOut = new Array(numLevels);
    const last = numLevels - 1;
    const topLen = dims[last].w * dims[last].h;
    lapOut[last] = new Float32Array(topLen);
    for (let i = 0; i < topLen; i++) {
      const w = weightGaussians[last][i];
      lapOut[last][i] = gaussA[last][i] * w + gaussB[last][i] * (1 - w);
    }

    for (let lv = last - 1; lv >= 0; lv--) {
      const tw = dims[lv].w;
      const th = dims[lv].h;
      const cw = dims[lv + 1].w;
      const ch = dims[lv + 1].h;
      const upA = pyrUpPlane(gaussA[lv + 1], cw, ch, tw, th);
      const upB = pyrUpPlane(gaussB[lv + 1], cw, ch, tw, th);

      const cur = new Float32Array(tw * th);
      const wPlane = weightGaussians[lv];
      const gA = gaussA[lv];
      const gB = gaussB[lv];

      for (let i = 0; i < tw * th; i++) {
        const lA = gA[i] - upA[i];
        const lB = gB[i] - upB[i];
        const w = wPlane[i];
        cur[i] = lA * w + lB * (1 - w);
      }
      lapOut[lv] = cur;
    }

    let accum = lapOut[last];
    for (let lv = last - 1; lv >= 0; lv--) {
      const up = pyrUpPlane(accum, dims[lv + 1].w, dims[lv + 1].h, dims[lv].w, dims[lv].h);
      const cur = lapOut[lv];
      for (let i = 0; i < cur.length; i++) {
        cur[i] += up[i];
      }
      accum = cur;
    }
    return accum;
  }

  // ===========================================================================
  // Screened Poisson Seamless Cloning (Harmonic Membrane Solver ∇²Δ - λΔ = 0)
  // ===========================================================================

  /**
   * Solves the Screened Poisson equation on the color difference Δ = Orig - AI:
   *  - Dirichlet BC Δ = Orig - AI along internal seam (adjacent to mergeFaceMask === 0)
   *  - Neumann BC (zero normal flux) along outer image borders (x=0, x=W-1, y=0, y=H-1)
   * Preserves 100% of full-resolution AI skin pores/details while matching boundary colors seamlessly.
   *
   * @param {Uint8ClampedArray} aiRgba (bw * bh * 4)
   * @param {Uint8ClampedArray} origRgba (bw * bh * 4)
   * @param {Uint8Array} subMergeMask (bw * bh)
   * @param {Float32Array} subDistOut (bw * bh)
   * @param {RectBox} box Sub-box inside fullW x fullH
   * @param {number} fullW
   * @param {number} fullH
   * @param {number} reach01 0..1 (1 = pure Poisson across entire face; <1 = Screened Poisson decay)
   * @param {number} safetyFeatherPx Small micro-feather right on the 1-3px edge
   * @param {Uint8ClampedArray} outRgba (bw * bh * 4)
   */
  function solveScreenedPoissonBox(
    aiRgba,
    origRgba,
    subMergeMask,
    subDistOut,
    box,
    fullW,
    fullH,
    reach01,
    safetyFeatherPx,
    outRgba
  ) {
    const bw = box.w;
    const bh = box.h;
    const step = Math.max(1, Math.floor(Math.max(bw, bh) / 180));
    const gw = Math.max(2, Math.ceil(bw / step));
    const gh = Math.max(2, Math.ceil(bh / step));
    const gLen = gw * gh;

    // cellType: 0 = outside mergeFaceMask, 1 = interior unknown, 2 = Dirichlet seam
    const cellType = new Uint8Array(gLen);
    const dR = new Float32Array(gLen);
    const dG = new Float32Array(gLen);
    const dB = new Float32Array(gLen);

    const seamBand = Math.max(1.6, step * 1.35);

    for (let gy = 0; gy < gh; gy++) {
      const sy = Math.min(bh - 1, gy * step);
      for (let gx = 0; gx < gw; gx++) {
        const sx = Math.min(bw - 1, gx * step);
        const sIdx = sy * bw + sx;
        const gIdx = gy * gw + gx;

        if (subMergeMask[sIdx] !== 1) {
          cellType[gIdx] = 0;
          continue;
        }

        const distToBody = subDistOut[sIdx];
        if (distToBody <= seamBand) {
          // Internal seam touching corpoSemBordas -> Dirichlet BC!
          cellType[gIdx] = 2;
          const p4 = sIdx * 4;
          dR[gIdx] = origRgba[p4] - aiRgba[p4];
          dG[gIdx] = origRgba[p4 + 1] - aiRgba[p4 + 1];
          dB[gIdx] = origRgba[p4 + 2] - aiRgba[p4 + 2];
        } else {
          cellType[gIdx] = 1;
        }
      }
    }

    // Ensure every interior cell (1) directly adjacent to an outside cell (0) is promoted to Dirichlet seam (2)
    for (let gy = 0; gy < gh; gy++) {
      const sy = Math.min(bh - 1, gy * step);
      for (let gx = 0; gx < gw; gx++) {
        const gIdx = gy * gw + gx;
        if (cellType[gIdx] !== 1) continue;
        const touchesZero =
          (gx > 0 && cellType[gIdx - 1] === 0) ||
          (gx < gw - 1 && cellType[gIdx + 1] === 0) ||
          (gy > 0 && cellType[gIdx - gw] === 0) ||
          (gy < gh - 1 && cellType[gIdx + gw] === 0);
        if (touchesZero) {
          cellType[gIdx] = 2;
          const sx = Math.min(bw - 1, gx * step);
          const p4 = (sy * bw + sx) * 4;
          dR[gIdx] = origRgba[p4] - aiRgba[p4];
          dG[gIdx] = origRgba[p4 + 1] - aiRgba[p4 + 1];
          dB[gIdx] = origRgba[p4 + 2] - aiRgba[p4 + 2];
        }
      }
    }

    // Screening parameter lambda: 0 at reach=100%, higher as reach decreases
    const invReach = 1 - Math.max(0, Math.min(1, reach01));
    const lambda = invReach * invReach * 0.28 * step * step;
    const omega = 1.82;
    const iterations = 150;

    // Red-Black SOR solver
    for (let iter = 0; iter < iterations; iter++) {
      for (let rb = 0; rb < 2; rb++) {
        for (let gy = 0; gy < gh; gy++) {
          const row = gy * gw;
          const globalTopTouch = box.y + gy * step <= 0;
          const globalBotTouch = box.y + gy * step >= fullH - 1;

          for (let gx = (gy + rb) & 1; gx < gw; gx += 2) {
            const idx = row + gx;
            if (cellType[idx] !== 1) continue;

            let sumR = 0, sumG = 0, sumB = 0;
            let count = 0;

            // Left neighbor
            if (gx > 0) {
              const ni = idx - 1;
              if (cellType[ni] !== 0) {
                sumR += dR[ni]; sumG += dG[ni]; sumB += dB[ni]; count++;
              } else {
                // Directly adjacent to outside -> treat as seam neighbor
                count++;
              }
            } else if (box.x > 0) {
              count++;
            } // else touching x=0 image border -> Neumann (skip so zero flux!)

            // Right neighbor
            if (gx < gw - 1) {
              const ni = idx + 1;
              if (cellType[ni] !== 0) {
                sumR += dR[ni]; sumG += dG[ni]; sumB += dB[ni]; count++;
              } else {
                count++;
              }
            } else if (box.x + bw < fullW) {
              count++;
            }

            // Top neighbor
            if (gy > 0) {
              const ni = idx - gw;
              if (cellType[ni] !== 0) {
                sumR += dR[ni]; sumG += dG[ni]; sumB += dB[ni]; count++;
              } else {
                count++;
              }
            } else if (!globalTopTouch) {
              count++;
            }

            // Bottom neighbor
            if (gy < gh - 1) {
              const ni = idx + gw;
              if (cellType[ni] !== 0) {
                sumR += dR[ni]; sumG += dG[ni]; sumB += dB[ni]; count++;
              } else {
                count++;
              }
            } else if (!globalBotTouch) {
              count++;
            }

            if (count > 0) {
              const denom = count + lambda;
              dR[idx] += omega * (sumR / denom - dR[idx]);
              dG[idx] += omega * (sumG / denom - dG[idx]);
              dB[idx] += omega * (sumB / denom - dB[idx]);
            }
          }
        }
      }
    }

    // Fill outside grid cells with nearest neighbor values so bilinear interpolation near boundary has zero step
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const idx = gy * gw + gx;
        if (cellType[idx] !== 0) continue;
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        if (gx > 0 && cellType[idx - 1] !== 0) { sr += dR[idx - 1]; sg += dG[idx - 1]; sb += dB[idx - 1]; cnt++; }
        if (gx < gw - 1 && cellType[idx + 1] !== 0) { sr += dR[idx + 1]; sg += dG[idx + 1]; sb += dB[idx + 1]; cnt++; }
        if (gy > 0 && cellType[idx - gw] !== 0) { sr += dR[idx - gw]; sg += dG[idx - gw]; sb += dB[idx - gw]; cnt++; }
        if (gy < gh - 1 && cellType[idx + gw] !== 0) { sr += dR[idx + gw]; sg += dG[idx + gw]; sb += dB[idx + gw]; cnt++; }
        if (cnt > 0) {
          dR[idx] = sr / cnt;
          dG[idx] = sg / cnt;
          dB[idx] = sb / cnt;
        }
      }
    }

    const microRamp = Math.max(2, Math.min(10, safetyFeatherPx));

    // Bilinearly apply smooth harmonic membrane Δ onto full-resolution AI image
    for (let y = 0; y < bh; y++) {
      const fyGrid = y / step;
      const y0 = Math.min(gh - 1, fyGrid | 0);
      const y1 = Math.min(gh - 1, y0 + 1);
      const ty = fyGrid - y0;
      const r0 = y0 * gw;
      const r1 = y1 * gw;

      for (let x = 0; x < bw; x++) {
        const sIdx = y * bw + x;
        if (subMergeMask[sIdx] !== 1) continue;

        const fxGrid = x / step;
        const x0 = Math.min(gw - 1, fxGrid | 0);
        const x1 = Math.min(gw - 1, x0 + 1);
        const tx = fxGrid - x0;

        const i00 = r0 + x0, i10 = r0 + x1;
        const i01 = r1 + x0, i11 = r1 + x1;

        const dr0 = dR[i00] + (dR[i10] - dR[i00]) * tx;
        const dr1 = dR[i01] + (dR[i11] - dR[i01]) * tx;
        const deltaR = dr0 + (dr1 - dr0) * ty;

        const dg0 = dG[i00] + (dG[i10] - dG[i00]) * tx;
        const dg1 = dG[i01] + (dG[i11] - dG[i01]) * tx;
        const deltaG = dg0 + (dg1 - dg0) * ty;

        const db0 = dB[i00] + (dB[i10] - dB[i00]) * tx;
        const db1 = dB[i01] + (dB[i11] - dB[i01]) * tx;
        const deltaB = db0 + (db1 - db0) * ty;

        const p4 = sIdx * 4;
        const pr = Math.max(0, Math.min(255, Math.round(aiRgba[p4] + deltaR)));
        const pg = Math.max(0, Math.min(255, Math.round(aiRgba[p4 + 1] + deltaG)));
        const pb = Math.max(0, Math.min(255, Math.round(aiRgba[p4 + 2] + deltaB)));

        // Micro-feather right on the 1..microRamp outer pixels to absorb sub-grid quantization
        const d = subDistOut[sIdx];
        if (d < microRamp) {
          const w = smoothstep(0, microRamp, d);
          outRgba[p4] = Math.round(pr * w + origRgba[p4] * (1 - w));
          outRgba[p4 + 1] = Math.round(pg * w + origRgba[p4 + 1] * (1 - w));
          outRgba[p4 + 2] = Math.round(pb * w + origRgba[p4 + 2] * (1 - w));
        } else {
          outRgba[p4] = pr;
          outRgba[p4 + 1] = pg;
          outRgba[p4 + 2] = pb;
        }
        outRgba[p4 + 3] = Math.max(aiRgba[p4 + 3], origRgba[p4 + 3]);
      }
    }
  }

  // ===========================================================================
  // Master Entry Point: Advanced Final Seam & Skin-Tone Merge
  // ===========================================================================

  /**
   * Merges (face + bordas precisas) + (corpo sem bordas imprecisas) into imagemFinal
   * using the selected seam & skin-tone harmonization technique.
   *
   * @param {{
   *   facePreciseCanvas: HTMLCanvasElement,
   *   corpoSemBordasCanvas: HTMLCanvasElement,
   *   origFullCanvas: HTMLCanvasElement,
   *   mergeFaceMask: Uint8Array,
   *   origFaceMask1: Uint8Array | null,
   *   edtToOutsideSq: Float32Array | null,
   *   edtInsideOrigFaceSq: Float32Array | null,
   *   mergeBox: RectBox | null,
   *   options: FinalMergeOptions
   * }} params
   * @returns {HTMLCanvasElement}
   */
  function mergeFinalAdvanced(params) {
    const {
      facePreciseCanvas,
      corpoSemBordasCanvas,
      origFullCanvas,
      mergeFaceMask,
      origFaceMask1,
      edtToOutsideSq,
      edtInsideOrigFaceSq,
      mergeBox,
      options,
    } = params;

    const Ops = global.SplitMergeImageOps;
    const W = corpoSemBordasCanvas.width;
    const H = corpoSemBordasCanvas.height;

    const mode = options.mode || 'none';
    const radiusPx = Math.max(0, options.radiusPx || 0);
    const colorStrength = Math.max(0, Math.min(1, options.colorMatchStrength || 0));

    // Fast path: exact crisp union when mode === 'none' and no color correction requested
    if ((mode === 'none' || (radiusPx <= 0 && mode !== 'poisson' && mode !== 'lab_skin')) && colorStrength <= 0.001) {
      return Ops.uniteByComplementaryMask(facePreciseCanvas, corpoSemBordasCanvas, mergeFaceMask);
    }

    const outCanvas = Ops.createCanvas(W, H);
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
    const cleanCtx = corpoSemBordasCanvas.getContext('2d', { willReadFrequently: true });
    const faceCtx = facePreciseCanvas.getContext('2d', { willReadFrequently: true });
    const origCtx = origFullCanvas.getContext('2d', { willReadFrequently: true });

    if (!outCtx || !cleanCtx || !faceCtx || !origCtx || !edtToOutsideSq) {
      return Ops.uniteByComplementaryMask(facePreciseCanvas, corpoSemBordasCanvas, mergeFaceMask);
    }

    // Start output from (corpo sem bordas imprecisas) on the full frame
    outCtx.drawImage(corpoSemBordasCanvas, 0, 0);

    // Restrict computation to padded bounding box of mergeFaceMask for high speed
    const pad = Math.max(8, Math.ceil(radiusPx) + 6);
    const rawBox = mergeBox || { x: 0, y: 0, w: W, h: H };
    const bx = Math.max(0, rawBox.x - pad);
    const by = Math.max(0, rawBox.y - pad);
    const bw = Math.min(W - bx, rawBox.w + pad * 2);
    const bh = Math.min(H - by, rawBox.h + pad * 2);
    if (bw <= 0 || bh <= 0) return outCanvas;

    const subLen = bw * bh;
    const outImgData = outCtx.getImageData(bx, by, bw, bh);
    const outRgba = outImgData.data;
    const aiRgba = faceCtx.getImageData(bx, by, bw, bh).data;
    const origRgba = origCtx.getImageData(bx, by, bw, bh).data;

    const subMergeMask = new Uint8Array(subLen);
    const subOrigFace = origFaceMask1 ? new Uint8Array(subLen) : null;
    const subDistOut = new Float32Array(subLen);
    const subDistCore = edtInsideOrigFaceSq ? new Float32Array(subLen) : null;

    for (let y = 0; y < bh; y++) {
      const fullRow = (by + y) * W + bx;
      const subRow = y * bw;
      for (let x = 0; x < bw; x++) {
        const fi = fullRow + x;
        const si = subRow + x;
        subMergeMask[si] = mergeFaceMask[fi];
        if (subOrigFace && origFaceMask1) subOrigFace[si] = origFaceMask1[fi];
        subDistOut[si] = Math.sqrt(edtToOutsideSq[fi]);
        if (subDistCore && edtInsideOrigFaceSq) {
          subDistCore[si] = Math.sqrt(edtInsideOrigFaceSq[fi]);
        }

        // Fill any transparent padding holes inside mergeFaceMask with origRgba so black never leaks
        if (subMergeMask[si] === 1) {
          const p4 = si * 4;
          const a = aiRgba[p4 + 3];
          if (a === 0) {
            aiRgba[p4] = origRgba[p4];
            aiRgba[p4 + 1] = origRgba[p4 + 1];
            aiRgba[p4 + 2] = origRgba[p4 + 2];
            aiRgba[p4 + 3] = origRgba[p4 + 3];
          } else if (a < 255) {
            const wa = a / 255;
            aiRgba[p4] = Math.round(aiRgba[p4] * wa + origRgba[p4] * (1 - wa));
            aiRgba[p4 + 1] = Math.round(aiRgba[p4 + 1] * wa + origRgba[p4 + 1] * (1 - wa));
            aiRgba[p4 + 2] = Math.round(aiRgba[p4 + 2] * wa + origRgba[p4 + 2] * (1 - wa));
            aiRgba[p4 + 3] = 255;
          }
        }
      }
    }

    // Compute CIE L*a*b* buffers when needed (color harmonization, lab_skin, luma_chroma, edge_aware)
    const effectiveColorMatch =
      mode === 'lab_skin' ? Math.max(0.85, colorStrength) : colorStrength;
    const needsLab =
      effectiveColorMatch > 0.001 || mode === 'luma_chroma' || mode === 'edge_aware';

    /** @type {Float32Array | null} */
    let aiLab = null;
    /** @type {Float32Array | null} */
    let origLab = null;

    if (needsLab) {
      aiLab = new Float32Array(subLen * 3);
      origLab = new Float32Array(subLen * 3);
      for (let i = 0; i < subLen; i++) {
        const p4 = i * 4;
        const i3 = i * 3;
        rgbToLabInto(origRgba[p4], origRgba[p4 + 1], origRgba[p4 + 2], origLab, i3);
        if (subMergeMask[i] === 1) {
          rgbToLabInto(aiRgba[p4], aiRgba[p4 + 1], aiRgba[p4 + 2], aiLab, i3);
        }
      }

      if (effectiveColorMatch > 0.001) {
        const stats = estimateCollarLabTransfer(
          aiLab,
          origLab,
          subMergeMask,
          subOrigFace,
          subDistOut,
          Math.max(16, radiusPx),
          options.prioritizeSkin
        );
        applyLabColorTransfer(aiLab, aiRgba, subMergeMask, stats, effectiveColorMatch);
      }
    }

    /**
     * Helper computing spatial weight w in [0..1] (0 = original body, 1 = AI face)
     * with optional protection of inner core face features.
     * @param {number} si
     * @param {number} rBand
     */
    const spatialWeight = (si, rBand) => {
      if (subMergeMask[si] !== 1) return 0;
      if (rBand <= 0.01) return 1;
      const dOut = subDistOut[si];
      let w = smoothstep(0, rBand, dOut);
      if (options.protectCoreFace && subOrigFace && subOrigFace[si] === 1 && subDistCore) {
        // Allow gentle 6px transition across original cut line, then lock to 100% AI face
        const coreLock = smoothstep(0, 8, subDistCore[si]);
        w = w + (1 - w) * coreLock;
      }
      return w;
    };

    // =========================================================================
    // Mode Dispatch
    // =========================================================================

    if (mode === 'none' || (radiusPx <= 0 && mode !== 'poisson')) {
      for (let i = 0; i < subLen; i++) {
        if (subMergeMask[i] === 1) {
          const p4 = i * 4;
          outRgba[p4] = aiRgba[p4];
          outRgba[p4 + 1] = aiRgba[p4 + 1];
          outRgba[p4 + 2] = aiRgba[p4 + 2];
          outRgba[p4 + 3] = aiRgba[p4 + 3];
        }
      }
    } else if (mode === 'feather' || mode === 'lab_skin') {
      const rEff = Math.max(1, radiusPx);
      for (let i = 0; i < subLen; i++) {
        if (subMergeMask[i] !== 1) continue;
        const w = spatialWeight(i, rEff);
        const inv = 1 - w;
        const p4 = i * 4;
        outRgba[p4] = Math.round(aiRgba[p4] * w + origRgba[p4] * inv);
        outRgba[p4 + 1] = Math.round(aiRgba[p4 + 1] * w + origRgba[p4 + 1] * inv);
        outRgba[p4 + 2] = Math.round(aiRgba[p4 + 2] * w + origRgba[p4 + 2] * inv);
        outRgba[p4 + 3] = Math.round(aiRgba[p4 + 3] * w + origRgba[p4 + 3] * inv);
      }
    } else if (mode === 'luma_chroma' && aiLab && origLab) {
      // Wide transition on Chroma (a*, b* - skin tone/color), crisp narrower transition on Luminance (L* - detail)
      const rChroma = Math.max(4, radiusPx * 1.65);
      const rLuma = Math.max(1.5, radiusPx * 0.45);
      for (let i = 0; i < subLen; i++) {
        if (subMergeMask[i] !== 1) continue;
        const wL = spatialWeight(i, rLuma);
        const wC = spatialWeight(i, rChroma);
        const i3 = i * 3;
        const L = aiLab[i3] * wL + origLab[i3] * (1 - wL);
        const A = aiLab[i3 + 1] * wC + origLab[i3 + 1] * (1 - wC);
        const B = aiLab[i3 + 2] * wC + origLab[i3 + 2] * (1 - wC);
        const p4 = i * 4;
        labToRgbInto(L, A, B, outRgba, p4);
        outRgba[p4 + 3] = Math.max(aiRgba[p4 + 3], origRgba[p4 + 3]);
      }
    } else if (mode === 'edge_aware' && aiLab && origLab) {
      // Wide blend on similar skin tones, tight anti-ghosting transition across high-contrast structural edges
      const rWide = Math.max(4, radiusPx * 1.35);
      const rTight = Math.max(1.5, radiusPx * 0.28);
      for (let i = 0; i < subLen; i++) {
        if (subMergeMask[i] !== 1) continue;
        const i3 = i * 3;
        const dL = Math.abs(aiLab[i3] - origLab[i3]);
        const dC = Math.hypot(aiLab[i3 + 1] - origLab[i3 + 1], aiLab[i3 + 2] - origLab[i3 + 2]);
        // High luminance jump (>18) indicates structural edge (hair/collar) -> tighten radius to avoid ghosting!
        // Moderate chrominance difference with low dL indicates skin-tone shift -> keep wide radius!
        const edgeFactor = smoothstep(8, 28, dL - dC * 0.25);
        const localR = rWide * (1 - edgeFactor) + rTight * edgeFactor;
        const w = spatialWeight(i, localR);
        const inv = 1 - w;
        const p4 = i * 4;
        outRgba[p4] = Math.round(aiRgba[p4] * w + origRgba[p4] * inv);
        outRgba[p4 + 1] = Math.round(aiRgba[p4 + 1] * w + origRgba[p4 + 1] * inv);
        outRgba[p4 + 2] = Math.round(aiRgba[p4 + 2] * w + origRgba[p4 + 2] * inv);
        outRgba[p4 + 3] = Math.round(aiRgba[p4 + 3] * w + origRgba[p4 + 3] * inv);
      }
    } else if (mode === 'multiband') {
      const rEff = Math.max(4, radiusPx);
      const rA = new Float32Array(subLen);
      const gA = new Float32Array(subLen);
      const bA = new Float32Array(subLen);
      const rB = new Float32Array(subLen);
      const gB = new Float32Array(subLen);
      const bB = new Float32Array(subLen);
      const w0 = new Float32Array(subLen);

      for (let i = 0; i < subLen; i++) {
        const p4 = i * 4;
        rB[i] = origRgba[p4];
        gB[i] = origRgba[p4 + 1];
        bB[i] = origRgba[p4 + 2];
        if (subMergeMask[i] === 1) {
          rA[i] = aiRgba[p4];
          gA[i] = aiRgba[p4 + 1];
          bA[i] = aiRgba[p4 + 2];
          // Center sharp detail seam around 0.45 * rEff while coarse levels spread over [0..rEff]
          const d = subDistOut[i];
          let w = smoothstep(rEff * 0.2, rEff * 0.85, d);
          if (options.protectCoreFace && subOrigFace && subOrigFace[i] === 1 && subDistCore) {
            const coreLock = smoothstep(0, 8, subDistCore[i]);
            w = w + (1 - w) * coreLock;
          }
          w0[i] = w;
        }
      }

      // Smoothly extrapolate AI colors outside subMergeMask so pyramid never bleeds dark edges
      extrapolatePlanesPullPush(rA, gA, bA, subMergeMask, bw, bh);

      // Build Gaussian pyramid of weight mask (4 to 5 octaves depending on radius & size)
      const maxLevels = rEff >= 28 ? 5 : 4;
      const wGauss = [w0];
      const dims = [{ w: bw, h: bh }];
      for (let lv = 0; lv < maxLevels - 1; lv++) {
        if (dims[lv].w <= 4 || dims[lv].h <= 4) break;
        const down = pyrDownPlane(wGauss[lv], dims[lv].w, dims[lv].h);
        wGauss.push(down.data);
        dims.push({ w: down.w, h: down.h });
      }

      const outR = blendSingleChannelPyramid(rA, rB, wGauss, dims);
      const outG = blendSingleChannelPyramid(gA, gB, wGauss, dims);
      const outB = blendSingleChannelPyramid(bA, bB, wGauss, dims);

      const outerTaper = Math.max(3, Math.min(10, rEff * 0.25));
      for (let i = 0; i < subLen; i++) {
        if (subMergeMask[i] !== 1) continue;
        const p4 = i * 4;
        let mr = Math.max(0, Math.min(255, outR[i]));
        let mg = Math.max(0, Math.min(255, outG[i]));
        let mb = Math.max(0, Math.min(255, outB[i]));

        // Guarantee exact C1 continuity with untouched corpoSemBordas right at d = 0
        const d = subDistOut[i];
        if (d < outerTaper) {
          const env = smoothstep(0, outerTaper, d);
          mr = mr * env + origRgba[p4] * (1 - env);
          mg = mg * env + origRgba[p4 + 1] * (1 - env);
          mb = mb * env + origRgba[p4 + 2] * (1 - env);
        }

        outRgba[p4] = Math.round(mr);
        outRgba[p4 + 1] = Math.round(mg);
        outRgba[p4 + 2] = Math.round(mb);
        outRgba[p4 + 3] = Math.max(aiRgba[p4 + 3], origRgba[p4 + 3]);
      }
    } else if (mode === 'poisson') {
      solveScreenedPoissonBox(
        aiRgba,
        origRgba,
        subMergeMask,
        subDistOut,
        { x: bx, y: by, w: bw, h: bh },
        W,
        H,
        options.poissonReach,
        Math.max(2, radiusPx * 0.25),
        outRgba
      );
    }

    outCtx.putImageData(outImgData, bx, by);
    return outCanvas;
  }

  global.SplitMergeSeam = {
    mergeFinalAdvanced,
  };
})(window);
