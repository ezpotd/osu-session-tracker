const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws'); 
const { spawn } = require('child_process');

// --- CONSTANTS ---
const WS_URL = 'ws://127.0.0.1:24050/ws'; 
const DATA_PATH = app.getPath('userData'); 
const DB_FILE = path.join(DATA_PATH, 'osu_plays_db.json');

let mainWindow;
let ws;
let memoryReaderProcess; 
let currentSession = null;
let lastMenuState = 0;
let maxComboInSession = 0;

// STATE VARIABLES
let lastSaveTime = 0;
let hasFailed = false;
let prevCombo = 0;
let sliderBreaks = 0;
let liveStats = {
    pp: 0, accuracy: 0, score: 0, 
    misses: 0, n50: 0, n100: 0, n300: 0,
    sb: 0, grade: '?', ur: 0, time: 0
};

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        }
    });
    app.whenReady().then(() => {
        createWindow();
        startMemoryReader();
        updateStartupSettings(); 
    });
}

// --- AUTO-STARTUP ---
function updateStartupSettings() {
    if (app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin: true,
            path: app.getPath('exe'),
            args: ['--hidden'] 
        });
    } else {
        app.setLoginItemSettings({
            openAtLogin: false,
            path: process.execPath,
            args: []
        });
    }
}

// --- MEMORY READER ---
function startMemoryReader() {
    const exeName = 'memory-reader.exe';
    let exePath;

    if (app.isPackaged) {
        exePath = path.join(process.resourcesPath, 'bin', exeName);
    } else {
        exePath = path.join(__dirname, 'bin', exeName);
    }

    if (fs.existsSync(exePath)) {
        memoryReaderProcess = spawn(exePath, [], {
            cwd: path.dirname(exePath),
            detached: false,
            windowsHide: true
        });
        setTimeout(connectToOsu, 3000);
    } else {
        connectToOsu(); 
    }
}

function stopMemoryReader() {
    if (memoryReaderProcess) {
        memoryReaderProcess.kill();
        memoryReaderProcess = null;
    }
}

// --- DATABASE ---
function getPlays() {
    if (!fs.existsSync(DB_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return []; }
}

ipcMain.on('delete-play', (event, idToDelete) => {
    let plays = getPlays();
    const initialLength = plays.length;
    plays = plays.filter(p => p.id !== idToDelete);
    if (plays.length !== initialLength) {
        fs.writeFileSync(DB_FILE, JSON.stringify(plays, null, 2));
        if (mainWindow) mainWindow.webContents.send('update-data', plays);
    }
});

function savePlay(playData) {
    const duration = playData.durationSeconds;
    const totalHits = (playData.n300||0) + (playData.n100||0) + (playData.n50||0) + (playData.misses||0);

    // --- 1. ROOT CAUSE FIX: GHOST SESSIONS ---
    // If you "Quit" a session and have 0 Score, it means you never hit a note.
    // This catches:
    // - The "Menu Flicker" bug during retries.
    // - Instant resets where you miss the first note and restart before scoring.
    // - Replay loading glitches (often report 0 score initially).
    if (playData.status === 'Quit' && playData.score === 0) {
        console.log(`[Tracker] Ignored 0-Score Quit (Ghost Session).`);
        return;
    }

    // --- 2. REPLAY PHYSICS CHECK ---
    // 18 hits/sec = 1080 RPM. Impossible for humans.
    // This catches replay fast-forwards.
    if (duration > 1 && totalHits > 0) {
        const hitsPerSecond = totalHits / duration;
        if (hitsPerSecond > 18) {
            console.log(`[Tracker] Discarded: Impossible Speed (${hitsPerSecond.toFixed(1)} hits/s). Likely a Replay.`);
            return;
        }
    }

    const plays = getPlays();
    
    // --- 3. DUPLICATE CHECK (Safety Net) ---
    const isDuplicate = plays.slice(-5).some(p => 
        p.mapId === playData.mapId &&
        p.score === playData.score &&
        p.mods === playData.mods &&
        Math.abs(p.durationSeconds - playData.durationSeconds) < 2
    );

    if (isDuplicate) {
        console.log(`[Tracker] Ignored Duplicate Play`);
        return;
    }

    plays.push(playData);
    fs.writeFileSync(DB_FILE, JSON.stringify(plays, null, 2));
    lastSaveTime = Date.now();

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-data', plays);
    }
    console.log(`[DB] Saved: ${playData.mapTitle} (${playData.status}) Duration: ${duration}s`);
}

// --- WINDOW ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: '#1a1a2e',
        show: false, 
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        icon: path.join(__dirname, 'app-icon.ico') 
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.setMenuBarVisibility(false);

    const startHidden = process.argv.includes('--hidden');
    if (!startHidden) mainWindow.show();

    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('update-data', getPlays());
    });
}

// --- WEBSOCKET LOGIC ---
function connectToOsu() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('status-update', 'Connected to osu!');
        }
    });

    ws.on('message', (data) => {
        try {
            const state = JSON.parse(data);
            handleStateChange(state);
        } catch (e) { /* Ignore */ }
    });

    ws.on('close', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
             mainWindow.webContents.send('status-update', 'Waiting for osu!...');
        }
        setTimeout(connectToOsu, 5000);
    });

    ws.on('error', (err) => {});
}

function handleStateChange(data) {
    if (!data.menu || !data.menu.bm || !data.gameplay) return;

    const menuState = data.menu.state;
    const mapInfo = data.menu.bm;      
    const gameplay = data.gameplay;
    const mods = (data.menu.mods.str || "").toUpperCase();

    // Name Check
    let nameMismatch = false;
    if (gameplay.name && data.userProfile && data.userProfile.name) {
        if (gameplay.name !== data.userProfile.name) nameMismatch = true;
    }

    // 1. START PLAYING
    if (menuState === 2 && lastMenuState !== 2) {
        startNewSession(mapInfo, mods);
        if (nameMismatch) {
            console.log(`[Tracker] Replay detected (Name Mismatch: ${gameplay.name}).`);
            if(currentSession) currentSession.isReplay = true;
        }
    }

    // 2. WHILE PLAYING
    if (menuState === 2 && currentSession) {
        if (currentSession.isReplay) return;
        if (nameMismatch) { currentSession.isReplay = true; return; }

        let currentTime = 0;
        if (data.menu.bm.time) currentTime = data.menu.bm.time.current || 0;

        // --- RETRY DETECTION ---
        if (liveStats.time > 2000 && currentTime < 1000 && gameplay.score === 0) {
            console.log(`[Tracker] Retry Detected.`);
            completeSession(data, hasFailed ? 'Fail' : 'Quit'); 
            startNewSession(mapInfo, mods);
            return; 
        }

        const currCombo = gameplay.combo.current || 0;
        const currMisses = gameplay.hits['0'] || 0;

        if (currCombo > maxComboInSession) maxComboInSession = currCombo;
        if (data.menu.mods && data.menu.mods.str) currentSession.mods = data.menu.mods.str;
        
        if (currCombo < prevCombo && prevCombo > 5 && currMisses === (liveStats.misses || 0)) {
            sliderBreaks++;
        }
        prevCombo = currCombo;

        liveStats.pp = gameplay.pp.current || 0;
        liveStats.accuracy = gameplay.accuracy || 0;
        liveStats.score = gameplay.score || 0;
        liveStats.misses = currMisses;
        liveStats.n50 = gameplay.hits['50'] || 0;
        liveStats.n100 = gameplay.hits['100'] || 0;
        liveStats.n300 = gameplay.hits['300'] || 0;
        liveStats.sb = sliderBreaks;
        liveStats.ur = gameplay.hits.unstableRate || 0; 
        liveStats.time = currentTime;
        
        if(gameplay.hits.grade) liveStats.grade = gameplay.hits.grade.current || '?';

        const isNF = currentSession.mods.includes("NF");
        if (!isNF && gameplay.hp.normal === 0 && liveStats.score > 0) {
            hasFailed = true;
        }
    }

    // 3. PASS
    if (menuState === 7 && lastMenuState === 2 && currentSession) {
        // Date Verification
        let isOldScore = false;
        const resultDate = (data.resultsScreen && data.resultsScreen.playTime) || null;
        if (resultDate) {
            const scoreTime = new Date(resultDate).getTime();
            if (scoreTime < (currentSession.startTime - 60000)) isOldScore = true;
        }

        if (isOldScore) {
            currentSession = null;
        } else {
            completeSession(data, 'Pass');
        }
    }

    // 4. FAIL / QUIT
    if ((menuState === 0 || menuState === 1 || menuState === 5) && lastMenuState === 2 && currentSession) {
        const isFail = hasFailed; 
        completeSession(data, isFail ? 'Fail' : 'Quit');
    }

    lastMenuState = menuState;
}

function startNewSession(mapInfo, modsStr) {
    currentSession = {
        startTime: Date.now(),
        mapId: mapInfo.id,
        mapSetId: mapInfo.set,
        mapArtist: mapInfo.metadata.artist,
        mapTitle: mapInfo.metadata.title,
        mapDiff: mapInfo.metadata.difficulty,
        mapper: mapInfo.metadata.mapper, 
        ar: mapInfo.stats.AR,
        cs: mapInfo.stats.CS,
        od: mapInfo.stats.OD,
        mods: modsStr || "", 
        status: 'In Progress',
        isReplay: false
    };
    maxComboInSession = 0;
    prevCombo = 0;
    sliderBreaks = 0;
    liveStats = { pp: 0, accuracy: 0, score: 0, misses: 0, n50:0, n100:0, n300:0, sb: 0, grade: '?', ur: 0, time: 0 };
    hasFailed = false; 
}

function completeSession(finalData, status) {
    if (!currentSession) return;
    if (currentSession.isReplay) {
        currentSession = null;
        return;
    }

    let finalPP, finalAcc, finalScore, finalMiss, finalRank, finalUR, finalTime;
    let n300, n100, n50, finalSB;

    if (status === 'Pass' && finalData) {
        finalPP = finalData.gameplay.pp.current;
        finalAcc = finalData.gameplay.accuracy;
        finalScore = finalData.gameplay.score;
        finalMiss = finalData.gameplay.hits['0'];
        n50 = finalData.gameplay.hits['50'];
        n100 = finalData.gameplay.hits['100'];
        n300 = finalData.gameplay.hits['300'];
        finalRank = finalData.gameplay.hits.grade.current;
        finalUR = finalData.gameplay.hits.unstableRate;
        finalTime = liveStats.time; 
        finalSB = liveStats.sb; 
    } else {
        finalPP = liveStats.pp;
        finalAcc = liveStats.accuracy;
        finalScore = liveStats.score;
        finalMiss = liveStats.misses;
        n50 = liveStats.n50;
        n100 = liveStats.n100;
        n300 = liveStats.n300;
        finalSB = liveStats.sb;
        finalUR = liveStats.ur;
        finalTime = liveStats.time; 
        finalRank = (status === 'Fail') ? 'F' : '-';
    }

    let durationSec = Math.floor(finalTime / 1000);
    if (durationSec <= 0) {
        durationSec = Math.floor((Date.now() - currentSession.startTime) / 1000);
    }

    const playRecord = {
        id: Date.now() + Math.random(),
        ...currentSession, 
        endTime: Date.now(),
        durationSeconds: durationSec, 
        status: status,
        score: finalScore || 0,
        accuracy: finalAcc || 0,
        maxCombo: maxComboInSession,
        misses: finalMiss || 0,
        n50: n50 || 0,
        n100: n100 || 0,
        n300: n300 || 0,
        sb: finalSB || 0,
        pp: Math.round(finalPP || 0),
        rank: finalRank || '?',
        ur: finalUR ? Math.round(finalUR) : 0
    };

    savePlay(playRecord);
    currentSession = null;
}

app.on('will-quit', () => {
    stopMemoryReader(); 
    app.isQuiting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {}
});