// ==UserScript==
// @name         S1914 Map Drawing Overlay (Path IDs)
// @namespace    1914.cam-hud.drawing.path-ids
// @version      1.15.1
// @description  Map drawing overlay with unique IDs for each path for robust API syncing, per-player visibility controls, collapsible HUD, and deferred incremental batch logging.
// @match        https://www.supremacy1914.com/*
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    // tweakable knobs
    const CONFIG = {
        BATCH_WAIT_SECONDS: 5 // how long after you stop drawing before batching/logging that data
    };

    // UI root and header (collapsible HUD shell)
    const ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:flex-start;background:rgba(0,0,0,.6);color:#fff;padding:8px 10px;border-radius:8px;font:12px/1.2 system-ui,ui-sans-serif;backdrop-filter:blur(4px)';
    document.body.appendChild(ui);

    const uiHeader = document.createElement('div');
    uiHeader.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '⯆';
    collapseBtn.style.cssText = 'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);color:#fff;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:11px;line-height:1;';
    uiHeader.appendChild(collapseBtn);

    const headerLabel = document.createElement('span');
    headerLabel.textContent = 'Drawing Overlay';
    headerLabel.style.cssText = 'font-weight:600;color:#c5e1ff;font-size:11px;';
    uiHeader.appendChild(headerLabel);

    ui.appendChild(uiHeader);

    // HUD content (buttons, player filters, etc.)
    const uiContent = document.createElement('div');
    uiContent.style.cssText = 'display:flex;flex-wrap:wrap;row-gap:8px;column-gap:8px;align-items:center;';
    ui.appendChild(uiContent);

    // Buttons group (draw hints, grid toggle, clear, players dropdown)
    const controls = document.createElement('div');
    controls.style.cssText = 'display:contents; border-left: 1px solid rgba(255,255,255,.2); margin-left: 6px; padding-left: 8px;';

    const drawLabel = document.createElement('b');
    drawLabel.textContent = 'Draw:';
    drawLabel.style.cssText = 'font-weight:600;color:#c5e1ff';

    const drawHint = document.createElement('span');
    drawHint.textContent = '(Alt+Drag)';
    drawHint.style.color = '#aaa';

    const eraseLabel = document.createElement('b');
    eraseLabel.textContent = 'Erase:';
    eraseLabel.style.cssText = 'font-weight:600;color:#c5e1ff; margin-left: 8px;';

    const eraseHint = document.createElement('span');
    eraseHint.textContent = '(Alt+RClick)';
    eraseHint.style.color = '#aaa';

    const gridButton = document.createElement('button');
    gridButton.textContent = 'Grid: Off';
    gridButton.style.cssText = 'background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer; margin-left: 8px;';

    const clearButton = document.createElement('button');
    clearButton.textContent = 'Clear My Drawings';
    clearButton.style.cssText = 'background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;';

    const apiControls = document.createElement('div');
    apiControls.style.cssText = 'display:contents; border-left: 1px solid rgba(255,255,255,.2); margin-left: 6px; padding-left: 8px;';

    // Player visibility controls (dropdown with per-player toggles + hide all)
    const playersWrap = document.createElement('div');
    playersWrap.style.cssText = 'position:relative; display:inline-flex; align-items:center; gap:6px; margin-left:8px;';

    const playersBtn = document.createElement('button');
    playersBtn.textContent = 'Players ▾';
    playersBtn.style.cssText = 'background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;';

    const hideAllBtn = document.createElement('button');
    hideAllBtn.textContent = 'Hide All: Off';
    hideAllBtn.style.cssText = 'background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;';

    const playersPanel = document.createElement('div');
    playersPanel.style.cssText = 'position:absolute; top:36px; left:0; min-width:220px; max-height:260px; overflow:auto; background:rgba(0,0,0,.9); border:1px solid rgba(255,255,255,.2); border-radius:8px; padding:8px; display:none; box-shadow:0 6px 18px rgba(0,0,0,.4);';

    const playersList = document.createElement('div');
    playersList.style.cssText = 'display:flex; flex-direction:column; gap:6px;';

    playersPanel.appendChild(playersList);
    playersWrap.append(playersBtn, hideAllBtn, playersPanel);

    controls.append(
        drawLabel,
        drawHint,
        eraseLabel,
        eraseHint,
        gridButton,
        clearButton,
        apiControls,
        playersWrap
    );

    uiContent.appendChild(controls);

    // The drawing canvas overlay that sits over the game
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483646; pointer-events: none;';
    document.body.appendChild(canvas);

    // Keep canvas in sync with window size
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // Global runtime state (game info, drawings, filters, batching)
    const state = {
        attached: false,
        hupWin: null,
        hupPath: '',
        game: { playerID: null, gameID: null, playerColor: '#FF0000' },
        allDrawings: {},
        drawing: {
            isDrawing: false,
            isErasing: false,
            currentPath: null,
            viewport: null,
            showGrid: false
        },
        filters: { hideAll: false, hiddenPlayers: {} },
        _lastPlayerKeys: '',
        uiCollapsed: true,
        batch: {
            timerId: null
        }
    };

    // Safe nested object access
    function tryGet(obj, path) {
        try { return path.split('.').reduce((o, k) => o && o[k], obj) ?? null; } catch { return null; }
    }

    // Create a numeric-ish ID for each drawn path
    function generateUniqueId() {
        const timestamp = Date.now();
        const randomPart = Math.floor(Math.random() * 1_000);
        return timestamp * 1_000 + randomPart;
    }

    // Collect all same-origin frames (top window + iframes) so we can find the game viewport
    function framesSameOrigin() {
        const list = [];
        try { if (window && window.document) list.push({ win: window, tag: 'top' }); } catch { }
        try {
            for (let i = 0; i < window.frames.length; i++) {
                const w = window.frames[i];
                try { void w.document; list.push({ win: w, tag: 'frames[' + i + ']' }); } catch { }
            }
        } catch { }
        try {
            const ifr = document.getElementsByTagName('iframe');
            for (let i = 0; i < ifr.length; i++) {
                const el = ifr[i];
                try {
                    if (el.contentWindow && el.contentWindow.document) {
                        list.push({ win: el.contentWindow, tag: 'iframe[' + i + ']' });
                    }
                } catch { }
            }
        } catch { }
        return list;
    }

    // Possible viewport locations inside the game client
    const viewportPaths = [
        'hup.mapMouseController.viewport',
        'hup.lasso.viewport',
        'h.game.m.map_mouse_controller.viewport',
        'hup.gameController.view.viewport'
    ];

    // Tries to hook into the running game: finds viewport, attaches listeners
    function attach() {
        const cands = framesSameOrigin();
        for (const c of cands) {
            for (const p of viewportPaths) {
                const vp = tryGet(c.win, p);
                if (vp && vp.rect) {
                    if (state.hupWin !== c.win) {
                        if (state.hupWin) removeDrawingListeners(state.hupWin);
                        addDrawingListeners(c.win);
                    }
                    state.attached = true;
                    state.hupWin = c.win;
                    state.hupPath = p;
                    initializeGameData(c.win);
                    return true;
                }
            }
        }
        if (state.hupWin) removeDrawingListeners(state.hupWin);
        state.attached = false;
        hupWin = null;
        hupPath = '';
        return false;
    }

    // Keeps trying to connect until we succeed once
    const boot = setInterval(() => { if (attach()) clearInterval(boot); }, 300);

    // Pulls basic game/player info from the client (playerID, color, gameID)
    function initializeGameData(win) {
        const gameState = tryGet(win, 'hup.gameState');
        if (!gameState) return;
        const playerProfile = gameState.getPlayerProfile();
        if (playerProfile) {
            state.game.playerID = playerProfile.playerID;
            state.game.playerColor = playerProfile.primaryColor;
        }
        const gameServer = tryGet(win, 'hup.gameServer');
        if (gameServer && gameServer.gameID) state.game.gameID = gameServer.gameID;
        if (state.game.playerID && !state.allDrawings[state.game.playerID]) {
            state.allDrawings[state.game.playerID] = { color: state.game.playerColor, paths: [] };
        }
        ensureVisibilityEntry(state.game.playerID);
        rebuildPlayersIfChanged();
    }

    // "Clear My Drawings" button handler
    clearButton.addEventListener('click', () => {
        if (state.game.playerID && state.allDrawings[state.game.playerID]) {
            state.allDrawings[state.game.playerID].paths = [];
        }
    });

    // Grid toggle button handler
    gridButton.addEventListener('click', () => {
        state.drawing.showGrid = !state.drawing.showGrid;
        gridButton.textContent = state.drawing.showGrid ? 'Grid: On' : 'Grid: Off';
        gridButton.style.background = state.drawing.showGrid ? 'rgba(80,120,255,.3)' : 'rgba(255,255,255,.1)';
    });

    // Players dropdown toggle
    playersBtn.addEventListener('click', () => {
        playersPanel.style.display = playersPanel.style.display === 'none' ? 'block' : 'none';
    });

    // Global "hide all drawings" toggle
    hideAllBtn.addEventListener('click', () => {
        state.filters.hideAll = !state.filters.hideAll;
        hideAllBtn.textContent = state.filters.hideAll ? 'Hide All: On' : 'Hide All: Off';
    });

    // Expand/collapse the HUD
    collapseBtn.addEventListener('click', () => {
        state.uiCollapsed = !state.uiCollapsed;
        if (state.uiCollapsed) {
            uiContent.style.display = 'none';
            playersPanel.style.display = 'none';
            collapseBtn.textContent = '⯈';
        } else {
            uiContent.style.display = 'flex';
            collapseBtn.textContent = '⯆';
        }
    });

    // Ensures a player exists in the visibility map
    function ensureVisibilityEntry(playerID) {
        if (playerID == null) return;
        if (!(playerID in state.filters.hiddenPlayers)) state.filters.hiddenPlayers[playerID] = false;
    }

    // Builds one row in the players dropdown (color dot, checkbox, player ID)
    function playerItemRow(playerID, color) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.04)';
        const sw = document.createElement('span');
        sw.style.cssText = 'width:12px;height:12px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.4)';
        sw.style.background = color || '#888';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !state.filters.hiddenPlayers[playerID];
        cb.addEventListener('change', () => {
            state.filters.hiddenPlayers[playerID] = !cb.checked;
        });
        const name = document.createElement('span');
        name.textContent = `#${playerID}`;
        name.style.cssText = 'color:#e6f0ff';
        row.append(sw, cb, name);
        return row;
    }

    // Updates the players dropdown if the set of players changed
    function rebuildPlayersIfChanged() {
        const keys = Object.keys(state.allDrawings).sort((a, b) => Number(a) - Number(b));
        const sig = keys.join(',');
        if (sig === state._lastPlayerKeys) return;
        state._lastPlayerKeys = sig;
        playersList.textContent = '';
        for (const k of keys) {
            ensureVisibilityEntry(k);
            const item = playerItemRow(k, state.allDrawings[k]?.color);
            playersList.appendChild(item);
        }
        if (keys.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No players yet';
            empty.style.cssText = 'color:#bbb;padding:6px 2px;';
            playersList.appendChild(empty);
        }
    }

    // Converts screen coords (mouse) to world coords (map space)
    function getTransformedCoords(screenX, screenY) {
        const vp = state.drawing.viewport;
        if (!vp) return null;
        const scale = typeof vp._scale === 'number' ? vp._scale : 1;
        return { x: screenX / scale + vp.rect.x, y: screenY / scale + vp.rect.y };
    }

    // Removes nearby stroke segments from your own drawings (Alt+RClick erase)
    function erasePathsNear(coords) {
        if (!coords || !state.drawing.viewport || !state.game.playerID) return;
        const myDrawings = state.allDrawings[state.game.playerID];
        if (!myDrawings) return;
        const scale = state.drawing.viewport._scale;
        const eraseRadius = 15 / scale;
        const eraseRadiusSq = eraseRadius * eraseRadius;
        const ERASE_CHUNK_SIZE = 20;
        for (let i = myDrawings.paths.length - 1; i >= 0; i--) {
            const path = myDrawings.paths[i];
            for (let j = 0; j < path.points.length; j++) {
                const point = path.points[j];
                const dx = point.x - coords.x;
                const dy = point.y - coords.y;
                if (dx * dx + dy * dy < eraseRadiusSq) {
                    const halfChunk = Math.floor(ERASE_CHUNK_SIZE / 2);
                    const startIndex = Math.max(0, j - halfChunk);
                    const endIndex = Math.min(path.points.length, j + halfChunk);
                    const pointsBefore = path.points.slice(0, startIndex);
                    const pointsAfter = path.points.slice(endIndex);
                    myDrawings.paths.splice(i, 1);
                    if (pointsBefore.length > 1) {
                        myDrawings.paths.push({
                            id: generateUniqueId(),
                            points: pointsBefore,
                            sent: false,
                            isFinal: true
                        });
                    }
                    if (pointsAfter.length > 1) {
                        myDrawings.paths.push({
                            id: generateUniqueId(),
                            points: pointsAfter,
                            sent: false,
                            isFinal: true
                        });
                    }
                    return;
                }
            }
        }
    }

    // After you finish drawing, starts the "send in X seconds" timer
    function markDirtyAndScheduleBatch() {
        if (state.batch.timerId !== null) return;
        state.batch.timerId = window.setTimeout(() => {
            flushBatchToConsole();
            state.batch.timerId = null;
        }, CONFIG.BATCH_WAIT_SECONDS * 1000);
    }

    // Builds a batch of only new, finished paths and logs it out
    function flushBatchToConsole() {
        if (!state.game.gameID || !state.game.playerID) return;

        const playersPayload = [];

        for (const [playerID, pdata] of Object.entries(state.allDrawings)) {
            const unsentFinishedPaths = pdata.paths.filter(p => p.sent !== true && p.isFinal === true);

            if (unsentFinishedPaths.length === 0) continue;

            playersPayload.push({
                playerID: Number(playerID),
                playerColor: pdata.color,
                paths: unsentFinishedPaths.map(p => ({
                    id: p.id,
                    points: p.points
                }))
            });

            for (const p of unsentFinishedPaths) {
                p.sent = true;
            }
        }

        if (playersPayload.length === 0) {
            return;
        }

        const payload = {
            gameID: state.game.gameID,
            players: playersPayload
        };

        console.log("--- BATCH SEND ---");
        console.log(JSON.stringify(payload, null, 2));
    }

    // Handles Alt+mousedown:
    // - LMB: begin new stroke and start collecting points
    // - RMB: enter erase mode
    function handleMouseDown(e) {
        if (!state.attached || !e.altKey || !state.game.playerID) return;

        if (e.button === 2) {
            e.stopPropagation(); e.preventDefault();
            state.drawing.isErasing = true;
            erasePathsNear(getTransformedCoords(e.clientX, e.clientY));
        } else if (e.button === 0) {
            e.stopPropagation(); e.preventDefault();
            state.drawing.isDrawing = true;

            const coords = getTransformedCoords(e.clientX, e.clientY);
            if (coords) {
                state.drawing.currentPath = {
                    id: generateUniqueId(),
                    points: [coords],
                    sent: false,
                    isFinal: false
                };

                if (!state.allDrawings[state.game.playerID]) {
                    state.allDrawings[state.game.playerID] = {
                        color: state.game.playerColor,
                        paths: []
                    };
                }

                state.allDrawings[state.game.playerID].paths.push(state.drawing.currentPath);

                ensureVisibilityEntry(state.game.playerID);
                rebuildPlayersIfChanged();
            }
        }
    }

    // Handles Alt+mousemove:
    // - while drawing, keep adding new points
    // - while erasing, keep carving
    function handleMouseMove(e) {
        if (!e.altKey) return;

        if (state.drawing.isErasing) {
            e.stopPropagation(); e.preventDefault();
            erasePathsNear(getTransformedCoords(e.clientX, e.clientY));
        } else if (state.drawing.isDrawing) {
            e.stopPropagation(); e.preventDefault();
            const coords = getTransformedCoords(e.clientX, e.clientY);
            if (coords && state.drawing.currentPath) {
                state.drawing.currentPath.points.push(coords);
            }
        }
    }

    // Handles Alt+mouseup:
    // - finalize stroke
    // - mark it ready to send
    // - start batch timer
    function handleMouseUp(e) {
        if (state.drawing.isDrawing || state.drawing.isErasing) {
            e.stopPropagation(); e.preventDefault();

            const wasDrawing = state.drawing.isDrawing;

            if (wasDrawing && state.drawing.currentPath) {
                state.drawing.currentPath.isFinal = true;
            }

            state.drawing.isDrawing = false;
            state.drawing.isErasing = false;
            state.drawing.currentPath = null;

            if (wasDrawing) {
                markDirtyAndScheduleBatch();
            }
        }
    }

    // Blocks the browser context menu when using Alt+RClick erase
    function handleContextMenu(e) {
        if (e.altKey) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // Hooks mouse listeners into the game frame
    function addDrawingListeners(win) {
        win.addEventListener('mousedown', handleMouseDown, true);
        win.addEventListener('mousemove', handleMouseMove, true);
        win.addEventListener('mouseup', handleMouseUp, true);
        win.addEventListener('contextmenu', handleContextMenu, true);
    }

    // Unhooks mouse listeners from the game frame
    function removeDrawingListeners(win) {
        win.removeEventListener('mousedown', handleMouseDown, true);
        win.removeEventListener('mousemove', handleMouseMove, true);
        win.removeEventListener('mouseup', handleMouseUp, true);
        win.removeEventListener('contextmenu', handleContextMenu, true);
    }

    // Draws the optional map grid overlay (if Grid: On)
    function drawGrid(viewport) {
        const { totalWidth, totalHeight, _scale: scale } = viewport;
        const gridSize = 100;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();

        for (let x = 0; x <= totalWidth; x += gridSize) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, totalHeight);
        }

        for (let y = 0; y <= totalHeight; y += gridSize) {
            ctx.moveTo(0, y);
            ctx.lineTo(totalWidth, y);
        }

        ctx.stroke();
    }

    // Draws one stroke (used twice: outline pass, color pass)
    function drawSinglePath(points, color, scale) {
        if (points.length === 0) return;

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);

        ctx.strokeStyle = color;
        ctx.stroke();
    }

    // Renders all visible player strokes to the overlay canvas
    // (outline first, then their actual color)
    function updateCanvas(viewport) {
        const scale = viewport._scale;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-viewport.rect.x, -viewport.rect.y);

        if (state.drawing.showGrid && viewport.totalWidth) {
            drawGrid(viewport);
        }

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const [playerID, playerData] of Object.entries(state.allDrawings)) {
            if (state.filters.hideAll) continue;
            if (state.filters.hiddenPlayers[playerID]) continue;

            for (const path of playerData.paths) {
                ctx.lineWidth = 5 / scale;
                drawSinglePath(path.points, 'rgba(0,0,0,0.8)', scale);

                ctx.lineWidth = 3 / scale;
                drawSinglePath(path.points, playerData.color, scale);
            }
        }

        ctx.restore();
    }

    // Default the HUD to collapsed on load
    uiContent.style.display = 'none';
    playersPanel.style.display = 'none';
    collapseBtn.textContent = '⯈';

    // Main RAF loop that:
    // - stays attached to the viewport
    // - updates player list if new players draw
    // - redraws canvas following camera position/zoom
    function tick() {
        if (!state.attached) attach();

        if (state.attached) {
            const vp = tryGet(state.hupWin, state.hupPath);
            if (vp && vp.rect) {
                state.drawing.viewport = vp;
                rebuildPlayersIfChanged();
                updateCanvas(vp);
            } else {
                state.attached = false;
                state.drawing.viewport = null;
            }
        }

        requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
})();
