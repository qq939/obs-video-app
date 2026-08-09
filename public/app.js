(function () {
    'use strict';

    const CHUNK_SIZE = 2 * 1024 * 1024;
    // FEED_COPIES: ghost copies for infinite scroll illusion (3 = [ghost | real | ghost])
    const FEED_COPIES = 3;
    // WINDOW_SIZE: 固定11格播放窗口（前5+当前+后5），滑动后空缺随机填充
    const WINDOW_SIZE = 11;

    // ---------------------------------------------------------------- DOM refs
    const viewport = document.getElementById('viewport');
    const pagesEl = document.getElementById('pages');
    const feeds = [
        document.getElementById('feed0'),
        document.getElementById('mainFeed'),
        document.getElementById('feed2')
    ];
    const pageDot = document.getElementById('pageDot');
    const videoContainer = document.getElementById('videoContainer');
    const videoLabel = document.getElementById('videoLabel');
    const videoOverlayBtns = document.getElementById('videoOverlayBtns');
    const overlayCompress = document.getElementById('overlayCompress');
    const overlayDelete = document.getElementById('overlayDelete');
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
    const seekTrack = document.getElementById('seekTrack');
    const seekFill = document.getElementById('seekFill');
    const seekThumb = document.getElementById('seekThumb');
    const seekLabel = document.getElementById('seekLabel');
    const uploadModal = document.getElementById('uploadModal');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const progressArea = document.getElementById('progressArea');
    const progressTitle = document.getElementById('progressTitle');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const cancelBtn = document.getElementById('cancelBtn');
    const fabUpload = document.getElementById('fabUpload');

    // ---------------------------------------------------------------- state
    let videos = [];
    let activeIndex = 0;
    // playlistWindow: 固定11格「播放信息」队列（索引5=当前播放，0-4=前5，6-10=后5）
    // 每个元素为 {uuid, t} —— uuid 指向 videos[] 中的 name，t 为该视频当前播放进度（秒）
    // 上滑：每个位置从右侧邻居接收 (uuid, t)，最末格补随机 (uuid, t)
    // 下滑：每个位置从左侧邻居接收 (uuid, t)，最首格补随机 (uuid, t)
    let playlistWindow = [];
    let currentPage = 1;      // 0=info, 1=main, 2=settings
    let playing = true;
    let random = true;
    let autoplay = true;
    let playbackSpeed = 1.5;
    let currentAbort = null;
    let longPressTimer = null;
    let longPressMoved = false;
    const positions = new Map();

    // ──────────────────────────── playlist window（11格播放信息队列）────────────────────────
    // playlistWindow = 固定11格 (uuid, t) 队列。
    // 索引5 = 当前播放；0-4 = 前5；6-10 = 后5。
    // 上滑 shiftWindow(+1)：i 位置从 i+1 接收 (uuid, t)，索引10补随机
    // 下滑 shiftWindow(-1)：i 位置从 i-1 接收 (uuid, t)，索引0补随机
    // 随机补位：从 videos 随机选一个 uuid + 随机进度 t（0..duration）
    // 进度 t 的含义：该位置视频当时播放到的时间点；切换后会 seek 到该 t

    let _fillPool = [];  // 当前随机候选池（videos 数组）

    // 随机生成一个 (uuid, t) —— uuid 随机，t 在 duration 范围内随机
    function _makeRandomEntry() {
        if (videos.length === 0) return null;
        if (_fillPool.length === 0) {
            _fillPool = videos.slice();
            _shufflePool(_fillPool);
        }
        const v = _fillPool.pop();
        // 视频时长可能是 NaN/未知；保守取 [0, max(0, duration-0.5)]；未知时取 [0, 60)
        const dur = (v && Number.isFinite(v.duration)) ? v.duration : 60;
        const t = Math.max(0, Math.random() * Math.max(1, dur - 0.5));
        return { uuid: v ? v.name : null, t };
    }

    // 取一个随机 uuid 的视频对象（不消耗 _fillPool）
    function _randomVideo() {
        if (videos.length === 0) return null;
        return videos[Math.floor(Math.random() * videos.length)];
    }

    function _shufflePool(pool) {
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool;
    }

    function _makeFillPool() {
        // 候选池：videos 全集；_makeRandomEntry 自己从池中 pop（耗尽自动重新洗）
        _fillPool = videos.slice();
        _shufflePool(_fillPool);
    }

    function _nextFill() {
        if (_fillPool.length === 0) _makeFillPool();
        return _fillPool.pop() || null;
    }

    // 初始化队列：11 格 (uuid, t)；5 个前位、5 个后位都从 videos 随机选 + 随机 t；当前 = videos[activeIndex]，t = positions 缓存或 0
    function initPlaylistWindow() {
        if (videos.length === 0) { playlistWindow = []; _fillPool = []; syncAppState(); return; }
        const w = new Array(WINDOW_SIZE);
        // 前5格 (uuid, t) 随机
        for (let i = 0; i < 5; i++) w[i] = _makeRandomEntry();
        // 当前：videos[activeIndex] + 缓存或 0
        const cur = videos[activeIndex];
        w[5] = { uuid: cur ? cur.name : null, t: (cur && positions.get(cur.name)) || 0 };
        // 后5格 (uuid, t) 随机
        for (let i = 6; i < WINDOW_SIZE; i++) w[i] = _makeRandomEntry();
        playlistWindow = w;
        syncAppState();
    }

    // 上滑(+1)/下滑(-1)移动队列
    // 上滑：位置 i 从位置 i+1 接收 (uuid, t)，索引10补随机
    // 下滑：位置 i 从位置 i-1 接收 (uuid, t)，索引0补随机
    function shiftWindow(delta) {
        if (!delta || videos.length === 0 || playlistWindow.length !== WINDOW_SIZE) return;
        if (delta > 0) {
            // 上滑：左移。位置 i = 位置 i+1；末尾(10)补随机
            const next = new Array(WINDOW_SIZE);
            for (let i = 0; i < WINDOW_SIZE - 1; i++) next[i] = playlistWindow[i + 1];
            next[WINDOW_SIZE - 1] = _makeRandomEntry();
            playlistWindow = next;
        } else {
            // 下滑：右移。位置 i = 位置 i-1；开头(0)补随机
            const next = new Array(WINDOW_SIZE);
            for (let i = 1; i < WINDOW_SIZE; i++) next[i] = playlistWindow[i - 1];
            next[0] = _makeRandomEntry();
            playlistWindow = next;
        }
        // 同步 activeIndex 到 playlistWindow[5].uuid 在 videos 数组中的索引
        const curUuid = playlistWindow[5] && playlistWindow[5].uuid;
        if (curUuid) {
            const idx = videos.findIndex(v => v.name === curUuid);
            if (idx >= 0) activeIndex = idx;
        }
        syncAppState();
    }

    // 重建窗口使 videos[targetIdx] 在队列中间（索引5），其余随机；用于 applyIndex 跳转
    function setPlaylistWindow(targetIdx) {
        if (videos.length === 0) { playlistWindow = []; _fillPool = []; syncAppState(); return; }
        targetIdx = Math.max(0, Math.min(videos.length - 1, targetIdx));
        const w = new Array(WINDOW_SIZE);
        for (let i = 0; i < 5; i++) w[i] = _makeRandomEntry();
        const cur = videos[targetIdx];
        w[5] = { uuid: cur ? cur.name : null, t: (cur && positions.get(cur.name)) || 0 };
        for (let i = 6; i < WINDOW_SIZE; i++) w[i] = _makeRandomEntry();
        playlistWindow = w;
        activeIndex = targetIdx;
        syncAppState();
    }

    function syncAppState() {
        window._appState = {
            window: playlistWindow.map(v => v ? { uuid: v.uuid, t: v.t } : null),
            windowSize: playlistWindow.length,
        };
        window._allVideoNames = videos.map(v => v.name);
        window._playlistWindow = playlistWindow;
        window._activeIndex = activeIndex;
    }

    // ---------------------------------------------------------------- single video element (ONE instance only)
    const video = document.createElement('video');
    video.muted = false;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;';
    videoContainer.appendChild(video);

    // ---------------------------------------------------------------- HLS
    const _probe = document.createElement('video');
    const _canNativeHls = !!(_probe.canPlayType && _probe.canPlayType('application/vnd.apple.mpegurl'));
    const HAS_HLSJS = !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());
    const NATIVE_HLS = _canNativeHls && /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
    function hlsCapable(v) { return !!(v && v.hls && v.hlsReady) && (NATIVE_HLS || HAS_HLSJS); }
    let hlsInstance = null;

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
    // 秒数 -> 播放进度文案 (mm:ss / h:mm:ss)，供 seekLabel 使用
    function fmtClock(s) {
        if (!isFinite(s) || s < 0) s = 0;
        const total = Math.floor(s);
        const hh = Math.floor(total / 3600);
        const mm = Math.floor((total % 3600) / 60);
        const ss = total % 60;
        const pad = (x) => String(x).padStart(2, '0');
        return hh > 0 ? hh + ':' + pad(mm) + ':' + pad(ss) : mm + ':' + pad(ss);
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // Pure-JS SHA-256
    const SHA256_K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const SHA256_H0 = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];

    function createSha256() {
        const rotr = (x,n) => (x>>>n)|(x<<(32-n));
        const h = SHA256_H0.slice(); let buf = new Uint8Array(0), totalLen = 0;
        function compress(pad, off) {
            const w = new Uint32Array(64);
            for(let j=0;j<16;j++){const o=off+j*4;w[j]=(pad[o]<<24)|(pad[o+1]<<16)|(pad[o+2]<<8)|pad[o+3];}
            for(let j=16;j<64;j++){
                const s0=rotr(w[j-15],7)^rotr(w[j-15],18)^(w[j-15]>>>3);
                const s1=rotr(w[j-2],17)^rotr(w[j-2],19)^(w[j-2]>>>10);
                w[j]=(w[j-16]+s0+w[j-7]+s1)|0;
            }
            let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
            for(let j=0;j<64;j++){
                const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);
                const ch=(e&f)^(~e&g);
                const t1=(hh+S1+ch+SHA256_K[j]+w[j])|0;
                const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);
                const maj=(a&b)^(a&c)^(b&c);
                const t2=(S0+maj)|0;
                hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
            }
            h[0]=(h[0]+a)|0;h[1]=(h[1]+b)|0;h[2]=(h[2]+c)|0;h[3]=(h[3]+d)|0;
            h[4]=(h[4]+e)|0;h[5]=(h[5]+f)|0;h[6]=(h[6]+g)|0;h[7]=(h[7]+hh)|0;
        }
        return {
            update(chunk){
                totalLen+=chunk.length;
                if(buf.length>0){const c2=new Uint8Array(buf.length+chunk.length);c2.set(buf);c2.set(chunk,buf.length);buf=c2;}
                else buf=chunk;
                const full=Math.floor(buf.length/64)*64;
                for(let i=0;i<full;i+=64)compress(buf,i);
                buf=buf.slice(full);
            },
            digestHex(){
                const bitLen=totalLen*8,hi=Math.floor(bitLen/0x100000000),lo=bitLen>>>0;
                const rem=buf.length,padLen=rem<56?64-rem:128-rem;
                const pd=new Uint8Array(rem+padLen);pd.set(buf);pd[rem]=0x80;
                pd[pd.length-8]=(hi>>>24)&0xff;pd[pd.length-7]=(hi>>>16)&0xff;pd[pd.length-6]=(hi>>>8)&0xff;pd[pd.length-5]=hi&0xff;
                pd[pd.length-4]=(lo>>>24)&0xff;pd[pd.length-3]=(lo>>>16)&0xff;pd[pd.length-2]=(lo>>>8)&0xff;pd[pd.length-1]=lo&0xff;
                for(let i=0;i<pd.length;i+=64)compress(pd,i);
                let hex='';
                for(let i=0;i<8;i++)hex+=(h[i]>>>28&0xf).toString(16)+(h[i]>>>24&0xf).toString(16)+(h[i]>>>20&0xf).toString(16)+(h[i]>>>16&0xf).toString(16)+(h[i]>>>12&0xf).toString(16)+(h[i]>>>8&0xf).toString(16)+(h[i]>>>4&0xf).toString(16)+(h[i]&0xf).toString(16);
                return hex;
            }
        };
    }

    async function sha256(buffer) {
        if (crypto.subtle) { try { const d = await crypto.subtle.digest('SHA-256', buffer); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2,'0')).join(''); } catch(e) {} }
        const ctx = createSha256(); ctx.update(new Uint8Array(buffer)); return ctx.digestHex();
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

    // ---------------------------------------------------------------- page navigation
    function setPage(n) {
        n = Math.max(0, Math.min(2, n));
        if (n === currentPage) return;
        recordActivePosition();
        currentPage = n;
        viewport.dataset.page = n;
        pagesEl.style.setProperty('--page', n);
        buildPageDots();
        applyPagePlayback();
    }

    // ---------------------------------------------------------------- playback effect per page
    let effectTimer = null;

    function applyPagePlayback() {
        clearInterval(effectTimer);
        if (videos.length === 0) return;

        if (currentPage === 2) {
            // Settings page: 3x fast forward
            video.playbackRate = 3;
        } else if (currentPage === 0) {
            // Info page: 3x rewind via manual seek
            video.playbackRate = 1;
            effectTimer = setInterval(() => {
                if (currentPage !== 0 || videos.length === 0) { clearInterval(effectTimer); return; }
                video.currentTime = Math.max(0, video.currentTime - 0.3);
                if (video.currentTime <= 0) video.pause();
            }, 100);
        } else {
            // Main page: normal speed
            video.playbackRate = playbackSpeed;
        }
        updatePlayback();
    }

    // ---------------------------------------------------------------- render feed (placeholder items only — NO video elements)
    function renderFeeds() {
        feeds.forEach(f => { f.innerHTML = ''; });

        if (videos.length === 0) {
            feeds.forEach(f => { f.innerHTML = EMPTY_HTML; });
            videoLabel.textContent = '';
            video.src = '';
            destroyHls();
            updateInfo();
            playlistWindow = [];
            syncAppState();
            return;
        }

        initPlaylistWindow();  // 11 格 (uuid, t) 随机填充 + 当前 = videos[activeIndex]
        loadVideoForIndex(5);  // 中间格

        feeds.forEach(feed => {
            for (let c = 0; c < FEED_COPIES; c++) {
                playlistWindow.forEach((entry) => {
                    const item = document.createElement('div');
                    item.className = 'video-item';
                    item._vid = entry ? entry.uuid : null;  // video name for lookup
                    feed.appendChild(item);
                });
            }
        });

        activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, videos.length - 1)));
        feeds.forEach(f => scrollToIndex(f, 5));
        buildPageDots();
        loadVideoForIndex(5);
        updateInfo();
        feedReady = true;  // 初始化完成，启用 scroll handler
    }

    // ---------------------------------------------------------------- feed scroll
    // feed 渲染 playlistWindow × 3 副本（共 33 格）。中间副本的当前视频（窗口索引5）
    // 始终在 scrollTop = (playlistWindow.length + 5) * h = 16 * h（初始定位）。
    // 后续 scroll 由 vertAnimateTo 接管，applyIndex 不再调用 scrollToIndex。
    const MIDDLE_CURRENT_TOP = (WINDOW_SIZE + 5);
    function scrollToIndex(feed, idx) {
        if (videos.length === 0) { feed.scrollTop = 0; return; }
        feed._progScrollUntil = Date.now() + 60;
        feed.scrollTo({ top: MIDDLE_CURRENT_TOP * feed.clientHeight, behavior: 'instant' });
    }

    let feedReady = false;  // false=初始化期间，跳过 scroll handler 的 applyIndex

    feeds.forEach(feed => {
        feed.addEventListener('scroll', () => {
            if (videos.length === 0 || Date.now() < (feed._progScrollUntil || 0)) return;
            clearTimeout(feed._scrollTimer);
            feed._scrollTimer = setTimeout(() => {
                if (!feedReady) return;  // 初始化期间不响应
                const h = Math.max(1, feed.clientHeight);
                const n = playlistWindow.length;
                let vis = Math.round(feed.scrollTop / h);
                // 无限滚动副本跳转：只修正 scrollTop，不重建窗口（窗口重建由 vertAnimateTo 处理）
                if (vis < n) { feed._progScrollUntil = Date.now() + 60; feed.scrollTo({ top: (vis + n) * h, behavior: 'instant' }); return; }
                if (vis >= 2 * n) { feed._progScrollUntil = Date.now() + 60; feed.scrollTo({ top: (vis - n) * h, behavior: 'instant' }); return; }
            }, 120);
        });
    });

    function applyIndex(delta) {
        // delta: +1 上滑一步（队列左移）；-1 下滑一步（队列右移）
        if (!delta || videos.length === 0) return;
        recordActivePosition();
        shiftWindow(delta);
        playing = autoplay;
        loadVideoForIndex(5);  // playlistWindow 中间格
        updateInfo();
        updatePlayback();
    }

    // ---------------------------------------------------------------- single video player
    function loadVideoForIndex(idx) {
        if (videos.length === 0) return;
        // 当前视频来自 playlistWindow 中间格（索引5）的 (uuid, t)
        const entry = playlistWindow[5];
        if (!entry || !entry.uuid) return;
        const v = videos.find(x => x.name === entry.uuid) || videos[idx];
        if (!v) return;

        destroyHls();

        // Restore position: 优先取 playlistWindow 中的 t；其次 positions 缓存
        const seekT = entry.t || positions.get(v.name);
        if (seekT !== undefined && seekT > 0) {
            video._pendingSeek = seekT;
        }
        if (positions.has(v.name)) positions.delete(v.name);

        if (v.hls && v.hlsReady && hlsCapable(v)) {
            video.src = '';
            if (video.children.length) video.innerHTML = '';
            const sHls = document.createElement('source');
            sHls.src = v.hls; sHls.type = 'application/vnd.apple.mpegurl';
            video.appendChild(sHls);
            if (NATIVE_HLS) {
                video.src = v.hls;
            } else if (HAS_HLSJS) {
                attachHls(v);
            }
        } else {
            if (video.children.length) video.innerHTML = '';
            const sDirect = document.createElement('source');
            sDirect.src = v.url;
            const ext = (v.name.split('.').pop() || '').toLowerCase();
            sDirect.type = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'mkv' ? 'video/x-matroska' : ext === 'm4v' ? 'video/x-m4v' : ext === 'ogv' ? 'video/ogg' : 'video/mp4';
            video.appendChild(sDirect);
            video.src = v.url;
        }

        videoLabel.textContent = escapeHtml(v.name) + '  ·  ' + fmtSize(v.size);
        video.preload = 'metadata';
        applyPagePlayback();
    }

    function attachHls(v) {
        if (!window.Hls || !window.Hls.isSupported()) return;
        if (hlsInstance) { try { hlsInstance.destroy(); } catch(e){} hlsInstance = null; }
        hlsInstance = new window.Hls({ maxBufferLength: 30 });
        hlsInstance.loadSource(v.hls);
        hlsInstance.attachMedia(video);
        let netR = 0, medR = 0;
        hlsInstance.on(window.Hls.Events.ERROR, (evt, data) => {
            if (!data || !data.fatal) return;
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && netR < 1) { netR++; hlsInstance.startLoad(); }
            else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && medR < 1) { medR++; hlsInstance.recoverMediaError(); }
            else { destroyHls(); video.src = v.url; }
        });
    }

    function destroyHls() {
        if (hlsInstance) { try { hlsInstance.destroy(); } catch(e){} hlsInstance = null; }
    }

    function recordActivePosition() {
        if (videos.length === 0) return;
        const v = videos[activeIndex];
        if (!v) return;
        if (isFinite(video.currentTime) && video.currentTime > 0.5) positions.set(v.name, video.currentTime);
    }

    // ---------------------------------------------------------------- playback
    function updatePlayback() {
        if (videos.length === 0) return;

        const v = videos[activeIndex];
        const savedPos = v ? positions.get(v.name) : undefined;

        if (savedPos !== undefined && isFinite(video.duration)) {
            if (savedPos < video.duration - 0.3 && Math.abs(video.currentTime - savedPos) > 0.5) {
                video.currentTime = savedPos;
                positions.delete(v.name);
            }
        } else if (savedPos !== undefined && !video._pendingSeek) {
            video._pendingSeek = savedPos;
            positions.delete(v.name);
        }

        if (playing) {
            video.muted = false;
            const p = video.play();
            if (p && p.catch) p.catch(() => {
                // 自动播放策略拒绝：静音兜底继续播放，绝不中途暂停；
                // 声音在用户下一次手势触发 updatePlayback 时恢复
                video.muted = true;
                const p2 = video.play();
                if (p2 && p2.catch) p2.catch(() => {});
            });
        } else {
            video.pause();
        }
    }

    // Progress bar update
    setInterval(() => {
        if (videos.length === 0) return;
        if (video.duration && isFinite(video.duration) && video.duration > 0) {
            const pct = video.currentTime / video.duration;
            const pctStr = Math.round(pct * 100) + '%';
            infoProgress.textContent = pctStr;
            seekFill.style.width = pctStr;
            seekThumb.style.left = pctStr;
            seekLabel.textContent = fmtClock(video.currentTime) + ' / ' + fmtClock(video.duration);
        }
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

    // ---------------------------------------------------------------- page dots
    function buildPageDots() {
        pageDot.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const span = document.createElement('span');
            if (i === currentPage) span.className = 'on';
            pageDot.appendChild(span);
        }
    }

    // ---------------------------------------------------------------- load
    async function loadFeed() {
        const data = await jsonFetch('/videos');
        let list = data.videos || [];
        if (random) shuffle(list);
        videos = list;
        activeIndex = 0;
        positions.clear();
        renderFeeds();
    }

    // ---------------------------------------------------------------- gestures
    // 横向翻页阈值：相对视口 35%（最小 240px），视口 1280 时 = 448，避免左右滑动误翻页
    const SWIPE_THRESHOLD = Math.max(240, Math.round(window.innerWidth * 0.35));
    const DRAG_START = 12;          // 横向拖拽起步距离
    const AXIS_LOCK_DIST = 18;      // 位移超过该值后锁定主轴（斜向滑动防误判）
    const EDGE_ZONE = 60;
    const CLOSE_THRESHOLD = 80;
    const VELOCITY_THRESHOLD = 0.5; // px/ms：快速轻扫豁免横向阈值
    const LONG_PRESS_MS = 800;
    const PAGE_COUNT = 3;

    let swipeStartX = 0, swipeStartY = 0, swipeMoved = false;
    let verticalMoved = false;   // true if user scrolled vertically (skip tap)
    let swipeStartTime = 0;
    let axisLock = null;         // null | 'h' | 'v'：位移超过 AXIS_LOCK_DIST 后锁定主轴
    // Rubber-band resistance at page edges
    function dragOffset(dx) {
        if ((dx < 0 && currentPage < PAGE_COUNT - 1) || (dx > 0 && currentPage > 0)) return dx;
        return dx / 3;
    }

    // Live drag-follow: disable CSS transition so pages track finger 1:1
    function beginDrag(dx) {
        swipeMoved = true;
        pagesEl.style.transition = 'none';
        pagesEl.style.transform = 'translateX(calc(-1 * var(--page) * (100% / 3) + ' + dragOffset(dx) + 'px))';
    }

    // Resolve swipe end -> decide target page, animate back
    function finishSwipe(endX, endY) {
        if (!swipeMoved) return false;  // treat as tap
        const dx = endX - swipeStartX;
        const dy = endY - swipeStartY;
        // 快速轻扫（有意翻页）豁免：位移 ≥ 60% 阈值且速度 > VELOCITY_THRESHOLD 即翻页
        const dt = Math.max(1, Date.now() - swipeStartTime);
        const fast = Math.abs(dx) >= SWIPE_THRESHOLD * 0.6 && Math.abs(dx) / dt > VELOCITY_THRESHOLD;
        if (Math.abs(dx) < SWIPE_THRESHOLD && !fast) {
            pagesEl.style.transition = '';
            pagesEl.style.transform = '';
            return false;
        }
        const target = Math.max(0, Math.min(PAGE_COUNT - 1, dx < 0 ? currentPage + 1 : currentPage - 1));
        pagesEl.style.transform = '';            // clear inline so CSS var takes effect
        if (target !== currentPage) {
            recordActivePosition();
            currentPage = target;
        }
        viewport.dataset.page = currentPage;     // 与 setPage 保持状态同步
        pagesEl.style.setProperty('--page', currentPage);
        pagesEl.style.transition = '';
        buildPageDots();
        applyPagePlayback();
        return true;
    }

    // ---- Douyin-style vertical paging (finger-follow + snap-back animation) ----
    let vertStartY = 0, vertBaseTop = 0, vertAnim = null;

    function cancelVertAnim() {
        if (vertAnim) { cancelAnimationFrame(vertAnim.raf); vertAnim = null; }
    }

    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    // 跟手：视觉中心固定在 MIDDLE_CURRENT_TOP，手指拖动产生视觉偏移
    function vertFollow(dy) {
        const feed = feeds[1];
        if (videos.length === 0) return;
        feed._progScrollUntil = Date.now() + 120;
        feed.scrollTop = vertBaseTop - dy;
    }

    // 松手：dy<0 上滑→下一视频；dy>0 下滑→上一视频
    function vertRelease(dy) {
        const feed = feeds[1];
        const h = Math.max(1, feed.clientHeight);
        if (videos.length === 0) return;
        const moved = Math.abs(dy);
        const dt = Math.max(1, Date.now() - swipeStartTime);
        const vel = dy / dt;   // px/ms
        let delta = 0;
        if (dy < 0 && (moved > h * 0.25 || vel < -0.5)) delta = 1;    // 上滑
        else if (dy > 0 && (moved > h * 0.25 || vel > 0.5)) delta = -1; // 下滑
        if (delta === 0) {
            // 未超过阈值，回弹到中心
            vertAnimateTo(vertBaseTop);
            return;
        }
        const newTop = vertBaseTop - delta * h;
        vertAnimateTo(newTop, delta);
    }

    // 平滑吸附动画：rAF + easeOutCubic，结束时调用 applyIndex
    function vertAnimateTo(top, delta) {
        const feed = feeds[1];
        cancelVertAnim();
        let from = feed.scrollTop;
        if (Math.abs(from - top) < 1) { if (delta) applyIndex(delta); return; }
        feed.scrollTop = from + (top - from) * 0.02;
        from = feed.scrollTop;
        const dur = 380;
        feed._progScrollUntil = Date.now() + dur + 120;
        vertAnim = { from, to: top, delta, start: performance.now(), dur, raf: 0 };
        const step = (now) => {
            if (!vertAnim) return;
            const t = Math.min(1, (now - vertAnim.start) / vertAnim.dur);
            const v = easeOutCubic(t);
            feed.scrollTop = vertAnim.from + (vertAnim.to - vertAnim.from) * v;
            if (t < 1) {
                vertAnim.raf = requestAnimationFrame(step);
            } else {
                const d = vertAnim.delta;
                vertAnim = null;
                feed._progScrollUntil = Date.now() + 120;
                feed.scrollTop = MIDDLE_CURRENT_TOP * feed.clientHeight;
                if (d) applyIndex(d);
            }
        };
        vertAnim.raf = requestAnimationFrame(step);
    }

    // wheel：上下翻页（deltaY>0 上滑→下一视频，deltaY<0 下滑→上一视频）
    feeds[1].addEventListener('wheel', (e) => {
        if (playlistWindow.length === 0) return;
        e.preventDefault();
        if (vertAnim) return;
        const dir = e.deltaY > 0 ? 1 : -1;
        applyIndex(dir);
    }, { passive: false });

    // Treat tap on a side-panel page as "go back to main"
    function handleTap(e) {
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest('.speed-btn') || target.closest('.cancel-btn') ||
            target.closest('.modal') || target.closest('.side-panel') ||
            target.closest('.v-delete') || target.closest('.v-compress') ||
            target.closest('.switch') || target.closest('.upload-opt')) return;

        if (currentPage !== 1) { setPage(1); return; }

        // Long-press on main feed -> upload
        if (longPressTimer && !longPressMoved) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            uploadModal.classList.remove('hidden');
            progressArea.classList.add('hidden');
            return;
        }

        // Tap on video item —— 把点击位置映射到 playlistWindow 索引，再决定上下滑几步
        const item = target.closest('.video-item');
        if (!item) return;
        const domIdx = Array.prototype.indexOf.call(item.parentNode.children, item);
        const wn = playlistWindow.length;  // 11
        if (wn === 0) return;
        const winIdx = domIdx % wn;        // 0..10
        const center = 5;
        const delta = winIdx - center;     // +1..+5 上滑；-1..-5 下滑
        if (delta === 0) { playing = !playing; updatePlayback(); }
        else { applyIndex(delta); }
    }

    // ---- Touch ----
    // 长按视频=5倍速；长按空白=settings/feed 空白处=上传。区分方法：起点是否在 videoContainer 内
    function isOnVideo(clientX, clientY) {
        if (currentPage !== 1) return false;
        const el = document.elementFromPoint(clientX, clientY);
        return !!(el && el.closest && el.closest('#videoContainer'));
    }
    let fastSpeed = false;  // 长按 5 倍速期间为 true
    function beginFastSpeed() {
        if (fastSpeed) return;
        fastSpeed = true;
        video.playbackRate = 5;
    }
    function endFastSpeed() {
        if (!fastSpeed) return;
        fastSpeed = false;
        video.playbackRate = playbackSpeed;
    }

    viewport.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        swipeStartX = t.clientX; swipeStartY = t.clientY;
        swipeStartTime = Date.now(); swipeMoved = false;
        verticalMoved = false;
        axisLock = null;
        vertStartY = t.clientY;
        vertBaseTop = feeds[1].scrollTop;
        cancelVertAnim();
        longPressMoved = false;
        const onVideo = isOnVideo(t.clientX, t.clientY);
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            longPressMoved = true;
            if (onVideo) {
                // 长按视频 → 5 倍速
                beginFastSpeed();
            } else if (currentPage === 1) {
                uploadModal.classList.remove('hidden');
                progressArea.classList.add('hidden');
            }
        }, LONG_PRESS_MS);

        // Edge hints
        if (swipeStartX < EDGE_ZONE) edgeHintLeft.style.opacity = '1';
        if (swipeStartX > window.innerWidth - EDGE_ZONE) edgeHintRight.style.opacity = '1';
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        const dx = t.clientX - swipeStartX;
        const dy = t.clientY - swipeStartY;

        // Cancel long-press on any movement
        if (longPressTimer && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            clearTimeout(longPressTimer); longPressTimer = null;
        }

        // 方向锁定：首次显著位移后锁定主轴，后续只响应主轴（斜向/微抖不再误判）
        if (!axisLock && (Math.abs(dx) > AXIS_LOCK_DIST || Math.abs(dy) > AXIS_LOCK_DIST)) {
            axisLock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        }

        if (axisLock === 'h') {
            if (Math.abs(dx) > DRAG_START) beginDrag(dx);
            edgeHintLeft.style.opacity = '0'; edgeHintRight.style.opacity = '0';
        } else if (axisLock === 'v') {
            verticalMoved = true;
            vertFollow(dy);
            edgeHintLeft.style.opacity = '0'; edgeHintRight.style.opacity = '0';
        }
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        endFastSpeed();  // 松手恢复 1x 倍速（或用户设置的 playbackSpeed）
        const t = e.changedTouches[0];
        edgeHintLeft.style.opacity = '0'; edgeHintRight.style.opacity = '0';
        const dy = t.clientY - vertStartY;
        if (verticalMoved && Math.abs(dy) > 12) {   // 纵向手势松手 → 平滑吸附动画
            vertRelease(dy);
            return;
        }
        const handled = finishSwipe(t.clientX, t.clientY);
        if (!handled && !verticalMoved) handleTap(e);
    }, { passive: true });

    viewport.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        endFastSpeed();
    }, { passive: true });

    // ---- Mouse ----
    let mouseDown = false;
    viewport.addEventListener('mousedown', (e) => {
        mouseDown = true;
        swipeStartX = e.clientX; swipeStartY = e.clientY;
        swipeStartTime = Date.now(); swipeMoved = false;
        verticalMoved = false;
        axisLock = null;
        vertStartY = e.clientY;
        vertBaseTop = feeds[1].scrollTop;
        cancelVertAnim();
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (currentPage === 1) {
                uploadModal.classList.remove('hidden');
                progressArea.classList.add('hidden');
            }
        }, LONG_PRESS_MS);
    });
    viewport.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - swipeStartX;
        const dy = e.clientY - swipeStartY;
        if (longPressTimer && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            clearTimeout(longPressTimer); longPressTimer = null;
        }
        // 方向锁定（与 touchmove 一致）
        if (!axisLock && (Math.abs(dx) > AXIS_LOCK_DIST || Math.abs(dy) > AXIS_LOCK_DIST)) {
            axisLock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        }
        if (axisLock === 'h') {
            if (Math.abs(dx) > DRAG_START) beginDrag(dx);
        } else if (axisLock === 'v') {
            verticalMoved = true; vertFollow(dy);
        }
    });
    viewport.addEventListener('mouseup', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (!mouseDown) return;
        mouseDown = false;
        const dy = e.clientY - vertStartY;
        if (verticalMoved && Math.abs(dy) > 12) {   // 纵向手势松手 → 平滑吸附动画
            vertRelease(dy);
            return;
        }
        if (!finishSwipe(e.clientX, e.clientY) && !verticalMoved) handleTap(e);
    });

    // First interaction unlocks audio
    ['pointermove','wheel','scroll','touchmove','keydown'].forEach(ev => {
        document.addEventListener(ev, function first() { updatePlayback(); }, { once: true, passive: true });
    });

    // Video metadata: restore pending seek
    video.addEventListener('loadedmetadata', () => {
        if (video._pendingSeek !== undefined && isFinite(video._pendingSeek) &&
            video._pendingSeek < video.duration - 0.3) {
            video.currentTime = video._pendingSeek;
        }
        video._pendingSeek = undefined;
    });

    // Seek bar drag (touch + mouse)
    let seekDragging = false;

    function doSeek(clientX) {
        if (videos.length === 0 || !seekTrack) return;
        const rect = seekTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (video.duration && isFinite(video.duration)) {
            video.currentTime = ratio * video.duration;
        }
    }

    seekTrack && seekTrack.addEventListener('touchstart', (e) => {
        seekDragging = true;
        doSeek(e.touches[0].clientX);
        e.stopPropagation();
    }, { passive: true });
    seekTrack && seekTrack.addEventListener('touchmove', (e) => {
        if (seekDragging) { doSeek(e.touches[0].clientX); e.stopPropagation(); }
    }, { passive: true });
    seekTrack && seekTrack.addEventListener('touchend', () => { seekDragging = false; }, { passive: true });
    seekTrack && seekTrack.addEventListener('mousedown', (e) => {
        seekDragging = true;
        doSeek(e.clientX);
        e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => { if (seekDragging) doSeek(e.clientX); });
    document.addEventListener('mouseup', () => { seekDragging = false; });

    // Speed selector
    speedOptions.addEventListener('click', (e) => {
        const btn = e.target.closest('.speed-btn');
        if (!btn) return;
        playbackSpeed = parseFloat(btn.dataset.speed);
        speedOptions.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (currentPage === 1) { video.playbackRate = playbackSpeed; }
    });

    // Overlay buttons (only shown on settings page)
    overlayCompress.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (videos.length === 0) return;
        const v = videos[activeIndex];
        if (!confirm('压缩 ' + v.name + ' ？\n将转为 H.264/MP4，体积更小、播放更流畅。')) return;
        overlayCompress.disabled = true; overlayCompress.textContent = '压缩中…';
        try {
            const r = await jsonFetch('/compress/' + encodeURIComponent(v.name), { method: 'POST' });
            alert(r.skipped ? '无需压缩（' + fmtSize(r.before) + '）。' : '压缩完成：' + fmtSize(r.before) + ' → ' + fmtSize(r.after) + '，节省 ' + r.savedPct + '%。');
            await loadFeed();
        } catch (err) { alert('压缩失败：' + err.message); overlayCompress.disabled = false; overlayCompress.textContent = '压缩'; }
    });

    overlayDelete.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (videos.length === 0) return;
        const v = videos[activeIndex];
        if (!confirm('删除 ' + v.name + ' ？')) return;
        try { await fetch(v.url, { method: 'DELETE' }); await loadFeed(); }
        catch (err) { alert('删除失败：' + err.message); }
    });

    window.addEventListener('resize', () => {
        feeds.forEach(f => { if (videos.length) scrollToIndex(f, activeIndex); });
    });

    // ---------------------------------------------------------------- upload
    async function computeFileHash(file, onProgress) {
        if (crypto.subtle) { try { const buf = await file.arrayBuffer(); const d = await crypto.subtle.digest('SHA-256', buf); if (onProgress) onProgress(100); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2,'0')).join(''); } catch(e) {} }
        const ctx = createSha256(); const SLICE = 8*1024*1024; let processed = 0;
        for (let start = 0; start < file.size; start += SLICE) {
            const buf = await file.slice(start, Math.min(file.size, start+SLICE)).arrayBuffer();
            ctx.update(new Uint8Array(buf));
            processed += buf.byteLength;
            if (onProgress) onProgress(Math.round(processed/file.size*100));
        }
        return ctx.digestHex();
    }

    async function uploadFile(file) {
        if (currentAbort) { currentAbort.abort(); currentAbort = null; }
        currentAbort = new AbortController();
        progressArea.classList.remove('hidden');
        progressTitle.textContent = file.name;
        progressFill.style.width = '0%'; progressText.textContent = '0%';
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
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({filename:file.name, size:file.size, hash, chunkSize:CHUNK_SIZE, totalChunks}),
                signal: currentAbort.signal
            });
            if (init.skip) {
                progressFill.style.width='100%'; progressText.textContent='100%  秒传成功！';
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
                await fetch('/upload/chunk/' + uploadId + '/' + idx, {method:'PUT', body:file.slice(start,end), signal:currentAbort.signal});
            }
            progressText.textContent='完成中…'; progressFill.style.width='98%';
            await jsonFetch('/upload/complete/' + uploadId, {method:'POST', signal:currentAbort.signal});
            progressFill.style.width='100%'; progressText.textContent='完成！';
            await sleep(500); uploadModal.classList.add('hidden'); await loadFeed();
        } catch (err) {
            if (err.name === 'AbortError') progressText.textContent = '已取消';
            else { progressText.textContent = '失败: ' + err.message; alert('上传失败：' + err.message); }
        } finally { currentAbort = null; }
    }

    async function compressVideo(file, onProgress) {
        return new Promise((resolve, reject) => {
            const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
            const url = URL.createObjectURL(file);
            let chunks = [];
            v.onloadedmetadata = () => {
                const c = document.createElement('canvas');
                c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
                const ctx = c.getContext('2d');
                const stream = c.captureStream(30);
                const mr = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9', videoBitsPerSecond:3000000});
                mr.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                mr.onstop = () => { const blob = new Blob(chunks, {type:'video/webm'}); URL.revokeObjectURL(url); resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webm'), {type:'video/webm'})); };
                v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('视频解码失败')); };
                v.play(); mr.start(100);
                const draw = () => { if (mr.state === 'recording') { ctx.drawImage(v,0,0,c.width,c.height); if (onProgress && v.duration) onProgress(Math.round(v.currentTime/v.duration*100)); requestAnimationFrame(draw); } };
                v.onended = () => { if (mr.state === 'recording') mr.stop(); };
                draw();
            };
            v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法加载视频')); };
            v.src = url;
        });
    }

    cancelBtn.addEventListener('click', () => { if (currentAbort) { currentAbort.abort(); currentAbort = null; } uploadModal.classList.add('hidden'); });
    // Floating upload button (right edge) — open upload modal without long-press
    if (fabUpload) {
        let fabDown = false;
        let fabMoved = false;
        const onFabClick = (e) => { e.stopPropagation(); uploadModal.classList.remove('hidden'); };
        fabUpload.addEventListener('click', onFabClick);
        // Don't trigger panel swipe when tapping the FAB
        fabUpload.addEventListener('touchstart', (e) => { fabDown = true; fabMoved = false; e.stopPropagation(); }, { passive: true });
        fabUpload.addEventListener('touchmove', (e) => { fabMoved = true; e.stopPropagation(); }, { passive: true });
        fabUpload.addEventListener('touchend', (e) => { if (fabDown && !fabMoved) { e.preventDefault(); e.stopPropagation(); onFabClick(e); } fabDown = false; });
        fabUpload.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) handleUploadFile(f); });
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) handleUploadFile(f); fileInput.value = ''; });

    async function handleUploadFile(file) {
        const cb = document.getElementById('compressBeforeUpload').checked;
        if (cb) {
            try {
                progressArea.classList.remove('hidden'); progressTitle.textContent = '压缩 ' + file.name + ' …';
                progressFill.style.width='0%'; progressText.textContent='0%';
                const c = await compressVideo(file, p => { progressText.textContent='压缩中 '+p+'%'; progressFill.style.width=Math.round(p*0.7)+'%'; });
                progressText.textContent='压缩完成，上传中…'; progressFill.style.width='70%';
                await uploadFile(c);
            } catch (err) { alert('压缩失败：'+err.message+'\n改用直接上传。'); await uploadFile(file); }
        } else { await uploadFile(file); }
    }

    // Settings switches
    randomSwitch.addEventListener('change', () => { random = randomSwitch.checked; loadFeed(); });
    autoplaySwitch.addEventListener('change', () => { autoplay = autoplaySwitch.checked; if (autoplay && !playing) { playing = true; updatePlayback(); } });

    // ---------------------------------------------------------------- init
    pagesEl.style.setProperty('--page', 1);
    loadFeed();

})();
