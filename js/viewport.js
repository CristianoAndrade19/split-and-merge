// @ts-check
/// <reference path="./types.js" />

(function (global) {
  'use strict';

  const Geo = global.SplitMergeGeometry;

  class CanvasViewport {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{
     *   onSelectionComplete?: (sel: SelectionShape) => void,
     *   onRegionClick?: (pt: Point) => void,
     *   onTransformChange?: (tx: number, ty: number, scale: number, isDragging: boolean) => void,
     *   onZoomChange?: (zoom: number) => void,
     *   onCompareChange?: (splitRatio: number) => void
     * }} callbacks
     */
    constructor(canvas, callbacks = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.callbacks = callbacks;

      // Document dimensions (matches imagem1 W1 x H1)
      this.docW = 0;
      this.docH = 0;

      // Viewport camera: screenPt = imgPt * zoom + pan
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;

      /** @type {'cut' | 'align' | 'pan' | 'compare' | 'sample' | 'view'} */
      this.mode = 'cut';
      this.spacePressed = false;

      // Visual render config updated by app.js
      this.renderState = {
        /** @type {HTMLCanvasElement | HTMLImageElement | null} */
        primaryCanvas: null,
        /** @type {HTMLCanvasElement | HTMLImageElement | null} */
        onionCanvas: null,
        onionOpacity: 0,
        /** @type {HTMLCanvasElement | null} */
        maskOverlayCanvas: null,
        showMaskOverlay: true,
        /** @type {Point[] | null} */
        guideCutPath: null,
        guideIsLasso: false,
        /** @type {{ x: number, y: number, text: string, color: string }[]} */
        badges: [],
        /** @type {{ x: number, y: number, label: string, color: string }[]} */
        samplePins: [],
        /** @type {{ drawX: number, drawY: number, drawW: number, drawH: number } | null} */
        alignBox: null,
        /** @type {RectBox | null} */
        targetSubBox: null,
        /** @type {HTMLCanvasElement | null} */
        compareBeforeCanvas: null,
        compareLabelBefore: 'Antes (imagemMerge)',
        compareLabelAfter: 'Depois (imagemFinal)',
        compareRatio: 0.5,
        emptyHintTitle: 'Importe ou cole a imagem1 (Ctrl+V)',
        emptyHintSub: 'Arraste um arquivo aqui, clique em Importar ou pressione Ctrl+V',
      };

      // Active pointer interaction state
      this.isPointerDown = false;
      /** @type {'none' | 'pan' | 'stroke' | 'align-move' | 'align-scale' | 'compare'} */
      this.dragAction = 'none';
      this.pointerId = -1;
      this.dragStartScreen = { x: 0, y: 0 };
      this.panStart = { x: 0, y: 0 };

      // Freehand cut/lasso stroke state
      /** @type {Point[]} */
      this.strokePts = [];
      this.strokePreview = { pIn: null, nearStart: false, startedOutsideOrBorder: false };
      this.dashOffset = 0;
      this.animFrameId = 0;

      // Align layer drag state
      this.alignBaseTransform = { x: 0, y: 0, scale: 1, rotation: 0 };
      this.alignStartTransform = { x: 0, y: 0, scale: 1, rotation: 0 };
      this.alignCenterImg = { x: 0, y: 0 };
      this.alignStartDist = 1;
      this.alignStartAngle = 0;

      this._checkerPattern = null;
      this._renderQueued = false;
      this._bindEvents();
      this._observeResize();
      this._draw();
    }

    _getCheckerPattern() {
      if (this._checkerPattern || !this.ctx) return this._checkerPattern;
      const size = 16;
      const pCanvas = document.createElement('canvas');
      pCanvas.width = size * 2;
      pCanvas.height = size * 2;
      const pCtx = pCanvas.getContext('2d');
      if (pCtx) {
        pCtx.fillStyle = '#1b2230';
        pCtx.fillRect(0, 0, size * 2, size * 2);
        pCtx.fillStyle = '#263042';
        pCtx.fillRect(0, 0, size, size);
        pCtx.fillRect(size, size, size, size);
        this._checkerPattern = this.ctx.createPattern(pCanvas, 'repeat');
      }
      return this._checkerPattern;
    }

    _observeResize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const ro = new ResizeObserver(() => {
        const resized = this._syncCanvasSize();
        if (resized) {
          // Redraw synchronously right after canvas width/height reset so ResizeObserver
          // (which runs after rAF and right before Paint) never leaves a blank frame!
          this._draw();
        } else {
          this.requestRender();
        }
      });
      ro.observe(parent);
      this._syncCanvasSize();
    }

    _syncCanvasSize() {
      const parent = this.canvas.parentElement;
      if (!parent) return false;
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(100, Math.floor(rect.width));
      const cssH = Math.max(100, Math.floor(rect.height));
      const targetW = Math.floor(cssW * dpr);
      const targetH = Math.floor(cssH * dpr);
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        return true;
      }
      return false;
    }

    getCssSize() {
      const dpr = window.devicePixelRatio || 1;
      return {
        w: this.canvas.width / dpr,
        h: this.canvas.height / dpr,
      };
    }

    /**
     * Sets document dimensions and optionally fits camera with comfortable outer margin.
     * @param {number} w
     * @param {number} h
     * @param {boolean} [autoFit=false]
     */
    setDocumentSize(w, h, autoFit = false) {
      const changed = this.docW !== w || this.docH !== h;
      this.docW = w;
      this.docH = h;
      if ((autoFit || changed) && w > 0 && h > 0) {
        this.fitToViewport();
      } else {
        this.requestRender();
      }
    }

    /**
     * Fits the image inside the viewport with ~24% outer margin so starting a cut
     * from outside the image ("vir de fora da imagem") is effortless on all 4 sides.
     */
    fitToViewport() {
      this._syncCanvasSize();
      const { w: vw, h: vh } = this.getCssSize();
      if (this.docW <= 0 || this.docH <= 0) {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.requestRender();
        return;
      }
      const marginFactor = 0.76;
      const scaleX = (vw * marginFactor) / this.docW;
      const scaleY = (vh * marginFactor) / this.docH;
      this.zoom = Math.max(0.05, Math.min(8, Math.min(scaleX, scaleY)));
      this.panX = (vw - this.docW * this.zoom) * 0.5;
      this.panY = (vh - this.docH * this.zoom) * 0.5;
      if (this.callbacks.onZoomChange) this.callbacks.onZoomChange(this.zoom);
      this.requestRender();
    }

    setZoom(newZoom, anchorScreenX, anchorScreenY) {
      const { w: vw, h: vh } = this.getCssSize();
      const ax = anchorScreenX !== undefined ? anchorScreenX : vw * 0.5;
      const ay = anchorScreenY !== undefined ? anchorScreenY : vh * 0.5;

      const clamped = Math.max(0.05, Math.min(16, newZoom));
      const imgPt = this.screenToImage(ax, ay);
      this.zoom = clamped;
      this.panX = ax - imgPt.x * this.zoom;
      this.panY = ay - imgPt.y * this.zoom;

      if (this.callbacks.onZoomChange) this.callbacks.onZoomChange(this.zoom);
      this.requestRender();
    }

    /**
     * @param {number} sx
     * @param {number} sy
     * @returns {Point}
     */
    screenToImage(sx, sy) {
      return {
        x: (sx - this.panX) / this.zoom,
        y: (sy - this.panY) / this.zoom,
      };
    }

    /**
     * @param {number} ix
     * @param {number} iy
     * @returns {Point}
     */
    imageToScreen(ix, iy) {
      return {
        x: ix * this.zoom + this.panX,
        y: iy * this.zoom + this.panY,
      };
    }

    /**
     * @param {PointerEvent | MouseEvent | WheelEvent} e
     */
    _eventScreenPos(e) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    _getAlignHandlePositions() {
      const box = this.renderState.alignBox;
      if (!box) return null;
      const c = this.imageToScreen(box.cx, box.cy);
      const w = box.drawW * this.zoom;
      const h = box.drawH * this.zoom;
      const rot = ((box.rotation || 0) * Math.PI) / 180;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      const rotatePt = (lx, ly) => ({
        x: c.x + lx * cosR - ly * sinR,
        y: c.y + lx * sinR + ly * cosR,
      });

      const stalkLen = 24;
      const rotHandle = rotatePt(0, -h * 0.5 - stalkLen);
      const corners = [
        rotatePt(-w * 0.5, -h * 0.5),
        rotatePt(w * 0.5, -h * 0.5),
        rotatePt(w * 0.5, h * 0.5),
        rotatePt(-w * 0.5, h * 0.5),
      ];

      return { c, w, h, rot, rotHandle, corners };
    }

    _hitTestAlignCorner(sx, sy) {
      const handles = this._getAlignHandlePositions();
      if (!handles) return false;
      for (const c of handles.corners) {
        if (Math.hypot(sx - c.x, sy - c.y) <= 13) return true;
      }
      return false;
    }

    _hitTestAlignRotate(sx, sy) {
      const handles = this._getAlignHandlePositions();
      if (!handles) return false;
      return Math.hypot(sx - handles.rotHandle.x, sy - handles.rotHandle.y) <= 13;
    }

    _bindEvents() {
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      this.canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          if (this.docW <= 0) return;
          const pos = this._eventScreenPos(e);

          // In align mode, Alt + Wheel scales the layer directly for quick precision!
          if (this.mode === 'align' && e.altKey && this.callbacks.onTransformChange) {
            const factor = e.deltaY < 0 ? 1.04 : 1 / 1.04;
            const nextScale = Math.max(0.1, Math.min(8, this.alignBaseTransform.scale * factor));
            this.alignBaseTransform.scale = nextScale;
            this.callbacks.onTransformChange(
              this.alignBaseTransform.x,
              this.alignBaseTransform.y,
              nextScale,
              this.alignBaseTransform.rotation || 0,
              false
            );
            return;
          }

          const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          this.setZoom(this.zoom * zoomFactor, pos.x, pos.y);
        },
        { passive: false }
      );

      this.canvas.addEventListener('pointerdown', (e) => {
        if (this.docW <= 0 || this.docH <= 0) return;
        const pos = this._eventScreenPos(e);
        this.isPointerDown = true;
        this.pointerId = e.pointerId;
        this.dragStartScreen = pos;
        this.canvas.setPointerCapture(e.pointerId);

        // Middle mouse, Right mouse, Spacebar, or explicit Pan tool -> Pan camera
        if (e.button === 1 || e.button === 2 || this.spacePressed || this.mode === 'pan') {
          this.dragAction = 'pan';
          this.panStart = { x: this.panX, y: this.panY };
          this._updateCursor();
          return;
        }

        if (e.button !== 0) return;

        if (this.mode === 'compare' && this.renderState.compareBeforeCanvas) {
          this.dragAction = 'compare';
          this._updateCompareFromScreenX(pos.x);
          return;
        }

        if (this.mode === 'align') {
          const imgPt = this.screenToImage(pos.x, pos.y);
          this.alignStartTransform = {
            x: this.alignBaseTransform.x,
            y: this.alignBaseTransform.y,
            scale: this.alignBaseTransform.scale,
            rotation: this.alignBaseTransform.rotation || 0,
          };
          const box = this.renderState.alignBox;
          if (box && this._hitTestAlignRotate(pos.x, pos.y)) {
            this.dragAction = 'align-rotate';
            const handles = this._getAlignHandlePositions();
            this.alignStartAngle = handles
              ? Math.atan2(pos.y - handles.c.y, pos.x - handles.c.x)
              : 0;
          } else if (box && this._hitTestAlignCorner(pos.x, pos.y)) {
            this.dragAction = 'align-scale';
            this.alignCenterImg = {
              x: box.cx || box.drawX + box.drawW * 0.5,
              y: box.cy || box.drawY + box.drawH * 0.5,
            };
            this.alignStartDist = Math.max(10, Geo.dist(imgPt, this.alignCenterImg));
          } else {
            this.dragAction = 'align-move';
          }
          this._updateCursor();
          return;
        }

        if (this.mode === 'sample') {
          const imgPt = this.screenToImage(pos.x, pos.y);
          if (Geo.isInsideRect(imgPt, this.docW, this.docH) && this.callbacks.onRegionClick) {
            this.callbacks.onRegionClick(imgPt);
          }
          this.isPointerDown = false;
          this.dragAction = 'none';
          this.pointerId = -1;
          return;
        }

        if (this.mode === 'cut') {
          this.dragAction = 'stroke';
          const imgPt = this.screenToImage(pos.x, pos.y);
          this.strokePts = [imgPt];
          const res = Geo.analyzeStrokeProgress(this.strokePts, this.docW, this.docH, this.zoom, false);
          this.strokePreview = res.preview;
          this._startDashAnimation();
          this.requestRender();
          return;
        }

        // Default in 'view' mode: left drag pans
        this.dragAction = 'pan';
        this.panStart = { x: this.panX, y: this.panY };
        this._updateCursor();
      });

      this.canvas.addEventListener('pointermove', (e) => {
        const pos = this._eventScreenPos(e);

        if (!this.isPointerDown || e.pointerId !== this.pointerId) {
          this._updateHoverCursor(pos.x, pos.y);
          return;
        }

        if (this.dragAction === 'pan') {
          this.panX = this.panStart.x + (pos.x - this.dragStartScreen.x);
          this.panY = this.panStart.y + (pos.y - this.dragStartScreen.y);
          this.requestRender();
          return;
        }

        if (this.dragAction === 'compare') {
          this._updateCompareFromScreenX(pos.x);
          return;
        }

        if (this.dragAction === 'align-move') {
          const dxImg = (pos.x - this.dragStartScreen.x) / this.zoom;
          const dyImg = (pos.y - this.dragStartScreen.y) / this.zoom;
          const nx = this.alignStartTransform.x + dxImg;
          const ny = this.alignStartTransform.y + dyImg;
          this.alignBaseTransform.x = nx;
          this.alignBaseTransform.y = ny;
          if (this.callbacks.onTransformChange) {
            this.callbacks.onTransformChange(
              nx,
              ny,
              this.alignBaseTransform.scale,
              this.alignBaseTransform.rotation || 0,
              true
            );
          }
          return;
        }

        if (this.dragAction === 'align-scale') {
          const imgPt = this.screenToImage(pos.x, pos.y);
          const curDist = Math.max(5, Geo.dist(imgPt, this.alignCenterImg));
          const ratio = curDist / this.alignStartDist;
          const nextScale = Math.max(0.1, Math.min(8, this.alignStartTransform.scale * ratio));
          this.alignBaseTransform.scale = nextScale;
          if (this.callbacks.onTransformChange) {
            this.callbacks.onTransformChange(
              this.alignBaseTransform.x,
              this.alignBaseTransform.y,
              nextScale,
              this.alignBaseTransform.rotation || 0,
              true
            );
          }
          return;
        }

        if (this.dragAction === 'align-rotate') {
          const handles = this._getAlignHandlePositions();
          if (!handles) return;
          const curAngle = Math.atan2(pos.y - handles.c.y, pos.x - handles.c.x);
          let deltaDeg = ((curAngle - this.alignStartAngle) * 180) / Math.PI;
          let newRot = Math.round((this.alignStartTransform.rotation + deltaDeg) * 10) / 10;
          while (newRot > 180) newRot -= 360;
          while (newRot < -180) newRot += 360;
          this.alignBaseTransform.rotation = newRot;
          if (this.callbacks.onTransformChange) {
            this.callbacks.onTransformChange(
              this.alignBaseTransform.x,
              this.alignBaseTransform.y,
              this.alignBaseTransform.scale,
              newRot,
              true
            );
          }
          return;
        }

        if (this.dragAction === 'stroke') {
          const imgPt = this.screenToImage(pos.x, pos.y);
          const last = this.strokePts[this.strokePts.length - 1];
          // Sample points at >= 1.5 screen px spacing for smooth, clean curves
          if (!last || Geo.dist(last, imgPt) * this.zoom >= 1.5) {
            this.strokePts.push(imgPt);
            const res = Geo.analyzeStrokeProgress(
              this.strokePts,
              this.docW,
              this.docH,
              this.zoom,
              false
            );
            this.strokePreview = res.preview;

            if (res.completed) {
              // Selection immediately determined while holding mouse (touched 2 borders or closed lasso)!
              this.strokePts = [];
              this.dragAction = 'none';
              this._stopDashAnimation();
              if (this.callbacks.onSelectionComplete) {
                this.callbacks.onSelectionComplete(res.completed);
              }
              this.requestRender();
              return;
            }
            this.requestRender();
          }
        }
      });

      const finishPointer = (/** @type {PointerEvent} */ e) => {
        if (!this.isPointerDown || e.pointerId !== this.pointerId) return;
        const pos = this._eventScreenPos(e);

        if (this.dragAction === 'stroke') {
          const movedScreen = Math.hypot(
            pos.x - this.dragStartScreen.x,
            pos.y - this.dragStartScreen.y
          );
          if (movedScreen < 5 && this.strokePts.length <= 3) {
            // Quick click on canvas -> allow clicking a region to inspect/select
            const imgPt = this.screenToImage(pos.x, pos.y);
            if (Geo.isInsideRect(imgPt, this.docW, this.docH) && this.callbacks.onRegionClick) {
              this.callbacks.onRegionClick(imgPt);
            }
          } else {
            const res = Geo.analyzeStrokeProgress(
              this.strokePts,
              this.docW,
              this.docH,
              this.zoom,
              true
            );
            if (res.completed && this.callbacks.onSelectionComplete) {
              this.callbacks.onSelectionComplete(res.completed);
            }
          }
          this.strokePts = [];
          this._stopDashAnimation();
        } else if (
          this.dragAction === 'align-move' ||
          this.dragAction === 'align-scale' ||
          this.dragAction === 'align-rotate'
        ) {
          if (this.callbacks.onTransformChange) {
            this.callbacks.onTransformChange(
              this.alignBaseTransform.x,
              this.alignBaseTransform.y,
              this.alignBaseTransform.scale,
              this.alignBaseTransform.rotation || 0,
              false
            );
          }
        }

        this.isPointerDown = false;
        this.dragAction = 'none';
        this.pointerId = -1;
        this._updateCursor();
        this.requestRender();
      };

      this.canvas.addEventListener('pointerup', finishPointer);
      this.canvas.addEventListener('pointercancel', finishPointer);

      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !this._isTypingTarget(e.target)) {
          if (!this.spacePressed) {
            this.spacePressed = true;
            this._updateCursor();
          }
          e.preventDefault();
        }
      });

      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
          this.spacePressed = false;
          this._updateCursor();
        }
      });
    }

    _isTypingTarget(target) {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    _updateCompareFromScreenX(sx) {
      const imgPt = this.screenToImage(sx, 0);
      const r = Math.max(0, Math.min(1, imgPt.x / Math.max(1, this.docW)));
      this.renderState.compareRatio = r;
      if (this.callbacks.onCompareChange) this.callbacks.onCompareChange(r);
      this.requestRender();
    }

    _updateHoverCursor(sx, sy) {
      if (this.spacePressed || this.mode === 'pan') {
        this.canvas.style.cursor = 'grab';
        return;
      }
      if (this.mode === 'align') {
        if (this._hitTestAlignRotate(sx, sy)) {
          this.canvas.style.cursor = 'grab';
        } else if (this._hitTestAlignCorner(sx, sy)) {
          this.canvas.style.cursor = 'nwse-resize';
        } else {
          this.canvas.style.cursor = 'move';
        }
        return;
      }
      if (this.mode === 'compare') {
        this.canvas.style.cursor = 'ew-resize';
        return;
      }
      if (this.mode === 'cut' || this.mode === 'sample') {
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      this.canvas.style.cursor = 'grab';
    }

    _updateCursor() {
      if (this.dragAction === 'pan') {
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      if (this.spacePressed || this.mode === 'pan') {
        this.canvas.style.cursor = 'grab';
        return;
      }
      if (this.mode === 'cut' || this.mode === 'sample') {
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      if (this.mode === 'align') {
        if (this.dragAction === 'align-rotate') {
          this.canvas.style.cursor = 'grabbing';
        } else if (this.dragAction === 'align-scale') {
          this.canvas.style.cursor = 'nwse-resize';
        } else {
          this.canvas.style.cursor = 'move';
        }
        return;
      }
      if (this.mode === 'compare') {
        this.canvas.style.cursor = 'ew-resize';
        return;
      }
      this.canvas.style.cursor = 'grab';
    }

    _startDashAnimation() {
      if (this.animFrameId) return;
      const tick = () => {
        if (this.dragAction !== 'stroke') {
          this.animFrameId = 0;
          return;
        }
        this.dashOffset = (this.dashOffset - 0.8) % 24;
        this._draw();
        this.animFrameId = requestAnimationFrame(tick);
      };
      this.animFrameId = requestAnimationFrame(tick);
    }

    _stopDashAnimation() {
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = 0;
      }
    }

    requestRender() {
      if (this._renderQueued) return;
      this._renderQueued = true;
      requestAnimationFrame(() => {
        this._renderQueued = false;
        this._draw();
      });
    }

    _draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const { w: vw, h: vh } = this.getCssSize();

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 1. Outer workspace backdrop ("fora da imagem")
      ctx.fillStyle = '#0b0f17';
      ctx.fillRect(0, 0, vw, vh);

      // Subtle dot grid outside image so user perceives camera pan & outer margin clearly
      this._drawWorkspaceGrid(ctx, vw, vh);

      if (this.docW <= 0 || this.docH <= 0 || !this.renderState.primaryCanvas) {
        this._drawEmptyState(ctx, vw, vh);
        ctx.restore();
        return;
      }

      // 2. Image coordinate space transform
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);

      // Drop shadow behind document bounds
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 28 / this.zoom;
      ctx.shadowOffsetY = 8 / this.zoom;
      ctx.fillStyle = '#1b2230';
      ctx.fillRect(0, 0, this.docW, this.docH);
      ctx.restore();

      // Checkerboard inside [0, docW] x [0, docH] for transparent areas / padding
      const checker = this._getCheckerPattern();
      if (checker) {
        ctx.save();
        ctx.scale(1 / this.zoom, 1 / this.zoom);
        ctx.fillStyle = checker;
        ctx.fillRect(0, 0, this.docW * this.zoom, this.docH * this.zoom);
        ctx.restore();
      }

      // Smooth interpolation when zoomed out, crisp pixels when zoomed far in (> 300%)
      ctx.imageSmoothingEnabled = this.zoom < 3;
      ctx.imageSmoothingQuality = 'high';

      // Primary image OR Before/After Split Comparison
      if (this.mode === 'compare' && this.renderState.compareBeforeCanvas) {
        const splitX = this.docW * this.renderState.compareRatio;
        // Draw After (imagemFinal) full
        ctx.drawImage(this.renderState.primaryCanvas, 0, 0, this.docW, this.docH);
        // Draw Before clipped on left side
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitX, this.docH);
        ctx.clip();
        ctx.drawImage(this.renderState.compareBeforeCanvas, 0, 0, this.docW, this.docH);
        ctx.restore();
      } else {
        ctx.drawImage(this.renderState.primaryCanvas, 0, 0, this.docW, this.docH);
      }

      // Optional Onion Skin reference (e.g. imagem1 under/over imagem2 while aligning)
      if (this.renderState.onionCanvas && this.renderState.onionOpacity > 0.005) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, this.renderState.onionOpacity));
        ctx.drawImage(this.renderState.onionCanvas, 0, 0, this.docW, this.docH);
        ctx.restore();
      }

      // Mask tint & crisp seam contour overlay
      if (this.renderState.showMaskOverlay && this.renderState.maskOverlayCanvas) {
        ctx.drawImage(this.renderState.maskOverlayCanvas, 0, 0, this.docW, this.docH);
      }

      ctx.restore(); // Back to screen coordinates for crisp 1px UI lines, handles & labels!

      // 3. Screen-space overlays (crisp at any zoom level!)
      this._drawDocumentFrame(ctx);

      if (this.renderState.targetSubBox) {
        this._drawSubBoxGuide(ctx, this.renderState.targetSubBox);
      }

      if (this.renderState.guideCutPath && this.renderState.guideCutPath.length >= 2) {
        this._drawGuidePath(ctx, this.renderState.guideCutPath, this.renderState.guideIsLasso);
      }

      if (this.mode === 'align' && this.renderState.alignBox) {
        this._drawAlignGizmo(ctx, this.renderState.alignBox);
      }

      if (this.renderState.showAnatomicGuides) {
        this._drawAnatomicGuides(ctx);
      }

      if (this.mode === 'compare' && this.renderState.compareBeforeCanvas) {
        this._drawCompareDivider(ctx);
      }

      if (this.renderState.badges && this.renderState.badges.length > 0 && this.mode !== 'compare') {
        this._drawBadges(ctx, this.renderState.badges);
      }

      if (this.renderState.samplePins && this.renderState.samplePins.length > 0) {
        this._drawSamplePins(ctx, this.renderState.samplePins);
      }

      if (this.strokePts.length > 0) {
        this._drawActiveStroke(ctx);
      }

      ctx.restore();
    }

    _drawSamplePins(ctx, pins) {
      ctx.save();
      for (const pin of pins) {
        const sp = this.imageToScreen(pin.x, pin.y);
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = pin.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = pin.color;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 2.5, 0, Math.PI * 2);
        ctx.fill();

        this._drawPill(ctx, sp.x + 12, sp.y - 12, pin.label, pin.color, 'left');
      }
      ctx.restore();
    }

    _drawWorkspaceGrid(ctx, vw, vh) {
      const step = 28;
      ctx.fillStyle = 'rgba(148, 163, 184, 0.08)';
      const offX = ((this.panX % step) + step) % step;
      const offY = ((this.panY % step) + step) % step;
      for (let y = offY; y < vh; y += step) {
        for (let x = offX; x < vw; x += step) {
          ctx.fillRect(x, y, 1.2, 1.2);
        }
      }
    }

    _drawEmptyState(ctx, vw, vh) {
      const boxW = Math.min(460, vw - 48);
      const boxH = 210;
      const bx = (vw - boxW) * 0.5;
      const by = (vh - boxH) * 0.5;

      ctx.save();
      ctx.fillStyle = 'rgba(17, 24, 39, 0.86)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 16);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 28px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('＋', vw * 0.5, by + 68);

      ctx.fillStyle = '#f1f5f9';
      ctx.font = '600 16px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText(this.renderState.emptyHintTitle, vw * 0.5, by + 112);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText(this.renderState.emptyHintSub, vw * 0.5, by + 142);
      ctx.restore();
    }

    _drawDocumentFrame(ctx) {
      const tl = this.imageToScreen(0, 0);
      const br = this.imageToScreen(this.docW, this.docH);
      const w = br.x - tl.x;
      const h = br.y - tl.y;

      ctx.save();
      ctx.strokeStyle = this.mode === 'cut' ? 'rgba(56, 189, 248, 0.65)' : 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.x, tl.y, w, h);

      // Subtle label in outer margin reminding user they can start cuts outside the border
      if (this.mode === 'cut' && tl.y > 22) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
        ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(
          `${this.docW} × ${this.docH} px  •  Segure o mouse: corte tocando 2 bordas (pode vir de fora) ou feche um laço`,
          tl.x,
          tl.y - 8
        );
      }
      ctx.restore();
    }

    _drawSubBoxGuide(ctx, box) {
      const tl = this.imageToScreen(box.x, box.y);
      const br = this.imageToScreen(box.x + box.w, box.y + box.h);
      ctx.save();
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.restore();
    }

    _drawGuidePath(ctx, pts, isLasso) {
      ctx.save();
      ctx.beginPath();
      const p0 = this.imageToScreen(pts[0].x, pts[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = this.imageToScreen(pts[i].x, pts[i].y);
        ctx.lineTo(p.x, p.y);
      }
      if (isLasso) ctx.closePath();

      ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(244, 114, 182, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.restore();
    }

    _drawAlignGizmo(ctx, box) {
      const handles = this._getAlignHandlePositions();
      if (!handles) return;
      const { c, w, h, rot } = handles;

      ctx.save();
      ctx.translate(c.x, c.y);
      if (rot) ctx.rotate(rot);

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.75;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-w * 0.5, -h * 0.5, w, h);
      ctx.setLineDash([]);

      // Center crosshair
      ctx.beginPath();
      ctx.moveTo(-7, 0);
      ctx.lineTo(7, 0);
      ctx.moveTo(0, -7);
      ctx.lineTo(0, 7);
      ctx.stroke();

      // Top rotation handle with connecting stalk
      const stalkLen = 24;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.5);
      ctx.lineTo(0, -h * 0.5 - stalkLen);
      ctx.stroke();

      // Rotation circle handle
      ctx.fillStyle = '#0284c7';
      ctx.strokeStyle = '#e0f2fe';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, -h * 0.5 - stalkLen, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 4 Corner scale handles
      const corners = [
        { x: -w * 0.5, y: -h * 0.5 },
        { x: w * 0.5, y: -h * 0.5 },
        { x: w * 0.5, y: h * 0.5 },
        { x: -w * 0.5, y: h * 0.5 },
      ];
      for (const cr of corners) {
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cr.x, cr.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawAnatomicGuides(ctx) {
      if (!this.docW || !this.docH) return;
      ctx.save();
      const fc = this.renderState.faceCenter || { x: this.docW * 0.5, y: this.docH * 0.38 };
      const sCenter = this.imageToScreen(fc.x, fc.y);

      // Estimated head width and shoulder width based on document / face
      const headW = (this.renderState.estimatedHeadWidth || this.docW * 0.38) * this.zoom;
      const headH = headW * 1.35;
      const shoulderW = headW * 2.4;

      // 1. Vertical facial symmetry line
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sCenter.x, sCenter.y - headH * 0.85);
      ctx.lineTo(sCenter.x, sCenter.y + headH * 1.1);
      ctx.stroke();

      // 2. Horizontal bipupilar eye line
      const eyeY = sCenter.y - headH * 0.08;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(sCenter.x - headW * 0.65, eyeY);
      ctx.lineTo(sCenter.x + headW * 0.65, eyeY);
      ctx.stroke();

      // Pupil cross markers at ~0.24 head width from center
      const eyeOffset = headW * 0.24;
      for (const ex of [sCenter.x - eyeOffset, sCenter.x + eyeOffset]) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.75;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(ex - 5, eyeY);
        ctx.lineTo(ex + 5, eyeY);
        ctx.moveTo(ex, eyeY - 5);
        ctx.lineTo(ex, eyeY + 5);
        ctx.stroke();
      }

      // 3. Menton / Chin guide line
      const chinY = sCenter.y + headH * 0.5;
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sCenter.x - headW * 0.35, chinY);
      ctx.lineTo(sCenter.x + headW * 0.35, chinY);
      ctx.stroke();

      // 4. Head-to-Shoulder Proportion Box (1:2.4)
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(sCenter.x - shoulderW * 0.5, chinY, shoulderW, headH * 0.8);

      // Head bounding bracket
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.setLineDash([]);
      ctx.strokeRect(sCenter.x - headW * 0.5, sCenter.y - headH * 0.5, headW, headH);

      // HUD readout label
      this._drawPill(
        ctx,
        sCenter.x,
        sCenter.y - headH * 0.5 - 16,
        '📏 Proporção Cabeça/Ombros: 1:2.4 (Ideal) • Alinhe as Pupilas',
        '#f59e0b',
        'center'
      );

      ctx.restore();
    }

    _drawCompareDivider(ctx) {
      const splitImgX = this.docW * this.renderState.compareRatio;
      const top = this.imageToScreen(splitImgX, 0);
      const bot = this.imageToScreen(splitImgX, this.docH);

      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();

      const midY = (top.y + bot.y) * 0.5;
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(top.x, midY, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('↔', top.x, midY);

      // Corner compare labels
      const docTL = this.imageToScreen(0, 0);
      const docTR = this.imageToScreen(this.docW, 0);
      this._drawPill(ctx, docTL.x + 12, docTL.y + 16, this.renderState.compareLabelBefore, '#f59e0b', 'left');
      this._drawPill(ctx, docTR.x - 12, docTR.y + 16, this.renderState.compareLabelAfter, '#10b981', 'right');
      ctx.restore();
    }

    _drawBadges(ctx, badges) {
      ctx.save();
      for (const b of badges) {
        const sp = this.imageToScreen(b.x, b.y);
        this._drawPill(ctx, sp.x, sp.y, b.text, b.color, 'center');
      }
      ctx.restore();
    }

    _drawPill(ctx, x, y, text, accentColor, align = 'center') {
      ctx.save();
      ctx.font = '600 11.5px system-ui, -apple-system, Segoe UI, sans-serif';
      const padX = 10;
      const h = 24;
      const textW = ctx.measureText(text).width;
      const w = textW + padX * 2 + 10;
      let bx = x - w * 0.5;
      if (align === 'left') bx = x;
      if (align === 'right') bx = x - w;
      const by = y - h * 0.5;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 999);
      ctx.fill();
      ctx.stroke();

      // Colored status dot
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(bx + 11, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 20, y + 0.5);
      ctx.restore();
    }

    _drawActiveStroke(ctx) {
      if (this.strokePts.length === 0) return;
      ctx.save();

      const p0 = this.imageToScreen(this.strokePts[0].x, this.strokePts[0].y);

      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < this.strokePts.length; i++) {
        const p = this.imageToScreen(this.strokePts[i].x, this.strokePts[i].y);
        ctx.lineTo(p.x, p.y);
      }

      // Dark backing stroke for contrast on bright images
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Animated bright foreground stroke
      ctx.strokeStyle = this.strokePreview.nearStart ? '#34d399' : '#38bdf8';
      ctx.lineWidth = 2.2;
      ctx.setLineDash([7, 5]);
      ctx.lineDashOffset = this.dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);

      // Start anchor ring (turns bright emerald when closing lasso!)
      if (!this.strokePreview.startedOutsideOrBorder || this.strokePreview.nearStart) {
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, this.strokePreview.nearStart ? 10 : 6.5, 0, Math.PI * 2);
        ctx.fillStyle = this.strokePreview.nearStart
          ? 'rgba(16, 185, 129, 0.35)'
          : 'rgba(56, 189, 248, 0.22)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = this.strokePreview.nearStart ? '#10b981' : '#38bdf8';
        ctx.stroke();
      }

      // 1st border intersection dot (when cutting from outside!)
      if (this.strokePreview.pIn) {
        const spIn = this.imageToScreen(this.strokePreview.pIn.x, this.strokePreview.pIn.y);
        ctx.beginPath();
        ctx.arc(spIn.x, spIn.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#f472b6';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  global.SplitMergeViewport = CanvasViewport;
})(window);

