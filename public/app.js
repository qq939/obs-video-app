(function () {
    'use strict';

    const CHUNK_SIZE = 2 * 1024 * 1024;
    const FEED_COPIES = 3;

    // ---------------------------------------------------------------- DOM refs
    const viewport = document.getElementById('viewport');
    const feed = document.getElementById('mainFeed');
    const infoPanel = document.getElementById('infoPanel');
    const settingsPanel = document.getElementById('settingsPanel');
    const panelMask = document.getElementById('panelMask');
    const edgeHintLeft = document.getElementById('edgeHintLeft');
    const edgeHintRight = document.getElementById('edgeHintRight');
    const infoName = document.getElementById('infoName');
    const infoSize = document.getElementById('infoSize');
    const infoTime = document.getElementById('infoTime');
    const infoProgress = document.getElementById('infoProgress');
    const infoIndex = document.getElementById('infoIndex');
    const videoCount = document.getElementById('videoCount');
    const randomSwitch = document.getElementById('randomSwitch');
    const autoplaySwitch = document.getElementById('autoplaySwitch');
    const speedOptions = document.getElementById('speedOptions');
    const uploadModal = document.getElementById('uploadModal');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const progressArea = document.getElementById('progressArea');
    const progressTitle = document.getElementById('progressTitle');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const cancelBtn = document.getElementById('cancelBtn');

    // ---------------------------------------------------------------- state
    let videos = [];
    let activeIndex = 0;
    let panel = null;
    let playing = true;
    let random = true;
    let autoplay = true;
    let playbackSpeed = 1.5;
    let currentAbort = null;
    const positions = new Map();

    // ---------------------------------------------------------------- HLS
    const _probe = document.createElement('video');
    const _canNativeHls = !!(_probe.canPlayType && _probe.canPlayType('application/vnd.apple.mpegurl'));
    const HAS_HLSJS = !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());
    const NATIVE_HLS = _canNativeHls && /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
    function hlsCapable(v) { return !!(v && v.hls && v.hlsReady) && (NATIVE_HLS || HAS_HLSJS); }

    const EMPTY_HTML =
        '<div class="empty-state">' +
        '<div class="empty-icon">🎬</div>' +
        '<p>还没有视频</p>' +
        '<p class="sub">长按空白处上传</p>' +
        '</div>';

    // ---------------------------------------------------------------- utils
    function fmtSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function formatTime(t) {
        if (!t) return '-';
        return new Date(t).toLocaleString('zh-CN', { hour12: false });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // Pure-JS SHA-256
    const SHA256_K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const SHA256_H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    function createSha256() {
        const rotr = (x, n) => (x >>> n) | (x << (32 - n));
        const h = SHA256_H0.slice();
        let buf = new Uint8Array(0), totalLen = 0;
        function compress(padded, offset) {
            const w = new Uint32Array(64);
            for (let j = 0; j < 16; j++) { const o = offset + j * 4; w[j] = (padded[o] << 24) | (padded[o+1] << 16) | (padded[o+2] << 8) | padded[o+3]; }
            for (let j = 16; j < 64; j++) {
                const s0 = rotr(w[j-15],7) ^ rotr(w[j-15],18) ^ (w[j-15] >>> 3);
                const s1 = rotr(w[j-2],17) ^ rotr(w[j-2],19) ^ (w[j-2] >>> 10);
                w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
            }
            let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (let j = 0; j < 64; j++) {
                const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
                const ch = (e & f) ^ (~e & g);
                const t1 = (hh + S1 + ch + SHA256_K[j] + w[j]) | 0;
                const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (S0 + maj) | 0;
                hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            h[0] = (h[0]+a)|0; h[1] = (h[1]+b)|0; h[2] = (h[2]+c)|0; h[3] = (h[3]+d)|0;
            h[4] = (h[4]+e)|0; h[5] = (h[5]+f)|0; h[6] = (h[6]+g)|0; h[7] = (h[7]+hh)|0;
        }
        return {
            update(chunk) {
                totalLen += chunk.length;
                if (buf.length > 0) { const c2 = new Uint8Array(buf.length + chunk.length); c2.set(buf); c2.set(chunk, buf.length); buf = c2; }
                else buf = chunk;
                const full = Math.floor(buf.length / 64) * 64;
                for (let i = 0; i < full; i += 64) compress(buf, i);
                buf = buf.slice(full);
            },
            digestHex() {
                const bitLen = totalLen * 8;
                const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
                const rem = buf.length, padLen = rem < 56 ? 64 - rem : 128 - rem;
                const padded = new Uint8Array(rem + padLen);
                padded.set(buf); padded[rem] = 0x80;
                padded[padded.length-8] = (hi>>>24)&0xff; padded[padded.length-7] = (hi>>>16)&0xff;
                padded[padded.length-6] = (hi>>>8)&0xff; padded[padded.length-5] = hi&0xff;
                padded[padded.length-4] = (lo>>>24)&0xff; padded[padded.length-3] = (lo>>>16)&0xff;
                padded[padded.length-2] = (lo>>>8)&0xff; padded[padded.length-1] = lo&0xff;
                for (let i = 0; i < padded.length; i += 64) compress(padded, i);
                let hex = '';
                for (let i = 0; i < 8; i++) hex += (h[i]>>>28&0xf).toString(16)+(h[i]>>>24&0xf).toString(16)+(h[i]>>>20&0xf).toString(16)+(h[i]>>>16&0xf).toString(16)+(h[i]>>>12&0xf).toString(16)+(h[i]>>>8&0xf).toString(16)+(h[i]>>>4&0xf).toString(16)+(h[i]&0xf).toString(16);
                return hex;
            }
        };
    }

    async function sha256(buffer) {
        if (crypto.subtle) { try { const d = await crypto.subtle.digest('SHA-256', buffer); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2,'0')).join(''); } catch(e) {} }
        const ctx = createSha256();
        ctx.update(new Uint8Array(buffer)); return ctx.digestHex();
    }

    async function jsonFetch(url, opts) {
        const res = await fetch(url, opts);
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!res.ok) throw new Error(data.error || data.raw || ('HTTP ' + res.status));
        return data;
    }

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ---------------------------------------------------------------- panel
    function openPanel(name) {
        if (panel === name) return;
        panel = name;
        viewport.dataset.panel = name;
        if (name === 'settings') applyPlaybackEffect(3, false);
        else if (name === 'info') applyPlaybackEffect(3, true);
    }

    function closePanel() {
        if (!panel) return;
        panel = null;
        delete viewport.dataset.panel;
        applyPlaybackEffect(playbackSpeed, false);
    }

    // ---------------------------------------------------------------- playback effect
    let effectTimer = null;

    function applyPlaybackEffect(speed, rewind) {
        clearInterval(effectTimer);
        if (rewind && panel === 'info') {
            effectTimer = setInterval(() => {
                if (panel !== 'info' || videos.length === 0) { clearInterval(effectTimer); return; }
                const activeItem = feed.children[videos.length + activeIndex];
                if (!activeItem) return;
                const video = activeItem.querySelector('video');
                if (!video) return;
                video.currentTime = Math.max(0, video.currentTime - 0.3);
                if (video.currentTime <= 0) video.pause();
            }, 100);
        } else {
            const activeItem = feed.children[videos.length + activeIndex];
            if (activeItem) {
                const video = activeItem.querySelector('video');
                if (video) video.playbackRate = speed;
            }
        }
    }

    // ---------------------------------------------------------------- render
    function createVideoItem(v) {
        const item = document.createElement('div');
        item.className = 'video-item';
        item._videoData = v;

        const video = document.createElement('video');
        if (v.hls && v.hlsReady && (NATIVE_HLS || HAS_HLSJS)) {
            const sHls = document.createElement('source');
            sHls.src = v.hls; sHls.type = 'application/vnd.apple.mpegurl';
            video.appendChild(sHls);
        }
        const sDirect = document.createElement('source');
        sDirect.src = v.url;
        const ext = (v.name.split('.').pop() || '').toLowerCase();
        const mime = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'mkv' ? 'video/x-matroska' : ext === 'm4v' ? 'video/x-m4v' : ext === 'ogv' ? 'video/ogg' : 'video/mp4';
        sDirect.type = mime;
        video.appendChild(sDirect);
        video.src = v.hls && v.hlsReady && (NATIVE_HLS || HAS_HLSJS) ? v.hls : v.url;
        video.muted = false;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.playbackRate = panel === 'settings' ? 3 : playbackSpeed;
        video.addEventListener('loadedmetadata', () => {
            const pending = video._pendingSeek;
            if (pending !== undefined && isFinite(pending) && video.duration && isFinite(video.duration) && pending < video.duration - 0.3) {
                video.currentTime = pending;
            }
            video._pendingSeek = undefined;
        });
        item.appendChild(video);

        const label = document.createElement('div');
        label.className = 'v-label';
        label.textContent = escapeHtml(v.name) + '  ·  ' + fmtSize(v.size);
        item.appendChild(label);

        const comp = document.createElement('button');
        comp.className = 'v-compress';
        comp.textContent = '压缩';
        comp.addEventListener('click', async (e) => {
            e.stopPropagation(); e.preventDefault();
            if (!confirm('压缩 ' + v.name + ' ？\n将转为 H.264/MP4，体积更小、播放更流畅。')) return;
            comp.disabled = true; comp.textContent = '压缩中…';
            try {
                const r = await jsonFetch('/compress/' + encodeURIComponent(v.name), { method: 'POST' });
                alert(r.skipped ? '无需压缩：原视频已经很紧凑（' + fmtSize(r.before) + '）。' : '压缩完成：' + fmtSize(r.before) + ' → ' + fmtSize(r.after) + '，节省 ' + r.savedPct + '%。');
                await loadFeed();
            } catch (err) { alert('压缩失败：' + err.message); comp.disabled = false; comp.textContent = '压缩'; }
        });
        item.appendChild(comp);

        const del = document.createElement('button');
        del.className = 'v-delete';
        del.textContent = '删除';
        del.addEventListener('click', async (e) => {
            e.stopPropagation(); e.preventDefault();
            if (!confirm('删除 ' + v.name + ' ？')) return;
            try { await fetch(v.url, { method: 'DELETE' }); await loadFeed(); }
            catch (err) { alert('删除失败：' + err.message); }
        });
        item.appendChild(del);

        return item;
    }

    function renderFeed() {
        feed.innerHTML = '';
        if (videos.length === 0) {
            feed.innerHTML = EMPTY_HTML;
            updateInfo();
            updateVideoCache();
            return;
        }
        for (let c = 0; c < FEED_COPIES; c++) videos.forEach((v) => feed.appendChild(createVideoItem(v)));
        activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, videos.length - 1)));
        scrollToIndex(activeIndex);
        updateInfo();
        updateVideoCache();
        updatePlayback();
    }

    // ---------------------------------------------------------------- feed scroll
    function scrollToIndex(idx) {
        if (videos.length === 0) { feed.scrollTop = 0; return; }
        feed._progScrollUntil = Date.now() + 60;
        feed.scrollTop = (videos.length + idx) * feed.clientHeight;
    }

    feed.addEventListener('scroll', () => {
        if (videos.length === 0 || Date.now() < (feed._progScrollUntil || 0)) return;
        clearTimeout(feed._scrollTimer);
        feed._scrollTimer = setTimeout(() => {
            const h = Math.max(1, feed.clientHeight);
            const n = videos.length;
            let vis = Math.round(feed.scrollTop / h);
            if (vis < n) { feed._progScrollUntil = Date.now() + 60; feed.scrollTop = (vis + n) * h; applyIndex(vis, feed); return; }
            if (vis >= 2 * n) { feed._progScrollUntil = Date.now() + 60; feed.scrollTop = (vis - n) * h; applyIndex(vis - 2 * n, feed); return; }
            applyIndex(vis - n, feed);
        }, 120);
    });

    function applyIndex(idx) {
        idx = Math.max(0, Math.min(videos.length - 1, idx));
        if (idx === activeIndex) return;
        recordActivePosition();
        activeIndex = idx;
        playing = autoplay;
        updateInfo();
        updateVideoCache();
        updatePlayback();
    }

    // ---------------------------------------------------------------- cache
    function updateVideoCache() {
        if (videos.length === 0) return;
        const n = videos.length;
        for (let i = 0; i < feed.children.length; i++) {
            const item = feed.children[i];
            const video = item && item.querySelector ? item.querySelector('video') : null;
            if (!video) continue;
            const isActive = (i % n) === activeIndex;
            video.preload = isActive ? 'metadata' : 'none';
            if (!isActive) video.pause();
        }
        manageHls();
    }

    // ---------------------------------------------------------------- HLS
    function attachHls(item, video, v) {
        if (!video || !window.Hls || !window.Hls.isSupported()) return;
        if (video._hls || video._hlsFallback) return;
        const hls = new window.Hls({ maxBufferLength: 30 });
        video._hls = hls;
        hls.loadSource(v.hls);
        hls.attachMedia(video);
        let netR = 0, medR = 0;
        hls.on(window.Hls.Events.ERROR, (evt, data) => {
            if (!data || !data.fatal) return;
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && netR < 1) { netR++; hls.startLoad(); }
            else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && medR < 1) { medR++; hls.recoverMediaError(); }
            else destroyHls(item, video, v, true);
        });
    }

    function destroyHls(item, video, v, permanent) {
        if (video && video._hls) { try { video._hls.destroy(); } catch(e) {} video._hls = null; }
        if (video && v && permanent) { video._hlsFallback = true; video.src = v.url; }
    }

    function manageHls() {
        if (videos.length === 0) return;
        const n = videos.length;
        for (let i = 0; i < feed.children.length; i++) {
            const item = feed.children[i];
            if (!item || !item.querySelector) continue;
            const video = item.querySelector('video');
            if (!video) continue;
            const v = item._videoData;
            const isMiddle = i >= n && i < 2 * n;
            const isActive = (i % n) === activeIndex;
            if (isMiddle && isActive && !NATIVE_HLS && hlsCapable(v) && !video._hlsFallback) {
                if (!video._hls) attachHls(item, video, v);
                if (video._hls) video._hls.startLoad();
            } else if (video._hls) destroyHls(item, video, v, false);
        }
    }

    function recordActivePosition() {
        if (videos.length === 0) return;
        const v = videos[activeIndex];
        if (!v) return;
        const item = feed.children[videos.length + activeIndex];
        if (!item) return;
        const video = item.querySelector('video');
        if (video && isFinite(video.currentTime) && video.currentTime > 0.5) positions.set(v.name, video.currentTime);
    }

    // ---------------------------------------------------------------- playback
    function updatePlayback() {
        if (videos.length === 0) return;
        const activeName = videos[activeIndex] ? videos[activeIndex].name : null;
        const savedPos = activeName ? positions.get(activeName) : undefined;
        let posConsumed = false;
        const activeItem = feed.children[videos.length + activeIndex];

        for (let i = 0; i < feed.children.length; i++) {
            const item = feed.children[i];
            if (item === activeItem) continue;
            const v = item.querySelector ? item.querySelector('video') : null;
            if (v) v.pause();
        }

        if (!activeItem) return;
        const video = activeItem.querySelector('video');
        if (!video) return;

        if (savedPos !== undefined && isFinite(savedPos)) {
            if (video.duration && isFinite(video.duration)) {
                if (savedPos < video.duration - 0.3 && Math.abs(video.currentTime - savedPos) > 0.5) { video.currentTime = savedPos; posConsumed = true; }
            } else if (!video._pendingSeek) { video._pendingSeek = savedPos; posConsumed = true; }
        }
        if (savedPos !== undefined && posConsumed) positions.delete(activeName);

        const speed = panel === 'settings' ? 3 : panel === 'info' ? 1 : playbackSpeed;
        video.playbackRate = speed;

        if (playing) {
            video.muted = false;
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
        } else {
            video.pause();
        }
    }

    setInterval(() => {
        if (videos.length === 0) return;
        const activeItem = feed.children[videos.length + activeIndex];
        if (!activeItem) return;
        const video = activeItem.querySelector('video');
        if (!video || !video.duration || !isFinite(video.duration) || video.duration <= 0) return;
        infoProgress.textContent = Math.round((video.currentTime / video.duration) * 100) + '%';
    }, 500);

    // ---------------------------------------------------------------- info
    function updateInfo() {
        if (videos.length === 0) {
            infoName.textContent = '-'; infoSize.textContent = '-';
            infoTime.textContent = '-'; infoProgress.textContent = '0%';
            infoIndex.textContent = '-'; videoCount.textContent = '0';
            return;
        }
        const v = videos[activeIndex];
        infoName.textContent = v.name;
        infoSize.textContent = fmtSize(v.size);
        infoTime.textContent = formatTime(v.mtime);
        infoIndex.textContent = (activeIndex + 1) + ' / ' + videos.length;
        videoCount.textContent = videos.length;
    }

    // ---------------------------------------------------------------- load
    async function loadFeed() {
        const data = await jsonFetch('/videos');
        let list = data.videos || [];
        if (random) shuffle(list);
        videos = list;
        activeIndex = 0;
        positions.clear();
        renderFeed();
    }

    // ---------------------------------------------------------------- gestures
    const SWIPE_THRESHOLD = 220;
    const DRAG_START = 12;
    const EDGE_ZONE = 60;
    const CLOSE_THRESHOLD = 80;
    const VELOCITY_THRESHOLD = 0.3;
    const LONG_PRESS_MS = 800;   // 长按 800ms 触发上传

    let swipeStartX = 0, swipeStartY = 0, swipeMoved = false;
    let swipeStartTime = 0;
    let panelDragStartX = 0;
    let draggingPanel = null;
    let longPressTimer = null;
    let longPressTarget = null;

    viewport.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        swipeStartX = t.clientX;
        swipeStartY = t.clientY;
        swipeStartTime = Date.now();
        swipeMoved = false;

        if (panel) {
            draggingPanel = panel;
            panelDragStartX = t.clientX;
        } else {
            // Start long-press detection on feed area
            longPressTarget = e.target;
            longPressTimer = setTimeout(() => {
                // Long press triggered — open upload
                longPressTimer = null;
                longPressTarget = null;
                if (!panel) {
                    uploadModal.classList.remove('hidden');
                    progressArea.classList.add('hidden');
                }
            }, LONG_PRESS_MS);
        }

        if (!panel) {
            if (swipeStartX < EDGE_ZONE) edgeHintLeft.style.opacity = '1';
            if (swipeStartX > window.innerWidth - EDGE_ZONE) edgeHintRight.style.opacity = '1';
        }
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;

        // Cancel long-press if finger moved significantly
        if (longPressTimer && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            longPressTarget = null;
        }

        if (draggingPanel) {
            swipeMoved = true;
            if (draggingPanel === 'info') {
                infoPanel.style.transition = 'none';
                infoPanel.style.transform = 'translateX(' + Math.max(-infoPanel.offsetWidth, Math.min(0, dx)) + 'px)';
            } else {
                settingsPanel.style.transition = 'none';
                settingsPanel.style.transform = 'translateX(' + Math.max(0, Math.min(settingsPanel.offsetWidth, dx)) + 'px)';
            }
            return;
        }

        if (Math.abs(dx) > DRAG_START && Math.abs(dx) > Math.abs(dy)) {
            swipeMoved = true;
            if (swipeStartX < EDGE_ZONE && dx > SWIPE_THRESHOLD && !panel) {
                openPanel('info');
                edgeHintLeft.style.opacity = '0';
            } else if (swipeStartX > window.innerWidth - EDGE_ZONE && dx < -SWIPE_THRESHOLD && !panel) {
                openPanel('settings');
                edgeHintRight.style.opacity = '0';
            }
        } else if (Math.abs(dy) > 15) {
            swipeMoved = true;
            edgeHintLeft.style.opacity = '0';
            edgeHintRight.style.opacity = '0';
        }
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
        // Cancel long-press
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressTarget = null; }

        const t = e.changedTouches[0];
        edgeHintLeft.style.opacity = '0';
        edgeHintRight.style.opacity = '0';

        if (draggingPanel) {
            const dx = t.clientX - panelDragStartX;
            const velocity = Math.abs(dx) / Math.max(1, Date.now() - swipeStartTime);
            if ((draggingPanel === 'info' && (dx > CLOSE_THRESHOLD || (dx > 0 && velocity > VELOCITY_THRESHOLD))) ||
                (draggingPanel === 'settings' && (dx < -CLOSE_THRESHOLD || (dx < 0 && velocity > VELOCITY_THRESHOLD)))) {
                closePanel();
            }
            infoPanel.style.transition = ''; infoPanel.style.transform = '';
            settingsPanel.style.transition = ''; settingsPanel.style.transform = '';
            draggingPanel = null;
            return;
        }

        const handled = finishSwipe(t.clientX, t.clientY);
        if (!handled) handleTap(e);
    }, { passive: true });

    // Mouse support
    let mouseDown = false;
    viewport.addEventListener('mousedown', (e) => {
        mouseDown = true;
        swipeStartX = e.clientX;
        swipeStartY = e.clientY;
        swipeStartTime = Date.now();
        swipeMoved = false;
        if (panel) { draggingPanel = panel; panelDragStartX = e.clientX; }
        else {
            longPressTarget = e.target;
            longPressTimer = setTimeout(() => {
                if (!panel) { uploadModal.classList.remove('hidden'); progressArea.classList.add('hidden'); }
                longPressTimer = null;
            }, LONG_PRESS_MS);
        }
    });
    viewport.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - swipeStartX;
        const dy = e.clientY - swipeStartY;
        if (longPressTimer && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (draggingPanel) {
            swipeMoved = true;
            if (draggingPanel === 'info') {
                infoPanel.style.transition = 'none';
                infoPanel.style.transform = 'translateX(' + Math.max(-infoPanel.offsetWidth, Math.min(0, dx)) + 'px)';
            } else {
                settingsPanel.style.transition = 'none';
                settingsPanel.style.transform = 'translateX(' + Math.max(0, Math.min(settingsPanel.offsetWidth, dx)) + 'px)';
            }
            return;
        }
        if (Math.abs(dx) > DRAG_START && Math.abs(dx) > Math.abs(dy)) swipeMoved = true;
        else if (Math.abs(dy) > 15) swipeMoved = true;
    });
    viewport.addEventListener('mouseup', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressTarget = null; }
        if (!mouseDown) return;
        mouseDown = false;
        if (draggingPanel) {
            const dx = e.clientX - panelDragStartX;
            if ((draggingPanel === 'info' && dx > CLOSE_THRESHOLD) || (draggingPanel === 'settings' && dx < -CLOSE_THRESHOLD)) closePanel();
            infoPanel.style.transition = ''; infoPanel.style.transform = '';
            settingsPanel.style.transition = ''; settingsPanel.style.transform = '';
            draggingPanel = null;
            return;
        }
        const handled = finishSwipe(e.clientX, e.clientY);
        if (!handled) handleTap(e);
    });

    function finishSwipe(endX, endY) {
        if (!swipeMoved) return false;
        const dx = endX - swipeStartX;
        const velocity = Math.abs(dx) / Math.max(1, Date.now() - swipeStartTime);
        if (panel) return false;
        if (swipeStartX < EDGE_ZONE && (dx > SWIPE_THRESHOLD || (dx > EDGE_ZONE && velocity > VELOCITY_THRESHOLD))) { openPanel('info'); return true; }
        if (swipeStartX > window.innerWidth - EDGE_ZONE && (dx < -SWIPE_THRESHOLD || (dx < -EDGE_ZONE && velocity > VELOCITY_THRESHOLD))) { openPanel('settings'); return true; }
        return false;
    }

    function handleTap(e) {
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest('.v-delete') || target.closest('.v-compress') ||
            target.closest('.cancel-btn') || target.closest('.speed-btn') ||
            target.closest('.modal') || target.closest('.side-panel')) return;

        if (panel) { closePanel(); return; }

        const item = target.closest('.video-item');
        if (!item) return;
        const domIdx = Array.prototype.indexOf.call(feed.children, item);
        const idx = videos.length ? domIdx % videos.length : domIdx;
        if (idx === activeIndex) { playing = !playing; updatePlayback(); }
    }

    ['pointermove', 'wheel', 'scroll', 'touchmove', 'keydown'].forEach((ev) => {
        document.addEventListener(ev, function first() { updatePlayback(); }, { once: true, passive: true });
    });

    panelMask.addEventListener('click', closePanel);

    // Speed selector
    speedOptions.addEventListener('click', (e) => {
        const btn = e.target.closest('.speed-btn');
        if (!btn) return;
        playbackSpeed = parseFloat(btn.dataset.speed);
        speedOptions.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (!panel) applyPlaybackEffect(playbackSpeed, false);
    });

    window.addEventListener('resize', () => { if (videos.length) scrollToIndex(activeIndex); });

    // ---------------------------------------------------------------- upload
    async function computeFileHash(file, onProgress) {
        if (crypto.subtle) { try { const buf = await file.arrayBuffer(); const d = await crypto.subtle.digest('SHA-256', buf); if (onProgress) onProgress(100); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2,'0')).join(''); } catch(e) {} }
        const ctx = createSha256();
        const SLICE = 8 * 1024 * 1024;
        let processed = 0;
        for (let start = 0; start < file.size; start += SLICE) {
            const buf = await file.slice(start, Math.min(file.size, start + SLICE)).arrayBuffer();
            ctx.update(new Uint8Array(buf));
            processed += buf.byteLength;
            if (onProgress) onProgress(Math.round((processed / file.size) * 100));
        }
        return ctx.digestHex();
    }

    async function uploadFile(file) {
        if (currentAbort) { currentAbort.abort(); currentAbort = null; }
        currentAbort = new AbortController();
        progressArea.classList.remove('hidden');
        progressTitle.textContent = file.name;
        progressFill.style.width = '0%';
        progressText.textContent = '0%';

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        let hash = '', pct = 0;

        try {
            progressText.textContent = '计算文件哈希…';
            hash = await computeFileHash(file, (p) => {
                const hp = Math.round(p * 0.05);
                if (hp !== pct) { pct = hp; progressText.textContent = '哈希 ' + hp + '%'; }
            });

            progressText.textContent = '正在连接…';
            const init = await jsonFetch('/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, size: file.size, hash, chunkSize: CHUNK_SIZE, totalChunks }),
                signal: currentAbort.signal
            });

            if (init.skip) {
                progressFill.style.width = '100%'; progressText.textContent = '100%  秒传成功！';
                await sleep(800); uploadModal.classList.add('hidden'); await loadFeed(); return;
            }

            const { uploadId, uploaded = [] } = init;
            const remaining = [];
            for (let i = 0; i < totalChunks; i++) if (!uploaded.includes(i)) remaining.push(i);

            for (let i = 0; i < remaining.length; i++) {
                const idx = remaining[i];
                const start = idx * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const uploadPct = Math.round((i / remaining.length) * 90) + 5;
                progressText.textContent = '上传中 ' + uploadPct + '%  (' + (i+1) + '/' + remaining.length + ' 分片)';
                progressFill.style.width = uploadPct + '%';
                await fetch('/upload/chunk/' + uploadId + '/' + idx, { method: 'PUT', body: file.slice(start, end), signal: currentAbort.signal });
            }

            progressText.textContent = '完成中…'; progressFill.style.width = '98%';
            await jsonFetch('/upload/complete/' + uploadId, { method: 'POST', signal: currentAbort.signal });
            progressFill.style.width = '100%'; progressText.textContent = '完成！';
            await sleep(500); uploadModal.classList.add('hidden'); await loadFeed();
        } catch (err) {
            if (err.name === 'AbortError') progressText.textContent = '已取消';
            else { progressText.textContent = '失败: ' + err.message; alert('上传失败：' + err.message); }
        } finally { currentAbort = null; }
    }

    async function compressVideo(file, onProgress) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.muted = true; video.preload = 'auto';
            const url = URL.createObjectURL(file);
            let chunks = [];
            video.onloadedmetadata = () => {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 1280; canvas.height = video.videoHeight || 720;
                const ctx = canvas.getContext('2d');
                const stream = canvas.captureStream(30);
                const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 3000000 });
                mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                mediaRecorder.onstop = () => { const blob = new Blob(chunks, { type: 'video/webm' }); URL.revokeObjectURL(url); resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webm'), { type: 'video/webm' })); };
                video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('视频解码失败')); };
                video.play(); mediaRecorder.start(100);
                const drawFrame = () => {
                    if (mediaRecorder.state === 'recording') { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); if (onProgress && video.duration) onProgress(Math.round((video.currentTime / video.duration) * 100)); requestAnimationFrame(drawFrame); }
                };
                video.onended = () => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); };
                drawFrame();
            };
            video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法加载视频')); };
            video.src = url;
        });
    }

    cancelBtn.addEventListener('click', () => { if (currentAbort) { currentAbort.abort(); currentAbort = null; } uploadModal.classList.add('hidden'); });
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); const file = e.dataTransfer.files[0]; if (file) handleUploadFile(file); });
    fileInput.addEventListener('change', () => { const file = fileInput.files[0]; if (file) handleUploadFile(file); fileInput.value = ''; });

    async function handleUploadFile(file) {
        const compressBefore = document.getElementById('compressBeforeUpload').checked;
        if (compressBefore) {
            try {
                progressArea.classList.remove('hidden');
                progressTitle.textContent = '压缩 ' + file.name + ' …';
                progressFill.style.width = '0%'; progressText.textContent = '0%';
                const compressed = await compressVideo(file, (p) => { progressText.textContent = '压缩中 ' + p + '%'; progressFill.style.width = Math.round(p * 0.7) + '%'; });
                progressText.textContent = '压缩完成，上传中…'; progressFill.style.width = '70%';
                await uploadFile(compressed);
            } catch (err) { alert('压缩失败：' + err.message + '\n改用直接上传。'); await uploadFile(file); }
        } else { await uploadFile(file); }
    }

    randomSwitch.addEventListener('change', () => { random = randomSwitch.checked; loadFeed(); });
    autoplaySwitch.addEventListener('change', () => { autoplay = autoplaySwitch.checked; if (autoplay && !playing) { playing = true; updatePlayback(); } });

    // ---------------------------------------------------------------- init
    loadFeed();

})();
