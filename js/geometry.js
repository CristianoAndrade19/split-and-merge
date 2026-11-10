// @ts-check
/// <reference path="./types.js" />

(function (global) {
  'use strict';

  /**
   * @param {Point} a
   * @param {Point} b
   */
  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  /**
   * @param {Point[]} pts
   */
  function polylineLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += dist(pts[i - 1], pts[i]);
    }
    return len;
  }

  /**
   * Signed/unsigned area of a 2D polygon via shoelace formula.
   * @param {Point[]} poly
   */
  function polygonArea(poly) {
    if (!poly || poly.length < 3) return 0;
    let sum = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) * 0.5;
  }

  /**
   * @param {Point} p
   * @param {number} W
   * @param {number} H
   */
  function isInsideRect(p, W, H) {
    return p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
  }

  /**
   * @param {Point} p
   * @param {number} W
   * @param {number} H
   */
  function isStrictlyInsideRect(p, W, H) {
    return p.x > 1e-4 && p.x < W - 1e-4 && p.y > 1e-4 && p.y < H - 1e-4;
  }

  /**
   * Nearest point on the border of [0, W] x [0, H] and Euclidean distance to that border.
   * Works for points both inside and outside the rectangle.
   * @param {Point} p
   * @param {number} W
   * @param {number} H
   */
  function nearestPointOnBorder(p, W, H) {
    const cx = Math.max(0, Math.min(W, p.x));
    const cy = Math.max(0, Math.min(H, p.y));
    // If point was outside or on the border, clamping lands directly on the border.
    if (p.x <= 0 || p.x >= W || p.y <= 0 || p.y >= H) {
      return { point: { x: cx, y: cy }, distance: Math.hypot(p.x - cx, p.y - cy) };
    }
    // Point is strictly inside: find closest of the 4 edges
    const dLeft = p.x;
    const dRight = W - p.x;
    const dTop = p.y;
    const dBottom = H - p.y;
    const minD = Math.min(dLeft, dRight, dTop, dBottom);
    if (minD === dLeft) return { point: { x: 0, y: p.y }, distance: dLeft };
    if (minD === dRight) return { point: { x: W, y: p.y }, distance: dRight };
    if (minD === dTop) return { point: { x: p.x, y: 0 }, distance: dTop };
    return { point: { x: p.x, y: H }, distance: dBottom };
  }

  /**
   * Liang-Barsky exact clipping of segment a -> b to rectangle [0, W] x [0, H].
   * @param {Point} a
   * @param {Point} b
   * @param {number} W
   * @param {number} H
   */
  function clipSegmentToRect(a, b, W, H) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;

    const p = [-dx, dx, -dy, dy];
    const q = [a.x, W - a.x, a.y, H - a.y];

    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] < 0) return { hit: false, t0: 0, t1: 0, p0: a, p1: b };
      } else {
        const r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return { hit: false, t0: 0, t1: 0, p0: a, p1: b };
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return { hit: false, t0: 0, t1: 0, p0: a, p1: b };
          if (r < t1) t1 = r;
        }
      }
    }

    const p0 = {
      x: Math.max(0, Math.min(W, a.x + t0 * dx)),
      y: Math.max(0, Math.min(H, a.y + t0 * dy)),
    };
    const p1 = {
      x: Math.max(0, Math.min(W, a.x + t1 * dx)),
      y: Math.max(0, Math.min(H, a.y + t1 * dy)),
    };

    // Snap very small floating-point drift onto exact border coordinates
    const eps = 1e-5;
    if (Math.abs(p0.x) < eps) p0.x = 0;
    if (Math.abs(p0.x - W) < eps) p0.x = W;
    if (Math.abs(p0.y) < eps) p0.y = 0;
    if (Math.abs(p0.y - H) < eps) p0.y = H;

    if (Math.abs(p1.x) < eps) p1.x = 0;
    if (Math.abs(p1.x - W) < eps) p1.x = W;
    if (Math.abs(p1.y) < eps) p1.y = 0;
    if (Math.abs(p1.y - H) < eps) p1.y = H;

    return { hit: true, t0, t1, p0, p1 };
  }

  /**
   * Clockwise perimeter coordinate t in [0, 2W + 2H) for a point p on the border of [0, W] x [0, H].
   * @param {Point} rawP
   * @param {number} W
   * @param {number} H
   */
  function perimeterCoord(rawP, W, H) {
    const p = nearestPointOnBorder(rawP, W, H).point;
    const eps = 1e-4;
    if (Math.abs(p.y) <= eps) {
      return Math.max(0, Math.min(W, p.x)); // Top edge: (0,0) -> (W,0)
    }
    if (Math.abs(p.x - W) <= eps) {
      return W + Math.max(0, Math.min(H, p.y)); // Right edge: (W,0) -> (W,H)
    }
    if (Math.abs(p.y - H) <= eps) {
      return W + H + Math.max(0, Math.min(W, W - p.x)); // Bottom edge: (W,H) -> (0,H)
    }
    return 2 * W + H + Math.max(0, Math.min(H, H - p.y)); // Left edge: (0,H) -> (0,0)
  }

  /**
   * Builds a closed polygon inside [0, W] x [0, H] from a border-to-border cut polyline
   * whose first and last points lie on the boundary of [0, W] x [0, H].
   * Works whether P_in and P_out lie on opposite, adjacent, or the exact same edge.
   *
   * @param {Point[]} cutPath
   * @param {number} W
   * @param {number} H
   * @returns {Point[]}
   */
  function buildBorderCutPolygon(cutPath, W, H) {
    if (!cutPath || cutPath.length < 2) return [];
    const pIn = nearestPointOnBorder(cutPath[0], W, H).point;
    const pOut = nearestPointOnBorder(cutPath[cutPath.length - 1], W, H).point;

    const perim = 2 * (W + H);
    const tIn = perimeterCoord(pIn, W, H);
    const tOut = perimeterCoord(pOut, W, H);
    const spanCW = (tIn - tOut + perim) % perim;

    const corners = [
      { pt: { x: 0, y: 0 }, t: 0 },
      { pt: { x: W, y: 0 }, t: W },
      { pt: { x: W, y: H }, t: W + H },
      { pt: { x: 0, y: H }, t: 2 * W + H },
    ];

    const between = [];
    for (const c of corners) {
      const d = (c.t - tOut + perim) % perim;
      if (d > 1e-4 && d < spanCW - 1e-4) {
        between.push({ pt: c.pt, d });
      }
    }
    between.sort((a, b) => a.d - b.d);

    const poly = [pIn];
    for (let i = 1; i < cutPath.length - 1; i++) {
      poly.push({
        x: Math.max(0, Math.min(W, cutPath[i].x)),
        y: Math.max(0, Math.min(H, cutPath[i].y)),
      });
    }
    poly.push(pOut);
    for (const b of between) {
      poly.push(b.pt);
    }
    return poly;
  }

  /**
   * Exact intersection of proper line segments p1-p2 and p3-p4.
   * @param {Point} p1
   * @param {Point} p2
   * @param {Point} p3
   * @param {Point} p4
   * @returns {Point | null}
   */
  function segmentsIntersect(p1, p2, p3, p4) {
    const s1x = p2.x - p1.x;
    const s1y = p2.y - p1.y;
    const s2x = p4.x - p3.x;
    const s2y = p4.y - p3.y;

    const denom = -s2x * s1y + s1x * s2y;
    if (Math.abs(denom) < 1e-10) return null;

    const s = (-s1y * (p1.x - p3.x) + s1x * (p1.y - p3.y)) / denom;
    const t = (s2x * (p1.y - p3.y) - s2y * (p1.x - p3.x)) / denom;

    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
      return {
        x: p1.x + t * s1x,
        y: p1.y + t * s1y,
      };
    }
    return null;
  }

  /**
   * Analyzes a freehand mouse stroke (while holding mouse or on mouse release)
   * to detect either:
   *  1) Border-to-border cut ("vir de fora da imagem e ao tocar 2 bordas, determina a selecao")
   *  2) Closed lasso ("ao fechar um laco")
   *
   * @param {Point[]} pts Points in image pixel coordinates
   * @param {number} W Image width
   * @param {number} H Image height
   * @param {number} viewScale Viewport zoom (screen px per image px)
   * @param {boolean} isFinalRelease True on pointerup
   * @returns {{
   *   completed: SelectionShape | null,
   *   preview: {
   *     pIn: Point | null,
   *     nearStart: boolean,
   *     startedOutsideOrBorder: boolean
   *   }
   * }}
   */
  function analyzeStrokeProgress(pts, W, H, viewScale, isFinalRelease) {
    const scale = Math.max(0.05, viewScale || 1);
    const px = (screenPx) => screenPx / scale;

    if (!pts || pts.length < 2) {
      const startBorder = pts && pts[0] ? nearestPointOnBorder(pts[0], W, H) : null;
      const startedOut = pts && pts[0]
        ? (!isStrictlyInsideRect(pts[0], W, H) || (startBorder ? startBorder.distance <= px(10) : false))
        : false;
      return {
        completed: null,
        preview: { pIn: null, nearStart: false, startedOutsideOrBorder: startedOut },
      };
    }

    const imgArea = W * H;
    const minValidArea = Math.max(16, imgArea * 0.0004); // >= 0.04% of image area prevents accidental corner grazes
    const minCutImgLen = Math.max(4, Math.min(W, H) * 0.012, px(12));

    const first = pts[0];
    const firstBorder = nearestPointOnBorder(first, W, H);
    const startedOutside = !isStrictlyInsideRect(first, W, H);
    const startedOnBorder = !startedOutside && firstBorder.distance <= px(10);
    const startedOutsideOrBorder = startedOutside || startedOnBorder;

    // -------------------------------------------------------------------------
    // 1. Check Border-to-Border Cut
    // -------------------------------------------------------------------------
    /** @type {Point[] | null} */
    let activeCut = null;
    let movedAwayFromStartBorder = startedOutside;

    if (startedOnBorder) {
      activeCut = [firstBorder.point];
    }

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const clip = clipSegmentToRect(a, b, W, H);

      if (!clip.hit) {
        // Completely outside the image rectangle
        continue;
      }

      const enteredFromOutside = clip.t0 > 1e-6 || (i === 1 && !isStrictlyInsideRect(a, W, H));
      const exitedToOutside = clip.t1 < 1 - 1e-6;

      if (enteredFromOutside && (!activeCut || activeCut.length === 0)) {
        activeCut = [clip.p0];
        movedAwayFromStartBorder = true;
      }

      if (activeCut) {
        const lastPt = activeCut[activeCut.length - 1];
        if (dist(lastPt, clip.p0) > 0.25 && enteredFromOutside && activeCut.length === 1) {
          activeCut[0] = clip.p0;
        }
        if (dist(activeCut[activeCut.length - 1], clip.p1) > 0.2) {
          activeCut.push(clip.p1);
        }

        if (!movedAwayFromStartBorder) {
          const dBorder = nearestPointOnBorder(clip.p1, W, H).distance;
          if (dBorder > px(12)) movedAwayFromStartBorder = true;
        }

        // Did we touch a 2nd border? Either segment exited to outside OR reached within 2 screen px of border
        const endBorder = nearestPointOnBorder(clip.p1, W, H);
        const touchedSecondBorder =
          exitedToOutside ||
          (movedAwayFromStartBorder &&
            startedOutsideOrBorder &&
            i === pts.length - 1 &&
            endBorder.distance <= px(2.5) &&
            dist(activeCut[0], endBorder.point) >= minCutImgLen);

        if (touchedSecondBorder && startedOutsideOrBorder) {
          const finalCut = activeCut.slice();
          finalCut[0] = nearestPointOnBorder(finalCut[0], W, H).point;
          finalCut[finalCut.length - 1] = endBorder.point;

          const cutLen = polylineLength(finalCut);
          const poly = buildBorderCutPolygon(finalCut, W, H);
          const areaA = polygonArea(poly);
          const minSideArea = Math.min(areaA, Math.max(0, imgArea - areaA));

          if (cutLen >= minCutImgLen && minSideArea >= minValidArea) {
            return {
              completed: {
                type: 'border-cut',
                polygon: poly,
                cutPath: finalCut,
                pIn: finalCut[0],
                pOut: finalCut[finalCut.length - 1],
              },
              preview: {
                pIn: finalCut[0],
                nearStart: false,
                startedOutsideOrBorder,
              },
            };
          } else if (exitedToOutside) {
            // Tiny corner nick from outside: ignore and wait for real entry
            activeCut = null;
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. Check Closed Lasso (touching start point or loop self-intersection)
    // -------------------------------------------------------------------------
    const totalImgLen = polylineLength(pts);
    const totalScreenLen = totalImgLen * scale;
    const last = pts[pts.length - 1];
    const distToStartScreen = dist(last, first) * scale;
    const closeThresholdScreen = 16;
    const nearStart = totalScreenLen >= 45 && distToStartScreen <= closeThresholdScreen;

    if (nearStart) {
      const loopPoly = pts.concat([first]);
      if (polygonArea(loopPoly) >= minValidArea) {
        return {
          completed: {
            type: 'lasso',
            polygon: loopPoly,
            cutPath: loopPoly,
          },
          preview: {
            pIn: activeCut ? activeCut[0] : null,
            nearStart: true,
            startedOutsideOrBorder,
          },
        };
      }
    }

    // Self-intersection closure on latest segment (e.g. drawing a loop and crossing own tail)
    if (pts.length >= 10 && !startedOutside) {
      const k = pts.length - 1;
      const segA = pts[k - 1];
      const segB = pts[k];
      for (let m = 1; m <= k - 6; m++) {
        const hit = segmentsIntersect( pts[m - 1], pts[m], segA, segB );
        if (hit) {
          const subLoop = [hit, ...pts.slice(m, k), hit];
          const loopScreenPerim = polylineLength(subLoop) * scale;
          const loopArea = polygonArea(subLoop);
          if (loopScreenPerim >= 65 && loopArea >= imgArea * 0.0025) {
            return {
              completed: {
                type: 'lasso',
                polygon: subLoop,
                cutPath: subLoop,
              },
              preview: {
                pIn: activeCut ? activeCut[0] : null,
                nearStart: true,
                startedOutsideOrBorder,
              },
            };
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Fallback completion on mouse release (pointerup)
    // -------------------------------------------------------------------------
    if (isFinalRelease && totalScreenLen >= 36) {
      const startB = nearestPointOnBorder(first, W, H);
      const endB = nearestPointOnBorder(last, W, H);

      // Case 3a: User started/ended very close to borders (within 24 screen px)
      if (startB.distance <= px(24) && endB.distance <= px(24) && dist(startB.point, endB.point) >= minCutImgLen) {
        /** @type {Point[]} */
        const snappedCut = [startB.point];
        for (let i = 0; i < pts.length; i++) {
          if (isInsideRect(pts[i], W, H)) {
            snappedCut.push(pts[i]);
          } else if (i > 0) {
            const c = clipSegmentToRect(pts[i - 1], pts[i], W, H);
            if (c.hit) {
              snappedCut.push(c.p0, c.p1);
            }
          }
        }
        snappedCut.push(endB.point);
        const poly = buildBorderCutPolygon(snappedCut, W, H);
        const areaA = polygonArea(poly);
        if (Math.min(areaA, Math.max(0, imgArea - areaA)) >= minValidArea) {
          return {
            completed: {
              type: 'border-cut',
              polygon: poly,
              cutPath: snappedCut,
              pIn: startB.point,
              pOut: endB.point,
            },
            preview: { pIn: startB.point, nearStart: false, startedOutsideOrBorder },
          };
        }
      }

      // Case 3b: User drew an almost-closed lasso inside and released mouse
      if (pts.length >= 4 && (!startedOutside || distToStartScreen <= 45)) {
        const closedPoly = pts.concat([first]);
        if (polygonArea(closedPoly) >= minValidArea) {
          return {
            completed: {
              type: 'lasso',
              polygon: closedPoly,
              cutPath: closedPoly,
            },
            preview: { pIn: null, nearStart: true, startedOutsideOrBorder },
          };
        }
      }
    }

    return {
      completed: null,
      preview: {
        pIn: activeCut ? activeCut[0] : null,
        nearStart,
        startedOutsideOrBorder,
      },
    };
  }

  /**
   * Rasterizes a polygon onto a crisp binary mask Uint8Array(W * H) of 0s and 1s.
   * Thresholding at alpha >= 128 guarantees that mask and (1 - mask) form an exact
   * partition of unity with zero 1-pixel anti-aliasing gap when reunited.
   *
   * @param {Point[]} polygon
   * @param {number} W
   * @param {number} H
   * @returns {Uint8Array}
   */
  function rasterizePolygonMask(polygon, W, H) {
    const mask = new Uint8Array(W * H);
    if (!polygon || polygon.length < 3 || W <= 0 || H <= 0) return mask;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return mask;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fill('evenodd');

    const data = ctx.getImageData(0, 0, W, H).data;
    const total = W * H;
    for (let i = 0; i < total; i++) {
      mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    }
    return mask;
  }

  /**
   * Smart initial guess for which region of rawMask (1 vs 0) is the Face vs Body.
   * Returns true if rawMask === 1 should be Face, or false if rawMask === 0 should be Face.
   *
   * @param {Uint8Array} rawMask
   * @param {number} W
   * @param {number} H
   * @returns {boolean}
   */
  function guessFaceIsOne(rawMask, W, H) {
    let count1 = 0;
    let sumY1 = 0;
    let count0 = 0;
    let sumY0 = 0;

    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (rawMask[row + x] === 1) {
          count1++;
          sumY1 += y;
        } else {
          count0++;
          sumY0 += y;
        }
      }
    }

    if (count1 === 0) return false;
    if (count0 === 0) return true;

    const total = W * H;
    const frac1 = count1 / total;
    const cy1 = sumY1 / count1;
    const cy0 = sumY0 / count0;

    // If one side is clearly a smaller enclosed/cut region (< 38%) and also not near the very bottom
    if (frac1 < 0.38 && cy1 <= cy0 + H * 0.15) return true;
    if (1 - frac1 < 0.38 && cy0 <= cy1 + H * 0.15) return false;

    // Otherwise, Face is typically higher up in the image (smaller Y coordinate)
    return cy1 <= cy0;
  }

  /**
   * Determines whether rawMask === 1 or rawMask === 0 has more overlap with referenceFaceMask.
   * Used when user draws a new custom cut on imagemMerge so Face+Borders automatically picks the face side.
   *
   * @param {Uint8Array} rawMask
   * @param {Uint8Array} referenceFaceMask
   * @returns {boolean}
   */
  function matchMaskSideToReference(rawMask, referenceFaceMask) {
    let overlap1 = 0;
    let overlap0 = 0;
    const n = Math.min(rawMask.length, referenceFaceMask.length);
    for (let i = 0; i < n; i++) {
      if (referenceFaceMask[i] === 1) {
        if (rawMask[i] === 1) overlap1++;
        else overlap0++;
      }
    }
    return overlap1 >= overlap0;
  }

  // ===========================================================================
  // Exact Linear-Time O(W*H) 2D Squared Euclidean Distance Transform
  // (Felzenszwalb & Huttenlocher 2012)
  // ===========================================================================

  const EDT_INF = 1e10; // Safe from overflow & NaN in Float64 arithmetic

  /**
   * 1D squared Euclidean Distance Transform.
   * @param {Float64Array} f
   * @param {Float64Array} d
   * @param {Int32Array} v
   * @param {Float64Array} z
   * @param {number} n
   */
  function edt1d(f, d, v, z, n) {
    let k = 0;
    v[0] = 0;
    z[0] = -1e20;
    z[1] = 1e20;

    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = 1e20;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      d[q] = dx * dx + f[v[k]];
    }
  }

  /**
   * Computes exact squared Euclidean distance from every pixel to the nearest pixel
   * where `mask[i] === targetVal`. Runs in O(W * H) time (~15ms on 2MP images).
   *
   * @param {Uint8Array} mask
   * @param {number} targetVal 0 or 1
   * @param {number} W
   * @param {number} H
   * @returns {Float32Array}
   */
  function computeEDT2DSq(mask, targetVal, W, H) {
    const total = W * H;
    const grid = new Float32Array(total);
    let hasTarget = false;
    for (let i = 0; i < total; i++) {
      if (mask[i] === targetVal) {
        grid[i] = 0;
        hasTarget = true;
      } else {
        grid[i] = EDT_INF;
      }
    }
    if (!hasTarget) return grid;

    const maxDim = Math.max(W, H);
    const f = new Float64Array(maxDim);
    const d = new Float64Array(maxDim);
    const v = new Int32Array(maxDim);
    const z = new Float64Array(maxDim + 1);

    // Transform along columns (Y)
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        f[y] = grid[y * W + x];
      }
      edt1d(f, d, v, z, H);
      for (let y = 0; y < H; y++) {
        grid[y * W + x] = d[y];
      }
    }

    // Transform along rows (X)
    for (let y = 0; y < H; y++) {
      const rowOffset = y * W;
      for (let x = 0; x < W; x++) {
        f[x] = grid[rowOffset + x];
      }
      edt1d(f, d, v, z, W);
      for (let x = 0; x < W; x++) {
        grid[rowOffset + x] = d[x];
      }
    }

    return grid;
  }

  /**
   * Dilates (radiusPx >= 0) or erodes (radiusPx < 0) a binary mask instantaneously
   * using precomputed squared Euclidean distance transforms.
   *
   * @param {Uint8Array} baseMask
   * @param {Float32Array} edtToOneSq Distance squared to nearest 1-pixel
   * @param {Float32Array | null} edtToZeroSq Distance squared to nearest 0-pixel (needed only if radiusPx < 0)
   * @param {number} radiusPx
   * @returns {Uint8Array}
   */
  function dilateMaskWithEDT(baseMask, edtToOneSq, edtToZeroSq, radiusPx) {
    const n = baseMask.length;
    if (radiusPx === 0) {
      return new Uint8Array(baseMask);
    }
    const out = new Uint8Array(n);
    if (radiusPx > 0) {
      const rSq = radiusPx * radiusPx;
      for (let i = 0; i < n; i++) {
        out[i] = edtToOneSq[i] <= rSq ? 1 : 0;
      }
    } else if (edtToZeroSq) {
      const rSq = radiusPx * radiusPx;
      for (let i = 0; i < n; i++) {
        out[i] = baseMask[i] === 1 && edtToZeroSq[i] > rSq ? 1 : 0;
      }
    }
    return out;
  }

  /**
   * Computes tight bounding box of pixels where mask[i] === 1.
   * @param {Uint8Array} mask
   * @param {number} W
   * @param {number} H
   * @param {number} [padPx=0]
   * @returns {RectBox | null}
   */
  function computeMaskBoundingBox(mask, W, H, padPx = 0) {
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (mask[row + x] === 1) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return null;

    const x0 = Math.max(0, minX - padPx);
    const y0 = Math.max(0, minY - padPx);
    const x1 = Math.min(W - 1, maxX + padPx);
    const y1 = Math.min(H - 1, maxY + padPx);

    return {
      x: x0,
      y: y0,
      w: x1 - x0 + 1,
      h: y1 - y0 + 1,
    };
  }

  /**
   * Computes pixel centroid of mask === targetVal for placing labels on the canvas.
   * @param {Uint8Array} mask
   * @param {number} targetVal
   * @param {number} W
   * @param {number} H
   * @returns {{ x: number, y: number, count: number }}
   */
  function computeMaskCentroid(mask, targetVal, W, H) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    // Stride by 2 on large images for speed
    const step = W * H > 800000 ? 2 : 1;
    for (let y = 0; y < H; y += step) {
      const row = y * W;
      for (let x = 0; x < W; x += step) {
        if (mask[row + x] === targetVal) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }
    if (count === 0) return { x: W / 2, y: H / 2, count: 0 };
    return { x: sumX / count, y: sumY / count, count: count * step * step };
  }

  /**
   * Computes the 2D Similarity Transform (scale, rotation, translation) to align
   * eye points on source image (eye2L, eye2R) with target eye points on doc image (eye1L, eye1R).
   *
   * @param {Point} eye1L Left eye of target/doc image
   * @param {Point} eye1R Right eye of target/doc image
   * @param {Point} eye2L Left eye on source image (in raw source pixels)
   * @param {Point} eye2R Right eye on source image (in raw source pixels)
   * @param {number} srcW Source image width
   * @param {number} srcH Source image height
   * @param {number} fullW Target doc width
   * @param {number} fullH Target doc height
   * @returns {{ scale: number, rotation: number, x: number, y: number, ipd1: number, ipd2: number }}
   */
  function computeSimilarityTransformFromEyes(eye1L, eye1R, eye2L, eye2R, srcW, srcH, fullW, fullH) {
    const dx1 = eye1R.x - eye1L.x;
    const dy1 = eye1R.y - eye1L.y;
    const ipd1 = Math.max(1, Math.hypot(dx1, dy1));
    const angle1 = Math.atan2(dy1, dx1);
    const mid1 = { x: (eye1L.x + eye1R.x) * 0.5, y: (eye1L.y + eye1R.y) * 0.5 };

    const dx2 = eye2R.x - eye2L.x;
    const dy2 = eye2R.y - eye2L.y;
    const ipd2 = Math.max(1, Math.hypot(dx2, dy2));
    const angle2 = Math.atan2(dy2, dx2);
    const mid2 = { x: (eye2L.x + eye2R.x) * 0.5, y: (eye2L.y + eye2R.y) * 0.5 };

    const fitScale = Math.min(fullW / Math.max(1, srcW), fullH / Math.max(1, srcH));
    const effectiveScale = ipd1 / ipd2;
    const scale = Math.max(0.1, Math.min(8, effectiveScale / fitScale));

    let rotRad = angle1 - angle2;
    while (rotRad > Math.PI) rotRad -= Math.PI * 2;
    while (rotRad < -Math.PI) rotRad += Math.PI * 2;
    const rotation = (rotRad * 180) / Math.PI;

    // Vector from raw source center to source eye midpoint
    const rawCenter = { x: srcW * 0.5, y: srcH * 0.5 };
    const dMid = { x: (mid2.x - rawCenter.x) * effectiveScale, y: (mid2.y - rawCenter.y) * effectiveScale };

    // Rotate dMid by rotRad
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const dMidRotX = dMid.x * cosR - dMid.y * sinR;
    const dMidRotY = dMid.x * sinR + dMid.y * cosR;

    // Required layer center in world doc coords
    const worldCenterX = mid1.x - dMidRotX;
    const worldCenterY = mid1.y - dMidRotY;

    // Relative to doc center (fullW/2, fullH/2)
    const tx = worldCenterX - fullW * 0.5;
    const ty = worldCenterY - fullH * 0.5;

    return {
      scale: Math.round(scale * 1000) / 1000,
      rotation: Math.round(rotation * 10) / 10,
      x: Math.round(tx * 10) / 10,
      y: Math.round(ty * 10) / 10,
      ipd1: Math.round(ipd1 * 10) / 10,
      ipd2: Math.round(ipd2 * 10) / 10,
    };
  }

  global.SplitMergeGeometry = {
    dist,
    polylineLength,
    polygonArea,
    isInsideRect,
    isStrictlyInsideRect,
    nearestPointOnBorder,
    clipSegmentToRect,
    perimeterCoord,
    buildBorderCutPolygon,
    segmentsIntersect,
    analyzeStrokeProgress,
    rasterizePolygonMask,
    guessFaceIsOne,
    matchMaskSideToReference,
    computeEDT2DSq,
    dilateMaskWithEDT,
    computeMaskBoundingBox,
    computeMaskCentroid,
    computeSimilarityTransformFromEyes,
  };
})(window);

