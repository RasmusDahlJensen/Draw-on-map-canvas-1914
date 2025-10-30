// ==UserScript==
// @name         S1914 Map Drawing Overlay (Synced via SignalR, Batched)
// @namespace    mr-cool.s1914.cam-hud.drawing.synced
// @version      3.1.0
// @description  Map drawing overlay with IDs, per-player visibility, batched create/delete to backend, and server-push sync
// @match        https://www.supremacy1914.com/*
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    /*****************************************************************
     * 0. CONFIG
     *****************************************************************/
    const CONFIG = {
        BATCH_WAIT_SECONDS: 5, // how long after you stop drawing/erasing before we send batch
        HUB_URL: 'https://powerboys.noxiaz.dk:5006/drawingHub' // backend SignalR hub
    };

    /*****************************************************************
     * 1. BACKEND / SIGNALR
     *****************************************************************/

    const backend = {
        connection: null,
        ready: false,
        _pendingInvokes: [],

        // We accumulate stuff to send on the next flush.
        // Each entry in createQueue:
        //   { gameID, playerID, playerColor, pathObj }
        // Each entry in deleteQueue:
        //   { gameID, playerID, pathUID }
        batchBuffers: {
            createQueue: [],
            deleteQueue: []
        },

        /**
         * Queue a path to be created next flush.
         * pathObj = { id, points:[{x,y},...], sent?, isFinal? }
         */
        queueCreatePath(gameID, playerID, playerColor, pathObj) {
            this.batchBuffers.createQueue.push({
                gameID,
                playerID,
                playerColor,
                pathObj
            });
        },

        /**
         * Queue a deletion by pathUID for next flush.
         */
        queueDeletePath(gameID, playerID, pathUID) {
            this.batchBuffers.deleteQueue.push({
                gameID,
                playerID,
                pathUID: String(pathUID)
            });
        },

        flushBatchesNow() {
            if (!this.ready) {
                this._pendingInvokes.push(() => this.flushBatchesNow());
                return;
            }

            const creates = this.batchBuffers.createQueue;
            const deletes = this.batchBuffers.deleteQueue;
            this.batchBuffers = { createQueue: [], deleteQueue: [] };

            for (const entry of creates) {
                const gameID = Number(entry.gameID);
                const playerID = Number(entry.playerID);
                const playerColor = entry.playerColor || '#FFFFFF';

                const backendPathModel = {
                    id: 0,
                    fk_GameID: 0,
                    pathUID: String(entry.pathObj.id),
                    points: entry.pathObj.points.map(pt => ({
                        id: 0,
                        fk_PathID: 0,
                        x: pt.x,
                        y: pt.y
                    }))
                };

                console.log('[SYNC] CreatePath -> backend', {
                    gameID,
                    playerID,
                    playerColor,
                    backendPathModel
                });

                this.connection.invoke(
                    'CreatePath',
                    gameID,
                    playerID,
                    playerColor,
                    backendPathModel
                ).catch(err => {
                    console.error('[SYNC] CreatePath failed', err);
                });
            }

            // Send deletes one by one
            for (const entry of deletes) {
                const gameID = Number(entry.gameID);
                const playerID = Number(entry.playerID);
                const uid = entry.pathUID;

                console.log('[SYNC] DeletePath -> backend', {
                    gameID,
                    playerID,
                    uid
                });

                this.connection.invoke(
                    'DeletePath',
                    gameID,
                    playerID,
                    uid
                ).catch(err => {
                    console.error('[SYNC] DeletePath failed', err);
                });
            }
        },

        /**
        Transform database into useable data
         */
        applyFullStateFromBackend(games) {
            if (!games || !state.game.gameID) return;
            const currentGameID = Number(state.game.gameID);

            const rebuilt = {};

            for (const game of games) {
                if (Number(game.gameID) !== currentGameID) continue;

                const pID = Number(game.playerID);
                const color = game.playerColor || '#FFFFFF';

                if (!rebuilt[pID]) {
                    rebuilt[pID] = {
                        color,
                        paths: []
                    };
                }

                for (const path of game.paths || []) {
                    const uid =
                        path.pathUID ||
                        path.PathUID ||
                        path.pathUid ||
                        path.id ||
                        'unknown';

                    const pts = [];
                    if (path.points) {
                        for (const pt of path.points) {
                            pts.push({ x: pt.x, y: pt.y });
                        }
                    }

                    rebuilt[pID].paths.push({
                        id: uid,
                        points: pts,
                        sent: true,
                        isFinal: true
                    });
                }
            }

            for (const [playerID, pdata] of Object.entries(rebuilt)) {
                state.allDrawings[playerID] = pdata;
                ensureVisibilityEntry(playerID);
            }

            rebuildPlayersIfChanged();
        },

        /**
         * Ask server for full state now (used after connect).
         */
        requestFullStateOnce() {
            if (!this.ready) {
                this._pendingInvokes.push(() => this.requestFullStateOnce());
                return;
            }

            this.connection.invoke('GetAll')
                .then(games => {
                    console.log('[SYNC] Initial GetAll <- backend', games);
                    this.applyFullStateFromBackend(games);
                })
                .catch(err => {
                    console.error('[SYNC] GetAll failed', err);
                });
        }
    };

    // Load SignalR client lib, then connect and wire handlers
    function ensureSignalRConnection() {
        if (backend.connection) return;

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/microsoft-signalr/8.0.0/signalr.min.js';
        script.crossOrigin = 'anonymous';

        script.onload = () => {
            console.log('[SYNC] SignalR client loaded, connecting...');

            backend.connection = new window.signalR.HubConnectionBuilder()
                .withUrl(CONFIG.HUB_URL, {
                    withCredentials: false
                })
                .withAutomaticReconnect()
                .build();

            //    await Clients.All.SendAsync("FullStateSync", gamesList);
            backend.connection.on('FullStateSync', (games) => {
                console.log('[SYNC] FullStateSync <- backend', games);
                backend.applyFullStateFromBackend(games);
            });

            backend.connection
                .start()
                .then(() => {
                    backend.ready = true;
                    console.log('[SYNC] Connected to hub', CONFIG.HUB_URL);

                    const pending = backend._pendingInvokes.slice();
                    backend._pendingInvokes.length = 0;
                    for (const fn of pending) {
                        try { fn(); } catch (e) { console.error('[SYNC] pending invoke err', e); }
                    }

                    backend.requestFullStateOnce();
                })
                .catch(err => {
                    console.error('[SYNC] hub start failed', err);
                });
        };

        script.onerror = () => {
            console.error('[SYNC] Failed to load SignalR client library');
        };

        document.head.appendChild(script);
    }

    /*****************************************************************
     * 2. UI CREATION
     *****************************************************************/

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

    const uiContent = document.createElement('div');
    uiContent.style.cssText = 'display:flex;flex-wrap:wrap;row-gap:8px;column-gap:8px;align-items:center;';
    ui.appendChild(uiContent);

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

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483646; pointer-events: none;';
    document.body.appendChild(canvas);

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    /*****************************************************************
     * 3. STATE
     *****************************************************************/
    const state = {
        attached: false,
        hupWin: null,
        hupPath: '',
        game: {
            playerID: null,
            gameID: null,
            playerColor: '#FF0000'
        },
        allDrawings: {},
        drawing: {
            isDrawing: false,
            isErasing: false,
            currentPath: null,
            viewport: null,
            showGrid: false
        },
        filters: {
            hideAll: false,
            hiddenPlayers: {}
        },
        _lastPlayerKeys: '',
        uiCollapsed: true,
        batch: {
            timerId: null
        }
    };

    /*****************************************************************
     * 4. HELPERS
     *****************************************************************/
    function tryGet(obj, path) {
        try { return path.split('.').reduce((o, k) => o && o[k], obj) ?? null; } catch { return null; }
    }

    function generateUniqueId() {
        const timestamp = Date.now();
        const randomPart = Math.floor(Math.random() * 1_000);
        return timestamp * 1_000 + randomPart;
    }

    function framesSameOrigin() {
        const list = [];
        try {
            if (window && window.document) {
                list.push({ win: window, tag: 'top' });
            }
        } catch { }
        try {
            for (let i = 0; i < window.frames.length; i++) {
                const w = window.frames[i];
                try {
                    void w.document;
                    list.push({ win: w, tag: 'frames[' + i + ']' });
                } catch { }
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

    const viewportPaths = [
        'hup.mapMouseController.viewport',
        'hup.lasso.viewport',
        'h.game.m.map_mouse_controller.viewport',
        'hup.gameController.view.viewport'
    ];

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

                    // once we know player/game, open the SignalR connection
                    ensureSignalRConnection();

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

    const boot = setInterval(() => {
        if (attach()) clearInterval(boot);
    }, 300);

    function initializeGameData(win) {
        const gameState = tryGet(win, 'hup.gameState');
        if (!gameState) return;

        const playerProfile = gameState.getPlayerProfile();
        if (playerProfile) {
            state.game.playerID = playerProfile.playerID;
            state.game.playerColor = playerProfile.primaryColor;
        }

        const gameServer = tryGet(win, 'hup.gameServer');
        if (gameServer && gameServer.gameID) {
            state.game.gameID = gameServer.gameID;
        }

        if (state.game.playerID && !state.allDrawings[state.game.playerID]) {
            state.allDrawings[state.game.playerID] = {
                color: state.game.playerColor,
                paths: []
            };
        }

        ensureVisibilityEntry(state.game.playerID);
        rebuildPlayersIfChanged();
    }

    /*****************************************************************
     * 5. UI BUTTON HANDLERS
     *****************************************************************/
    clearButton.addEventListener('click', () => {
        const pid = state.game.playerID;
        const gid = state.game.gameID;
        if (pid && state.allDrawings[pid]) {
            const myData = state.allDrawings[pid];

            for (const p of myData.paths) {
                backend.queueDeletePath(gid, pid, p.id);
            }

            myData.paths = [];
            markDirtyAndScheduleBatch();
        }
    });

    gridButton.addEventListener('click', () => {
        state.drawing.showGrid = !state.drawing.showGrid;
        gridButton.textContent = state.drawing.showGrid ? 'Grid: On' : 'Grid: Off';
        gridButton.style.background = state.drawing.showGrid
            ? 'rgba(80,120,255,.3)'
            : 'rgba(255,255,255,.1)';
    });

    playersBtn.addEventListener('click', () => {
        playersPanel.style.display =
            playersPanel.style.display === 'none' ? 'block' : 'none';
    });

    hideAllBtn.addEventListener('click', () => {
        state.filters.hideAll = !state.filters.hideAll;
        hideAllBtn.textContent = state.filters.hideAll
            ? 'Hide All: On'
            : 'Hide All: Off';
    });

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

    function ensureVisibilityEntry(playerID) {
        if (playerID == null) return;
        if (!(playerID in state.filters.hiddenPlayers)) {
            state.filters.hiddenPlayers[playerID] = false;
        }
    }

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

    function rebuildPlayersIfChanged() {
        const keys = Object.keys(state.allDrawings).sort(
            (a, b) => Number(a) - Number(b)
        );
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

    /*****************************************************************
     * 6. DRAW / ERASE + BATCHING
     *****************************************************************/

    function getTransformedCoords(screenX, screenY) {
        const vp = state.drawing.viewport;
        if (!vp) return null;
        const scale = typeof vp._scale === 'number' ? vp._scale : 1;
        return {
            x: screenX / scale + vp.rect.x,
            y: screenY / scale + vp.rect.y
        };
    }

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
                    backend.queueDeletePath(
                        state.game.gameID,
                        state.game.playerID,
                        path.id
                    );

                    if (pointsBefore.length > 1) {
                        const newPathBefore = {
                            id: generateUniqueId(),
                            points: pointsBefore,
                            sent: false,
                            isFinal: true
                        };
                        myDrawings.paths.push(newPathBefore);

                        backend.queueCreatePath(
                            state.game.gameID,
                            state.game.playerID,
                            myDrawings.color,
                            newPathBefore
                        );
                        newPathBefore.sent = true;
                    }

                    if (pointsAfter.length > 1) {
                        const newPathAfter = {
                            id: generateUniqueId(),
                            points: pointsAfter,
                            sent: false,
                            isFinal: true
                        };
                        myDrawings.paths.push(newPathAfter);

                        backend.queueCreatePath(
                            state.game.gameID,
                            state.game.playerID,
                            myDrawings.color,
                            newPathAfter
                        );
                        newPathAfter.sent = true;
                    }

                    markDirtyAndScheduleBatch();
                    return;
                }
            }
        }
    }

    function markDirtyAndScheduleBatch() {
        if (state.batch.timerId !== null) return;
        state.batch.timerId = window.setTimeout(() => {
            flushBatchToBackend();
            state.batch.timerId = null;
        }, CONFIG.BATCH_WAIT_SECONDS * 1000);
    }

    function flushBatchToBackend() {
        const gid = state.game.gameID;
        if (!gid) return;

        for (const [playerID, pdata] of Object.entries(state.allDrawings)) {
            for (const p of pdata.paths) {
                if (p.sent !== true && p.isFinal === true) {
                    backend.queueCreatePath(
                        gid,
                        playerID,
                        pdata.color,
                        p
                    );
                    p.sent = true;
                }
            }
        }

        backend.flushBatchesNow();
    }

    function handleMouseDown(e) {
        if (!state.attached || !e.altKey || !state.game.playerID) return;

        if (e.button === 2) {
            e.stopPropagation();
            e.preventDefault();
            state.drawing.isErasing = true;
            erasePathsNear(getTransformedCoords(e.clientX, e.clientY));
        } else if (e.button === 0) {
            e.stopPropagation();
            e.preventDefault();
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

                state.allDrawings[state.game.playerID].paths.push(
                    state.drawing.currentPath
                );

                ensureVisibilityEntry(state.game.playerID);
                rebuildPlayersIfChanged();
            }
        }
    }

    function handleMouseMove(e) {
        if (!e.altKey) return;

        if (state.drawing.isErasing) {
            e.stopPropagation();
            e.preventDefault();
            erasePathsNear(getTransformedCoords(e.clientX, e.clientY));
        } else if (state.drawing.isDrawing) {
            e.stopPropagation();
            e.preventDefault();
            const coords = getTransformedCoords(e.clientX, e.clientY);
            if (coords && state.drawing.currentPath) {
                state.drawing.currentPath.points.push(coords);
            }
        }
    }

    function handleMouseUp(e) {
        if (state.drawing.isDrawing || state.drawing.isErasing) {
            e.stopPropagation();
            e.preventDefault();

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

    function handleContextMenu(e) {
        if (e.altKey) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function addDrawingListeners(win) {
        win.addEventListener('mousedown', handleMouseDown, true);
        win.addEventListener('mousemove', handleMouseMove, true);
        win.addEventListener('mouseup', handleMouseUp, true);
        win.addEventListener('contextmenu', handleContextMenu, true);
    }

    function removeDrawingListeners(win) {
        win.removeEventListener('mousedown', handleMouseDown, true);
        win.removeEventListener('mousemove', handleMouseMove, true);
        win.removeEventListener('mouseup', handleMouseUp, true);
        win.removeEventListener('contextmenu', handleContextMenu, true);
    }

    /*****************************************************************
     * 7. RENDERING
     *****************************************************************/

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

    function drawSinglePath(points, color, scale) {
        if (points.length === 0) return;

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }

        ctx.strokeStyle = color;
        ctx.stroke();
    }

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

    uiContent.style.display = 'none';
    playersPanel.style.display = 'none';
    collapseBtn.textContent = '⯈';

    /*****************************************************************
     * 8. MAIN LOOP
     *****************************************************************/
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