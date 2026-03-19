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

// Selection
let selection = null; // { type:'rect'|'ellipse'|'lasso', x,y,w,h | points }
let selectionPath = null; // Path2D

// Drawing state
let isDrawing = false;
let drawStart = {x:0,y:0};
let lastDraw = {x:0,y:0};

// Gradient state
let gradientStart = null, gradientEnd = null;

// Lasso
let lassoPoints = [];

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
  }
  compositeCtx.globalAlpha = 1;
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
  const optSize = document.getElementById('opt-size');
  const optOpacity = document.getElementById('opt-opacity');
  const optHardness = document.getElementById('opt-hardness');
  const optFillMode = document.getElementById('opt-fill-mode');
  const optStrokeWidth = document.getElementById('opt-stroke-width');
  const optFont = document.getElementById('opt-font');
  const optGradType = document.getElementById('opt-gradient-type');
  const optTolerance = document.getElementById('opt-tolerance');
  const optSelectType = document.getElementById('opt-select-type');

  [optSize, optOpacity, optHardness, optFillMode, optStrokeWidth, optFont, optGradType, optTolerance, optSelectType].forEach(el => el.classList.add('hidden'));

  if (['brush','pencil','eraser'].includes(name)) {
    optSize.classList.remove('hidden');
    optOpacity.classList.remove('hidden');
    if (name === 'brush') optHardness.classList.remove('hidden');
  } else if (['rect','ellipse','line'].includes(name)) {
    optFillMode.classList.remove('hidden');
    optStrokeWidth.classList.remove('hidden');
    optOpacity.classList.remove('hidden');
  } else if (name === 'text') {
    optFont.classList.remove('hidden');
    optOpacity.classList.remove('hidden');
  } else if (name === 'gradient') {
    optGradType.classList.remove('hidden');
    optOpacity.classList.remove('hidden');
  } else if (name === 'fill') {
    optTolerance.classList.remove('hidden');
    optOpacity.classList.remove('hidden');
  } else if (name === 'select') {
    optSelectType.classList.remove('hidden');
  }

  // Cursor
  workspace.style.cursor = name === 'move' ? 'grab' :
    name === 'zoom' ? 'zoom-in' :
    name === 'eyedropper' ? 'crosshair' :
    name === 'text' ? 'text' : 'crosshair';

  // Status
  const toolNames = {move:'Move',select:'Select',lasso:'Lasso',brush:'Brush',pencil:'Pencil',eraser:'Eraser',fill:'Fill',gradient:'Gradient',eyedropper:'Eyedropper',text:'Text',rect:'Rectangle',ellipse:'Ellipse',line:'Line',zoom:'Zoom'};
  document.getElementById('statusTool').textContent = toolNames[name] || name;
}

// Tool buttons
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});

// Keyboard shortcuts
const toolKeys = {v:'move',m:'select',l:'lasso',b:'brush',p:'pencil',e:'eraser',g:'fill',d:'gradient',i:'eyedropper',t:'text',u:'rect',o:'ellipse',n:'line',z:'zoom'};

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
   SELECTION SYSTEM
   ═══════════════════════════════════════════════════════ */

function selectAll() {
  selection = { type: 'rect', x: 0, y: 0, w: canvasW, h: canvasH };
  buildSelectionPath();
  drawOverlay();
}

function clearSelection() {
  selection = null;
  selectionPath = null;
  lassoPoints = [];
  drawOverlay();
}

function buildSelectionPath() {
  if (!selection) { selectionPath = null; return; }
  selectionPath = new Path2D();
  if (selection.type === 'rect') {
    selectionPath.rect(selection.x, selection.y, selection.w, selection.h);
  } else if (selection.type === 'ellipse') {
    selectionPath.ellipse(selection.x + selection.w/2, selection.y + selection.h/2, Math.abs(selection.w)/2, Math.abs(selection.h)/2, 0, 0, Math.PI*2);
  } else if (selection.type === 'lasso' && selection.points && selection.points.length > 2) {
    selectionPath.moveTo(selection.points[0].x, selection.points[0].y);
    for (let i = 1; i < selection.points.length; i++) {
      selectionPath.lineTo(selection.points[i].x, selection.points[i].y);
    }
    selectionPath.closePath();
  }
}

function deleteSelection() {
  if (!selection || !selectionPath) return;
  pushUndo('Delete');
  const layer = getActiveLayer();
  layer.ctx.save();
  layer.ctx.clip(selectionPath);
  layer.ctx.clearRect(0, 0, canvasW, canvasH);
  layer.ctx.restore();
  compositeAll();
}

function cropToSelection() {
  if (!selection || selection.type !== 'rect') return;
  pushUndo('Crop');
  const {x, y, w, h} = selection;
  const nx = Math.max(0, Math.round(x));
  const ny = Math.max(0, Math.round(y));
  const nw = Math.min(canvasW - nx, Math.round(w));
  const nh = Math.min(canvasH - ny, Math.round(h));

  const newLayers = layers.map(l => {
    const data = l.ctx.getImageData(nx, ny, nw, nh);
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const ctx = c.getContext('2d');
    ctx.putImageData(data, 0, 0);
    return {...l, canvas: c, ctx};
  });

  canvasW = nw; canvasH = nh;
  compositeCanvas.width = nw; compositeCanvas.height = nh;
  overlayCanvas.width = nw; overlayCanvas.height = nh;
  canvasWrapper.style.width = nw + 'px';
  canvasWrapper.style.height = nh + 'px';

  layers = newLayers;
  selection = null;
  selectionPath = null;
  zoomFit();
  compositeAll();
  updateLayerPanel();
  updateStatus();
}

// Marching ants
let marchingAntsOffset = 0;
function drawOverlay() {
  overlayCtx.clearRect(0, 0, canvasW, canvasH);
  if (!selection) return;
  buildSelectionPath();
  if (!selectionPath) return;

  overlayCtx.save();
  overlayCtx.lineWidth = 1 / zoom;
  overlayCtx.setLineDash([6/zoom, 6/zoom]);
  overlayCtx.lineDashOffset = -marchingAntsOffset;
  overlayCtx.strokeStyle = '#000';
  overlayCtx.stroke(selectionPath);
  overlayCtx.lineDashOffset = -marchingAntsOffset + 6/zoom;
  overlayCtx.strokeStyle = '#fff';
  overlayCtx.stroke(selectionPath);
  overlayCtx.restore();
}

setInterval(() => {
  if (selection) {
    marchingAntsOffset += 1;
    drawOverlay();
  }
}, 80);

/* ═══════════════════════════════════════════════════════
   MOUSE EVENT HANDLING
   ═══════════════════════════════════════════════════════ */

workspace.addEventListener('mousedown', onMouseDown);
workspace.addEventListener('mousemove', onMouseMove);
workspace.addEventListener('mouseup', onMouseUp);
workspace.addEventListener('mouseleave', onMouseUp);

function onMouseDown(e) {
  const pos = screenToCanvas(e.clientX, e.clientY);
  const px = pos.x, py = pos.y;
  isDrawing = true;
  drawStart = {x: px, y: py};
  lastDraw = {x: px, y: py};

  // Pan with middle mouse, move tool, alt+click, or space+click
  if (e.button === 1 || (e.button === 0 && currentTool === 'move') || (e.button === 0 && e.altKey) || (e.button === 0 && spaceDown)) {
    isPanning = true;
    isDrawing = false;
    panStart = {x: e.clientX - panX, y: e.clientY - panY};
    workspace.style.cursor = 'grabbing';
    return;
  }

  if (e.button === 0 && currentTool === 'zoom') {
    const wsRect = workspace.getBoundingClientRect();
    const cx = e.clientX - wsRect.left;
    const cy = e.clientY - wsRect.top;
    if (e.shiftKey) zoomTo(zoom / 1.4, cx, cy);
    else zoomTo(zoom * 1.4, cx, cy);
    return;
  }

  const layer = getActiveLayer();
  if (!layer || !layer.visible) return;

  if (['brush','pencil','eraser'].includes(currentTool)) {
    pushUndo(currentTool.charAt(0).toUpperCase() + currentTool.slice(1));
    const size = currentTool === 'pencil' ? 1 : getBrushSize();
    const color = currentTool === 'eraser' ? 'rgba(0,0,0,1)' : fgColor;
    const hardness = currentTool === 'pencil' ? 1 : getBrushHardness();
    const opacity = getToolOpacity();

    if (currentTool === 'eraser') {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'destination-out';
      drawBrushStroke(layer.ctx, px, py, size, color, hardness, opacity);
      layer.ctx.restore();
    } else {
      if (selectionPath) {
        layer.ctx.save();
        layer.ctx.clip(selectionPath);
        drawBrushStroke(layer.ctx, px, py, size, color, hardness, opacity);
        layer.ctx.restore();
      } else {
        drawBrushStroke(layer.ctx, px, py, size, color, hardness, opacity);
      }
    }
    compositeAll();
  } else if (currentTool === 'fill') {
    pushUndo('Fill');
    const tol = parseInt(document.getElementById('fillTolerance').value) || 32;
    if (selectionPath) {
      layer.ctx.save();
      layer.ctx.clip(selectionPath);
      floodFill(layer.ctx, px, py, fgColor, tol);
      layer.ctx.restore();
    } else {
      floodFill(layer.ctx, px, py, fgColor, tol);
    }
    compositeAll();
  } else if (currentTool === 'eyedropper') {
    pickColor(px, py);
  } else if (currentTool === 'text') {
    const text = prompt('Enter text:');
    if (text) {
      pushUndo('Text');
      const font = document.getElementById('textFont').value;
      const size = parseInt(document.getElementById('textSize').value) || 24;
      layer.ctx.save();
      layer.ctx.globalAlpha = getToolOpacity();
      layer.ctx.font = `${size}px "${font}"`;
      layer.ctx.fillStyle = fgColor;
      layer.ctx.textBaseline = 'top';
      if (selectionPath) layer.ctx.clip(selectionPath);
      layer.ctx.fillText(text, px, py);
      layer.ctx.restore();
      compositeAll();
    }
  } else if (currentTool === 'gradient') {
    gradientStart = {x: px, y: py};
    gradientEnd = {x: px, y: py};
  } else if (currentTool === 'lasso') {
    lassoPoints = [{x: px, y: py}];
  } else if (currentTool === 'select') {
    // Selection start is handled in drawStart
  }

  updateStatus(e);
}

function onMouseMove(e) {
  const pos = screenToCanvas(e.clientX, e.clientY);
  const px = pos.x, py = pos.y;

  // Update status
  document.getElementById('statusPos').textContent = `X: ${Math.round(px)}  Y: ${Math.round(py)}`;

  if (isPanning) {
    panX = e.clientX - panStart.x;
    panY = e.clientY - panStart.y;
    updateTransform();
    return;
  }

  if (!isDrawing) return;

  const layer = getActiveLayer();
  if (!layer || !layer.visible) return;

  if (['brush','pencil','eraser'].includes(currentTool)) {
    const size = currentTool === 'pencil' ? 1 : getBrushSize();
    const color = currentTool === 'eraser' ? 'rgba(0,0,0,1)' : fgColor;
    const hardness = currentTool === 'pencil' ? 1 : getBrushHardness();
    const opacity = getToolOpacity();

    if (currentTool === 'eraser') {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'destination-out';
      drawLineBetween(layer.ctx, lastDraw.x, lastDraw.y, px, py, size, color, hardness, opacity);
      layer.ctx.restore();
    } else {
      if (selectionPath) {
        layer.ctx.save();
        layer.ctx.clip(selectionPath);
        drawLineBetween(layer.ctx, lastDraw.x, lastDraw.y, px, py, size, color, hardness, opacity);
        layer.ctx.restore();
      } else {
        drawLineBetween(layer.ctx, lastDraw.x, lastDraw.y, px, py, size, color, hardness, opacity);
      }
    }
    compositeAll();
    lastDraw = {x: px, y: py};
  } else if (currentTool === 'gradient') {
    gradientEnd = {x: px, y: py};
    // Draw preview on overlay
    overlayCtx.clearRect(0, 0, canvasW, canvasH);
    overlayCtx.beginPath();
    overlayCtx.moveTo(gradientStart.x, gradientStart.y);
    overlayCtx.lineTo(gradientEnd.x, gradientEnd.y);
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 1/zoom;
    overlayCtx.setLineDash([4/zoom, 4/zoom]);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  } else if (currentTool === 'select') {
    const x = Math.min(drawStart.x, px);
    const y = Math.min(drawStart.y, py);
    const w = Math.abs(px - drawStart.x);
    const h = Math.abs(py - drawStart.y);
    const shape = document.getElementById('selectShape').value;
    selection = { type: shape, x, y, w, h };
    buildSelectionPath();
    drawOverlay();
  } else if (currentTool === 'lasso') {
    lassoPoints.push({x: px, y: py});
    overlayCtx.clearRect(0, 0, canvasW, canvasH);
    overlayCtx.beginPath();
    overlayCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      overlayCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 1/zoom;
    overlayCtx.setLineDash([4/zoom, 4/zoom]);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  } else if (['rect','ellipse','line'].includes(currentTool)) {
    // Preview shape on overlay
    overlayCtx.clearRect(0, 0, canvasW, canvasH);
    drawShapePreview(overlayCtx, drawStart.x, drawStart.y, px, py);
  }
}

function onMouseUp(e) {
  if (isPanning) {
    isPanning = false;
    workspace.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
    return;
  }

  if (!isDrawing) return;
  isDrawing = false;

  const pos = screenToCanvas(e.clientX || 0, e.clientY || 0);
  const px = pos.x, py = pos.y;
  const layer = getActiveLayer();

  if (currentTool === 'gradient' && gradientStart && gradientEnd) {
    pushUndo('Gradient');
    const type = document.getElementById('gradientType').value;
    layer.ctx.save();
    layer.ctx.globalAlpha = getToolOpacity();
    if (selectionPath) layer.ctx.clip(selectionPath);

    let grad;
    if (type === 'radial') {
      const r = Math.hypot(gradientEnd.x - gradientStart.x, gradientEnd.y - gradientStart.y);
      grad = layer.ctx.createRadialGradient(gradientStart.x, gradientStart.y, 0, gradientStart.x, gradientStart.y, r);
    } else {
      grad = layer.ctx.createLinearGradient(gradientStart.x, gradientStart.y, gradientEnd.x, gradientEnd.y);
    }
    grad.addColorStop(0, fgColor);
    grad.addColorStop(1, bgColor);
    layer.ctx.fillStyle = grad;
    layer.ctx.fillRect(0, 0, canvasW, canvasH);
    layer.ctx.restore();
    compositeAll();
    overlayCtx.clearRect(0, 0, canvasW, canvasH);
    gradientStart = null;
    gradientEnd = null;
  } else if (['rect','ellipse','line'].includes(currentTool) && layer) {
    pushUndo('Shape');
    drawShapeOnLayer(layer.ctx, drawStart.x, drawStart.y, px, py);
    compositeAll();
    overlayCtx.clearRect(0, 0, canvasW, canvasH);
  } else if (currentTool === 'lasso' && lassoPoints.length > 2) {
    selection = { type: 'lasso', points: [...lassoPoints] };
    buildSelectionPath();
    drawOverlay();
    lassoPoints = [];
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
   COLOR SYSTEM
   ═══════════════════════════════════════════════════════ */

function setFgColor(hex) {
  fgColor = hex;
  updateColorUI();
}

function setBgColor(hex) {
  bgColor = hex;
  updateColorUI();
}

function swapColors() {
  [fgColor, bgColor] = [bgColor, fgColor];
  updateColorUI();
}

function updateColorUI() {
  document.getElementById('fgWell').style.background = fgColor;
  document.getElementById('bgWell').style.background = bgColor;
  document.getElementById('colorSwatchPreview').style.background = fgColor;
  document.getElementById('mainColorPicker').value = fgColor;

  // Parse to RGB
  const temp = document.createElement('canvas');
  temp.width = 1; temp.height = 1;
  const tctx = temp.getContext('2d');
  tctx.fillStyle = fgColor;
  tctx.fillRect(0,0,1,1);
  const d = tctx.getImageData(0,0,1,1).data;

  document.getElementById('hexInput').value = fgColor.replace('#','').toUpperCase();
  document.getElementById('rInput').value = d[0];
  document.getElementById('gInput').value = d[1];
  document.getElementById('bInput').value = d[2];
}

document.getElementById('mainColorPicker').addEventListener('input', function() {
  setFgColor(this.value);
});

document.getElementById('hexInput').addEventListener('change', function() {
  let v = this.value.replace('#','');
  if (/^[0-9a-fA-F]{6}$/.test(v)) setFgColor('#' + v);
});

['rInput','gInput','bInput'].forEach(id => {
  document.getElementById(id).addEventListener('change', function() {
    const r = parseInt(document.getElementById('rInput').value) || 0;
    const g = parseInt(document.getElementById('gInput').value) || 0;
    const b = parseInt(document.getElementById('bInput').value) || 0;
    setFgColor('#' + [r,g,b].map(v => Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join(''));
  });
});

// Color wells
document.getElementById('fgWell').addEventListener('click', () => {
  document.getElementById('mainColorPicker').click();
});
document.getElementById('bgWell').addEventListener('dblclick', () => {
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = bgColor;
  picker.addEventListener('input', () => setBgColor(picker.value));
  picker.click();
});

function pickColor(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= canvasW || iy >= canvasH) return;
  const layer = getActiveLayer();
  const d = layer.ctx.getImageData(ix, iy, 1, 1).data;
  const hex = '#' + [d[0],d[1],d[2]].map(v => v.toString(16).padStart(2,'0')).join('');
  setFgColor(hex);
}

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
    workspace.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
  }
});

/* ═══════════════════════════════════════════════════════
   INIT ON LOAD
   ═══════════════════════════════════════════════════════ */

window.addEventListener('load', init);
window.addEventListener('resize', () => { /* zoom stays the same, just re-center if needed */ });

