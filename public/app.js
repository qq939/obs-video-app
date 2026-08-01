(function () {
    'use strict';

    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
    const PAGE_COUNT = 3;

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
    let currentPage = 1;          // 0 = info panel, 1 = main feed, 2 = settings
    let playing = true;           // global play/pause
    let random = true;            // random switch (default on)
    let autoplay = true;          // autoplay switch (default on)
    let userInteracted = false;   // has the user tapped/clicked yet (for sound)
    let suppressScroll = false;   // guard against programmatic-scroll feedback
    let currentAbort = null;      // active upload AbortController

    const EMPTY_HTML =
        '<div class="empty-state">' +
        '<div class="empty-icon">🎬</div>' +
        '<p>还没有视频</p>' +
        '<p class="sub">右滑到设置页点击 + 上传</p>' +
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

    async function sha256(buffer) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
            videos.forEach((v) => feed.appendChild(createVideoItem(v)));
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
    function getFeedIndex(feed) {
        if (videos.length === 0) return 0;
        const idx = Math.round(feed.scrollTop / Math.max(1, feed.clientHeight));
        return Math.max(0, Math.min(videos.length - 1, idx));
    }

    function scrollToIndex(feed, idx) {
        feed.scrollTop = idx * feed.clientHeight;
    }

    function syncFeeds(sourceFeed) {
        suppressScroll = true;
        feeds.forEach((f) => {
            if (f !== sourceFeed) scrollToIndex(f, activeIndex);
        });
        setTimeout(() => { suppressScroll = false; }, 250);
    }

    feeds.forEach((feed) => {
        feed.addEventListener('scroll', () => {
            if (suppressScroll || videos.length === 0) return;
            clearTimeout(feed._scrollTimer);
            feed._scrollTimer = setTimeout(() => {
                const idx = getFeedIndex(feed);
                if (idx !== activeIndex) {
                    activeIndex = idx;
                    playing = autoplay;
                    syncFeeds(feed);
                    updateInfo();
                    updatePlayback();
                }
            }, 120);
        });
    });

    // ---------------------------------------------------------------- playback
    function updatePlayback() {
        if (videos.length === 0) return;
        feeds.forEach((feed, pi) => {
            const item = feed.children[activeIndex];
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

    // Keep the three copies of the active video aligned in time.
    setInterval(() => {
        if (videos.length === 0) return;
        const leaderFeed = feeds[currentPage];
        if (!leaderFeed) return;
        const leaderItem = leaderFeed.children[activeIndex];
        if (!leaderItem) return;
        const leader = leaderItem.querySelector('video');
        if (!leader) return;

        if (leader.duration && isFinite(leader.duration) && leader.duration > 0) {
            infoProgress.textContent = Math.round((leader.currentTime / leader.duration) * 100) + '%';
        }

        feeds.forEach((feed, pi) => {
            if (pi === currentPage) return;
            const item = feed.children[activeIndex];
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

    function handleTap(e) {
        userInteracted = true;
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest('.v-delete') || target.closest('.upload-btn') ||
            target.closest('.cancel-btn') || target.closest('.refresh-btn') ||
            target.closest('.modal')) return;
        const item = target.closest('.video-item');
        if (!item) return;
        const feed = item.parentNode;
        const idx = Array.prototype.indexOf.call(feed.children, item);
        if (idx === activeIndex) {
            playing = !playing;
            updatePlayback();
        }
    }

    function finishSwipe(endX, endY) {
        if (!swipeMoved) return false;   // treat as a tap
        const dx = endX - swipeStartX;
        const dy = endY - swipeStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
            if (dx < 0) setPage(currentPage + 1);   // swipe left -> next page
            else setPage(currentPage - 1);          // swipe right -> previous page
        }
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
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) swipeMoved = true;
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
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) swipeMoved = true;
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
    async function computeFileHash(file) {
        const buf = await file.arrayBuffer();
        return sha256(buf);
    }

    function setProgress(pct, cur, total) {
        progressFill.style.width = pct + '%';
        progressText.textContent = pct + '%  (' + cur + '/' + total + ' 分片)';
    }

    async function uploadFile(file) {
        const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        const hash = await computeFileHash(file);

        const controller = new AbortController();
        currentAbort = controller;
        progressArea.classList.remove('hidden');
        progressTitle.textContent = file.name;
        setProgress(0, 0, totalChunks);

        try {
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

            // 2. upload missing chunks (resume support)
            const done = new Set(init.uploaded || []);
            for (let i = 0; i < init.totalChunks; i++) {
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
                setProgress(Math.round(((i + 1) / init.totalChunks) * 100), i + 1, init.totalChunks);
            }

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
