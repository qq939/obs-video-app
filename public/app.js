(function () {
    'use strict';

    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
    const PAGE_COUNT = 3;
    // Each feed renders this many copies of the video list. The middle copy is
    // the "real" one; the leading/trailing ghost copies make up/down scrolling
    // endless by letting the user scroll one list-length past either end before
    // an invisible jump back to the middle copy (same real video, no visual
    // change). More copies would smooth very long flicks but cost DOM memory.
    const FEED_COPIES = 3;

    // ---------------------------------------------------------------- DOM refs
    const pagesEl = document.getElementById('pages');
    const viewport = document.getElementById('viewport');
    const feeds = [
        document.querySelector('[data-feed="0"]'),
        document.querySelector('[data-feed="1"]'),
        document.querySelector('[data-feed="2"]')
    ];
    const pageDot = document.getElementById('pageDot');
    const infoName = document.getElementById('infoName');
    const infoSize = document.getElementById('infoSize');
    const infoTime = document.getElementById('infoTime');
    const infoProgress = document.getElementById('infoProgress');
    const infoIndex = document.getElementById('infoIndex');
    const videoCount = document.getElementById('videoCount');
    const randomSwitch = document.getElementById('randomSwitch');
    const autoplaySwitch = document.getElementById('autoplaySwitch');
    const refreshBtn = document.getElementById('refreshBtn');
    const uploadBtn = document.getElementById('uploadBtn');
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
    let currentPage = 1;          // 0 = info, 1 = main feed, 2 = settings
    let playing = true;           // global play/pause
    let random = true;            // random switch (default on)
    let autoplay = true;          // autoplay switch (default on)
    let userInteracted = false;   // has the user tapped/clicked yet (for sound)
    let currentAbort = null;      // active upload AbortController

    const EMPTY_HTML =
        '<div class="empty-state">' +
        '<div class="empty-icon">🎬</div>' +
        '<p>还没有视频</p>' +
        '<p class="sub">左滑到设置页点击 + 上传</p>' +
        '</div>';

    // ---------------------------------------------------------------- utils
    function fmtSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function fmtClock(sec) {
        if (!Number.isFinite(sec)) return '0:00';
        const s = Math.floor(sec);
        const m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
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

    // Pure-JS SHA-256 fallback. WebCrypto (crypto.subtle) is only available in
    // secure contexts (HTTPS or localhost); when the app is reached via a LAN
    // IP over plain HTTP, crypto.subtle is undefined, so we fall back to this.
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

    // Streaming SHA-256 context: lets us hash a large file in slices (8MB at a
    // time) instead of loading the whole file into memory, and report progress.
    function createSha256() {
        const rotr = (x, n) => (x >>> n) | (x << (32 - n));
        const h = SHA256_H0.slice();
        let buf = new Uint8Array(0);   // leftover partial block (< 64 bytes)
        let totalLen = 0;

        function compress(padded, offset) {
            const w = new Uint32Array(64);
            for (let j = 0; j < 16; j++) {
                const o = offset + j * 4;
                w[j] = (padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3];
            }
            for (let j = 16; j < 64; j++) {
                const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
                const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
            }
            let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (let j = 0; j < 64; j++) {
                const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                const ch = (e & f) ^ (~e & g);
                const t1 = (hh + S1 + ch + SHA256_K[j] + w[j]) | 0;
                const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (S0 + maj) | 0;
                hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
            h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
        }

        return {
            update(chunk) {
                totalLen += chunk.length;
                if (buf.length > 0) {
                    const combined = new Uint8Array(buf.length + chunk.length);
                    combined.set(buf);
                    combined.set(chunk, buf.length);
                    buf = combined;
                } else {
                    buf = chunk;
                }
                const fullLen = Math.floor(buf.length / 64) * 64;
                for (let i = 0; i < fullLen; i += 64) compress(buf, i);
                buf = buf.slice(fullLen);
            },
            digestHex() {
                const bitLen = totalLen * 8;
                const bitLenHi = Math.floor(bitLen / 0x100000000);
                const bitLenLo = bitLen >>> 0;
                const rem = buf.length;
                const padLen = rem < 56 ? 64 - rem : 128 - rem;
                const padded = new Uint8Array(rem + padLen);
                padded.set(buf);
                padded[rem] = 0x80;
                padded[padded.length - 8] = (bitLenHi >>> 24) & 0xff;
                padded[padded.length - 7] = (bitLenHi >>> 16) & 0xff;
                padded[padded.length - 6] = (bitLenHi >>> 8) & 0xff;
                padded[padded.length - 5] = bitLenHi & 0xff;
                padded[padded.length - 4] = (bitLenLo >>> 24) & 0xff;
                padded[padded.length - 3] = (bitLenLo >>> 16) & 0xff;
                padded[padded.length - 2] = (bitLenLo >>> 8) & 0xff;
                padded[padded.length - 1] = bitLenLo & 0xff;
                for (let i = 0; i < padded.length; i += 64) compress(padded, i);
                let hex = '';
                for (let i = 0; i < 8; i++) {
                    hex += (h[i] >>> 28 & 0xf).toString(16) + (h[i] >>> 24 & 0xf).toString(16) +
                        (h[i] >>> 20 & 0xf).toString(16) + (h[i] >>> 16 & 0xf).toString(16) +
                        (h[i] >>> 12 & 0xf).toString(16) + (h[i] >>> 8 & 0xf).toString(16) +
                        (h[i] >>> 4 & 0xf).toString(16) + (h[i] & 0xf).toString(16);
                }
                return hex;
            }
        };
    }

    function sha256Hex(bytes) {
        const ctx = createSha256();
        ctx.update(bytes);
        return ctx.digestHex();
    }

    async function sha256(buffer) {
        if (crypto.subtle) {
            try {
                const digest = await crypto.subtle.digest('SHA-256', buffer);
                return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
            } catch (e) { /* fall through to pure JS */ }
        }
        return sha256Hex(new Uint8Array(buffer));
    }

    async function jsonFetch(url, opts) {
        const res = await fetch(url, opts);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!res.ok) {
            throw new Error(data.error || data.raw || ('HTTP ' + res.status));
        }
        return data;
    }

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ---------------------------------------------------------------- render
    function createVideoItem(v) {
        const item = document.createElement('div');
        item.className = 'video-item';

        const video = document.createElement('video');
        video.src = v.url;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        item.appendChild(video);

        const label = document.createElement('div');
        label.className = 'v-label';
        label.textContent = escapeHtml(v.name) + '  ·  ' + fmtSize(v.size);
        item.appendChild(label);

        const comp = document.createElement('button');
        comp.className = 'v-compress';
        comp.textContent = '压缩';
        comp.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!confirm('压缩 ' + v.name + ' ？\n将转为 H.264/MP4，体积更小、播放更流畅。')) return;
            comp.disabled = true;
            comp.textContent = '压缩中…';
            try {
                const r = await jsonFetch('/compress/' + encodeURIComponent(v.name), { method: 'POST' });
                if (r.skipped) {
                    alert('无需压缩：原视频已经很紧凑（' + fmtSize(r.before) + '）。');
                } else {
                    alert('压缩完成：' + fmtSize(r.before) + ' → ' + fmtSize(r.after) +
                        '，节省 ' + r.savedPct + '%。');
                }
                await loadFeed();
            } catch (err) {
                alert('压缩失败：' + err.message);
                comp.disabled = false;
                comp.textContent = '压缩';
            }
        });
        item.appendChild(comp);

        const del = document.createElement('button');
        del.className = 'v-delete';
        del.textContent = '删除';
        del.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (!confirm('删除 ' + v.name + ' ？')) return;
            try {
                await fetch(v.url, { method: 'DELETE' });
                await loadFeed();
            } catch (err) {
                alert('删除失败：' + err.message);
            }
        });
        item.appendChild(del);

        return item;
    }

    function renderFeeds() {
        feeds.forEach((feed) => {
            feed.innerHTML = '';
            if (videos.length === 0) {
                feed.innerHTML = EMPTY_HTML;
                return;
            }
            for (let c = 0; c < FEED_COPIES; c++) {
                videos.forEach((v) => feed.appendChild(createVideoItem(v)));
            }
        });

        activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, videos.length - 1)));
        feeds.forEach((f) => scrollToIndex(f, activeIndex));
        buildPageDots();
        updateInfo();
        updatePlayback();
    }

    function buildPageDots() {
        pageDot.innerHTML = '';
        for (let i = 0; i < PAGE_COUNT; i++) {
            const span = document.createElement('span');
            if (i === currentPage) span.className = 'on';
            pageDot.appendChild(span);
        }
    }

    // ---------------------------------------------------------------- feed
    // The feed scrolls over FEED_COPIES * videos.length items. The middle copy
    // is at indices [n, 2n). Scroll positions in the ghost copies are mapped
    // back to the middle so the wrap is invisible (same real video on screen).
    function scrollToIndex(feed, idx) {
        if (videos.length === 0) { feed.scrollTop = 0; return; }
        // Mark this feed as programmatically scrolled for a short window so the
        // scroll event it fires is ignored (only that feed, and only briefly —
        // a user scrolling the source feed right after must still be handled).
        feed._progScrollUntil = Date.now() + 60;
        feed.scrollTop = (videos.length + idx) * feed.clientHeight;
    }

    function syncFeeds(sourceFeed) {
        feeds.forEach((f) => {
            if (f !== sourceFeed) scrollToIndex(f, activeIndex);
        });
    }

    // Update activeIndex to a real video index and propagate. Guards against
    // out-of-range values (e.g. from the empty state) and no-ops if unchanged.
    function applyIndex(idx, sourceFeed) {
        idx = Math.max(0, Math.min(videos.length - 1, idx));
        if (idx === activeIndex) return;
        activeIndex = idx;
        playing = autoplay;
        syncFeeds(sourceFeed);
        updateInfo();
        updatePlayback();
    }

    feeds.forEach((feed) => {
        feed.addEventListener('scroll', () => {
            // Ignore the scroll burst caused by our own scrollToIndex() on this
            // feed (60ms window). User scrolls of ANY feed are always handled.
            if (videos.length === 0 || Date.now() < (feed._progScrollUntil || 0)) return;
            clearTimeout(feed._scrollTimer);
            feed._scrollTimer = setTimeout(() => {
                const h = Math.max(1, feed.clientHeight);
                const n = videos.length;
                let vis = Math.round(feed.scrollTop / h);
                if (vis < n) {
                    // Entered the leading ghost copy: jump forward one full list
                    // to the same real video in the middle copy (no visual jump).
                    feed._progScrollUntil = Date.now() + 60;
                    feed.scrollTop = (vis + n) * h;
                    applyIndex(vis, feed);              // real index = vis
                    return;
                }
                if (vis >= 2 * n) {
                    // Entered the trailing ghost copy: jump back one full list.
                    feed._progScrollUntil = Date.now() + 60;
                    feed.scrollTop = (vis - n) * h;
                    applyIndex(vis - 2 * n, feed);      // real index = vis - 2n
                    return;
                }
                applyIndex(vis - n, feed);              // middle copy
            }, 120);
        });
    });

    // ---------------------------------------------------------------- playback
    // Control the active video in the middle copy of each feed. The ghost
    // copies are only on screen during a wrap transition (a brief moment while
    // scrolling through them), so the middle copy is the canonical one; the
    // 500ms sync below keeps every feed's middle copy aligned in time.
    function updatePlayback() {
        if (videos.length === 0) return;
        feeds.forEach((feed, pi) => {
            const item = feed.children[videos.length + activeIndex];
            if (!item) return;
            const video = item.querySelector('video');
            if (!video) return;
            if (playing) {
                const p = video.play();
                if (p && p.catch) p.catch(() => {});
                // Only the visible page's active video may have sound.
                video.muted = !(pi === currentPage && userInteracted);
            } else {
                video.pause();
            }
        });
    }

    // Keep the three feeds' copies of the active video aligned in time.
    setInterval(() => {
        if (videos.length === 0) return;
        const leaderFeed = feeds[currentPage];
        if (!leaderFeed) return;
        const leaderItem = leaderFeed.children[videos.length + activeIndex];
        if (!leaderItem) return;
        const leader = leaderItem.querySelector('video');
        if (!leader) return;

        if (leader.duration && isFinite(leader.duration) && leader.duration > 0) {
            infoProgress.textContent = Math.round((leader.currentTime / leader.duration) * 100) + '%';
        }

        feeds.forEach((feed, pi) => {
            if (pi === currentPage) return;
            const item = feed.children[videos.length + activeIndex];
            if (!item) return;
            const v = item.querySelector('video');
            if (!v) return;
            if (Math.abs(v.currentTime - leader.currentTime) > 0.4) {
                v.currentTime = leader.currentTime;
            }
        });
    }, 500);

    // ---------------------------------------------------------------- info/settings
    function updateInfo() {
        if (videos.length === 0) {
            infoName.textContent = '-';
            infoSize.textContent = '-';
            infoTime.textContent = '-';
            infoProgress.textContent = '0%';
            infoIndex.textContent = '-';
            videoCount.textContent = '0';
            return;
        }
        const v = videos[activeIndex];
        infoName.textContent = v.name;
        infoSize.textContent = fmtSize(v.size);
        infoTime.textContent = formatTime(v.mtime);
        infoIndex.textContent = (activeIndex + 1) + ' / ' + videos.length;
        videoCount.textContent = videos.length;
    }

    // ---------------------------------------------------------------- pages
    function setPage(n) {
        n = Math.max(0, Math.min(PAGE_COUNT - 1, n));
        if (n === currentPage) return;
        currentPage = n;
        pagesEl.style.setProperty('--page', n);
        buildPageDots();
        updatePlayback();
    }

    // ---------------------------------------------------------------- load
    async function loadFeed() {
        const data = await jsonFetch('/videos');
        let list = data.videos || [];
        if (random) shuffle(list);      // local re-shuffle on top of server shuffle
        videos = list;
        activeIndex = 0;
        renderFeeds();
    }

    // ---------------------------------------------------------------- gestures
    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeMoved = false;
    const SWIPE_THRESHOLD = 50;   // px of horizontal travel needed to change page
    const DRAG_START = 8;         // px of horizontal travel before drag-follow kicks in

    // Convert a finger delta into a translateX offset for .pages. When there is
    // no page in the dragged direction (edge), apply resistance so the content
    // does not fly off screen.
    function dragOffset(dx) {
        if ((dx < 0 && currentPage < PAGE_COUNT - 1) || (dx > 0 && currentPage > 0)) return dx;
        return dx / 3;
    }

    // Live drag-follow: while the finger moves, the pages container tracks it
    // 1:1. The CSS transition is disabled during the drag so there is no lag,
    // then re-enabled on release so the snap animation starts from the exact
    // on-screen position.
    function beginDrag(dx) {
        swipeMoved = true;
        pagesEl.style.transition = 'none';
        pagesEl.style.transform =
            'translateX(calc(-1 * var(--page) * (100% / 3) + ' + dragOffset(dx) + 'px))';
    }

    function handleTap(e) {
        userInteracted = true;
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest('.v-delete') || target.closest('.v-compress') ||
            target.closest('.upload-btn') ||
            target.closest('.cancel-btn') || target.closest('.refresh-btn') ||
            target.closest('.modal')) return;
        const item = target.closest('.video-item');
        if (!item) return;
        const feed = item.parentNode;
        // The feed contains FEED_COPIES copies; map the DOM index to the real
        // video index so taps work whichever copy the item lives in.
        const domIdx = Array.prototype.indexOf.call(feed.children, item);
        const idx = videos.length ? domIdx % videos.length : domIdx;
        if (currentPage !== 1) {
            // On a side-panel page (0=info, 2=settings) the video only fills a
            // partial width; tapping it returns to the middle pure-feed page
            // and resumes playback.
            playing = true;
            if (idx !== activeIndex) {
                activeIndex = idx;
                syncFeeds(feed);
            }
            setPage(1);
            return;
        }
        if (idx === activeIndex) {
            playing = !playing;
            updatePlayback();
        }
    }

    function finishSwipe(endX, endY) {
        if (!swipeMoved) return false;   // treat as a tap
        const dx = endX - swipeStartX;
        const dy = endY - swipeStartY;
        let target = currentPage;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
            // Standard drag-follow: content moves with the finger.
            // Left  -> next page (page 1 -> page 2 = settings)
            // Right -> previous page (page 1 -> page 0 = info)
            target = Math.max(0, Math.min(PAGE_COUNT - 1, dx < 0 ? currentPage + 1 : currentPage - 1));
        }
        // Re-enable the CSS transition, update the page base, then drop the
        // live drag offset so the element animates to the target page.
        pagesEl.style.transition = '';
        if (target !== currentPage) {
            currentPage = target;
            pagesEl.style.setProperty('--page', target);
            buildPageDots();
            updatePlayback();
        }
        pagesEl.style.transform = '';
        return true;
    }

    viewport.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        swipeStartX = t.clientX;
        swipeStartY = t.clientY;
        swipeMoved = false;
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;
        if (Math.abs(dx) > DRAG_START && Math.abs(dx) > Math.abs(dy)) beginDrag(dx);
        else if (Math.abs(dy) > 12) swipeMoved = true;   // vertical scroll: not a tap
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0];
        const handled = finishSwipe(t.clientX, t.clientY);
        if (!handled) handleTap(e);
    }, { passive: true });

    // Mouse support for desktop testing.
    let mouseDown = false;
    viewport.addEventListener('mousedown', (e) => {
        mouseDown = true;
        swipeStartX = e.clientX;
        swipeStartY = e.clientY;
        swipeMoved = false;
    });
    viewport.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - swipeStartX;
        const dy = e.clientY - swipeStartY;
        if (Math.abs(dx) > DRAG_START && Math.abs(dx) > Math.abs(dy)) beginDrag(dx);
        else if (Math.abs(dy) > 12) swipeMoved = true;
    });
    viewport.addEventListener('mouseup', (e) => {
        if (!mouseDown) return;
        mouseDown = false;
        const handled = finishSwipe(e.clientX, e.clientY);
        if (!handled) handleTap(e);
    });

    // First interaction -> allow sound on the active video.
    ['touchstart', 'click'].forEach((ev) => {
        document.addEventListener(ev, function first() {
            userInteracted = true;
            updatePlayback();
        }, { once: true, passive: true });
    });

    window.addEventListener('resize', () => {
        feeds.forEach((f) => scrollToIndex(f, activeIndex));
    });

    // ---------------------------------------------------------------- upload
    async function computeFileHash(file, onProgress) {
        // WebCrypto is fast and only needs the whole buffer in secure contexts.
        if (crypto.subtle) {
            try {
                const buf = await file.arrayBuffer();
                const digest = await crypto.subtle.digest('SHA-256', buf);
                if (onProgress) onProgress(100);
                return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
            } catch (e) { /* fall through to pure JS */ }
        }
        // Pure-JS streaming hash: slice the file so big videos are not loaded
        // into memory all at once, and report progress so the UI is responsive.
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

    function setProgress(pct, cur, total) {
        progressFill.style.width = pct + '%';
        progressText.textContent = pct + '%  (' + cur + '/' + total + ' 分片)';
    }

    async function uploadFile(file) {
        const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        const controller = new AbortController();
        currentAbort = controller;
        progressArea.classList.remove('hidden');
        progressTitle.textContent = file.name;
        setProgress(0, 0, totalChunks);

        try {
            // 0. sha256 first (needed for init dedup/resume + server verification).
            //    Show progress while hashing so a large file does not look frozen.
            const hash = await computeFileHash(file, (pct) => {
                progressFill.style.width = pct + '%';
                progressText.textContent = '计算校验值 ' + pct + '%';
            });
            setProgress(0, 0, totalChunks);
            progressTitle.textContent = file.name;

            // 1. init
            const init = await jsonFetch('/upload/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: file.name,
                    size: file.size,
                    hash,
                    chunkSize: CHUNK_SIZE,
                    totalChunks
                }),
                signal: controller.signal
            });

            if (init.skip) {
                setProgress(100, totalChunks, totalChunks);
                progressTitle.textContent = '已存在，跳过上传';
                await sleep(400);
                return;
            }

            // 2. upload missing chunks in parallel (resume support)
            const done = new Set(init.uploaded || []);
            const total = init.totalChunks;
            let uploaded = done.size;
            const CONCURRENCY = 4;
            let next = 0;
            async function worker() {
                while (next < total) {
                    const i = next++;
                    if (done.has(i)) continue;
                    const start = i * init.chunkSize;
                    const end = Math.min(file.size, start + init.chunkSize);
                    const chunk = file.slice(start, end);
                    const res = await fetch(`/upload/chunk/${init.uploadId}/${i}`, {
                        method: 'PUT',
                        body: chunk,
                        signal: controller.signal
                    });
                    if (!res.ok) throw new Error('chunk ' + i + ' failed: HTTP ' + res.status);
                    uploaded++;
                    setProgress(Math.round((uploaded / total) * 100), uploaded, total);
                }
            }
            const nWorkers = Math.min(CONCURRENCY, Math.max(1, total - done.size));
            await Promise.all(Array.from({ length: nWorkers }, () => worker()));

            // 3. complete
            const doneRes = await jsonFetch(`/upload/complete/${init.uploadId}`, {
                method: 'POST',
                signal: controller.signal
            });
            if (!doneRes.ok) throw new Error(doneRes.error || 'complete failed');
            setProgress(100, totalChunks, totalChunks);
            progressTitle.textContent = '上传完成';
        } finally {
            await sleep(500);
            progressArea.classList.add('hidden');
            currentAbort = null;
        }
    }

    async function startUpload(file) {
        try {
            await uploadFile(file);
            const compressOpt = document.getElementById('compressAfterUpload');
            if (compressOpt && compressOpt.checked) {
                progressArea.classList.remove('hidden');
                progressTitle.textContent = file.name + ' —— 压缩中…';
                progressFill.style.width = '100%';
                progressText.textContent = 'H.264 转码';
                try {
                    await jsonFetch('/compress/' + encodeURIComponent(file.name), { method: 'POST' });
                } catch (err) {
                    console.error('auto-compress failed:', err);
                }
                progressArea.classList.add('hidden');
            }
            await loadFeed();
            closeModal();
        } catch (err) {
            if (err.name !== 'AbortError') alert('上传失败：' + err.message);
        }
    }

    function openModal() {
        uploadModal.classList.remove('hidden');
        progressArea.classList.add('hidden');
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        progressTitle.textContent = '';
    }

    function closeModal() {
        uploadModal.classList.add('hidden');
    }

    uploadBtn.addEventListener('click', openModal);
    const uploadPanelBtn = document.getElementById('uploadPanelBtn');
    if (uploadPanelBtn) uploadPanelBtn.addEventListener('click', openModal);

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) startUpload(file);
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (file) startUpload(file);
    });

    cancelBtn.addEventListener('click', () => {
        if (currentAbort) currentAbort.abort();
        closeModal();
    });

    uploadModal.addEventListener('click', (e) => {
        if (e.target === uploadModal) closeModal();
    });

    // ---------------------------------------------------------------- settings
    refreshBtn.addEventListener('click', () => {
        loadFeed().catch((err) => alert('刷新失败：' + err.message));
    });

    randomSwitch.addEventListener('change', () => {
        random = randomSwitch.checked;
        loadFeed().catch((err) => alert('刷新失败：' + err.message));
    });

    autoplaySwitch.addEventListener('change', () => {
        autoplay = autoplaySwitch.checked;
        if (!autoplay) playing = false;
        else playing = true;
        updatePlayback();
    });

    // ---------------------------------------------------------------- init
    document.querySelectorAll('.page').forEach((pg) => {
        pg.dataset.active = pg.dataset.page;   // page 1 hides its side panel
    });
    pagesEl.style.setProperty('--page', currentPage);

    loadFeed().catch((err) => {
        console.error('loadFeed failed:', err);
        feeds.forEach((feed) => {
            feed.innerHTML = EMPTY_HTML;
        });
        updateInfo();
    });
})();
