const { ipcRenderer } = require('electron');

// --- STATE ---
let allPlays = [];
let playsSortCol = 'startTime';
let playsSortAsc = false;
let statsSortCol = 'plays';
let statsSortAsc = false;

// Pagination State
let currentPagePlays = 1;
let currentPageStats = 1;
const rowsPerPage = 50;

document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupSorting();
    setupSearch();
    setupPagination(); 
});

ipcRenderer.on('update-data', (event, data) => {
    if (Array.isArray(data)) {
        allPlays = data;
        try {
            // Reset pages on new data load usually good UX
            currentPagePlays = 1;
            currentPageStats = 1;
            renderTable();
            renderStatsTable();
        } catch (e) {}
    }
});

ipcRenderer.on('status-update', (event, msg) => {
    const badge = document.getElementById('status-badge');
    if(badge) {
        badge.innerText = msg;
        if(msg.includes("Connected")) badge.style.color = "#50fa7b"; 
        else badge.style.color = "#ff5555";
    }
});

function deletePlay(id) {
    if(confirm("Delete this play?")) {
        ipcRenderer.send('delete-play', id);
    }
}
window.deletePlay = deletePlay;

function setupNavigation() {
    const btnPlays = document.getElementById('btn-plays');
    const btnStats = document.getElementById('btn-stats');
    if (btnPlays && btnStats) {
        btnPlays.addEventListener('click', () => switchTab('plays'));
        btnStats.addEventListener('click', () => switchTab('stats'));
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.view-section').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    
    // FIX: Use 'flex' instead of 'block' to maintain scroll layout
    document.getElementById(`view-${tabName}`).style.display = 'flex';
    
    const btn = document.getElementById(`btn-${tabName}`);
    if (btn) btn.classList.add('active');
}

function setupPagination() {
    // Plays
    document.getElementById('btn-prev-plays')?.addEventListener('click', () => { 
        if (currentPagePlays > 1) { currentPagePlays--; renderTable(); } 
    });
    document.getElementById('btn-next-plays')?.addEventListener('click', () => { 
        currentPagePlays++; renderTable(); 
    });

    // Stats
    document.getElementById('btn-prev-stats')?.addEventListener('click', () => { 
        if (currentPageStats > 1) { currentPageStats--; renderStatsTable(); } 
    });
    document.getElementById('btn-next-stats')?.addEventListener('click', () => { 
        currentPageStats++; renderStatsTable(); 
    });
}

function setupSorting() {
    document.querySelectorAll('th').forEach(th => {
        th.addEventListener('click', () => {
            const table = th.getAttribute('data-table');
            const col = th.getAttribute('data-sort');
            if (!col) return; 
            if (table === 'plays') {
                if (playsSortCol === col) playsSortAsc = !playsSortAsc;
                else { playsSortCol = col; playsSortAsc = true; }
                renderTable();
            } else if (table === 'stats') {
                if (statsSortCol === col) statsSortAsc = !statsSortAsc;
                else { statsSortCol = col; statsSortAsc = true; }
                renderStatsTable();
            }
        });
    });
}

function setupSearch() {
    const searchInput = document.getElementById('search-input');
    if(searchInput) {
        searchInput.addEventListener('keyup', () => { 
            currentPagePlays = 1; 
            renderTable(); 
        });
    }
}

function formatTime(seconds) {
    if (!seconds) return "0s";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTotalTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function renderTable() {
    const tbody = document.getElementById('plays-body');
    const pageInfo = document.getElementById('page-info-plays');
    const btnNext = document.getElementById('btn-next-plays');
    const btnPrev = document.getElementById('btn-prev-plays');

    if (!tbody) return;

    const term = document.getElementById('search-input').value.toLowerCase();
    let filtered = allPlays.filter(p => {
        const title = (p.mapTitle || '').toLowerCase();
        const artist = (p.mapArtist || '').toLowerCase();
        return title.includes(term) || artist.includes(term);
    });

    filtered.sort((a, b) => {
        let valA = a[playsSortCol] || '';
        let valB = b[playsSortCol] || '';
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return playsSortAsc ? -1 : 1;
        if (valA > valB) return playsSortAsc ? 1 : -1;
        return 0;
    });

    const totalPages = Math.ceil(filtered.length / rowsPerPage) || 1;
    if (currentPagePlays > totalPages) currentPagePlays = totalPages;
    if (currentPagePlays < 1) currentPagePlays = 1;

    const start = (currentPagePlays - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const visibleData = filtered.slice(start, end);

    if (pageInfo) pageInfo.innerText = `Page ${currentPagePlays} of ${totalPages}`;
    if (btnPrev) btnPrev.disabled = currentPagePlays === 1;
    if (btnNext) btnNext.disabled = currentPagePlays === totalPages;

    tbody.innerHTML = visibleData.map(play => {
        const date = play.startTime ? new Date(play.startTime).toLocaleString() : '-';
        const mapStr = `${play.mapArtist || '?'} - ${play.mapTitle || '?'} [${play.mapDiff || '?'}]`;
        const modsStr = (play.mods && play.mods.length > 0) ? play.mods : 'NM';
        const durationStr = formatTime(play.durationSeconds || 0);
        const bgUrl = play.mapSetId ? `https://assets.ppy.sh/beatmaps/${play.mapSetId}/covers/list.jpg` : '';

        return `
            <tr>
                <td class="col-img"><img src="${bgUrl}" class="bg-thumb" loading="lazy" onerror="this.style.display='none'"></td>
                <td class="col-date">${date}</td>
                <td class="col-map">${mapStr}</td>
                <td class="col-mapper">${play.mapper || '?'}</td>
                <td class="col-mods">${modsStr}</td>
                <td class="col-stat">${play.ar || '-'}</td>
                <td class="col-stat">${play.cs || '-'}</td>
                <td class="col-stat">${play.od || '-'}</td>
                <td class="status-${play.status}">${play.status}</td>
                <td class="rank-${play.rank}">${play.rank || '-'}</td>
                <td class="col-pp">${play.pp || 0}pp</td>
                <td>${(play.accuracy || 0).toFixed(2)}%</td>
                <td style="color: #ff5555">${play.maxCombo || 0}x</td>
                <td class="col-time">${durationStr}</td>
                <td class="col-ur">${play.ur ? Math.round(play.ur) : '-'}</td>
                <td class="col-300" style="font-size: 11px;">${play.n300||0}</td>
                <td class="col-100" style="font-size: 11px;">${play.n100||0}</td>
                <td class="col-50" style="font-size: 11px;">${play.n50||0}</td>
                <td class="col-miss" style="font-size: 11px;">${play.misses||0}</td>
                <td class="col-sb" style="font-size: 11px;">${play.sb||0}</td>
                <td style="text-align:center;"><button class="btn-delete" onclick="deletePlay(${play.id})">✖</button></td>
            </tr>
        `;
    }).join('');
}

function renderStatsTable() {
    const tbody = document.getElementById('stats-body');
    const pageInfo = document.getElementById('page-info-stats');
    const btnNext = document.getElementById('btn-next-stats');
    const btnPrev = document.getElementById('btn-prev-stats');

    if (!tbody) return;

    const groups = {};
    allPlays.forEach(play => {
        const id = play.mapId || ((play.mapArtist||'') + (play.mapTitle||'') + (play.mapDiff||''));
        if (!groups[id]) {
            groups[id] = {
                title: play.mapTitle || 'Unknown',
                artist: play.mapArtist || 'Unknown',
                diff: play.mapDiff || '?',
                mapSetId: play.mapSetId,
                plays: 0, passes: 0, maxPP: 0, maxCombo: 0, maxAcc: 0, totalSeconds: 0
            };
        }
        groups[id].plays++;
        if (play.status === 'Pass') groups[id].passes++;
        groups[id].maxPP = Math.max(groups[id].maxPP, (play.pp || 0));
        groups[id].maxAcc = Math.max(groups[id].maxAcc, (play.accuracy || 0));
        groups[id].totalSeconds += (play.durationSeconds || 0);
        if ((play.maxCombo || 0) > groups[id].maxCombo) groups[id].maxCombo = play.maxCombo;
    });

    const rows = Object.values(groups).map(g => ({
        ...g,
        passRate: g.plays ? ((g.passes / g.plays) * 100) : 0
    }));

    rows.sort((a, b) => {
        let valA = a[statsSortCol] || 0;
        let valB = b[statsSortCol] || 0;
        if (valA < valB) return statsSortAsc ? -1 : 1;
        if (valA > valB) return statsSortAsc ? 1 : -1;
        return 0;
    });

    // STATS PAGINATION
    const totalPages = Math.ceil(rows.length / rowsPerPage) || 1;
    if (currentPageStats > totalPages) currentPageStats = totalPages;
    if (currentPageStats < 1) currentPageStats = 1;

    const start = (currentPageStats - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const visibleData = rows.slice(start, end);

    if (pageInfo) pageInfo.innerText = `Page ${currentPageStats} of ${totalPages}`;
    if (btnPrev) btnPrev.disabled = currentPageStats === 1;
    if (btnNext) btnNext.disabled = currentPageStats === totalPages;

    tbody.innerHTML = visibleData.map(g => {
        const totalTimeStr = formatTotalTime(g.totalSeconds);
        const bgUrl = g.mapSetId ? `https://assets.ppy.sh/beatmaps/${g.mapSetId}/covers/list.jpg` : '';
        return `
            <tr>
                <td class="col-img"><img src="${bgUrl}" class="bg-thumb" loading="lazy" onerror="this.style.display='none'"></td>
                <td class="col-map">${g.artist} - ${g.title}</td>
                <td style="color: #ff79c6">${g.diff}</td>
                <td style="font-size: 14px; font-weight: bold;">${g.plays}</td>
                <td class="${g.passRate >= 50 ? 'status-Pass' : 'status-Fail'}">${g.passRate.toFixed(0)}%</td>
                <td style="color: #ff5555">${g.maxCombo}x</td>
                <td class="col-pp">${g.maxPP}pp</td>
                <td>${g.maxAcc.toFixed(2)}%</td>
                <td class="col-time">${totalTimeStr}</td>
            </tr>
        `;
    }).join('');
}