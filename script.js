"use strict";

/* ═══════════════════════════════════════════════════════
   CORE STATE
   ═══════════════════════════════════════════════════════ */

const workspace = document.getElementById('workspace');
const canvasWrapper = document.getElementById('canvasWrapper');
const compositeCanvas = document.getElementById('compositeCanvas');
const compositeCtx = compositeCanvas.getContext('2d');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');

let canvasW = 1920, canvasH = 1080;
let zoom = 1, panX = 0, panY = 0;
let isPanning = false, panStart = {x:0,y:0}, panOffset = {x:0,y:0};

let currentTool = 'move';
let fgColor = '#ffffff', bgColor = '#000000';

// Layers
let layers = [];
let activeLayerIndex = 0;
let layerIdCounter = 1;

// Undo
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 40;

// Selection — mask-based system
let selection = null; // { type, x, y, w, h | points }
let selectionPath = null; // Path2D for clipping
let selectionMask = null; // offscreen canvas for compositing
let selectionMaskCtx = null;
let selectShape = 'rect'; // 'rect' | 'ellipse'
let lassoMode = 'free'; // 'free' | 'poly'
let selectionMode = 'new'; // 'new' | 'add' | 'subtract'
let polyPoints = []; // polygonal lasso points
let transformSelActive = false;
let transformHandleDrag = null; // which handle is being dragged
let transformOrigBounds = null; // original bounding box before transform

// Drawing state
let isDrawing = false;
let drawStart = {x:0,y:0};
let lastDraw = {x:0,y:0};

// Gradient state
let gradientStart = null, gradientEnd = null;

// Lasso
let lassoPoints = [];

// Move tool - floating selection system
let isMovingPixels = false;
let moveFloatCanvas = null;
let moveFloatCtx = null;
let moveFloatOrigin = {x:0, y:0};
let moveOffset = {x:0, y:0};

// Persistent floating selection (Photoshop-style)
let floatingCanvas = null;
let floatingCtx = null;
let floatingOffset = {x:0, y:0};
let floatingActive = false;
let floatingSelectionData = null; // original selection data for ants

// Clipboard
let clipboardCanvas = null;
let clipboardOrigin = {x:0, y:0}; // position where copied from

// Brush stroke buffer (non-stacking opacity)
let strokeBuffer = null;
let strokeBufferCtx = null;

// Current filter
let currentFilterType = null;
let filterOriginalData = null;

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */

function initCanvas(w, h, bg) {
  canvasW = w; canvasH = h;
  compositeCanvas.width = w;
  compositeCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  canvasWrapper.style.width = w + 'px';
  canvasWrapper.style.height = h + 'px';

  layers = [];
  activeLayerIndex = 0;
  layerIdCounter = 1;
  undoStack = [];
  redoStack = [];
  selection = null;
  selectionPath = null;
  checkerPattern = null; // Reset pattern for new context

  addLayer('Background');
  if (bg === 'white') {
    const ctx = layers[0].ctx;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  } else if (bg === 'black') {
    const ctx = layers[0].ctx;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
  }

  zoomFit();
  compositeAll();
  updateLayerPanel();
  pushUndo('New Image');
  updateStatus();
}

function init() {
  initCanvas(1920, 1080, 'white');
  selectTool('brush');
  updateColorUI();
  // Set initial select tool icon
  document.getElementById('selectToolBtn').innerHTML = RECT_SELECT_SVG;
}

/* ═══════════════════════════════════════════════════════
   LAYER SYSTEM
   ═══════════════════════════════════════════════════════ */

function createLayerCanvas() {
  const c = document.createElement('canvas');
  c.width = canvasW;
  c.height = canvasH;
  return c;
}

function addLayer(name) {
  const c = createLayerCanvas();
  const layer = {
    id: layerIdCounter++,
    name: name || `Layer ${layerIdCounter - 1}`,
    canvas: c,
    ctx: c.getContext('2d'),
    visible: true,
    opacity: 1
  };
  layers.splice(activeLayerIndex, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  compositeAll();
  updateLayerPanel();
}

function deleteLayer() {
  if (layers.length <= 1) return;
  pushUndo('Delete Layer');
  layers.splice(activeLayerIndex, 1);
  if (activeLayerIndex >= layers.length) activeLayerIndex = layers.length - 1;
  compositeAll();
  updateLayerPanel();
}

function moveLayerUp() {
  if (activeLayerIndex <= 0) return;
  pushUndo('Reorder');
  [layers[activeLayerIndex], layers[activeLayerIndex-1]] = [layers[activeLayerIndex-1], layers[activeLayerIndex]];
  activeLayerIndex--;
  compositeAll();
  updateLayerPanel();
}

function moveLayerDown() {
  if (activeLayerIndex >= layers.length - 1) return;
  pushUndo('Reorder');
  [layers[activeLayerIndex], layers[activeLayerIndex+1]] = [layers[activeLayerIndex+1], layers[activeLayerIndex]];
  activeLayerIndex++;
  compositeAll();
  updateLayerPanel();
}

function getActiveLayer() { return layers[activeLayerIndex]; }

// Pre-rendered checkerboard pattern
let checkerPattern = null;
function getCheckerPattern(ctx) {
  if (checkerPattern) return checkerPattern;
  const pc = document.createElement('canvas');
  pc.width = 20; pc.height = 20;
  const pctx = pc.getContext('2d');
  pctx.fillStyle = '#cdcdcd'; pctx.fillRect(0, 0, 20, 20);
  pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, 10, 10);
  pctx.fillStyle = '#ffffff'; pctx.fillRect(10, 10, 10, 10);
  checkerPattern = ctx.createPattern(pc, 'repeat');
  return checkerPattern;
}

function compositeAll() {
  compositeCtx.clearRect(0, 0, canvasW, canvasH);
  // Draw checkerboard for transparency
  compositeCtx.fillStyle = getCheckerPattern(compositeCtx);
  compositeCtx.fillRect(0, 0, canvasW, canvasH);
  // Draw layers bottom to top (last in array = bottom)
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    compositeCtx.globalAlpha = l.opacity;
    compositeCtx.drawImage(l.canvas, 0, 0);
    // Render floating pixels above the active layer
    if (i === activeLayerIndex && floatingActive && floatingCanvas) {
      compositeCtx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
    }
  }
  compositeCtx.globalAlpha = 1;
}

function compositeAllWithStrokeBuffer() {
  compositeAll();
  if (!strokeBuffer) return;
  const layer = getActiveLayer();
  if (!layer) return;
  const opacity = getToolOpacity();
  compositeCtx.save();
  if (selectionPath) compositeCtx.clip(selectionPath);
  if (currentTool === 'eraser') {
    // Show eraser preview: draw layer without erased area, then add buffer as mask
    compositeCtx.globalAlpha = opacity;
    compositeCtx.globalCompositeOperation = 'destination-out';
    compositeCtx.drawImage(strokeBuffer, 0, 0);
  } else {
    compositeCtx.globalAlpha = opacity;
    compositeCtx.drawImage(strokeBuffer, 0, 0);
  }
  compositeCtx.globalCompositeOperation = 'source-over';
  compositeCtx.globalAlpha = 1;
  compositeCtx.restore();
}

function updateLayerPanel() {
  const list = document.getElementById('layersList');
  list.innerHTML = '';
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item' + (i === activeLayerIndex ? ' active' : '');
    item.onclick = () => { activeLayerIndex = i; updateLayerPanel(); updateLayerOpacitySlider(); };
    item.ondblclick = () => {
      const newName = prompt('Layer name:', l.name);
      if (newName) { l.name = newName; updateLayerPanel(); }
    };

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    const tc = document.createElement('canvas');
    tc.width = 32; tc.height = 32;
    const tctx = tc.getContext('2d');
    tctx.drawImage(l.canvas, 0, 0, canvasW, canvasH, 0, 0, 32, 32);
    thumb.appendChild(tc);

    const info = document.createElement('div');
    info.className = 'layer-info';
    info.innerHTML = `<div class="layer-name">${l.name}</div><div class="layer-opacity-text">${Math.round(l.opacity*100)}%</div>`;

    const vis = document.createElement('button');
    vis.className = 'layer-vis' + (l.visible ? '' : ' hidden-layer');
    vis.innerHTML = l.visible
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    vis.onclick = (e) => { e.stopPropagation(); l.visible = !l.visible; compositeAll(); updateLayerPanel(); };

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(vis);
    list.appendChild(item);
  }
  updateLayerOpacitySlider();
}

function updateLayerOpacitySlider() {
  const slider = document.getElementById('layerOpacity');
  const val = document.getElementById('layerOpacityVal');
  const l = getActiveLayer();
  if (l) {
    slider.value = Math.round(l.opacity * 100);
    val.textContent = Math.round(l.opacity * 100) + '%';
  }
}

document.getElementById('layerOpacity').addEventListener('input', function() {
  const l = getActiveLayer();
  if (!l) return;
  l.opacity = this.value / 100;
  document.getElementById('layerOpacityVal').textContent = this.value + '%';
  compositeAll();
  updateLayerPanel();
});

/* ═══════════════════════════════════════════════════════
   UNDO / REDO
   ═══════════════════════════════════════════════════════ */

function captureState() {
  return layers.map(l => ({
    id: l.id,
    name: l.name,
    data: l.ctx.getImageData(0, 0, canvasW, canvasH),
    visible: l.visible,
    opacity: l.opacity
  }));
}

function restoreState(state) {
  layers = state.map(s => {
    const c = createLayerCanvas();
    const ctx = c.getContext('2d');
    ctx.putImageData(s.data, 0, 0);
    return { id: s.id, name: s.name, canvas: c, ctx, visible: s.visible, opacity: s.opacity };
  });
  if (activeLayerIndex >= layers.length) activeLayerIndex = layers.length - 1;
  compositeAll();
  updateLayerPanel();
}

function pushUndo(actionName) {
  undoStack.push({ name: actionName, state: captureState(), activeLayer: activeLayerIndex });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateHistoryPanel();
}

function doUndo() {
  if (undoStack.length <= 1) return;
  const current = undoStack.pop();
  redoStack.push(current);
  const prev = undoStack[undoStack.length - 1];
  activeLayerIndex = prev.activeLayer;
  restoreState(prev.state);
  updateHistoryPanel();
}

function doRedo() {
  if (redoStack.length === 0) return;
  const next = redoStack.pop();
  undoStack.push(next);
  activeLayerIndex = next.activeLayer;
  restoreState(next.state);
  updateHistoryPanel();
}

function updateHistoryPanel() {
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  const all = [...undoStack];
  const redoItems = [...redoStack].reverse();

  all.forEach((item, i) => {
    const el = document.createElement('button');
    el.className = 'history-item' + (i === all.length - 1 ? ' current' : '');
    el.textContent = item.name;
    el.onclick = () => {
      while (undoStack.length > i + 1) {
        redoStack.push(undoStack.pop());
      }
      const target = undoStack[undoStack.length - 1];
      activeLayerIndex = target.activeLayer;
      restoreState(target.state);
      updateHistoryPanel();
    };
    list.appendChild(el);
  });

  redoItems.forEach((item) => {
    const el = document.createElement('button');
    el.className = 'history-item future';
    el.textContent = item.name;
    list.appendChild(el);
  });

  list.scrollTop = list.scrollHeight;
}

/* ═══════════════════════════════════════════════════════
   ZOOM & PAN
   ═══════════════════════════════════════════════════════ */

function updateTransform() {
  canvasWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  document.getElementById('statusZoom').textContent = Math.round(zoom * 100) + '%';
}

function zoomTo(newZoom, cx, cy) {
  const wsRect = workspace.getBoundingClientRect();
  if (cx === undefined) cx = wsRect.width / 2;
  if (cy === undefined) cy = wsRect.height / 2;

  const worldX = (cx - panX) / zoom;
  const worldY = (cy - panY) / zoom;

  zoom = Math.max(0.05, Math.min(64, newZoom));

  panX = cx - worldX * zoom;
  panY = cy - worldY * zoom;
  updateTransform();
}

function zoomIn() { zoomTo(zoom * 1.25); }
function zoomOut() { zoomTo(zoom / 1.25); }
function zoom100() { zoomTo(1); centerCanvas(); }

function zoomFit() {
  const wsRect = workspace.getBoundingClientRect();
  const pad = 40;
  const scaleX = (wsRect.width - pad) / canvasW;
  const scaleY = (wsRect.height - pad) / canvasH;
  zoom = Math.min(scaleX, scaleY, 1);
  centerCanvas();
}

function centerCanvas() {
  const wsRect = workspace.getBoundingClientRect();
  panX = (wsRect.width - canvasW * zoom) / 2;
  panY = (wsRect.height - canvasH * zoom) / 2;
  updateTransform();
}

workspace.addEventListener('wheel', (e) => {
  e.preventDefault();
  const wsRect = workspace.getBoundingClientRect();
  const cx = e.clientX - wsRect.left;
  const cy = e.clientY - wsRect.top;
  const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
  zoomTo(zoom * factor, cx, cy);
}, { passive: false });

/* ═══════════════════════════════════════════════════════
   MOUSE → CANVAS COORDINATES
   ═══════════════════════════════════════════════════════ */

function screenToCanvas(clientX, clientY) {
  const wsRect = workspace.getBoundingClientRect();
  const sx = clientX - wsRect.left;
  const sy = clientY - wsRect.top;
  return {
    x: (sx - panX) / zoom,
    y: (sy - panY) / zoom
  };
}

/* ═══════════════════════════════════════════════════════
   TOOL SYSTEM
   ═══════════════════════════════════════════════════════ */

function selectTool(name) {
  currentTool = name;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === name));

  // Show/hide option groups
  const allOpts = ['opt-size','opt-opacity','opt-hardness','opt-fill-mode','opt-stroke-width','opt-font','opt-gradient-type','opt-tolerance','opt-select-type','opt-lasso-type','opt-sel-mode','opt-transform-sel'];
  allOpts.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (['brush','pencil','eraser'].includes(name)) {
    document.getElementById('opt-size').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
    if (name === 'brush') document.getElementById('opt-hardness').classList.remove('hidden');
  } else if (['rect','ellipse','line'].includes(name)) {
    document.getElementById('opt-fill-mode').classList.remove('hidden');
    document.getElementById('opt-stroke-width').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'text') {
    document.getElementById('opt-font').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'gradient') {
    document.getElementById('opt-gradient-type').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'fill') {
    document.getElementById('opt-tolerance').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'select') {
    document.getElementById('opt-select-type').classList.remove('hidden');
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    document.getElementById('opt-transform-sel').classList.remove('hidden');
  } else if (name === 'lasso') {
    document.getElementById('opt-lasso-type').classList.remove('hidden');
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    document.getElementById('opt-transform-sel').classList.remove('hidden');
  }

  // Cursor
  if (['brush','pencil','eraser'].includes(name)) {
    workspace.style.cursor = 'none'; // custom brush cursor handles this
  } else {
    workspace.style.cursor = (name === 'pan') ? 'grab' :
      name === 'move' ? 'default' :
      name === 'zoom' ? 'zoom-in' :
      name === 'eyedropper' ? 'crosshair' :
      name === 'text' ? 'text' : 'crosshair';
    brushCursorEl.style.display = 'none';
  }

  // Status
  const toolNames = {move:'Move',pan:'Pan',select:'Select',lasso:'Lasso',brush:'Brush',pencil:'Pencil',eraser:'Eraser',fill:'Fill',gradient:'Gradient',eyedropper:'Eyedropper',text:'Text',rect:'Rectangle',ellipse:'Ellipse',line:'Line',zoom:'Zoom'};
  document.getElementById('statusTool').textContent = toolNames[name] || name;
}

// Tool buttons
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});

// Keyboard shortcuts
const toolKeys = {v:'move',h:'pan',m:'select',l:'lasso',b:'brush',p:'pencil',e:'eraser',g:'fill',d:'gradient',i:'eyedropper',t:'text',u:'rect',o:'ellipse',n:'line',z:'zoom'};

/* ═══════════════════════════════════════════════════════
   DRAWING TOOLS IMPLEMENTATION
   ═══════════════════════════════════════════════════════ */

function getBrushSize() { return parseInt(document.getElementById('brushSize').value) || 8; }
function getToolOpacity() { return (parseInt(document.getElementById('toolOpacity').value) || 100) / 100; }
function getBrushHardness() { return (parseInt(document.getElementById('brushHardness').value) || 100) / 100; }

// Sync sliders with number inputs
document.getElementById('brushSize').addEventListener('input', function() { document.getElementById('brushSizeNum').value = this.value; });
document.getElementById('brushSizeNum').addEventListener('input', function() { document.getElementById('brushSize').value = this.value; });
document.getElementById('toolOpacity').addEventListener('input', function() { document.getElementById('toolOpacityNum').value = this.value; });
document.getElementById('toolOpacityNum').addEventListener('input', function() { document.getElementById('toolOpacity').value = this.value; });
document.getElementById('fillTolerance').addEventListener('input', function() { document.getElementById('fillToleranceNum').value = this.value; });
document.getElementById('fillToleranceNum').addEventListener('input', function() { document.getElementById('fillTolerance').value = this.value; });

function drawBrushStroke(ctx, x, y, size, color, hardness, opacity) {
  ctx.save();
  ctx.globalAlpha = opacity;
  if (hardness >= 0.95) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size/2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const r = size/2;
    const grad = ctx.createRadialGradient(x, y, r * hardness, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color.slice(0,7) + '00');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, size, size);
  }
  ctx.restore();
}

function drawLineBetween(ctx, x0, y0, x1, y1, size, color, hardness, opacity) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.floor(dist / Math.max(1, size / 4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawBrushStroke(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, size, color, hardness, opacity);
  }
}

function floodFill(ctx, startX, startY, fillColor, tolerance) {
  const w = canvasW, h = canvasH;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

  const targetIdx = (sy * w + sx) * 4;
  const tR = data[targetIdx], tG = data[targetIdx+1], tB = data[targetIdx+2], tA = data[targetIdx+3];

  // Parse fill color
  const tempC = document.createElement('canvas');
  tempC.width = 1; tempC.height = 1;
  const tempCtx = tempC.getContext('2d');
  tempCtx.fillStyle = fillColor;
  tempCtx.fillRect(0,0,1,1);
  const fc = tempCtx.getImageData(0,0,1,1).data;

  if (fc[0] === tR && fc[1] === tG && fc[2] === tB && fc[3] === tA) return;

  const visited = new Uint8Array(w * h);
  const stack = [sx + sy * w];
  visited[sx + sy * w] = 1;

  function match(idx) {
    return Math.abs(data[idx] - tR) <= tolerance &&
           Math.abs(data[idx+1] - tG) <= tolerance &&
           Math.abs(data[idx+2] - tB) <= tolerance &&
           Math.abs(data[idx+3] - tA) <= tolerance;
  }

  while (stack.length > 0) {
    const pos = stack.pop();
    const px = pos % w, py = Math.floor(pos / w);
    const idx = pos * 4;
    data[idx] = fc[0]; data[idx+1] = fc[1]; data[idx+2] = fc[2]; data[idx+3] = fc[3];

    const neighbors = [];
    if (px > 0) neighbors.push(pos - 1);
    if (px < w-1) neighbors.push(pos + 1);
    if (py > 0) neighbors.push(pos - w);
    if (py < h-1) neighbors.push(pos + w);

    for (const n of neighbors) {
      if (!visited[n] && match(n * 4)) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/* ═══════════════════════════════════════════════════════
   SELECTION SYSTEM — Complete Overhaul
   ═══════════════════════════════════════════════════════ */

// SVG constants for toolbar icon swapping
const RECT_SELECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -0.98 20.37 20.36"><path d="M0 5.31h1.38V3.1c0-1.12.6-1.7 1.69-1.7h2.2V0H3.04C1.02 0 0 1.03 0 3.03zm6.51-3.9h5.34V0H6.51zm10.48 3.9h1.38V3.03c0-1.99-1.03-3.01-3.05-3.01h-2.22v1.38h2.2c1.07 0 1.69.58 1.69 1.7zM16.98 11.84h1.38V6.56h-1.38zm-3.88 6.54h2.22c2.02 0 3.05-1.02 3.05-3.01v-2.28h-1.38v2.21c0 1.12-.62 1.7-1.69 1.7h-2.2zm-6.6 0h5.35V17H6.51zM3.04 18.38h2.22V17H3.07c-1.09 0-1.7-.58-1.7-1.7v-2.21H0v2.28c0 2 1.02 3.01 3.04 3.01zM0 11.84h1.38V6.56H0z" fill="currentColor"/></svg>';
const ELLIPSE_SELECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 22.35 22.35"><path d="M1.46 10.18c0-.96.16-1.89.45-2.74L.55 6.88C.2 7.91 0 9.02 0 10.18c0 1.15.2 2.27.56 3.3l1.34-.56c-.28-.85-.44-1.78-.44-2.74zM6.26 2.38l-.56-1.32C3.69 2.05 2.04 3.7 1.05 5.72l1.33.56c.84-1.69 2.2-3.05 3.88-3.9zM10.16 1.46c.96 0 1.89.16 2.76.45l.55-1.34C12.43.2 11.32 0 10.16 0 9.02 0 7.89.2 6.85.57l.56 1.34c.87-.3 1.79-.45 2.75-.45zm7.81 4.81l1.33-.55c-1-2.02-2.65-3.67-4.67-4.67l-.55 1.33c1.69.84 3.06 2.2 3.89 3.9zm.95 3.91c0 .96-.16 1.89-.44 2.75l1.33.56c.37-1.04.57-2.16.57-3.31 0-1.16-.2-2.27-.57-3.31l-1.33.56c.29.87.44 1.79.44 2.75zm-4.85 7.8l.55 1.33c2.02-1 3.66-2.65 4.66-4.66l-1.31-.56c-.84 1.69-2.21 3.06-3.91 3.89zm-3.9 1.96c-.97 0-1.89-.16-2.76-.45l-.55 1.34c1.04.37 2.16.56 3.31.56 1.16 0 2.27-.2 3.3-.56l-.56-1.34c-.87.28-1.78.44-2.75.44zM2.38 14.09l-1.33.55c1 2.02 2.65 3.67 4.66 4.66l.55-1.33c-1.68-.84-3.05-2.2-3.88-3.88z" fill="currentColor"/></svg>';
const LASSO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.63 0.93 25.22 22.66"><path fill="currentColor" d="M9.53,16.16c-0.01,0-0.02,0-0.03,0c-0.85,0-1.69-0.06-2.49-0.18L7.31,14c0.7,0.11,1.49,0.15,2.22,0.16 c0.5,0,1.01-0.02,1.53-0.07l0.18,1.99C10.66,16.13,10.09,16.16,9.53,16.16z M13.32,15.78l-0.38-1.96c1.28-0.25,2.49-0.62,3.61-1.11 l0.79,1.84C16.09,15.09,14.74,15.5,13.32,15.78z M4.9,15.49c-1.71-0.56-3.02-1.46-3.78-2.58l1.66-1.12c0.51,0.75,1.46,1.38,2.74,1.8 L4.9,15.49z M19.24,13.58l-1.03-1.72c1.17-0.7,2.09-1.51,2.68-2.34l1.63,1.15C21.78,11.73,20.65,12.74,19.24,13.58z M0.45,11.28 c-0.05-0.27-0.08-0.54-0.08-0.82c0-1.24,0.53-2.51,1.55-3.68l1.51,1.31c-0.69,0.8-1.06,1.62-1.06,2.37c0,0.15,0.01,0.29,0.04,0.44 L0.45,11.28z M23.51,8.49l-1.96-0.39c0.03-0.16,0.05-0.32,0.05-0.48c0-0.15-0.01-0.29-0.04-0.44c-0.12-0.6-0.48-1.15-1.07-1.62 L21.74,4c0.95,0.77,1.57,1.74,1.77,2.8c0.05,0.27,0.08,0.54,0.08,0.82C23.59,7.9,23.56,8.2,23.51,8.49z M4.74,6.88l-1.2-1.6 C4.6,4.49,5.87,3.8,7.29,3.25l0.72,1.87C6.76,5.6,5.66,6.2,4.74,6.88z M19.01,4.7c-1-0.41-2.24-0.67-3.58-0.76l0.12-2 c1.58,0.1,2.99,0.4,4.21,0.9L19.01,4.7z M9.81,4.54L9.29,2.6c0.45-0.12,0.91-0.22,1.38-0.32c0.93-0.18,1.86-0.3,2.77-0.35l0.11,2 c-0.82,0.04-1.66,0.15-2.5,0.31C10.63,4.33,10.21,4.43,9.81,4.54z"/><path fill="currentColor" d="M6,17.93c-0.56,0-1.11-0.17-1.59-0.49c-0.63-0.43-1.06-1.07-1.2-1.82c-0.3-1.54,0.71-3.04,2.25-3.34 c1.54-0.3,3.04,0.71,3.34,2.25c0.15,0.75-0.01,1.51-0.43,2.14c-0.43,0.63-1.07,1.06-1.82,1.2C6.37,17.91,6.19,17.93,6,17.93z M6.01,14.23c-0.05,0-0.11,0-0.16,0.02c-0.46,0.09-0.76,0.54-0.67,1c0.04,0.22,0.17,0.42,0.36,0.54c0.19,0.13,0.41,0.17,0.64,0.13 c0.22-0.04,0.42-0.17,0.54-0.36c0.13-0.19,0.17-0.41,0.13-0.64C6.77,14.51,6.41,14.23,6.01,14.23z"/><path fill="currentColor" d="M6.02,22.59l-0.38-1.96c0.6-0.12,0.99-0.36,1.2-0.75c0.49-0.9,0.06-2.44-0.15-2.96l1.85-0.75c0.11,0.28,1.08,2.77,0.06,4.66 C8.25,21.47,7.52,22.3,6.02,22.59z"/></svg>';
const POLY_LASSO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.63 -0.65 24.39 23.31"><path d="M6.67,11.3L6.1,9.76l-1.69,0.62l0.54,1.47c-0.86,0.63-1.33,1.72-1.12,2.83c0.14,0.75,0.57,1.39,1.2,1.82 C5.52,16.83,6.07,17,6.63,17c0.19,0,0.37-0.02,0.55-0.06c0.13-0.03,0.26-0.07,0.39-0.11c0.15,0.67,0.22,1.53-0.1,2.12 c-0.21,0.39-0.6,0.63-1.2,0.75l0.38,1.96c1.5-0.29,2.23-1.12,2.58-1.76c0.95-1.76,0.18-4.03-0.02-4.55 c0.06-0.12,0.1-0.25,0.14-0.38l2.36,0.02l0.02-1.8L9.3,13.17C8.89,12.06,7.84,11.31,6.67,11.3z M6.81,14.99 c-0.23,0.04-0.45,0-0.64-0.13c-0.19-0.12-0.32-0.32-0.36-0.54c-0.09-0.46,0.21-0.91,0.67-1c0.05-0.02,0.11-0.02,0.16-0.02 c0.4,0,0.76,0.28,0.84,0.69c0.04,0.23,0,0.45-0.13,0.64C7.23,14.82,7.03,14.95,6.81,14.99z" fill="currentColor"/><polygon points="14.8,4.23 12.77,5.73 11.21,5.32 10.75,7.07 13.15,7.69 15.87,5.68" fill="currentColor"/><polygon points="19.24,3.2 20.83,2.67 20.07,0.35 16.01,3.34 17.08,4.79" fill="currentColor"/><rect x="20.34" y="4.25" transform="matrix(0.9494 -0.3141 0.3141 0.9494 -1.0466 7.0124)" width="1.8" height="5" fill="currentColor"/><polygon points="5.59,8.36 4.51,5.44 9.3,6.69 9.76,4.95 4.92,3.69 4.48,5.36 3.92,3.82 3.47,3.31 1.63,2.83 3.9,8.98" fill="currentColor"/><polygon points="17.43,13.25 13.23,13.21 13.21,15.01 17.81,15.05 18.53,14.73 17.8,13.08" fill="currentColor"/><polygon points="23.35,10.27 21.64,10.83 21.8,11.31 19.17,12.47 19.9,14.12 24.02,12.29" fill="currentColor"/></svg>';

// Drawing-selection flag: prevents marching ants from interfering with live drawing preview
let isDrawingSelection = false;
let drawingPreviewPath = null; // temporary Path2D shown while dragging

function buildSelectionPath() {
  if (!selection) { selectionPath = null; return; }
  selectionPath = new Path2D();
  if (selection.type === 'rect') {
    selectionPath.rect(Math.round(selection.x), Math.round(selection.y), Math.round(selection.w), Math.round(selection.h));
  } else if (selection.type === 'ellipse') {
    const x=Math.round(selection.x), y=Math.round(selection.y), w=Math.round(selection.w), h=Math.round(selection.h);
    if (w > 0 && h > 0) selectionPath.ellipse(x+w/2, y+h/2, w/2, h/2, 0, 0, Math.PI*2);
  } else if (selection.type === 'lasso' && selection.points && selection.points.length > 2) {
    selectionPath.moveTo(Math.round(selection.points[0].x), Math.round(selection.points[0].y));
    for (let i=1; i<selection.points.length; i++) selectionPath.lineTo(Math.round(selection.points[i].x), Math.round(selection.points[i].y));
    selectionPath.closePath();
  }
}

function getSelectionBounds() {
  if (!selection) return null;
  if (selection.type === 'lasso' && selection.points) {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const p of selection.points) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
    return {x:minX, y:minY, w:maxX-minX, h:maxY-minY};
  }
  return {x:selection.x, y:selection.y, w:selection.w, h:selection.h};
}

function commitNewSelection(newPath, newSelData) {
  // newSelData = {type, x, y, w, h} or {type:'lasso', points:[...]}
  if (selectionMode === 'new') {
    selection = newSelData;
    selectionPath = newPath;
  } else if (selectionMode === 'add') {
    if (!selectionPath) {
      selection = newSelData;
      selectionPath = newPath;
    } else {
      // Composite: combine old and new into one Path2D
      const combined = new Path2D();
      combined.addPath(selectionPath);
      combined.addPath(newPath);
      selectionPath = combined;
      // Update selection bounds to encompass both
      const oldB = getSelectionBounds() || {x:0,y:0,w:0,h:0};
      const newB = newSelData.type === 'lasso' ? getBoundsFromPoints(newSelData.points) : {x:newSelData.x,y:newSelData.y,w:newSelData.w,h:newSelData.h};
      selection = {
        type:'composite',
        x: Math.min(oldB.x, newB.x), y: Math.min(oldB.y, newB.y),
        w: Math.max(oldB.x+oldB.w, newB.x+newB.w) - Math.min(oldB.x, newB.x),
        h: Math.max(oldB.y+oldB.h, newB.y+newB.h) - Math.min(oldB.y, newB.y)
      };
    }
  } else if (selectionMode === 'subtract') {
    if (!selectionPath) return; // nothing to subtract from
    // Use mask canvas approach for subtraction
    ensureMask();
    selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
    selectionMaskCtx.fillStyle = '#fff';
    selectionMaskCtx.fill(selectionPath);
    selectionMaskCtx.globalCompositeOperation = 'destination-out';
    selectionMaskCtx.fillStyle = '#fff';
    selectionMaskCtx.fill(newPath);
    selectionMaskCtx.globalCompositeOperation = 'source-over';
    // Rebuild selectionPath from mask using tracing
    rebuildPathFromMask();
    // Update bounds
    const b = getSelectionBounds();
    if (b) selection = { type:'composite', x:b.x, y:b.y, w:b.w, h:b.h };
  }
}

function getBoundsFromPoints(pts) {
  if (!pts || pts.length === 0) return {x:0,y:0,w:0,h:0};
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of pts) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
  return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};
}

function ensureMask() {
  if (!selectionMask || selectionMask.width !== canvasW || selectionMask.height !== canvasH) {
    selectionMask = document.createElement('canvas');
    selectionMask.width = canvasW; selectionMask.height = canvasH;
    selectionMaskCtx = selectionMask.getContext('2d');
  }
}

function rebuildPathFromMask() {
  // For subtract operations, we need to rebuild selectionPath from the mask
  // We use the mask as a clip source directly
  // Build a rectangular path covering the mask content area
  if (!selectionMask) return;
  const data = selectionMaskCtx.getImageData(0, 0, canvasW, canvasH).data;
  let minX=canvasW, minY=canvasH, maxX=0, maxY=0;
  let hasContent = false;
  for (let y=0; y<canvasH; y++) {
    for (let x=0; x<canvasW; x++) {
      if (data[(y*canvasW+x)*4+3] > 128) {
        minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y);
        hasContent = true;
      }
    }
  }
  if (!hasContent) { selection=null; selectionPath=null; return; }
  // For subtract, we use the mask canvas itself for clipping via compositing
  // Create a path that traces the mask edges (simplified: use mask as clip source)
  // We'll override the clip operation to use mask-based clipping
  selection = { type:'composite', x:minX, y:minY, w:maxX-minX+1, h:maxY-minY+1 };
  // selectionPath stays as the composited path from before subtract
  // Actual clipping will use the mask
}

function selectAll() {
  selection = { type:'rect', x:0, y:0, w:canvasW, h:canvasH };
  buildSelectionPath();
  drawOverlay();
}

function commitFloating() {
  if (!floatingActive || !floatingCanvas) return;
  const layer = getActiveLayer();
  if (layer) {
    layer.ctx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
  }
  floatingActive = false;
  floatingCanvas = null;
  floatingCtx = null;
  floatingOffset = {x:0, y:0};
  floatingSelectionData = null;
  compositeAll();
  updateLayerPanel();
}

function clearSelection() {
  // Commit any floating pixels first
  if (floatingActive) commitFloating();
  selection = null; selectionPath = null;
  lassoPoints = []; polyPoints = [];
  if (selectionMask) selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
  transformSelActive = false;
  const cb = document.getElementById('optTransformSel');
  if (cb) cb.checked = false;
  drawOverlay();
}

function deleteSelection() {
  if (!selectionPath) return;
  pushUndo('Delete');
  const layer = getActiveLayer();
  layer.ctx.save(); layer.ctx.clip(selectionPath);
  layer.ctx.clearRect(0, 0, canvasW, canvasH);
  layer.ctx.restore(); compositeAll();
}

function cropToSelection() {
  const b = getSelectionBounds();
  if (!b || b.w < 1 || b.h < 1) return;
  pushUndo('Crop');
  const nx=Math.max(0,Math.round(b.x)), ny=Math.max(0,Math.round(b.y));
  const nw=Math.min(canvasW-nx,Math.round(b.w)), nh=Math.min(canvasH-ny,Math.round(b.h));
  const newLayers = layers.map(l => {
    const d=l.ctx.getImageData(nx,ny,nw,nh); const c=document.createElement('canvas');
    c.width=nw; c.height=nh; const ctx=c.getContext('2d'); ctx.putImageData(d,0,0);
    return {...l, canvas:c, ctx};
  });
  canvasW=nw; canvasH=nh; compositeCanvas.width=nw; compositeCanvas.height=nh;
  overlayCanvas.width=nw; overlayCanvas.height=nh;
  canvasWrapper.style.width=nw+'px'; canvasWrapper.style.height=nh+'px';
  layers=newLayers; clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
}

/* --- Options bar functions --- */
function setSelectShape(shape) {
  selectShape = shape;
  document.getElementById('optSelectRect').classList.toggle('active', shape==='rect');
  document.getElementById('optSelectEllipse').classList.toggle('active', shape==='ellipse');
  document.getElementById('selectToolBtn').innerHTML = shape==='rect' ? RECT_SELECT_SVG : ELLIPSE_SELECT_SVG;
}

function setLassoMode(mode) {
  lassoMode = mode;
  document.getElementById('optLassoFree').classList.toggle('active', mode==='free');
  document.getElementById('optLassoPoly').classList.toggle('active', mode==='poly');
  const btn = document.getElementById('lassoToolBtn');
  if (btn) btn.innerHTML = mode==='free' ? LASSO_SVG : POLY_LASSO_SVG;
}

function setSelectionMode(mode) {
  selectionMode = mode;
  document.getElementById('optSelNew').classList.toggle('active', mode==='new');
  document.getElementById('optSelAdd').classList.toggle('active', mode==='add');
  document.getElementById('optSelSub').classList.toggle('active', mode==='subtract');
}

function toggleTransformSelection(checked) {
  transformSelActive = checked;
  drawOverlay();
}

/* --- Marching Ants (Professional) --- */
let marchingAntsOffset = 0;
let marchingAntsRAF = null;

function drawAntsOnPath(ctx, path) {
  if (!path) return;
  const lw = 1 / zoom;
  const dashLen = Math.max(3, 5 / zoom);
  ctx.save();
  ctx.lineWidth = lw;
  // Black base
  ctx.strokeStyle = '#000000';
  ctx.setLineDash([]);
  ctx.stroke(path);
  // White dashes (marching)
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([dashLen, dashLen]);
  ctx.lineDashOffset = -marchingAntsOffset * lw * 0.8;
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, canvasW, canvasH);

  // Don't render committed selection ants while actively drawing a new one
  if (isDrawingSelection) {
    // Draw the in-progress preview path
    if (drawingPreviewPath) drawAntsOnPath(overlayCtx, drawingPreviewPath);
    // Also draw committed selection if in add/subtract mode
    if (selectionMode !== 'new' && selectionPath) {
      drawAntsOnPath(overlayCtx, selectionPath);
    }
    return;
  }

  // Render committed selection
  if (selectionPath) {
    if (floatingActive) {
      overlayCtx.save();
      overlayCtx.translate(floatingOffset.x, floatingOffset.y);
      drawAntsOnPath(overlayCtx, selectionPath);
      overlayCtx.restore();
    } else {
      drawAntsOnPath(overlayCtx, selectionPath);
    }
  }

  // Transform handles
  if (transformSelActive && selection) {
    const b = getSelectionBounds();
    if (b && b.w > 0 && b.h > 0) drawTransformHandles(b);
  }
}

function drawTransformHandles(b) {
  const x=Math.round(b.x), y=Math.round(b.y), w=Math.round(b.w), h=Math.round(b.h);
  const hs = 4 / zoom;
  overlayCtx.save();
  // Bounding box outline
  overlayCtx.strokeStyle = '#0088ff';
  overlayCtx.lineWidth = 1 / zoom;
  overlayCtx.setLineDash([]);
  overlayCtx.strokeRect(x, y, w, h);
  // Handles
  overlayCtx.fillStyle = '#ffffff';
  overlayCtx.strokeStyle = '#0088ff';
  const handles = [[x,y],[x+w/2,y],[x+w,y],[x,y+h/2],[x+w,y+h/2],[x,y+h],[x+w/2,y+h],[x+w,y+h]];
  for (const [hx,hy] of handles) {
    overlayCtx.fillRect(hx-hs,hy-hs,hs*2,hs*2);
    overlayCtx.strokeRect(hx-hs,hy-hs,hs*2,hs*2);
  }
  overlayCtx.restore();
}

function startMarchingAnts() {
  if (marchingAntsRAF) return;
  let lastTime = 0;
  function animate(time) {
    marchingAntsRAF = requestAnimationFrame(animate);
    if (time - lastTime < 50) return;
    lastTime = time;
    marchingAntsOffset = (marchingAntsOffset + 1) % 300;
    drawOverlay();
  }
  marchingAntsRAF = requestAnimationFrame(animate);
}
startMarchingAnts();

/* --- Transform Interaction --- */
function getTransformHandle(px, py) {
  if (!transformSelActive) return null;
  const b = getSelectionBounds();
  if (!b || b.w < 1) return null;
  const {x,y,w,h} = b;
  const t = 8 / zoom;
  const handles = [{n:'nw',hx:x,hy:y},{n:'n',hx:x+w/2,hy:y},{n:'ne',hx:x+w,hy:y},{n:'w',hx:x,hy:y+h/2},{n:'e',hx:x+w,hy:y+h/2},{n:'sw',hx:x,hy:y+h},{n:'s',hx:x+w/2,hy:y+h},{n:'se',hx:x+w,hy:y+h}];
  for (const h of handles) { if (Math.abs(px-h.hx)<=t && Math.abs(py-h.hy)<=t) return h.n; }
  if (px>=x && px<=x+w && py>=y && py<=y+h) return 'move';
  return null;
}

function applyTransformDelta(handle, dx, dy) {
  if (!selection) return;
  const b = getSelectionBounds();
  if (!b) return;
  let {x,y,w,h} = b;
  if (handle==='move'){x+=dx;y+=dy;}
  else if(handle==='nw'){x+=dx;y+=dy;w-=dx;h-=dy;}
  else if(handle==='n'){y+=dy;h-=dy;}
  else if(handle==='ne'){w+=dx;y+=dy;h-=dy;}
  else if(handle==='w'){x+=dx;w-=dx;}
  else if(handle==='e'){w+=dx;}
  else if(handle==='sw'){x+=dx;w-=dx;h+=dy;}
  else if(handle==='s'){h+=dy;}
  else if(handle==='se'){w+=dx;h+=dy;}
  if(w<1){x+=w;w=Math.abs(w)||1;} if(h<1){y+=h;h=Math.abs(h)||1;}
  
  // For lasso, scale the points
  if (selection.type==='lasso' && selection.points) {
    const ob=getSelectionBounds();
    if(ob && ob.w>0 && ob.h>0) {
      const sx=w/ob.w, sy=h/ob.h, ox=x-ob.x*sx, oy=y-ob.y*sy;
      selection.points = selection.points.map(p=>({x:p.x*sx+ox, y:p.y*sy+oy}));
    }
  } else {
    selection.x=x; selection.y=y; selection.w=w; selection.h=h;
  }
  buildSelectionPath();
  drawOverlay();
}

/* ═══════════════════════════════════════════════════════
   MOUSE EVENT HANDLING
   ═══════════════════════════════════════════════════════ */

workspace.addEventListener('mousedown', onMouseDown);
workspace.addEventListener('mousemove', onMouseMove);
workspace.addEventListener('mouseup', onMouseUp);
workspace.addEventListener('mouseleave', onMouseUp);
workspace.addEventListener('dblclick', onDblClick);

function onDblClick(e) {
  if (currentTool==='lasso' && lassoMode==='poly' && polyPoints.length>2) {
    finishPolygonalLasso();
  }
}

function finishPolygonalLasso() {
  if (polyPoints.length < 3) { polyPoints=[]; drawOverlay(); return; }
  const p = new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for (let i=1;i<polyPoints.length;i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  p.closePath();
  const selData = {type:'lasso', points:[...polyPoints]};
  commitNewSelection(p, selData);
  polyPoints = [];
  isDrawingSelection = false;
  drawingPreviewPath = null;
  drawOverlay();
}

function makeShapePath(shape, sx, sy, sw, sh) {
  const p = new Path2D();
  if (shape==='rect') p.rect(sx, sy, sw, sh);
  else if (shape==='ellipse' && sw>0 && sh>0) p.ellipse(sx+sw/2, sy+sh/2, sw/2, sh/2, 0, 0, Math.PI*2);
  return p;
}

function onMouseDown(e) {
  const pos = screenToCanvas(e.clientX, e.clientY);
  const px=pos.x, py=pos.y;
  isDrawing = true;
  drawStart = {x:px, y:py}; lastDraw = {x:px, y:py};

  // Pan
  if (e.button===1 || (e.button===0 && currentTool==='pan') || (e.button===0 && e.altKey) || (e.button===0 && spaceDown)) {
    isPanning=true; isDrawing=false;
    panStart={x:e.clientX-panX, y:e.clientY-panY};
    workspace.style.cursor='grabbing'; return;
  }

  // Move tool
  if (e.button===0 && currentTool==='move') {
    const layer=getActiveLayer(); if(!layer||!layer.visible) return;
    
    if (floatingActive && floatingCanvas) {
      // Already floating — start repositioning
      isMovingPixels = true;
      isDrawing = false;
      return;
    }
    
    // Not floating yet — cut pixels and create floating selection
    pushUndo('Move');
    floatingCanvas = document.createElement('canvas');
    floatingCanvas.width = canvasW;
    floatingCanvas.height = canvasH;
    floatingCtx = floatingCanvas.getContext('2d');
    
    if (selectionPath) {
      // Cut selected pixels
      floatingCtx.save();
      floatingCtx.clip(selectionPath);
      floatingCtx.drawImage(layer.canvas, 0, 0);
      floatingCtx.restore();
      // Clear from layer (transparency)
      layer.ctx.save();
      layer.ctx.clip(selectionPath);
      layer.ctx.clearRect(0, 0, canvasW, canvasH);
      layer.ctx.restore();
    } else {
      // Move entire layer contents
      floatingCtx.drawImage(layer.canvas, 0, 0);
      layer.ctx.clearRect(0, 0, canvasW, canvasH);
    }
    
    floatingActive = true;
    floatingOffset = {x:0, y:0};
    isMovingPixels = true;
    isDrawing = false;
    compositeAll();
    return;
  }

  // Zoom
  if (e.button===0 && currentTool==='zoom') {
    const r=workspace.getBoundingClientRect();
    if(e.shiftKey) zoomTo(zoom/1.4, e.clientX-r.left, e.clientY-r.top);
    else zoomTo(zoom*1.4, e.clientX-r.left, e.clientY-r.top); return;
  }

  const layer=getActiveLayer(); if(!layer||!layer.visible) return;

  // Transform handles
  if (transformSelActive && (currentTool==='select'||currentTool==='lasso')) {
    const handle=getTransformHandle(px,py);
    if (handle) { transformHandleDrag=handle; transformOrigBounds=selection?JSON.parse(JSON.stringify(selection)):null; isDrawing=false; return; }
  }

  // Select tool
  if (currentTool==='select') {
    isDrawingSelection = true;
    drawingPreviewPath = null;
    if (selectionMode==='new') { selection=null; selectionPath=null; }
    return;
  }

  // Lasso tool
  if (currentTool==='lasso') {
    if (lassoMode==='free') {
      isDrawingSelection = true;
      drawingPreviewPath = null;
      if (selectionMode==='new') { selection=null; selectionPath=null; }
      lassoPoints = [{x:px, y:py}];
    } else if (lassoMode==='poly') {
      if (polyPoints.length===0) {
        isDrawingSelection = true;
        if (selectionMode==='new') { selection=null; selectionPath=null; }
      }
      if (polyPoints.length>0) {
        const first=polyPoints[0];
        if (Math.hypot(px-first.x, py-first.y) < 10/zoom && polyPoints.length>2) {
          finishPolygonalLasso(); isDrawing=false; return;
        }
      }
      polyPoints.push({x:px, y:py});
      updatePolyPreviewPath();
      isDrawing=false;
    }
    return;
  }

  // Drawing tools
  if (['brush','pencil','eraser'].includes(currentTool)) {
    pushUndo(currentTool.charAt(0).toUpperCase()+currentTool.slice(1));
    const size=currentTool==='pencil'?1:getBrushSize();
    const color=currentTool==='eraser'?'rgba(0,0,0,1)':fgColor;
    const hardness=currentTool==='pencil'?1:getBrushHardness();
    // Create stroke buffer for non-stacking opacity
    strokeBuffer=document.createElement('canvas'); strokeBuffer.width=canvasW; strokeBuffer.height=canvasH;
    strokeBufferCtx=strokeBuffer.getContext('2d');
    if(currentTool==='eraser'){strokeBufferCtx.globalCompositeOperation='source-over';}
    drawBrushStroke(strokeBufferCtx,px,py,size,color,hardness,1);
    compositeAllWithStrokeBuffer();
  } else if (currentTool==='fill') {
    pushUndo('Fill'); const tol=parseInt(document.getElementById('fillTolerance').value)||32;
    if(selectionPath){layer.ctx.save();layer.ctx.clip(selectionPath);floodFill(layer.ctx,px,py,fgColor,tol);layer.ctx.restore();}else floodFill(layer.ctx,px,py,fgColor,tol);
    compositeAll();
  } else if (currentTool==='eyedropper') { pickColor(px,py);
  } else if (currentTool==='text') {
    const text=prompt('Enter text:'); if(text){pushUndo('Text');const font=document.getElementById('textFont').value;const size=parseInt(document.getElementById('textSize').value)||24;layer.ctx.save();layer.ctx.globalAlpha=getToolOpacity();layer.ctx.font=`${size}px "${font}"`;layer.ctx.fillStyle=fgColor;layer.ctx.textBaseline='top';if(selectionPath)layer.ctx.clip(selectionPath);layer.ctx.fillText(text,px,py);layer.ctx.restore();compositeAll();}
  } else if (currentTool==='gradient') { gradientStart={x:px,y:py}; gradientEnd={x:px,y:py}; }
  updateStatus(e);
}

function onMouseMove(e) {
  const pos=screenToCanvas(e.clientX,e.clientY);
  const px=pos.x, py=pos.y;
  document.getElementById('statusPos').textContent=`X: ${Math.round(px)}  Y: ${Math.round(py)}`;

  if(isPanning){panX=e.clientX-panStart.x;panY=e.clientY-panStart.y;updateTransform();return;}
  
  // Floating selection dragging
  if(isMovingPixels&&floatingActive&&floatingCanvas){
    const dx=px-drawStart.x, dy=py-drawStart.y;
    floatingOffset.x += dx;
    floatingOffset.y += dy;
    drawStart = {x:px, y:py}; // reset for continuous delta
    compositeAll();
    drawOverlay();
    return;
  }

  // Transform dragging
  if(transformHandleDrag&&transformOrigBounds){
    const dx=px-drawStart.x, dy=py-drawStart.y;
    selection=JSON.parse(JSON.stringify(transformOrigBounds));
    applyTransformDelta(transformHandleDrag, dx, dy);
    return;
  }

  // Transform cursor
  if(transformSelActive&&(currentTool==='select'||currentTool==='lasso')&&!isDrawing){
    const h=getTransformHandle(px,py);
    if(h){const c={nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};workspace.style.cursor=c[h]||'crosshair';}
    else workspace.style.cursor='crosshair';
  }

  // Poly lasso hover preview
  if(currentTool==='lasso'&&lassoMode==='poly'&&polyPoints.length>0&&!isDrawing){
    updatePolyPreviewPath(px,py); return;
  }

  if(!isDrawing) return;
  const layer=getActiveLayer(); if(!layer||!layer.visible) return;

  // Select tool dragging
  if(currentTool==='select'&&isDrawingSelection){
    const sx=Math.round(Math.min(drawStart.x,px)), sy=Math.round(Math.min(drawStart.y,py));
    const sw=Math.round(Math.abs(px-drawStart.x)), sh=Math.round(Math.abs(py-drawStart.y));
    if(sw>0&&sh>0) drawingPreviewPath=makeShapePath(selectShape, sx, sy, sw, sh);
    drawOverlay();
    return;
  }

  // Lasso freeform dragging
  if(currentTool==='lasso'&&lassoMode==='free'&&isDrawingSelection){
    lassoPoints.push({x:px, y:py});
    // Build preview path from points
    const p=new Path2D();
    p.moveTo(Math.round(lassoPoints[0].x), Math.round(lassoPoints[0].y));
    for(let i=1;i<lassoPoints.length;i++) p.lineTo(Math.round(lassoPoints[i].x), Math.round(lassoPoints[i].y));
    drawingPreviewPath = p;
    drawOverlay();
    return;
  }

  // Other tools
  if(['brush','pencil','eraser'].includes(currentTool)&&strokeBuffer){
    const size=currentTool==='pencil'?1:getBrushSize();const color=currentTool==='eraser'?'rgba(0,0,0,1)':fgColor;const hardness=currentTool==='pencil'?1:getBrushHardness();
    drawLineBetween(strokeBufferCtx,lastDraw.x,lastDraw.y,px,py,size,color,hardness,1);
    compositeAllWithStrokeBuffer();
    lastDraw={x:px,y:py};
  } else if(currentTool==='gradient'){
    gradientEnd={x:px,y:py};
    overlayCtx.clearRect(0,0,canvasW,canvasH);overlayCtx.beginPath();overlayCtx.moveTo(gradientStart.x,gradientStart.y);overlayCtx.lineTo(gradientEnd.x,gradientEnd.y);overlayCtx.strokeStyle='#fff';overlayCtx.lineWidth=1/zoom;overlayCtx.setLineDash([4/zoom,4/zoom]);overlayCtx.stroke();overlayCtx.setLineDash([]);
  } else if(['rect','ellipse','line'].includes(currentTool)){
    overlayCtx.clearRect(0,0,canvasW,canvasH); drawShapePreview(overlayCtx,drawStart.x,drawStart.y,px,py);
  }
}

function updatePolyPreviewPath(cursorX, cursorY) {
  if(polyPoints.length===0) return;
  const p=new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for(let i=1;i<polyPoints.length;i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  if(cursorX!==undefined) p.lineTo(Math.round(cursorX), Math.round(cursorY));
  drawingPreviewPath = p;

  // Also draw vertex dots
  overlayCtx.clearRect(0,0,canvasW,canvasH);
  if(selectionMode!=='new'&&selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
  drawAntsOnPath(overlayCtx, p);
  overlayCtx.save();
  overlayCtx.fillStyle='#fff'; overlayCtx.strokeStyle='#000'; overlayCtx.lineWidth=1/zoom;
  for(const pt of polyPoints){const r=3/zoom;overlayCtx.beginPath();overlayCtx.arc(Math.round(pt.x),Math.round(pt.y),r,0,Math.PI*2);overlayCtx.fill();overlayCtx.stroke();}
  overlayCtx.restore();
}

function onMouseUp(e) {
  if(transformHandleDrag){transformHandleDrag=null;transformOrigBounds=null;return;}
  if(isPanning){isPanning=false;workspace.style.cursor=currentTool==='pan'?'grab':(currentTool==='move'?'default':'crosshair');return;}
  if(isMovingPixels&&moveFloatCanvas){const layer=getActiveLayer();if(layer)layer.ctx.drawImage(moveFloatCanvas,moveOffset.x,moveOffset.y);isMovingPixels=false;moveFloatCanvas=null;moveFloatCtx=null;compositeAll();return;}
  if(!isDrawing) return;
  isDrawing=false;

  const pos=screenToCanvas(e.clientX||0,e.clientY||0);
  const px=pos.x,py=pos.y;
  const layer=getActiveLayer();

  // Finalize rect/ellipse selection
  if(currentTool==='select'&&isDrawingSelection){
    isDrawingSelection=false; drawingPreviewPath=null;
    const sx=Math.round(Math.min(drawStart.x,px)), sy=Math.round(Math.min(drawStart.y,py));
    const sw=Math.round(Math.abs(px-drawStart.x)), sh=Math.round(Math.abs(py-drawStart.y));
    if(sw>1&&sh>1){
      const p=makeShapePath(selectShape,sx,sy,sw,sh);
      commitNewSelection(p, {type:selectShape, x:sx, y:sy, w:sw, h:sh});
    }
    drawOverlay(); return;
  }

  // Finalize freeform lasso
  if(currentTool==='lasso'&&lassoMode==='free'&&isDrawingSelection){
    isDrawingSelection=false; drawingPreviewPath=null;
    if(lassoPoints.length>2){
      const p=new Path2D();
      p.moveTo(Math.round(lassoPoints[0].x),Math.round(lassoPoints[0].y));
      for(let i=1;i<lassoPoints.length;i++) p.lineTo(Math.round(lassoPoints[i].x),Math.round(lassoPoints[i].y));
      p.closePath();
      commitNewSelection(p, {type:'lasso', points:[...lassoPoints]});
      lassoPoints=[];
    }
    drawOverlay(); return;
  }

  // Commit brush stroke buffer
  if(['brush','pencil','eraser'].includes(currentTool)&&strokeBuffer&&layer){
    const opacity=getToolOpacity();
    layer.ctx.save();
    if(selectionPath) layer.ctx.clip(selectionPath);
    if(currentTool==='eraser'){
      layer.ctx.globalCompositeOperation='destination-out';
      layer.ctx.globalAlpha=opacity;
      layer.ctx.drawImage(strokeBuffer,0,0);
    } else {
      layer.ctx.globalAlpha=opacity;
      layer.ctx.drawImage(strokeBuffer,0,0);
    }
    layer.ctx.restore();
    strokeBuffer=null; strokeBufferCtx=null;
    compositeAll(); return;
  }

  // Gradient
  if(currentTool==='gradient'&&gradientStart&&gradientEnd&&layer){
    pushUndo('Gradient');const type=document.getElementById('gradientType').value;
    layer.ctx.save();layer.ctx.globalAlpha=getToolOpacity();if(selectionPath)layer.ctx.clip(selectionPath);
    let grad;if(type==='radial'){const r=Math.hypot(gradientEnd.x-gradientStart.x,gradientEnd.y-gradientStart.y);grad=layer.ctx.createRadialGradient(gradientStart.x,gradientStart.y,0,gradientStart.x,gradientStart.y,r);}else grad=layer.ctx.createLinearGradient(gradientStart.x,gradientStart.y,gradientEnd.x,gradientEnd.y);
    grad.addColorStop(0,fgColor);grad.addColorStop(1,bgColor);layer.ctx.fillStyle=grad;layer.ctx.fillRect(0,0,canvasW,canvasH);layer.ctx.restore();compositeAll();overlayCtx.clearRect(0,0,canvasW,canvasH);gradientStart=null;gradientEnd=null;
  } else if(['rect','ellipse','line'].includes(currentTool)&&layer){
    pushUndo('Shape');drawShapeOnLayer(layer.ctx,drawStart.x,drawStart.y,px,py);compositeAll();overlayCtx.clearRect(0,0,canvasW,canvasH);
  }
}
function drawShapePreview(ctx, x1, y1, x2, y2) {
  const fillMode = document.getElementById('shapeFillMode').value;
  const sw = parseInt(document.getElementById('shapeStrokeWidth').value) || 2;

  ctx.save();
  ctx.strokeStyle = fgColor;
  ctx.fillStyle = fgColor;
  ctx.lineWidth = sw / zoom;
  ctx.globalAlpha = getToolOpacity();

  if (currentTool === 'rect') {
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (fillMode === 'fill' || fillMode === 'both') ctx.fillRect(x, y, w, h);
    if (fillMode === 'stroke' || fillMode === 'both') ctx.strokeRect(x, y, w, h);
  } else if (currentTool === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fillMode === 'fill' || fillMode === 'both') ctx.fill();
    if (fillMode === 'stroke' || fillMode === 'both') ctx.stroke();
  } else if (currentTool === 'line') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

function drawShapeOnLayer(ctx, x1, y1, x2, y2) {
  const fillMode = document.getElementById('shapeFillMode').value;
  const sw = parseInt(document.getElementById('shapeStrokeWidth').value) || 2;

  ctx.save();
  ctx.strokeStyle = fgColor;
  ctx.fillStyle = fgColor;
  ctx.lineWidth = sw;
  ctx.globalAlpha = getToolOpacity();
  if (selectionPath) ctx.clip(selectionPath);

  if (currentTool === 'rect') {
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (fillMode === 'fill' || fillMode === 'both') ctx.fillRect(x, y, w, h);
    if (fillMode === 'stroke' || fillMode === 'both') ctx.strokeRect(x, y, w, h);
  } else if (currentTool === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fillMode === 'fill' || fillMode === 'both') ctx.fill();
    if (fillMode === 'stroke' || fillMode === 'both') ctx.stroke();
  } else if (currentTool === 'line') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

/* ═══════════════════════════════════════════════════════
   COLOR SYSTEM — HSV Master State + Custom Picker
   ═══════════════════════════════════════════════════════ */

// HSV master state
let cpH = 0, cpS = 0, cpV = 1;

// --- Color Conversions ---
function hsvToRgb(h, s, v) {
  let r, g, b, i = Math.floor((h / 360) * 6), f = (h / 360) * 6 - i;
  let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break; case 2: r=p;g=v;b=t; break;
    case 3: r=p;g=q;b=v; break; case 4: r=t;g=p;b=v; break; case 5: r=v;g=p;b=q; break;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  let max=Math.max(r,g,b), min=Math.min(r,g,b), h, s, v=max, d=max-min;
  s = max===0 ? 0 : d/max;
  if (max===min) h=0;
  else { switch(max) { case r: h=(g-b)/d+(g<b?6:0); break; case g: h=(b-r)/d+2; break; case b: h=(r-g)/d+4; break; } h/=6; }
  return { h: h*360, s, v };
}
function hsvToHsl(h, s, v) {
  let l = v*(1-s/2);
  let sl = (l===0||l===1) ? 0 : (v-l)/Math.min(l,1-l);
  return { h, s: sl, l };
}
function hslToHsv(h, sl, l) {
  let v = l + sl*Math.min(l,1-l);
  let s = v===0 ? 0 : 2*(1-l/v);
  return { h, s, v };
}
function rgbToHex(r, g, b) { return ((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1).toUpperCase(); }
function hexToRgb(hex) {
  let r = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r:parseInt(r[1],16), g:parseInt(r[2],16), b:parseInt(r[3],16) } : null;
}

function setFgColor(hex) { fgColor = hex; updateColorUI(); }
function setBgColor(hex) { bgColor = hex; updateColorUI(); }
function swapColors() { [fgColor, bgColor] = [bgColor, fgColor]; updateColorUI(); }

function setFgFromHSV() {
  const rgb = hsvToRgb(cpH, cpS, cpV);
  fgColor = '#' + rgbToHex(rgb.r, rgb.g, rgb.b);
  updateColorUI();
}

function updateColorUI() {
  document.getElementById('fgWell').style.background = fgColor;
  document.getElementById('bgWell').style.background = bgColor;
  document.getElementById('colorSwatchPreview').style.background = fgColor;

  const temp = document.createElement('canvas'); temp.width=1; temp.height=1;
  const tctx = temp.getContext('2d'); tctx.fillStyle = fgColor; tctx.fillRect(0,0,1,1);
  const d = tctx.getImageData(0,0,1,1).data;

  document.getElementById('hexInput').value = fgColor.replace('#','').toUpperCase();
  document.getElementById('rInput').value = d[0];
  document.getElementById('gInput').value = d[1];
  document.getElementById('bInput').value = d[2];

  // Sync picker if open
  if (document.getElementById('colorPickerPanel').classList.contains('show')) {
    cpRenderFromState();
  }
}

// Right-panel mini inputs
document.getElementById('hexInput').addEventListener('change', function() {
  let v = this.value.replace('#','');
  if (/^[0-9a-fA-F]{6}$/.test(v)) {
    setFgColor('#' + v);
    const rgb = hexToRgb(v);
    if (rgb) { const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v; }
  }
});

['rInput','gInput','bInput'].forEach(id => {
  document.getElementById(id).addEventListener('change', function() {
    const r = parseInt(document.getElementById('rInput').value)||0;
    const g = parseInt(document.getElementById('gInput').value)||0;
    const b = parseInt(document.getElementById('bInput').value)||0;
    const hex = '#' + [r,g,b].map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
    setFgColor(hex);
    const hsv = rgbToHsv(r,g,b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
  });
});

// Color wells
document.getElementById('fgWell').addEventListener('click', () => toggleColorPicker());
document.getElementById('bgWell').addEventListener('dblclick', () => {
  // Simple swap to bg, open picker
  swapColors();
  toggleColorPicker();
});

function pickColor(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix<0||iy<0||ix>=canvasW||iy>=canvasH) return;
  const layer = getActiveLayer();
  const d = layer.ctx.getImageData(ix, iy, 1, 1).data;
  const hex = '#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
  const hsv = rgbToHsv(d[0],d[1],d[2]);
  if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
  setFgColor(hex);
}

/* ═══════════════════════════════════════════════════════
   COLOR PICKER PANEL LOGIC
   ═══════════════════════════════════════════════════════ */

const cpPanel = document.getElementById('colorPickerPanel');

function toggleColorPicker() {
  if (cpPanel.classList.contains('show')) { closeColorPicker(); return; }
  // Sync HSV from current fgColor
  const temp = document.createElement('canvas'); temp.width=1; temp.height=1;
  const tctx = temp.getContext('2d'); tctx.fillStyle = fgColor; tctx.fillRect(0,0,1,1);
  const d = tctx.getImageData(0,0,1,1).data;
  const hsv = rgbToHsv(d[0],d[1],d[2]);
  if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;

  cpPanel.classList.add('show');
  // Center on screen if not already positioned
  if (!cpPanel.dataset.positioned) {
    cpPanel.style.left = Math.max(50, (window.innerWidth - 520)/2) + 'px';
    cpPanel.style.top = Math.max(80, (window.innerHeight - 400)/2) + 'px';
    cpPanel.dataset.positioned = '1';
  }
  cpRenderFromState();
}

function closeColorPicker() { cpPanel.classList.remove('show'); }

// --- Dragging ---
let cpDragging = false, cpDragOff = {x:0,y:0};
document.getElementById('cpTitlebar').addEventListener('mousedown', (e) => {
  cpDragging = true;
  cpDragOff = { x: e.clientX - cpPanel.offsetLeft, y: e.clientY - cpPanel.offsetTop };
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!cpDragging) return;
  cpPanel.style.left = Math.max(0, e.clientX - cpDragOff.x) + 'px';
  cpPanel.style.top = Math.max(0, e.clientY - cpDragOff.y) + 'px';
});
document.addEventListener('mouseup', () => { cpDragging = false; });

// --- View Toggles ---
function cpSwitchView(view) {
  document.querySelectorAll('#colorPickerPanel .cp-left .cp-vtab').forEach(b => b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('cpSpectrumView').classList.toggle('hidden', view!=='spectrum');
  document.getElementById('cpWheelView').classList.toggle('hidden', view!=='wheel');
  cpRenderFromState();
}

function cpSwitchSliders(mode) {
  document.querySelectorAll('#colorPickerPanel .cp-right .cp-vtab').forEach(b => b.classList.toggle('active', b.dataset.slider===mode));
  document.getElementById('cpSlidersRgb').classList.toggle('hidden', mode!=='rgb');
  document.getElementById('cpSlidersHsb').classList.toggle('hidden', mode!=='hsb');
  document.getElementById('cpSlidersHsl').classList.toggle('hidden', mode!=='hsl');
  cpRenderFromState();
}

// --- Render from HSV state ---
function cpRenderFromState() {
  const rgb = hsvToRgb(cpH, cpS, cpV);
  const pureRgb = hsvToRgb(cpH, 1, 1);
  const hsl = hsvToHsl(cpH, cpS, cpV);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b);

  // CSS vars
  cpPanel.style.setProperty('--cp-pure-hue', `rgb(${pureRgb.r},${pureRgb.g},${pureRgb.b})`);

  // Swatch + Hex
  document.getElementById('cpSwatch').style.background = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
  const hexIn = document.getElementById('cpHexInput');
  if (document.activeElement !== hexIn) hexIn.value = hex;

  // Spectrum view
  const svField = document.getElementById('cpSvField');
  svField.style.background = `linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, rgb(${pureRgb.r},${pureRgb.g},${pureRgb.b}))`;
  document.getElementById('cpSvReticle').style.left = (cpS*100)+'%';
  document.getElementById('cpSvReticle').style.top = ((1-cpV)*100)+'%';
  document.getElementById('cpHueSlider').value = cpH;

  // Wheel view
  document.getElementById('cpWheelDarken').style.opacity = 1 - cpV;
  const angle = cpH * Math.PI / 180;
  document.getElementById('cpWheelReticle').style.left = (50 + cpS*50*Math.cos(angle))+'%';
  document.getElementById('cpWheelReticle').style.top = (50 + cpS*50*Math.sin(angle))+'%';
  document.getElementById('cpBriSlider').value = Math.round(cpV*100);
  const briEndRgb = hsvToRgb(cpH, cpS, 1);
  document.getElementById('cpBriSlider').style.background = `linear-gradient(to right, #000, rgb(${briEndRgb.r},${briEndRgb.g},${briEndRgb.b}))`;

  // RGB sliders
  const rS=document.getElementById('cpR'), gS=document.getElementById('cpG'), bS=document.getElementById('cpB');
  rS.value=rgb.r; gS.value=rgb.g; bS.value=rgb.b;
  document.getElementById('cpRN').value=rgb.r; document.getElementById('cpGN').value=rgb.g; document.getElementById('cpBN').value=rgb.b;
  rS.style.background=`linear-gradient(to right,rgb(0,${rgb.g},${rgb.b}),rgb(255,${rgb.g},${rgb.b}))`;
  gS.style.background=`linear-gradient(to right,rgb(${rgb.r},0,${rgb.b}),rgb(${rgb.r},255,${rgb.b}))`;
  bS.style.background=`linear-gradient(to right,rgb(${rgb.r},${rgb.g},0),rgb(${rgb.r},${rgb.g},255))`;

  // HSB sliders
  document.getElementById('cpHsbH').value=Math.round(cpH); document.getElementById('cpHsbHN').value=Math.round(cpH);
  document.getElementById('cpHsbS').value=Math.round(cpS*100); document.getElementById('cpHsbSN').value=Math.round(cpS*100);
  document.getElementById('cpHsbB').value=Math.round(cpV*100); document.getElementById('cpHsbBN').value=Math.round(cpV*100);
  const sStart=hsvToRgb(cpH,0,cpV), sEnd=hsvToRgb(cpH,1,cpV);
  document.getElementById('cpHsbS').style.background=`linear-gradient(to right,rgb(${sStart.r},${sStart.g},${sStart.b}),rgb(${sEnd.r},${sEnd.g},${sEnd.b}))`;
  const bEnd=hsvToRgb(cpH,cpS,1);
  document.getElementById('cpHsbB').style.background=`linear-gradient(to right,#000,rgb(${bEnd.r},${bEnd.g},${bEnd.b}))`;

  // HSL sliders
  document.getElementById('cpHslH').value=Math.round(cpH); document.getElementById('cpHslHN').value=Math.round(cpH);
  document.getElementById('cpHslS').value=Math.round(hsl.s*100); document.getElementById('cpHslSN').value=Math.round(hsl.s*100);
  document.getElementById('cpHslL').value=Math.round(hsl.l*100); document.getElementById('cpHslLN').value=Math.round(hsl.l*100);
  document.getElementById('cpHslS').style.background=`linear-gradient(to right,gray,rgb(${pureRgb.r},${pureRgb.g},${pureRgb.b}))`;
  document.getElementById('cpHslL').style.background=`linear-gradient(to right,#000,rgb(${pureRgb.r},${pureRgb.g},${pureRgb.b}),#fff)`;
}

// --- Spectrum SV Field Interaction ---
let cpDraggingSV = false;
const cpSvField = document.getElementById('cpSvField');
function cpUpdateSV(e) {
  const r = cpSvField.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  cpS = Math.max(0, Math.min(1, (cx-r.left)/r.width));
  cpV = 1 - Math.max(0, Math.min(1, (cy-r.top)/r.height));
  setFgFromHSV(); cpRenderFromState();
}
cpSvField.addEventListener('mousedown', (e) => { cpDraggingSV=true; cpUpdateSV(e); });
document.addEventListener('mousemove', (e) => { if(cpDraggingSV) cpUpdateSV(e); });
document.addEventListener('mouseup', () => { cpDraggingSV=false; });

// --- Wheel Interaction ---
let cpDraggingWheel = false;
const cpWheel = document.getElementById('cpWheel');
function cpUpdateWheel(e) {
  const r = cpWheel.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  const dx = cx-(r.left+r.width/2), dy = cy-(r.top+r.height/2);
  let a = Math.atan2(dy,dx)*180/Math.PI; if(a<0) a+=360;
  cpH = a; cpS = Math.min(1, Math.sqrt(dx*dx+dy*dy)/(r.width/2));
  setFgFromHSV(); cpRenderFromState();
}
cpWheel.addEventListener('mousedown', (e) => { cpDraggingWheel=true; cpUpdateWheel(e); });
document.addEventListener('mousemove', (e) => { if(cpDraggingWheel) cpUpdateWheel(e); });
document.addEventListener('mouseup', () => { cpDraggingWheel=false; });

// Hue slider
document.getElementById('cpHueSlider').addEventListener('input', (e) => { cpH=parseFloat(e.target.value); setFgFromHSV(); cpRenderFromState(); });
// Brightness slider (wheel)
document.getElementById('cpBriSlider').addEventListener('input', (e) => { cpV=parseFloat(e.target.value)/100; setFgFromHSV(); cpRenderFromState(); });

// --- Slider bindings ---
function cpBindSlider(sliderId, numId, syncFn) {
  const s=document.getElementById(sliderId), n=document.getElementById(numId);
  s.addEventListener('input', () => { n.value=s.value; syncFn(); });
  n.addEventListener('input', () => { s.value=n.value; syncFn(); });
  n.addEventListener('change', () => { s.value=n.value; syncFn(); });
}

function cpSyncRGB() {
  const r=parseInt(document.getElementById('cpRN').value)||0;
  const g=parseInt(document.getElementById('cpGN').value)||0;
  const b=parseInt(document.getElementById('cpBN').value)||0;
  const hsv=rgbToHsv(r,g,b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
  setFgFromHSV(); cpRenderFromState();
}
function cpSyncHSB() {
  cpH=parseInt(document.getElementById('cpHsbHN').value)||0;
  cpS=(parseInt(document.getElementById('cpHsbSN').value)||0)/100;
  cpV=(parseInt(document.getElementById('cpHsbBN').value)||0)/100;
  setFgFromHSV(); cpRenderFromState();
}
function cpSyncHSL() {
  const h=parseInt(document.getElementById('cpHslHN').value)||0;
  const s=(parseInt(document.getElementById('cpHslSN').value)||0)/100;
  const l=(parseInt(document.getElementById('cpHslLN').value)||0)/100;
  const hsv=hslToHsv(h,s,l); cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
  setFgFromHSV(); cpRenderFromState();
}

cpBindSlider('cpR','cpRN',cpSyncRGB); cpBindSlider('cpG','cpGN',cpSyncRGB); cpBindSlider('cpB','cpBN',cpSyncRGB);
cpBindSlider('cpHsbH','cpHsbHN',cpSyncHSB); cpBindSlider('cpHsbS','cpHsbSN',cpSyncHSB); cpBindSlider('cpHsbB','cpHsbBN',cpSyncHSB);
cpBindSlider('cpHslH','cpHslHN',cpSyncHSL); cpBindSlider('cpHslS','cpHslSN',cpSyncHSL); cpBindSlider('cpHslL','cpHslLN',cpSyncHSL);

// Hex input in picker
document.getElementById('cpHexInput').addEventListener('change', function() {
  let v = this.value.replace('#','').trim();
  if (v.length===3) v = v.split('').map(c=>c+c).join('');
  const rgb = hexToRgb(v);
  if (rgb) {
    const hsv=rgbToHsv(rgb.r,rgb.g,rgb.b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
    setFgFromHSV(); cpRenderFromState();
  }
});
document.getElementById('cpHexInput').addEventListener('keyup', (e) => {
  if (e.key==='Enter') { document.getElementById('cpHexInput').blur(); document.getElementById('cpHexInput').dispatchEvent(new Event('change')); }
});

// --- Eyedropper from picker ---
let cpEyedropperActive = false;
function cpStartEyedropper() {
  cpEyedropperActive = true;
  workspace.style.cursor = 'crosshair';
  document.getElementById('cpEyedropperBtn').style.background = 'var(--accent-dim)';
  document.getElementById('cpEyedropperBtn').style.color = 'var(--accent)';
}

// Intercept workspace click for eyedropper
workspace.addEventListener('click', (e) => {
  if (!cpEyedropperActive) return;
  cpEyedropperActive = false;
  document.getElementById('cpEyedropperBtn').style.background = '';
  document.getElementById('cpEyedropperBtn').style.color = '';
  const pos = screenToCanvas(e.clientX, e.clientY);
  pickColor(pos.x, pos.y);
  cpRenderFromState();
  e.stopPropagation();
}, true);

/* ═══════════════════════════════════════════════════════
   FILTERS
   ═══════════════════════════════════════════════════════ */

function openFilter(type) {
  closeAllMenus();
  currentFilterType = type;
  const layer = getActiveLayer();
  if (!layer) return;

  const titleEl = document.getElementById('filterTitle');
  const controlsEl = document.getElementById('filterControls');
  const previewCanvas = document.getElementById('filterPreviewCanvas');

  filterOriginalData = layer.ctx.getImageData(0, 0, canvasW, canvasH);

  // Setup preview
  const pw = 360, ph = Math.round(360 * canvasH / canvasW);
  previewCanvas.width = pw;
  previewCanvas.height = ph;
  const pctx = previewCanvas.getContext('2d');
  pctx.drawImage(layer.canvas, 0, 0, pw, ph);

  controlsEl.innerHTML = '';

  if (type === 'brightness') {
    titleEl.textContent = 'Brightness / Contrast';
    controlsEl.innerHTML = sliderRow('Brightness', 'filterBrightness', -100, 100, 0) + sliderRow('Contrast', 'filterContrast', -100, 100, 0);
  } else if (type === 'hsl') {
    titleEl.textContent = 'Hue / Saturation';
    controlsEl.innerHTML = sliderRow('Hue', 'filterHue', -180, 180, 0) + sliderRow('Saturation', 'filterSaturation', -100, 100, 0) + sliderRow('Lightness', 'filterLightness', -100, 100, 0);
  } else if (type === 'blur') {
    titleEl.textContent = 'Gaussian Blur';
    controlsEl.innerHTML = sliderRow('Radius', 'filterBlurRadius', 0, 20, 3);
  } else if (type === 'sharpen') {
    titleEl.textContent = 'Sharpen';
    controlsEl.innerHTML = sliderRow('Amount', 'filterSharpenAmt', 0, 100, 50);
  } else if (type === 'invert') {
    titleEl.textContent = 'Invert Colors';
    // No controls, apply immediately on preview
  } else if (type === 'grayscale') {
    titleEl.textContent = 'Grayscale';
  } else if (type === 'sepia') {
    titleEl.textContent = 'Sepia';
  }

  // Bind slider events
  controlsEl.querySelectorAll('.filter-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const valEl = slider.parentElement.querySelector('.filter-slider-value');
      if (valEl) valEl.textContent = slider.value;
      updateFilterPreview();
    });
  });

  document.getElementById('filterModal').classList.add('show');
  updateFilterPreview();
}

function sliderRow(label, id, min, max, val) {
  return `<div class="filter-slider-row">
    <span class="filter-slider-label">${label}</span>
    <input type="range" class="filter-slider" id="${id}" min="${min}" max="${max}" value="${val}">
    <span class="filter-slider-value">${val}</span>
  </div>`;
}

function updateFilterPreview() {
  const previewCanvas = document.getElementById('filterPreviewCanvas');
  const pctx = previewCanvas.getContext('2d');
  const pw = previewCanvas.width, ph = previewCanvas.height;
  const layer = getActiveLayer();
  pctx.drawImage(layer.canvas, 0, 0, pw, ph);

  const cssFilter = buildCSSFilter();
  if (cssFilter) {
    pctx.filter = cssFilter;
    pctx.drawImage(previewCanvas, 0, 0);
    pctx.filter = 'none';
  }
}

function buildCSSFilter() {
  if (currentFilterType === 'brightness') {
    const b = 100 + parseInt(document.getElementById('filterBrightness')?.value || 0);
    const c = 100 + parseInt(document.getElementById('filterContrast')?.value || 0);
    return `brightness(${b}%) contrast(${c}%)`;
  } else if (currentFilterType === 'hsl') {
    const h = parseInt(document.getElementById('filterHue')?.value || 0);
    const s = 100 + parseInt(document.getElementById('filterSaturation')?.value || 0);
    const l = 100 + parseInt(document.getElementById('filterLightness')?.value || 0);
    return `hue-rotate(${h}deg) saturate(${s}%) brightness(${l}%)`;
  } else if (currentFilterType === 'blur') {
    const r = parseInt(document.getElementById('filterBlurRadius')?.value || 3);
    return `blur(${r}px)`;
  } else if (currentFilterType === 'sharpen') {
    // CSS doesn't have native sharpen, we use contrast+saturate trick
    const a = 100 + parseInt(document.getElementById('filterSharpenAmt')?.value || 50) / 2;
    return `contrast(${a}%)`;
  } else if (currentFilterType === 'invert') {
    return 'invert(1)';
  } else if (currentFilterType === 'grayscale') {
    return 'grayscale(1)';
  } else if (currentFilterType === 'sepia') {
    return 'sepia(1)';
  }
  return null;
}

function applyFilter() {
  const layer = getActiveLayer();
  if (!layer) return;
  pushUndo('Filter');

  const cssFilter = buildCSSFilter();
  if (cssFilter) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasW;
    tempCanvas.height = canvasH;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.filter = cssFilter;

    if (selectionPath) {
      // Apply only within selection
      tempCtx.drawImage(layer.canvas, 0, 0);
      layer.ctx.save();
      layer.ctx.clip(selectionPath);
      layer.ctx.clearRect(0, 0, canvasW, canvasH);
      layer.ctx.drawImage(tempCanvas, 0, 0);
      layer.ctx.restore();
    } else {
      tempCtx.drawImage(layer.canvas, 0, 0);
      layer.ctx.clearRect(0, 0, canvasW, canvasH);
      layer.ctx.drawImage(tempCanvas, 0, 0);
    }
  }

  compositeAll();
  closeModal('filterModal');
}

/* ═══════════════════════════════════════════════════════
   FILE I/O
   ═══════════════════════════════════════════════════════ */

function newImage() {
  closeAllMenus();
  document.getElementById('newImageModal').classList.add('show');
}

function createNewImage() {
  const w = parseInt(document.getElementById('newWidth').value) || 1920;
  const h = parseInt(document.getElementById('newHeight').value) || 1080;
  const bg = document.getElementById('newBg').value;
  initCanvas(w, h, bg);
  closeModal('newImageModal');
}

function openImage() {
  closeAllMenus();
  document.getElementById('fileInput').click();
}

document.getElementById('fileInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const img = new Image();
    img.onload = function() {
      initCanvas(img.width, img.height, 'transparent');
      layers[0].ctx.drawImage(img, 0, 0);
      layers[0].name = file.name.replace(/\.[^.]+$/, '');
      compositeAll();
      updateLayerPanel();
      pushUndo('Open Image');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  this.value = '';
});

function saveImage(format) {
  closeAllMenus();
  // Create export canvas without checkerboard
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvasW;
  exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');

  if (format === 'jpg') {
    ectx.fillStyle = '#ffffff';
    ectx.fillRect(0, 0, canvasW, canvasH);
  }

  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    ectx.globalAlpha = l.opacity;
    ectx.drawImage(l.canvas, 0, 0);
  }
  ectx.globalAlpha = 1;

  const mimeType = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const ext = format === 'jpg' ? '.jpg' : format === 'webp' ? '.webp' : '.png';

  exportCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'image' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, mimeType, 0.92);
}

/* ═══════════════════════════════════════════════════════
   MENUS
   ═══════════════════════════════════════════════════════ */

let openMenuId = null;

document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', function(e) {
    e.stopPropagation();
    const menuId = 'menu-' + this.dataset.menu;
    if (openMenuId === menuId) {
      closeAllMenus();
      return;
    }
    closeAllMenus();
    document.getElementById(menuId).classList.add('show');
    this.classList.add('open');
    openMenuId = menuId;
  });

  item.addEventListener('mouseenter', function() {
    if (openMenuId) {
      closeAllMenus();
      const menuId = 'menu-' + this.dataset.menu;
      document.getElementById(menuId).classList.add('show');
      this.classList.add('open');
      openMenuId = menuId;
    }
  });
});

document.querySelectorAll('.menu-action').forEach(btn => {
  btn.addEventListener('click', () => closeAllMenus());
});

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.remove('show'));
  document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open'));
  openMenuId = null;
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (openMenuId && !e.target.closest('.menu-item')) closeAllMenus();
});

document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('show');
  });
});

/* ═══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════ */

document.addEventListener('keydown', (e) => {
  // Ignore when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && k === 'z') { e.preventDefault(); doUndo(); }
  else if (ctrl && k === 'y') { e.preventDefault(); doRedo(); }
  else if (ctrl && k === 'c') { e.preventDefault(); doCopy(); }
  else if (ctrl && k === 'v') { e.preventDefault(); doPaste(); }
  else if (ctrl && k === 'n') { e.preventDefault(); newImage(); }
  else if (ctrl && k === 'o') { e.preventDefault(); openImage(); }
  else if (ctrl && k === 's') { e.preventDefault(); saveImage(e.shiftKey ? 'jpg' : 'png'); }
  else if (ctrl && k === 'a') { e.preventDefault(); selectAll(); }
  else if (ctrl && k === 'd') { e.preventDefault(); clearSelection(); }
  else if (ctrl && k === '=') { e.preventDefault(); zoomIn(); }
  else if (ctrl && k === '-') { e.preventDefault(); zoomOut(); }
  else if (ctrl && k === '0') { e.preventDefault(); zoomFit(); }
  else if (ctrl && k === '1') { e.preventDefault(); zoom100(); }
  else if (k === 'delete' || k === 'backspace') { if (selection) { e.preventDefault(); deleteSelection(); } }
  else if (k === 'x') { swapColors(); }
  else if (k === '[') { // Decrease brush size
    e.preventDefault();
    const s = Math.max(1, getBrushSize() - (getBrushSize() > 20 ? 5 : getBrushSize() > 5 ? 2 : 1));
    document.getElementById('brushSize').value = s;
    document.getElementById('brushSizeNum').value = s;
  }
  else if (k === ']') { // Increase brush size
    e.preventDefault();
    const s = Math.min(500, getBrushSize() + (getBrushSize() > 20 ? 5 : getBrushSize() > 5 ? 2 : 1));
    document.getElementById('brushSize').value = s;
    document.getElementById('brushSizeNum').value = s;
  }
  else if (k === ' ') { e.preventDefault(); /* space for pan handled in mousedown */ }
  else if (toolKeys[k]) { selectTool(toolKeys[k]); }
});

/* ═══════════════════════════════════════════════════════
   STATUS BAR
   ═══════════════════════════════════════════════════════ */

function updateStatus(e) {
  document.getElementById('statusSize').textContent = `${canvasW} × ${canvasH}`;
  document.getElementById('statusZoom').textContent = Math.round(zoom * 100) + '%';
}

/* ═══════════════════════════════════════════════════════
   SPACE BAR PAN
   ═══════════════════════════════════════════════════════ */

let spaceDown = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !spaceDown && !e.target.matches('input,select,textarea')) {
    spaceDown = true;
    workspace.style.cursor = 'grab';
    e.preventDefault();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    workspace.style.cursor = currentTool === 'pan' ? 'grab' : (currentTool === 'move' ? 'default' : 'crosshair');
  }
});

/* ═══════════════════════════════════════════════════════
   BRUSH CURSOR PREVIEW
   ═══════════════════════════════════════════════════════ */

const brushCursorEl = document.getElementById('brushCursor');

function updateBrushCursor(e) {
  if (!['brush','pencil','eraser'].includes(currentTool)) {
    brushCursorEl.style.display = 'none';
    return;
  }
  const size = currentTool === 'pencil' ? 1 : getBrushSize();
  const screenSize = size * zoom;
  if (screenSize < 3) {
    brushCursorEl.style.display = 'none';
    return;
  }
  brushCursorEl.style.display = 'block';
  brushCursorEl.style.width = screenSize + 'px';
  brushCursorEl.style.height = screenSize + 'px';
  brushCursorEl.style.transform = `translate(${e.clientX - screenSize/2}px, ${e.clientY - screenSize/2}px)`;
}

workspace.addEventListener('mousemove', updateBrushCursor);
workspace.addEventListener('mouseleave', () => { brushCursorEl.style.display = 'none'; });

// Update cursor when brush size changes
document.getElementById('brushSize').addEventListener('input', () => {
  if (brushCursorEl.style.display === 'block') {
    const size = getBrushSize() * zoom;
    brushCursorEl.style.width = size + 'px';
    brushCursorEl.style.height = size + 'px';
  }
});

/* ═══════════════════════════════════════════════════════
   COPY / PASTE
   ═══════════════════════════════════════════════════════ */

function doCopy() {
  closeAllMenus();
  const layer = getActiveLayer();
  if (!layer) return;
  clipboardCanvas = document.createElement('canvas');
  if (selectionPath && selection) {
    const b = getSelectionBounds();
    if (!b || b.w < 1) return;
    clipboardCanvas.width = Math.round(b.w);
    clipboardCanvas.height = Math.round(b.h);
    const ctx = clipboardCanvas.getContext('2d');
    ctx.save();
    // Translate so selection area maps to 0,0
    ctx.translate(-Math.round(b.x), -Math.round(b.y));
    ctx.clip(selectionPath);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  } else {
    clipboardCanvas.width = canvasW;
    clipboardCanvas.height = canvasH;
    clipboardCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);
  }
}

function doPaste() {
  closeAllMenus();
  if (!clipboardCanvas) return;
  pushUndo('Paste');
  addLayer('Pasted');
  const layer = getActiveLayer();
  // Center the pasted content
  const dx = Math.round((canvasW - clipboardCanvas.width) / 2);
  const dy = Math.round((canvasH - clipboardCanvas.height) / 2);
  layer.ctx.drawImage(clipboardCanvas, dx, dy);
  compositeAll();
  updateLayerPanel();
}

// External clipboard paste (images from system clipboard)
document.addEventListener('paste', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      const img = new Image();
      img.onload = () => {
        pushUndo('Paste Image');
        addLayer('Pasted Image');
        const layer = getActiveLayer();
        const dx = Math.round((canvasW - img.width) / 2);
        const dy = Math.round((canvasH - img.height) / 2);
        layer.ctx.drawImage(img, dx, dy);
        compositeAll();
        updateLayerPanel();
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(blob);
      break;
    }
  }
});

/* ═══════════════════════════════════════════════════════
   IMAGE RESIZE
   ═══════════════════════════════════════════════════════ */

let resizeAspect = 1;

function openResizeDialog() {
  closeAllMenus();
  document.getElementById('resizeW').value = canvasW;
  document.getElementById('resizeH').value = canvasH;
  resizeAspect = canvasW / canvasH;
  document.getElementById('resizeImageModal').classList.add('show');
}

document.getElementById('resizeW').addEventListener('input', function() {
  if (document.getElementById('resizeConstrain').checked) {
    document.getElementById('resizeH').value = Math.round(this.value / resizeAspect);
  }
});
document.getElementById('resizeH').addEventListener('input', function() {
  if (document.getElementById('resizeConstrain').checked) {
    document.getElementById('resizeW').value = Math.round(this.value * resizeAspect);
  }
});

function applyResizeImage() {
  const newW = parseInt(document.getElementById('resizeW').value) || canvasW;
  const newH = parseInt(document.getElementById('resizeH').value) || canvasH;
  if (newW === canvasW && newH === canvasH) { closeModal('resizeImageModal'); return; }
  pushUndo('Resize');

  layers.forEach(l => {
    const temp = document.createElement('canvas');
    temp.width = newW; temp.height = newH;
    const tctx = temp.getContext('2d');
    tctx.drawImage(l.canvas, 0, 0, canvasW, canvasH, 0, 0, newW, newH);
    l.canvas.width = newW; l.canvas.height = newH;
    l.ctx = l.canvas.getContext('2d');
    l.ctx.drawImage(temp, 0, 0);
  });

  canvasW = newW; canvasH = newH;
  compositeCanvas.width = newW; compositeCanvas.height = newH;
  overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px';
  checkerPattern = null;
  clearSelection();
  zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
  closeModal('resizeImageModal');
}

/* ═══════════════════════════════════════════════════════
   CANVAS SIZE
   ═══════════════════════════════════════════════════════ */

let canvasAnchor = 'mc';

function openCanvasSizeDialog() {
  closeAllMenus();
  document.getElementById('canvasSizeW').value = canvasW;
  document.getElementById('canvasSizeH').value = canvasH;
  canvasAnchor = 'mc';
  document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === 'mc'));
  document.getElementById('canvasSizeModal').classList.add('show');
}

document.querySelectorAll('.anchor-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    canvasAnchor = btn.dataset.anchor;
    document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === canvasAnchor));
  });
});

function applyCanvasSize() {
  const newW = parseInt(document.getElementById('canvasSizeW').value) || canvasW;
  const newH = parseInt(document.getElementById('canvasSizeH').value) || canvasH;
  if (newW === canvasW && newH === canvasH) { closeModal('canvasSizeModal'); return; }
  pushUndo('Canvas Size');

  // Calculate offset based on anchor
  let ox = 0, oy = 0;
  if (canvasAnchor.includes('c')) ox = Math.round((newW - canvasW) / 2);
  if (canvasAnchor.includes('r')) ox = newW - canvasW;
  if (canvasAnchor.includes('m') && !canvasAnchor.includes('l') && !canvasAnchor.includes('r')) ox = Math.round((newW - canvasW) / 2);
  if (canvasAnchor[0] === 'm') oy = Math.round((newH - canvasH) / 2);
  if (canvasAnchor[0] === 'b') oy = newH - canvasH;
  // tl: ox=0, oy=0 (default)

  layers.forEach(l => {
    const temp = document.createElement('canvas');
    temp.width = newW; temp.height = newH;
    const tctx = temp.getContext('2d');
    tctx.drawImage(l.canvas, ox, oy);
    l.canvas.width = newW; l.canvas.height = newH;
    l.ctx = l.canvas.getContext('2d');
    l.ctx.drawImage(temp, 0, 0);
  });

  canvasW = newW; canvasH = newH;
  compositeCanvas.width = newW; compositeCanvas.height = newH;
  overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px';
  checkerPattern = null;
  clearSelection();
  zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
  closeModal('canvasSizeModal');
}

/* ═══════════════════════════════════════════════════════
   FLIP & ROTATE
   ═══════════════════════════════════════════════════════ */

function flipHorizontal() {
  closeAllMenus(); pushUndo('Flip H');
  layers.forEach(l => {
    const temp = document.createElement('canvas'); temp.width = canvasW; temp.height = canvasH;
    const tctx = temp.getContext('2d');
    tctx.translate(canvasW, 0); tctx.scale(-1, 1);
    tctx.drawImage(l.canvas, 0, 0);
    l.ctx.clearRect(0, 0, canvasW, canvasH);
    l.ctx.drawImage(temp, 0, 0);
  });
  compositeAll(); updateLayerPanel();
}

function flipVertical() {
  closeAllMenus(); pushUndo('Flip V');
  layers.forEach(l => {
    const temp = document.createElement('canvas'); temp.width = canvasW; temp.height = canvasH;
    const tctx = temp.getContext('2d');
    tctx.translate(0, canvasH); tctx.scale(1, -1);
    tctx.drawImage(l.canvas, 0, 0);
    l.ctx.clearRect(0, 0, canvasW, canvasH);
    l.ctx.drawImage(temp, 0, 0);
  });
  compositeAll(); updateLayerPanel();
}

function rotateImage(angle) {
  closeAllMenus(); pushUndo('Rotate');
  const isSwap = (angle === 90 || angle === 270 || angle === -90);
  const newW = isSwap ? canvasH : canvasW;
  const newH = isSwap ? canvasW : canvasH;

  layers.forEach(l => {
    const temp = document.createElement('canvas'); temp.width = newW; temp.height = newH;
    const tctx = temp.getContext('2d');
    tctx.translate(newW/2, newH/2);
    tctx.rotate(angle * Math.PI / 180);
    tctx.drawImage(l.canvas, -canvasW/2, -canvasH/2);
    l.canvas.width = newW; l.canvas.height = newH;
    l.ctx = l.canvas.getContext('2d');
    l.ctx.drawImage(temp, 0, 0);
  });

  canvasW = newW; canvasH = newH;
  compositeCanvas.width = newW; compositeCanvas.height = newH;
  overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px';
  checkerPattern = null;
  clearSelection();
  zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
}

function rotateCW() { rotateImage(90); }
function rotateCCW() { rotateImage(-90); }
function rotate180() { rotateImage(180); }

/* ═══════════════════════════════════════════════════════
   INIT ON LOAD
   ═══════════════════════════════════════════════════════ */

window.addEventListener('load', init);
window.addEventListener('resize', () => { /* zoom stays the same, just re-center if needed */ });

