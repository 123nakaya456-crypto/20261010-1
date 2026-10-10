/**
 * Astro-Target Diamond Finder App (v5.0)
 * 太陽・月 ＆ 目標物 重なり視点逆引きシミュレーター Main Application
 * - スタート初期目標: 剱岳, 富士山, 岐阜城
 * - 目標物 A のフリーキーワード地名検索 ＆ マイリスト登録保存機能
 * - 3点アライメント（新湊大橋 ✕ 岐阜城/剱岳/富士山 ✕ 太陽/月）年間絶景日時検索
 */

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('panorama-canvas');
    const engine = new TerrainEngine(canvas);
    const finderEngine = new FinderEngine();

    const STORAGE_MY_TARGETS = 'diamond_finder_my_targets';

    function getMyTargets() {
        try {
            const raw = localStorage.getItem(STORAGE_MY_TARGETS);
            return raw ? JSON.parse(raw) : [];
        } catch(e) { return []; }
    }

    function saveMyTargets(list) {
        try {
            localStorage.setItem(STORAGE_MY_TARGETS, JSON.stringify(list));
        } catch(e) {}
    }

    let activeCelestial = 'sun'; // 'sun' or 'moon'
    let currentTargetPeak = window.PEAKS_DATABASE.find(p => p.id === 'tsurugi') || window.PEAKS_DATABASE[0]; // スタート初期: 剱岳
    
    // マイ保存リストを合わせた全目標データベースの構築
    function getAllPeaks() {
        const myTargets = getMyTargets();
        const formattedMy = myTargets.map(item => ({
            id: `my_target_${item.id}`,
            name: `⭐ ${item.name}`,
            lat: item.lat,
            lng: item.lng,
            elev: item.elev,
            prefecture: item.prefecture || '登録地点',
            category: 'マイ目標'
        }));
        return [...formattedMy, ...window.PEAKS_DATABASE];
    }

    engine.peaks = getAllPeaks();
    engine.selectedTargetPeakId = currentTargetPeak.id;

    // 2D マップコントローラー
    let isSelectingMapForModal = false;

    const mapController = new MapController('leaflet-map', 
        // 視点ピン移動時 / タップ時
        (lat, lng) => {
            engine.camera.lat = lat;
            engine.camera.lng = lng;
            engine.locationName = `マップ選択地点 (${lat.toFixed(3)}°, ${lng.toFixed(3)}°)`;
            
            updateLocationInputs(lat, lng, engine.camera.elev, engine.camera.eyeHeight, engine.locationName);
            updateLocationDisplay(lat, lng, engine.camera.elev, engine.camera.eyeHeight, engine.locationName);
            
            if (currentTargetPeak && !isNaN(currentTargetPeak.lat) && !isNaN(currentTargetPeak.lng)) {
                const { bearing } = engine.calculateBearingAndDistance(lat, lng, currentTargetPeak.lat, currentTargetPeak.lng);
                engine.camera.azimuth = bearing;
                const sliderAz = document.getElementById('slider-azimuth');
                if (sliderAz) sliderAz.value = bearing;
                const valAz = document.getElementById('val-azimuth');
                if (valAz) valAz.textContent = `${Math.round(bearing)}°`;
            }

            mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
            engine.render();

            // モーダル用マップタップ選択時の復帰処理
            if (isSelectingMapForModal) {
                isSelectingMapForModal = false;
                const toast = document.getElementById('map-select-toast');
                if (toast) toast.style.display = 'none';

                openTripleModal();

                const selectObs = document.getElementById('modal-select-obs');
                if (selectObs) {
                    initObsDropdown('map_selected');
                    let mapGroup = selectObs.querySelector('optgroup[label="📍 2Dマップタップ選択視点"]');
                    if (!mapGroup) {
                        mapGroup = document.createElement('optgroup');
                        mapGroup.label = '📍 2Dマップタップ選択視点';
                        selectObs.insertBefore(mapGroup, selectObs.firstChild);
                    }
                    mapGroup.innerHTML = '';
                    const opt = document.createElement('option');
                    opt.value = 'map_selected';
                    opt.textContent = `📍 マップタップ選択視点 (${lat.toFixed(4)}°, ${lng.toFixed(4)}°)`;
                    opt.selected = true;
                    mapGroup.appendChild(opt);
                    selectObs.value = 'map_selected';
                }
            }
        },
        // 目標物ピン移動時
        (lat, lng) => {
            currentTargetPeak = {
                id: `custom_${Date.now()}`,
                name: 'マップ指示目標',
                lat, lng, elev: 200, category: 'カスタム'
            };
            engine.selectedTargetPeakId = currentTargetPeak.id;
            engine.peaks = engine.peaks.filter(p => !p.id.startsWith('custom_'));
            engine.peaks.push(currentTargetPeak);

            recalculateAlignment();
        }
    );

    function resizeCanvas() {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        engine.render();
    }
    window.addEventListener('resize', resizeCanvas);

    // ==========================================
    // 💎 逆引きアライメント計算＆マップ表示
    // ==========================================
    let recalcTimer = null;
    function recalculateAlignment() {
        if (!currentTargetPeak) return;
        if (recalcTimer) return;

        recalcTimer = requestAnimationFrame(() => {
            recalcTimer = null;
            const beamResult = finderEngine.calculateAlignmentBeam(currentTargetPeak, engine.activeDate, activeCelestial, engine.camera.elev || 100);
            if (!beamResult) return;

            mapController.updateAlignmentBeamOnMap(beamResult);
            mapController.updateTargetMarker(currentTargetPeak.lat, currentTargetPeak.lng);

            // スプリットマップ同期 (スプリット/2Dモード時)
            if (window._splitMapSync && (typeof currentViewMode !== 'undefined') && (currentViewMode === 'split' || currentViewMode === '2d')) {
                try {
                    window._splitMapSync.syncTarget(currentTargetPeak.lat, currentTargetPeak.lng);
                    if (beamResult.beamLinePoints && window._splitBeamPolyline) {
                        window._splitMapSync.map.removeLayer(window._splitBeamPolyline);
                    }
                    if (beamResult.beamLinePoints) {
                        const isSun = beamResult.celestialType === 'sun';
                        const latLngs = beamResult.beamLinePoints.map(p => [p.lat, p.lng]);
                        window._splitBeamPolyline = L.polyline(latLngs, {
                            color: isSun ? '#ff9100' : '#38bdf8',
                            weight: 4,
                            opacity: 0.85,
                            dashArray: '10, 6'
                        }).addTo(window._splitMapSync.map);
                    }
                } catch(e) {}
            }
            // ミニマップ同期
            if (window._miniMapSync && currentTargetPeak) {
                try { window._miniMapSync.syncTarget(currentTargetPeak.lat, currentTargetPeak.lng); } catch(e) {}
            }

            const celestialLabel = (activeCelestial === 'sun') ? '☀️ 太陽' : '🌙 月';
            const finderTitle = document.getElementById('finder-title-text');
            const finderDetail = document.getElementById('finder-detail-text');

            if (finderTitle) {
                finderTitle.innerHTML = `<i class="fa-solid fa-gem" style="color:#ffb703;"></i> 🎯 ${currentTargetPeak.name} ✕ ${celestialLabel} 重なり線`;
            }

            if (finderDetail) {
                const azStr = beamResult.astroPos.azimuth.toFixed(1);
                const altStr = beamResult.astroPos.altitude.toFixed(1);
                const statusWarn = beamResult.isBelowHorizon ? ' <span style="color:#f43f5e;">(地平線下)</span>' : '';
                const spotInfo = beamResult.bestDistanceKm ? ` | ⭐推奨視点距離: ${beamResult.bestDistanceKm.toFixed(1)}km` : '';
                finderDetail.innerHTML = `天体方位: ${azStr}° / 高度: ${altStr}°${statusWarn}${spotInfo}`;
            }

            if (isNaN(engine.camera.lat) || (engine.camera.lat === 35.6250 && engine.camera.lng === 139.2437)) {
                const usePt = beamResult.bestSpotPt || finderEngine.destinationPoint(currentTargetPeak.lat, currentTargetPeak.lng, 15, beamResult.reverseBearing);
                applyLocation(usePt.lat, usePt.lng, 500, 1.5, `${currentTargetPeak.name}ダイヤ観察点`);
                mapController.flyTo(usePt.lat, usePt.lng, 11);
            } else {
                const { bearing } = engine.calculateBearingAndDistance(engine.camera.lat, engine.camera.lng, currentTargetPeak.lat, currentTargetPeak.lng);
                engine.camera.azimuth = bearing;
                const sliderAz = document.getElementById('slider-azimuth');
                if (sliderAz) sliderAz.value = bearing;
                const valAz = document.getElementById('val-azimuth');
                if (valAz) valAz.textContent = `${Math.round(bearing)}°`;
                mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
                engine.render();
            }
        });
    }

    // ==========================================
    // 🔍 【目標物 A フリーキーワード検索 ＆ 登録保存】
    // ==========================================
    const targetPeakSelect = document.getElementById('target-peak-select');
    const modalSelectTarget = document.getElementById('modal-select-target');

    function initTargetDropdowns() {
        const allPeaks = getAllPeaks();
        const populate = (el) => {
            if (!el) return;
            el.innerHTML = '';

            const myGroup = allPeaks.filter(p => p.category === 'マイ目標');
            if (myGroup.length > 0) {
                const optMyGroup = document.createElement('optgroup');
                optMyGroup.label = '⭐ 保存したマイ目標物';
                myGroup.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = `${p.name} (${p.elev}m - ${p.prefecture})`;
                    if (p.id === currentTargetPeak.id) opt.selected = true;
                    optMyGroup.appendChild(opt);
                });
                el.appendChild(optMyGroup);
            }

            const startGroup = allPeaks.filter(p => p.category === 'スタート目標');
            const optStartGroup = document.createElement('optgroup');
            optStartGroup.label = '🚀 スタート初期目標 (剱岳・富士山・岐阜城)';
            startGroup.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `🎯 ${p.name} (${p.elev}m - ${p.prefecture})`;
                if (p.id === currentTargetPeak.id) opt.selected = true;
                optStartGroup.appendChild(opt);
            });
            el.appendChild(optStartGroup);

            const otherGroup = allPeaks.filter(p => p.category !== 'マイ目標' && p.category !== 'スタート目標');
            const optOtherGroup = document.createElement('optgroup');
            optOtherGroup.label = '⛰️ 全国主要目標・山岳';
            otherGroup.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `🎯 ${p.name} (${p.elev}m - ${p.prefecture})`;
                if (p.id === currentTargetPeak.id) opt.selected = true;
                optOtherGroup.appendChild(opt);
            });
            el.appendChild(optOtherGroup);
        };

        populate(targetPeakSelect);
        populate(modalSelectTarget);
    }
    initTargetDropdowns();

    if (targetPeakSelect) {
        targetPeakSelect.addEventListener('change', (e) => {
            const allPeaks = getAllPeaks();
            const found = allPeaks.find(p => p.id === e.target.value);
            if (found) {
                currentTargetPeak = found;
                engine.selectedTargetPeakId = found.id;
                recalculateAlignment();
            }
        });
    }

    // 地名・目標物フリー検索 (国土地理院 ＆ Nominatim)
    async function executeTargetGeoSearch(query, containerId = 'target-search-results') {
        if (!query.trim()) return;
        const resultsContainer = document.getElementById(containerId);
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">🔍 検索中...</span></div>';
        resultsContainer.classList.add('active');

        try {
            let items = [];
            try {
                const gsiRes = await fetch(`https://msearch.gsi.go.jp/address-search-api/AddressSearch?q=${encodeURIComponent(query)}`);
                if (gsiRes.ok) {
                    const gsiData = await gsiRes.json();
                    if (Array.isArray(gsiData) && gsiData.length > 0) {
                        items = gsiData.map(feat => ({
                            name: feat.properties.title,
                            lat: feat.geometry.coordinates[1],
                            lng: feat.geometry.coordinates[0],
                            source: '国土地理院'
                        }));
                    }
                }
            } catch (e) {}

            if (items.length < 3) {
                try {
                    const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=jp&limit=8`);
                    if (nomRes.ok) {
                        const nomData = await nomRes.json();
                        const nomItems = nomData.map(d => ({
                            name: d.display_name.split(',')[0],
                            lat: parseFloat(d.lat),
                            lng: parseFloat(d.lon),
                            source: d.type || '地図検索'
                        }));
                        items = [...items, ...nomItems];
                    }
                } catch (e) {}
            }

            if (items.length === 0) {
                resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">該当する目標物が見つかりませんでした</span></div>';
                return;
            }

            resultsContainer.innerHTML = '';
            items.slice(0, 8).forEach(item => {
                const div = document.createElement('div');
                div.className = 'search-item';
                div.innerHTML = `
                    <div class="search-item-title">🎯 ${item.name}</div>
                    <div class="search-item-sub">緯度: ${item.lat.toFixed(4)}° / 経度: ${item.lng.toFixed(4)}° (${item.source})</div>
                `;
                div.addEventListener('click', async () => {
                    resultsContainer.classList.remove('active');
                    let realElev = 100;
                    try { realElev = await engine.gsiDemProvider.fetchElevation(item.lat, item.lng); } catch (e) {}

                    currentTargetPeak = {
                        id: `search_${Date.now()}`,
                        name: item.name,
                        lat: item.lat,
                        lng: item.lng,
                        elev: Math.round(realElev || 100),
                        prefecture: '検索指定'
                    };

                    engine.peaks = engine.peaks.filter(p => !p.id.startsWith('search_'));
                    engine.peaks.push(currentTargetPeak);
                    engine.selectedTargetPeakId = currentTargetPeak.id;

                    initTargetDropdowns();
                    if (targetPeakSelect) targetPeakSelect.value = currentTargetPeak.id;
                    if (modalSelectTarget) modalSelectTarget.value = currentTargetPeak.id;

                    recalculateAlignment();
                });
                resultsContainer.appendChild(div);
            });
        } catch (e) {
            resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">検索エラーが発生しました</span></div>';
        }
    }

    const inputTargetSearch = document.getElementById('input-target-search');
    const btnTargetSearch = document.getElementById('btn-target-search');
    if (btnTargetSearch && inputTargetSearch) {
        btnTargetSearch.addEventListener('click', () => executeTargetGeoSearch(inputTargetSearch.value, 'target-search-results'));
        inputTargetSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeTargetGeoSearch(inputTargetSearch.value, 'target-search-results');
        });
    }

    const modalInputTargetSearch = document.getElementById('modal-input-target-search');
    const modalBtnTargetSearch = document.getElementById('modal-btn-target-search');
    if (modalBtnTargetSearch && modalInputTargetSearch) {
        modalBtnTargetSearch.addEventListener('click', () => executeTargetGeoSearch(modalInputTargetSearch.value, 'modal-target-search-results'));
        modalInputTargetSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeTargetGeoSearch(modalInputTargetSearch.value, 'modal-target-search-results');
        });
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#input-target-search') && !e.target.closest('#btn-target-search')) {
            const el = document.getElementById('target-search-results');
            if (el) el.classList.remove('active');
        }
        if (!e.target.closest('#modal-input-target-search') && !e.target.closest('#modal-btn-target-search')) {
            const el = document.getElementById('modal-target-search-results');
            if (el) el.classList.remove('active');
        }
    });

    // ⭐ 目標物をマイリストに登録保存する処理
    const btnSaveCustomTarget = document.getElementById('btn-save-custom-target');
    if (btnSaveCustomTarget) {
        btnSaveCustomTarget.addEventListener('click', () => {
            if (!currentTargetPeak) return;

            const myTargets = getMyTargets();
            const exists = myTargets.some(item => item.name === currentTargetPeak.name || (Math.abs(item.lat - currentTargetPeak.lat) < 0.001 && Math.abs(item.lng - currentTargetPeak.lng) < 0.001));

            if (exists) {
                alert(`「${currentTargetPeak.name}」は既にマイ目標物に登録されています！`);
                return;
            }

            const newTarget = {
                id: Date.now(),
                name: currentTargetPeak.name.replace('⭐ ', ''),
                lat: currentTargetPeak.lat,
                lng: currentTargetPeak.lng,
                elev: currentTargetPeak.elev,
                prefecture: currentTargetPeak.prefecture || '登録地点'
            };

            myTargets.push(newTarget);
            saveMyTargets(myTargets);

            engine.peaks = getAllPeaks();
            currentTargetPeak.id = `my_target_${newTarget.id}`;
            engine.selectedTargetPeakId = currentTargetPeak.id;

            initTargetDropdowns();
            alert(`⭐ 「${newTarget.name}」をマイ目標物に登録保存しました！`);
        });
    }

    // ⭐ 視点 B のマイリスト登録・保存処理 (LocalStorage)
    const STORAGE_MY_VIEWPOINTS = 'diamond_finder_my_viewpoints';
    function getMyViewpoints() {
        try {
            const raw = localStorage.getItem(STORAGE_MY_VIEWPOINTS);
            return raw ? JSON.parse(raw) : [];
        } catch(e) { return []; }
    }
    function saveMyViewpoints(list) {
        try { localStorage.setItem(STORAGE_MY_VIEWPOINTS, JSON.stringify(list)); } catch(e) {}
    }

    function initObsDropdown(selectedVal = '') {
        const selectObs = document.getElementById('modal-select-obs');
        if (!selectObs) return;
        selectObs.innerHTML = '';

        // 初期ブランク（未選択・指示プロンプト）
        const blankOpt = document.createElement('option');
        blankOpt.value = '';
        blankOpt.textContent = '-- 📍 視点 B を選択・地名検索・または2D地図から指定 --';
        if (!selectedVal) blankOpt.selected = true;
        selectObs.appendChild(blankOpt);

        // 2Dマップ直接タップ選択のショートカット
        const mapPickOpt = document.createElement('option');
        mapPickOpt.value = 'trigger_map_pick';
        mapPickOpt.textContent = '🗺️ 2D地図からタップして指定...';
        selectObs.appendChild(mapPickOpt);

        const defaultGroup = document.createElement('optgroup');
        defaultGroup.label = '📍 定番・基本視点 B';
        (window.VIEWPOINTS_DATABASE || []).forEach(vp => {
            const opt = document.createElement('option');
            opt.value = vp.id;
            opt.textContent = `📍 ${vp.name}`;
            if (selectedVal === vp.id) opt.selected = true;
            defaultGroup.appendChild(opt);
        });

        const currentOpt = document.createElement('option');
        currentOpt.value = 'current';
        currentOpt.textContent = '📍 GPS現在地';
        if (selectedVal === 'current') currentOpt.selected = true;
        defaultGroup.appendChild(currentOpt);

        selectObs.appendChild(defaultGroup);

        const myVps = getMyViewpoints();
        if (myVps.length > 0) {
            const myGroup = document.createElement('optgroup');
            myGroup.label = '⭐ 保存したマイ視点 B';
            myVps.forEach(vp => {
                const opt = document.createElement('option');
                opt.value = `my_vp_${vp.id}`;
                opt.textContent = `⭐ ${vp.name}`;
                if (selectedVal === `my_vp_${vp.id}`) opt.selected = true;
                myGroup.appendChild(opt);
            });
            selectObs.appendChild(myGroup);
        }
    }
    initObsDropdown('');

    const modalSelectObs = document.getElementById('modal-select-obs');
    if (modalSelectObs) {
        modalSelectObs.addEventListener('change', (e) => {
            if (e.target.value === 'trigger_map_pick') {
                startMapSelectionForModal();
            }
        });
    }

    // 視点 B 2Dマップタップ選択フロー制御
    function startMapSelectionForModal() {
        isSelectingMapForModal = true;
        closeTripleModal();

        const toast = document.getElementById('map-select-toast');
        if (toast) toast.style.display = 'flex';

        const mapEl = document.getElementById('leaflet-map');
        if (mapEl) {
            mapEl.scrollIntoView({ behavior: 'smooth' });
        }
    }

    function cancelMapSelectionForModal() {
        isSelectingMapForModal = false;
        const toast = document.getElementById('map-select-toast');
        if (toast) toast.style.display = 'none';
        openTripleModal();
    }

    const btnPickMapObs = document.getElementById('btn-pick-map-obs');
    const btnCancelMapSelect = document.getElementById('btn-cancel-map-select');
    if (btnPickMapObs) btnPickMapObs.addEventListener('click', startMapSelectionForModal);
    if (btnCancelMapSelect) btnCancelMapSelect.addEventListener('click', cancelMapSelectionForModal);

    // 視点 B フリー検索 (地名・住所)
    async function executeObsGeoSearch(query) {
        if (!query.trim()) return;
        const resultsContainer = document.getElementById('modal-obs-search-results');
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">🔍 視点地名を検索中...</span></div>';
        resultsContainer.classList.add('active');

        try {
            let items = [];
            try {
                const gsiRes = await fetch(`https://msearch.gsi.go.jp/address-search-api/AddressSearch?q=${encodeURIComponent(query)}`);
                if (gsiRes.ok) {
                    const gsiData = await gsiRes.json();
                    if (Array.isArray(gsiData) && gsiData.length > 0) {
                        items = gsiData.map(feat => ({
                            name: feat.properties.title,
                            lat: feat.geometry.coordinates[1],
                            lng: feat.geometry.coordinates[0],
                            source: '国土地理院'
                        }));
                    }
                }
            } catch (e) {}

            if (items.length < 3) {
                try {
                    const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=jp&limit=8`);
                    if (nomRes.ok) {
                        const nomData = await nomRes.json();
                        const nomItems = nomData.map(d => ({
                            name: d.display_name.split(',')[0],
                            lat: parseFloat(d.lat),
                            lng: parseFloat(d.lon),
                            source: d.type || '地図検索'
                        }));
                        items = [...items, ...nomItems];
                    }
                } catch (e) {}
            }

            if (items.length === 0) {
                resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">該当する視点が見つかりませんでした</span></div>';
                return;
            }

            resultsContainer.innerHTML = '';
            items.slice(0, 8).forEach(item => {
                const div = document.createElement('div');
                div.className = 'search-item';
                div.innerHTML = `
                    <div class="search-item-title">📍 ${item.name}</div>
                    <div class="search-item-sub">緯度: ${item.lat.toFixed(4)}° / 経度: ${item.lng.toFixed(4)}° (${item.source})</div>
                `;
                div.addEventListener('click', async () => {
                    resultsContainer.classList.remove('active');
                    let realElev = 10;
                    try { realElev = await engine.gsiDemProvider.fetchElevation(item.lat, item.lng); } catch (e) {}

                    const obsId = `search_obs_${Date.now()}`;
                    applyLocation(item.lat, item.lng, realElev, 1.5, item.name);
                    mapController.flyTo(item.lat, item.lng, 12);

                    initObsDropdown(obsId);
                    const selectObs = document.getElementById('modal-select-obs');
                    if (selectObs) {
                        let searchOptGroup = selectObs.querySelector('optgroup[label="🔍 検索指定視点 B"]');
                        if (!searchOptGroup) {
                            searchOptGroup = document.createElement('optgroup');
                            searchOptGroup.label = '🔍 検索指定視点 B';
                            selectObs.insertBefore(searchOptGroup, selectObs.firstChild);
                        }
                        searchOptGroup.innerHTML = '';
                        const opt = document.createElement('option');
                        opt.value = obsId;
                        opt.textContent = `📍 ${item.name}`;
                        opt.selected = true;
                        searchOptGroup.appendChild(opt);
                        selectObs.value = obsId;
                    }
                });
                resultsContainer.appendChild(div);
            });
        } catch (e) {
            resultsContainer.innerHTML = '<div class="search-item"><span class="search-item-sub">検索エラーが発生しました</span></div>';
        }
    }

    const modalInputObsSearch = document.getElementById('modal-input-obs-search');
    const modalBtnObsSearch = document.getElementById('modal-btn-obs-search');
    if (modalBtnObsSearch && modalInputObsSearch) {
        modalBtnObsSearch.addEventListener('click', () => executeObsGeoSearch(modalInputObsSearch.value));
        modalInputObsSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeObsGeoSearch(modalInputObsSearch.value);
        });
    }

    const btnToggleSaveObsForm = document.getElementById('btn-toggle-save-obs-form');
    const boxSaveObsForm = document.getElementById('box-save-obs-form');
    const btnSaveCustomObs = document.getElementById('btn-save-custom-obs');
    const inputSaveObsName = document.getElementById('input-save-obs-name');

    if (btnToggleSaveObsForm && boxSaveObsForm) {
        btnToggleSaveObsForm.addEventListener('click', () => {
            const currentDisp = boxSaveObsForm.style.display;
            boxSaveObsForm.style.display = (currentDisp === 'none' || !currentDisp) ? 'flex' : 'none';
        });
    }

    if (btnSaveCustomObs && inputSaveObsName) {
        btnSaveCustomObs.addEventListener('click', () => {
            const nameVal = inputSaveObsName.value.trim() || engine.locationName || 'マイ視点';
            const myVps = getMyViewpoints();

            const newVp = {
                id: Date.now(),
                name: nameVal,
                lat: engine.camera.lat,
                lng: engine.camera.lng,
                elev: engine.camera.elev || 0
            };

            myVps.push(newVp);
            saveMyViewpoints(myVps);
            initObsDropdown();

            const selectObs = document.getElementById('modal-select-obs');
            if (selectObs) selectObs.value = `my_vp_${newVp.id}`;

            boxSaveObsForm.style.display = 'none';
            inputSaveObsName.value = '';
            alert(`⭐ 視点 B 「${newVp.name}」をマイリストに登録保存しました！`);
        });
    }

    // ==========================================
    // 💎 【3点アライメント ダイヤモンド現象厳密絞り込み検索】
    // ==========================================
    const tripleModal = document.getElementById('triple-search-modal');
    const btnOpenTripleHdr = document.getElementById('btn-open-triple-search-hdr');
    const btnOpenTripleCard = document.getElementById('btn-open-triple-search-card');
    const btnOpenTripleSide = document.getElementById('btn-open-triple-search-side');
    const btnCloseTripleModal = document.getElementById('btn-close-triple-modal');

    const openTripleModal = () => {
        initObsDropdown();
        const baseDateText = document.getElementById('modal-base-date-text');
        if (baseDateText) {
            const pad = (n) => String(n).padStart(2, '0');
            const d = engine.activeDate || new Date();
            baseDateText.textContent = `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
        }
        if (tripleModal) tripleModal.classList.add('active');
    };
    const closeTripleModal = () => {
        if (tripleModal) tripleModal.classList.remove('active');
    };

    if (btnOpenTripleHdr) btnOpenTripleHdr.addEventListener('click', openTripleModal);
    if (btnOpenTripleCard) btnOpenTripleCard.addEventListener('click', openTripleModal);
    if (btnOpenTripleSide) btnOpenTripleSide.addEventListener('click', openTripleModal);
    if (btnCloseTripleModal) btnCloseTripleModal.addEventListener('click', closeTripleModal);

    let modalCelestialType = 'sun';
    const modalBtnCelSun = document.getElementById('modal-btn-cel-sun');
    const modalBtnCelMoon = document.getElementById('modal-btn-cel-moon');

    if (modalBtnCelSun && modalBtnCelMoon) {
        modalBtnCelSun.addEventListener('click', () => {
            modalCelestialType = 'sun';
            modalBtnCelSun.classList.add('active');
            modalBtnCelMoon.classList.remove('active');
        });
        modalBtnCelMoon.addEventListener('click', () => {
            modalCelestialType = 'moon';
            modalBtnCelMoon.classList.add('active');
            modalBtnCelSun.classList.remove('active');
        });
    }

    // 未来 / 過去 1年間検索モード切替
    let modalSearchDirection = 'future'; // 'future' or 'past'
    const modalBtnDirFuture = document.getElementById('modal-btn-dir-future');
    const modalBtnDirPast = document.getElementById('modal-btn-dir-past');

    if (modalBtnDirFuture && modalBtnDirPast) {
        modalBtnDirFuture.addEventListener('click', () => {
            modalSearchDirection = 'future';
            modalBtnDirFuture.classList.add('active');
            modalBtnDirPast.classList.remove('active');
        });
        modalBtnDirPast.addEventListener('click', () => {
            modalSearchDirection = 'past';
            modalBtnDirPast.classList.add('active');
            modalBtnDirFuture.classList.remove('active');
        });
    }

    const btnExecTriple = document.getElementById('btn-execute-triple-search');
    const resultsCountEl = document.getElementById('triple-results-count');
    const resultsListEl = document.getElementById('triple-results-list');

    if (btnExecTriple) {
        btnExecTriple.addEventListener('click', () => {
            const obsValue = document.getElementById('modal-select-obs').value;
            const targetId = document.getElementById('modal-select-target').value;

            if (!obsValue) {
                alert('📍 視点 B (見る場所) を選択、地名検索、または「🗺️ 2D地図タップ選択」ボタンで指定してください。');
                return;
            }

            let obsLat, obsLng, obsName, obsElev = 50;
            if (obsValue === 'shinminato') {
                obsLat = 36.7766; obsLng = 137.1086; obsName = '新湊大橋'; obsElev = 47;
            } else if (obsValue === 'toyama_city') {
                obsLat = 36.6953; obsLng = 137.2113; obsName = '富山市役所展望塔'; obsElev = 70;
            } else if (obsValue === 'current') {
                obsLat = engine.camera.lat; obsLng = engine.camera.lng; obsName = '現在地'; obsElev = engine.camera.elev || 10;
            } else if (obsValue === 'map_selected') {
                obsLat = engine.camera.lat; obsLng = engine.camera.lng; obsName = 'マップタップ選択視点'; obsElev = engine.camera.elev || 10;
            } else if (obsValue.startsWith('search_obs_')) {
                obsLat = engine.camera.lat; obsLng = engine.camera.lng; obsName = engine.locationName || '検索指定視点'; obsElev = engine.camera.elev || 10;
            } else if (obsValue.startsWith('my_vp_')) {
                const vpId = parseInt(obsValue.replace('my_vp_', ''), 10);
                const myVps = getMyViewpoints();
                const foundVp = myVps.find(v => v.id === vpId);
                if (foundVp) {
                    obsLat = foundVp.lat; obsLng = foundVp.lng; obsName = foundVp.name; obsElev = foundVp.elev;
                } else {
                    obsLat = engine.camera.lat; obsLng = engine.camera.lng; obsName = '登録視点'; obsElev = engine.camera.elev || 10;
                }
            } else {
                obsLat = engine.camera.lat; obsLng = engine.camera.lng; obsName = '選択視点'; obsElev = engine.camera.elev || 10;
            }

            const allPeaks = getAllPeaks();
            const targetObj = allPeaks.find(p => p.id === targetId) || currentTargetPeak;
            const searchBaseDate = engine.activeDate || new Date();
            const dirLabel = (modalSearchDirection === 'future') ? '未来1年間' : '過去1年間';

            resultsListEl.innerHTML = `<div style="text-align:center; padding:15px; color:#38bdf8;"><i class="fa-solid fa-spinner fa-spin"></i> 【${dirLabel}】山頂仰角と天体位置のダイヤモンド重なり条件を精密解析中...</div>`;

            setTimeout(() => {
                const results = finderEngine.searchTripleAlignmentDates(obsLat, obsLng, targetObj, modalCelestialType, searchBaseDate, modalSearchDirection, obsElev);

                const celLabel = (modalCelestialType === 'sun') ? '☀️ 太陽' : '🌙 月';
                const diaIcon = (modalCelestialType === 'sun') ? '💎 ダイヤモンド' : 'パール';
                
                resultsCountEl.innerHTML = `💎 絞り込み結果 (${dirLabel}): <b>${obsName}</b> ✕ <b>${targetObj.name}</b> ✕ <b>${celLabel}</b> (${diaIcon}${targetObj.name} 達成: ${results.length} 回)`;

                if (results.length === 0) {
                    resultsListEl.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">指定した1年間において、山頂の高さにピッタリ重なる条件は見つかりませんでした</div>';
                    return;
                }

                resultsListEl.innerHTML = '';
                results.forEach((item) => {
                    const pad = (n) => String(n).padStart(2, '0');
                    const dateStr = `${item.date.getFullYear()}/${pad(item.date.getMonth()+1)}/${pad(item.date.getDate())} ${pad(item.date.getHours())}:${pad(item.date.getMinutes())}`;
                    
                    let moonInfoStr = '';
                    if (modalCelestialType === 'moon') {
                        moonInfoStr = `<div style="font-size:0.75rem; color:#38bdf8; margin-top:2px;">${item.moonEmoji} <b>${item.moonPhaseName}</b> (月齢:${item.moonAge.toFixed(1)})</div>`;
                    }

                    const card = document.createElement('div');
                    card.className = 'triple-result-card';
                    card.innerHTML = `
                        <div>
                            <div class="triple-card-date"><i class="fa-solid fa-gem" style="color:#ffb703;"></i> ${dateStr}</div>
                            <div class="triple-card-sub">天体高度: ${item.altitude.toFixed(1)}° (山頂仰角:${item.peakAlt.toFixed(1)}°) | 方位誤差: ${item.diffAz.toFixed(2)}°</div>
                            ${moonInfoStr}
                        </div>
                        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px;">
                            <div class="triple-card-badge" style="background:rgba(255,183,3,0.25); color:#ffb703;">💎 山頂重なり 一致率 ${item.matchPercent}%</div>
                            <div style="font-size:0.68rem; color:#38bdf8;">タップでこの日時に移動 →</div>
                        </div>
                    `;

                    card.addEventListener('click', () => {
                        closeTripleModal();
                        
                        currentTargetPeak = targetObj;
                        engine.selectedTargetPeakId = targetObj.id;
                        activeCelestial = modalCelestialType;

                        const btnCelSun = document.getElementById('btn-celestial-sun');
                        const btnCelMoon = document.getElementById('btn-celestial-moon');
                        if (modalCelestialType === 'sun') {
                            btnCelSun.classList.add('active'); btnCelMoon.classList.remove('active');
                        } else {
                            btnCelMoon.classList.add('active'); btnCelSun.classList.remove('active');
                        }

                        applyLocation(obsLat, obsLng, obsElev, 1.5, obsName);
                        mapController.flyTo(obsLat, obsLng, 12);
                        syncPhotoWheelDisplay(item.date);
                    });

                    resultsListEl.appendChild(card);
                });
            }, 50);
        });
    }

    // 🌍 Google Earth 3D 同調連携 ＆ 戻るボタン モーダル
    const googleEarthModal = document.getElementById('google-earth-modal');
    const btnCloseEarthModal = document.getElementById('btn-close-earth-modal');
    const btnReturn3dPanorama = document.getElementById('btn-return-to-3d-panorama');
    const btnLaunchEarthWeb = document.getElementById('btn-launch-google-earth-web');
    const earthSpecText = document.getElementById('earth-viewpoint-spec-text');

    function openGoogleEarthModal() {
        if (!currentTargetPeak) return;

        const earthUrl = finderEngine.getGoogleEarthUrl(
            currentTargetPeak,
            engine.camera.lat,
            engine.camera.lng,
            engine.camera.azimuth,
            engine.camera.pitch,
            engine.camera.fov,
            engine.camera.elev
        );

        if (btnLaunchEarthWeb) {
            btnLaunchEarthWeb.href = earthUrl;
        }

        if (earthSpecText) {
            const zoomMag = (90 / engine.camera.fov).toFixed(1);
            earthSpecText.innerHTML = `
                <b>視点 B:</b> ${engine.locationName || 'マップ選択地点'}<br>
                <b>目標物 A:</b> ${currentTargetPeak.name} (標高 ${currentTargetPeak.elev}m)<br>
                <b>同調カメラアングル:</b> 方位 ${Math.round(engine.camera.azimuth)}° | 俯仰角 ${Math.round(engine.camera.pitch)}° | 望遠 ${zoomMag}x (${Math.round(engine.camera.fov)}°)<br>
                <b>視点座標:</b> 緯度 ${engine.camera.lat.toFixed(4)}° / 経度 ${engine.camera.lng.toFixed(4)}°
            `;
        }

        if (googleEarthModal) googleEarthModal.classList.add('active');
    }

    const closeGoogleEarthModal = () => {
        if (googleEarthModal) googleEarthModal.classList.remove('active');
    };

    if (btnCloseEarthModal) btnCloseEarthModal.addEventListener('click', closeGoogleEarthModal);
    if (btnReturn3dPanorama) btnReturn3dPanorama.addEventListener('click', closeGoogleEarthModal);

    function exportKMLFile() {
        if (!currentTargetPeak) return;
        const beamResult = finderEngine.calculateAlignmentBeam(currentTargetPeak, engine.activeDate, activeCelestial, engine.camera.elev || 100);
        const kmlContent = finderEngine.generateKML(beamResult, engine.camera.lat, engine.camera.lng);

        const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
        const link = document.createElement('a');
        link.download = `diamond_${currentTargetPeak.name}_alignment.kml`;
        link.href = URL.createObjectURL(blob);
        link.click();
    }

    const btnEarthHdr = document.getElementById('btn-open-google-earth-hdr');
    const btnEarthCard = document.getElementById('btn-open-google-earth-card');
    const btnEarthSide = document.getElementById('btn-open-google-earth-side');
    if (btnEarthHdr) btnEarthHdr.addEventListener('click', openGoogleEarthModal);
    if (btnEarthCard) btnEarthCard.addEventListener('click', openGoogleEarthModal);
    if (btnEarthSide) btnEarthSide.addEventListener('click', openGoogleEarthModal);

    const btnExportKml = document.getElementById('btn-export-earth-kml');
    const btnExportKmlSide = document.getElementById('btn-export-kml-side');
    if (btnExportKml) btnExportKml.addEventListener('click', exportKMLFile);
    if (btnExportKmlSide) btnExportKmlSide.addEventListener('click', exportKMLFile);

    // 🚀 3D 標高データ ＆ Raytracing 3段階解像度・動作速度モード切り替え
    const btnToggle3dRes = document.getElementById('btn-toggle-3d-res');
    const btnResFast = document.getElementById('btn-res-fast');
    const btnResStd = document.getElementById('btn-res-std');
    const btnResHigh = document.getElementById('btn-res-high');

    function set3dResModeUI(mode) {
        engine.setResMode(mode);

        if (btnToggle3dRes) {
            if (mode === 'fast') {
                btnToggle3dRes.innerHTML = '<i class="fa-solid fa-bolt"></i> 🚀 軽量・爆速';
                btnToggle3dRes.style.borderColor = '#22c55e';
                btnToggle3dRes.style.color = '#4ade80';
                btnToggle3dRes.style.background = 'rgba(34,197,94,0.15)';
            } else if (mode === 'std') {
                btnToggle3dRes.innerHTML = '<i class="fa-solid fa-layer-group"></i> ⚡ 標準';
                btnToggle3dRes.style.borderColor = 'var(--accent-blue)';
                btnToggle3dRes.style.color = 'var(--accent-blue)';
                btnToggle3dRes.style.background = 'rgba(56,189,248,0.15)';
            } else {
                btnToggle3dRes.innerHTML = '<i class="fa-solid fa-gem"></i> ✨ 5m高精細';
                btnToggle3dRes.style.borderColor = '#a855f7';
                btnToggle3dRes.style.color = '#c084fc';
                btnToggle3dRes.style.background = 'rgba(168,85,247,0.15)';
            }
        }

        const updateBtnStyle = (btn, active, activeColor, activeBg) => {
            if (!btn) return;
            if (active) {
                btn.classList.add('active');
                btn.style.background = activeBg;
                btn.style.color = activeColor;
                btn.style.borderColor = activeColor;
            } else {
                btn.classList.remove('active');
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-sub)';
                btn.style.borderColor = 'var(--border-color)';
            }
        };

        updateBtnStyle(btnResFast, mode === 'fast', '#4ade80', 'rgba(34,197,94,0.2)');
        updateBtnStyle(btnResStd, mode === 'std', '#38bdf8', 'rgba(56,189,248,0.2)');
        updateBtnStyle(btnResHigh, mode === 'high', '#c084fc', 'rgba(168,85,247,0.2)');
    }

    if (btnToggle3dRes) {
        btnToggle3dRes.addEventListener('click', () => {
            const modes = ['fast', 'std', 'high'];
            const nextIdx = (modes.indexOf(engine.resMode) + 1) % modes.length;
            set3dResModeUI(modes[nextIdx]);
        });
    }
    if (btnResFast) btnResFast.addEventListener('click', () => set3dResModeUI('fast'));
    if (btnResStd) btnResStd.addEventListener('click', () => set3dResModeUI('std'));
    if (btnResHigh) btnResHigh.addEventListener('click', () => set3dResModeUI('high'));

    // 天体選択
    const btnCelSun = document.getElementById('btn-celestial-sun');
    const btnCelMoon = document.getElementById('btn-celestial-moon');

    if (btnCelSun && btnCelMoon) {
        btnCelSun.addEventListener('click', () => {
            activeCelestial = 'sun';
            btnCelSun.classList.add('active');
            btnCelMoon.classList.remove('active');
            recalculateAlignment();
        });

        btnCelMoon.addEventListener('click', () => {
            activeCelestial = 'moon';
            btnCelMoon.classList.add('active');
            btnCelSun.classList.remove('active');
            recalculateAlignment();
        });
    }

    // 出没イベントジャンプ
    function jumpToEvent(eventType) {
        const times = engine.astroEngine.calculateSunMoonTimes(engine.activeDate, currentTargetPeak.lat, currentTargetPeak.lng);
        let targetDate = null;
        if (eventType === 'sunrise') { targetDate = times.sunrise; activeCelestial = 'sun'; }
        else if (eventType === 'sunset') { targetDate = times.sunset; activeCelestial = 'sun'; }
        else if (eventType === 'moonrise') { targetDate = times.moonrise; activeCelestial = 'moon'; }
        else if (eventType === 'moonset') { targetDate = times.moonset; activeCelestial = 'moon'; }

        if (targetDate) {
            syncPhotoWheelDisplay(targetDate);
            if (activeCelestial === 'sun') {
                btnCelSun.classList.add('active'); btnCelMoon.classList.remove('active');
            } else {
                btnCelMoon.classList.add('active'); btnCelSun.classList.remove('active');
            }
            recalculateAlignment();
        } else {
            alert('指定日における出没イベント時刻が計算できませんでした。日付を変更してお試しください。');
        }
    }

    document.getElementById('btn-event-sunrise').addEventListener('click', () => jumpToEvent('sunrise'));
    document.getElementById('btn-event-sunset').addEventListener('click', () => jumpToEvent('sunset'));
    document.getElementById('btn-event-moonrise').addEventListener('click', () => jumpToEvent('moonrise'));
    document.getElementById('btn-event-moonset').addEventListener('click', () => jumpToEvent('moonset'));

    function applyLocation(lat, lng, elev, eyeHeight = 1.5, name = 'カスタム地点') {
        engine.camera.lat = parseFloat(lat);
        engine.camera.lng = parseFloat(lng);
        engine.camera.elev = parseFloat(elev) || 0;
        engine.camera.eyeHeight = parseFloat(eyeHeight) || 1.5;
        engine.locationName = name;

        updateLocationInputs(lat, lng, elev, eyeHeight, name);
        updateLocationDisplay(lat, lng, elev, eyeHeight, name);

        if (currentTargetPeak) {
            const { bearing } = engine.calculateBearingAndDistance(lat, lng, currentTargetPeak.lat, currentTargetPeak.lng);
            engine.camera.azimuth = bearing;
            const sliderAz = document.getElementById('slider-azimuth');
            if (sliderAz) sliderAz.value = bearing;
            const valAz = document.getElementById('val-azimuth');
            if (valAz) valAz.textContent = `${Math.round(bearing)}°`;
        }

        mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
        engine.render();
    }

    function updateLocationInputs(lat, lng, elev, eyeHeight = 1.5, name = '') {
        const inputLat = document.getElementById('input-loc-lat');
        const inputLng = document.getElementById('input-loc-lng');
        const inputElev = document.getElementById('input-loc-elev');
        const inputEye = document.getElementById('input-loc-eye');

        if (inputLat) inputLat.value = isNaN(lat) ? '' : parseFloat(lat).toFixed(4);
        if (inputLng) inputLng.value = isNaN(lng) ? '' : parseFloat(lng).toFixed(4);
        if (inputElev) inputElev.value = isNaN(elev) ? '' : Math.round(elev || 0);
        if (inputEye) inputEye.value = parseFloat(eyeHeight || 1.5);
    }

    function updateLocationDisplay(lat, lng, elev, eyeHeight = 1.5, name = '') {
        const titleText = name ? name : '未選択 (2Dマップでライン上を選択)';
        document.getElementById('location-name-text').innerHTML = `<i class="fa-solid fa-location-dot" style="color: var(--accent-blue);"></i> 視点: ${titleText}`;
        document.getElementById('location-coords-text').textContent = 
            `緯度: ${isNaN(lat) ? '---' : parseFloat(lat).toFixed(4)}° | 経度: ${isNaN(lng) ? '---' : parseFloat(lng).toFixed(4)}° | 標高: ${elev || 0}m`;
    }

    function moveToCurrentLocation() {
        if (!navigator.geolocation) { alert('GPS未対応です'); return; }
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            let realElev = 0;
            try { realElev = await engine.gsiDemProvider.fetchElevation(lat, lng); } catch(e){}
            applyLocation(lat, lng, realElev, 1.5, '📍 現在地');
            mapController.flyTo(lat, lng, 12);
        });
    }

    const btnHdrLoc = document.getElementById('btn-current-loc-hdr');
    const btnPanelLoc = document.getElementById('btn-current-loc-panel');
    if (btnHdrLoc) btnHdrLoc.addEventListener('click', moveToCurrentLocation);
    if (btnPanelLoc) btnPanelLoc.addEventListener('click', moveToCurrentLocation);

    // 🗺️ 2D地図 ↔ 🛰️ 航空写真 切替イベント
    const btnToggleMapTile = document.getElementById('btn-toggle-map-tile');
    if (btnToggleMapTile) {
        btnToggleMapTile.addEventListener('click', () => {
            const nextType = (mapController.currentTileType === 'photo') ? 'std' : 'photo';
            mapController.setTileType(nextType);

            if (nextType === 'photo') {
                btnToggleMapTile.classList.add('active');
                btnToggleMapTile.innerHTML = '🗺️ 標準地図';
                btnToggleMapTile.style.borderColor = '#e2e8f0';
                btnToggleMapTile.style.color = '#e2e8f0';
            } else {
                btnToggleMapTile.classList.remove('active');
                btnToggleMapTile.innerHTML = '🛰️ 航空写真';
                btnToggleMapTile.style.borderColor = '#38bdf8';
                btnToggleMapTile.style.color = '#38bdf8';
            }
        });
    }

    // Stellarium Mobile 時間パネル
    const stellariumMobilePanel = document.getElementById('stellarium-mobile-panel');
    const btnToggleTimeMinimized = document.getElementById('btn-toggle-time-minimized');
    const miniClockVal = document.getElementById('mini-clock-val');

    if (btnToggleTimeMinimized && stellariumMobilePanel) {
        btnToggleTimeMinimized.addEventListener('click', () => {
            stellariumMobilePanel.classList.toggle('minimized');
        });
    }

    const valYear = document.getElementById('val-year');
    const valMonth = document.getElementById('val-month');
    const valDay = document.getElementById('val-day');
    const valHour = document.getElementById('val-hour');
    const valMinute = document.getElementById('val-minute');
    const valSecond = document.getElementById('val-second');

    function syncPhotoWheelDisplay(d) {
        engine.activeDate = d;
        const pad = (n) => String(n).padStart(2, '0');
        const y = d.getFullYear();
        const m = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hh = pad(d.getHours());
        const mm = pad(d.getMinutes());
        const ss = pad(d.getSeconds());

        if (valYear) valYear.textContent = y;
        if (valMonth) valMonth.textContent = m;
        if (valDay) valDay.textContent = day;
        if (valHour) valHour.textContent = hh;
        if (valMinute) valMinute.textContent = mm;
        if (valSecond) valSecond.textContent = ss;

        if (miniClockVal) miniClockVal.textContent = `${y}/${m}/${day} ${hh}:${mm}:${ss}`;

        recalculateAlignment();
    }

    function modifyDateTime(unit, amount) {
        const d = new Date(engine.activeDate);
        if (unit === 'year') d.setFullYear(d.getFullYear() + amount);
        else if (unit === 'month') d.setMonth(d.getMonth() + amount);
        else if (unit === 'day') d.setDate(d.getDate() + amount);
        else if (unit === 'hour') d.setHours(d.getHours() + amount);
        else if (unit === 'minute') d.setMinutes(d.getMinutes() + amount);
        else if (unit === 'second') d.setSeconds(d.getSeconds() + amount);

        syncPhotoWheelDisplay(d);
    }

    document.getElementById('btn-up-year').addEventListener('click', () => modifyDateTime('year', 1));
    document.getElementById('btn-up-month').addEventListener('click', () => modifyDateTime('month', 1));
    document.getElementById('btn-up-day').addEventListener('click', () => modifyDateTime('day', 1));
    document.getElementById('btn-up-hour').addEventListener('click', () => modifyDateTime('hour', 1));
    document.getElementById('btn-up-minute').addEventListener('click', () => modifyDateTime('minute', 1));
    document.getElementById('btn-up-second').addEventListener('click', () => modifyDateTime('second', 1));

    document.getElementById('btn-down-year').addEventListener('click', () => modifyDateTime('year', -1));
    document.getElementById('btn-down-month').addEventListener('click', () => modifyDateTime('month', -1));
    document.getElementById('btn-down-day').addEventListener('click', () => modifyDateTime('day', -1));
    document.getElementById('btn-down-hour').addEventListener('click', () => modifyDateTime('hour', -1));
    document.getElementById('btn-down-minute').addEventListener('click', () => modifyDateTime('minute', -1));
    document.getElementById('btn-down-second').addEventListener('click', () => modifyDateTime('second', -1));

    let isPlaying = false;
    let playSpeedFactor = 1.0;
    let animFrameId = null;
    let lastAnimTime = 0;

    const btnSpeedPlay = document.getElementById('btn-speed-play-pause');
    const iconSpeedPlay = document.getElementById('icon-speed-play');

    function animationLoop(timestamp) {
        if (!isPlaying) return;
        if (!lastAnimTime) lastAnimTime = timestamp;

        const deltaSec = (timestamp - lastAnimTime) / 1000;
        lastAnimTime = timestamp;

        if (playSpeedFactor !== 0) {
            const addedSec = deltaSec * playSpeedFactor;
            const newDate = new Date(engine.activeDate.getTime() + addedSec * 1000);
            syncPhotoWheelDisplay(newDate);
        }

        animFrameId = requestAnimationFrame(animationLoop);
    }

    if (btnSpeedPlay) {
        btnSpeedPlay.addEventListener('click', () => {
            isPlaying = !isPlaying;
            if (isPlaying) {
                iconSpeedPlay.className = 'fa-solid fa-pause';
                lastAnimTime = 0;
                animFrameId = requestAnimationFrame(animationLoop);
            } else {
                iconSpeedPlay.className = 'fa-solid fa-play';
                if (animFrameId) cancelAnimationFrame(animFrameId);
            }
        });
    }

    document.getElementById('btn-prev-night').addEventListener('click', () => modifyDateTime('day', -1));
    document.getElementById('btn-reset-now-photo').addEventListener('click', () => syncPhotoWheelDisplay(new Date()));
    document.getElementById('btn-next-night').addEventListener('click', () => modifyDateTime('day', 1));

    // FOV 望遠ズーム
    function updateFov(fovVal) {
        const clampedFov = Math.max(3, Math.min(150, parseFloat(fovVal)));
        engine.camera.fov = clampedFov;
        const sliderFov = document.getElementById('slider-fov');
        if (sliderFov) sliderFov.value = clampedFov;

        const zoomMag = (90 / clampedFov).toFixed(1);
        const valFovEl = document.getElementById('val-fov');
        if (valFovEl) valFovEl.textContent = `${Math.round(clampedFov)}° (${zoomMag}x 望遠)`;

        mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
        engine.render();
    }

    const sliderFov = document.getElementById('slider-fov');
    if (sliderFov) sliderFov.addEventListener('input', (e) => updateFov(e.target.value));

    document.querySelectorAll('.btn-zoom-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const fov = btn.getAttribute('data-fov');
            if (fov) updateFov(fov);
        });
    });

    const sliderAzimuth = document.getElementById('slider-azimuth');
    if (sliderAzimuth) {
        sliderAzimuth.addEventListener('input', (e) => {
            engine.camera.azimuth = parseFloat(e.target.value);
            document.getElementById('val-azimuth').textContent = `${Math.round(engine.camera.azimuth)}°`;
            mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
            engine.render();
        });
    }

    document.getElementById('btn-reset-view').addEventListener('click', () => {
        if (currentTargetPeak) {
            const { bearing } = engine.calculateBearingAndDistance(engine.camera.lat, engine.camera.lng, currentTargetPeak.lat, currentTargetPeak.lng);
            engine.camera.azimuth = bearing;
            if (sliderAzimuth) sliderAzimuth.value = bearing;
            document.getElementById('val-azimuth').textContent = `${Math.round(bearing)}°`;
        }
        updateFov(90);
    });

    document.getElementById('btn-screenshot').addEventListener('click', () => {
        const link = document.createElement('a');
        link.download = `diamond_${currentTargetPeak.name}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    });

    const sidePanel = document.getElementById('side-panel');
    document.getElementById('btn-toggle-panel').addEventListener('click', () => sidePanel.classList.toggle('collapsed'));
    document.getElementById('btn-close-panel').addEventListener('click', () => sidePanel.classList.add('collapsed'));

    // ==========================================
    // 📱 タッチ操作・ドラッグ＆ピンチズーム対応 (Google Pixel 7 等のタッチパネル対応)
    // ==========================================
    let isDragging = false;
    let startX = 0, startY = 0;
    let touchStartDist = 0;
    let initialFovOnPinch = 90;

    function handlePanMove(dx, dy) {
        const sensitivity = engine.camera.fov / Math.max(canvas.clientWidth, 300);
        engine.camera.azimuth = (engine.camera.azimuth - dx * sensitivity + 360) % 360;
        engine.camera.pitch = Math.max(-40, Math.min(40, engine.camera.pitch + dy * sensitivity));

        if (sliderAzimuth) sliderAzimuth.value = engine.camera.azimuth;
        const valAz = document.getElementById('val-azimuth');
        if (valAz) valAz.textContent = `${Math.round(engine.camera.azimuth)}°`;
        mapController.updateCameraView(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
        engine.render();
    }

    // マウス操作
    canvas.addEventListener('mousedown', (e) => { isDragging = true; startX = e.clientX; startY = e.clientY; });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        startX = e.clientX; startY = e.clientY;
        handlePanMove(dx, dy);
    });
    window.addEventListener('mouseup', () => { isDragging = false; });

    // タッチ操作 (Google Pixel 7 タッチスクリーン ＆ 2本指ピンチズーム)
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            isDragging = false;
            touchStartDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialFovOnPinch = engine.camera.fov;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && isDragging) {
            e.preventDefault();
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            handlePanMove(dx, dy);
        } else if (e.touches.length === 2 && touchStartDist > 0) {
            e.preventDefault();
            const currentDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (currentDist > 0) {
                const scale = touchStartDist / currentDist;
                const newFov = Math.max(3, Math.min(150, initialFovOnPinch * scale));
                updateFov(newFov);
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) touchStartDist = 0;
        if (e.touches.length === 0) isDragging = false;
    });

    canvas.addEventListener('touchcancel', () => {
        isDragging = false;
        touchStartDist = 0;
    });

    // マウスホイールズーム
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 1.15 : 0.85;
        const newFov = Math.max(3, Math.min(150, engine.camera.fov * delta));
        updateFov(newFov);
    }, { passive: false });

    // 初期化実行 (自動モーダル表示を廃止し、すっきり静かに起動)

    // ==========================================
    // 🔀 ビューモード切り替えシステム (追加 v5.1)
    // 以下のコードを DOMContentLoaded 内の末尾に挿入
    // ==========================================
// ==========================================
// 🔀 ビューモード切り替えシステム (3D専用 / スプリット / 2D専用)
// Pixel 7 最適化 - スムーズ3D/2D移行
// ==========================================

let currentViewMode = '3d'; // '3d' | 'split' | '2d'
let miniMapController = null;
let splitMapController = null;
let splitMapInitialized = false;
let miniMapInitialized = false;

const mainContent = document.querySelector('.main-content');

// ビューモードバッジ
const viewModeBadge = document.getElementById('view-mode-badge');
function showViewModeBadge(text) {
    if (!viewModeBadge) return;
    viewModeBadge.textContent = text;
    viewModeBadge.classList.add('visible');
    clearTimeout(viewModeBadge._hideTimer);
    viewModeBadge._hideTimer = setTimeout(() => viewModeBadge.classList.remove('visible'), 2000);
}

// スプリットマップ初期化
function initSplitMap() {
    if (splitMapInitialized) return;
    splitMapInitialized = true;

    const splitMapEl = document.getElementById('leaflet-map-split');
    if (!splitMapEl || !window.L) return;

    const defaultLat = engine.camera.lat || 36.6236;
    const defaultLng = engine.camera.lng || 137.2113;

    splitMapController = L.map('leaflet-map-split', {
        center: [defaultLat, defaultLng],
        zoom: 10,
        zoomControl: false
    });

    // 簡易ズームコントロール（右下）
    L.control.zoom({ position: 'bottomright' }).addTo(splitMapController);

    // 国土地理院 標準地図
    const stdLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'
    }).addTo(splitMapController);

    // 航空写真レイヤー
    const photoLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
        maxZoom: 18
    });

    let splitCurrentTile = 'std';
    const btnTileSplit = document.getElementById('btn-toggle-tile-split');
    if (btnTileSplit) {
        btnTileSplit.addEventListener('click', () => {
            if (splitCurrentTile === 'std') {
                splitMapController.removeLayer(stdLayer);
                photoLayer.addTo(splitMapController);
                splitCurrentTile = 'photo';
                btnTileSplit.classList.add('active');
            } else {
                splitMapController.removeLayer(photoLayer);
                stdLayer.addTo(splitMapController);
                splitCurrentTile = 'std';
                btnTileSplit.classList.remove('active');
            }
        });
    }

    // 視点マーカー（スプリットマップ用）
    const obsIconHtml = `<div style="background-color:#0284c7; width:20px; height:20px; border-radius:50%; border:3px solid white; box-shadow:0 0 12px rgba(2,132,199,0.9); display:flex; align-items:center; justify-content:center; color:white; font-size:10px;"><i class="fa-solid fa-eye"></i></div>`;
    const splitObsMarker = L.marker([defaultLat, defaultLng], {
        draggable: true,
        icon: L.divIcon({ className: 'custom-obs-marker', html: obsIconHtml, iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(splitMapController);

    // 目標マーカー（スプリットマップ用）
    const tgtIconHtml = `<div style="background-color:#00f5d4; width:22px; height:22px; border-radius:50%; border:3px solid #0f172a; box-shadow:0 0 14px rgba(0,245,212,0.95); display:flex; align-items:center; justify-content:center; color:#0f172a; font-size:12px;"><i class="fa-solid fa-crosshairs"></i></div>`;
    const splitTgtMarker = L.marker([36.6236, 137.6169], {
        draggable: true,
        icon: L.divIcon({ className: 'custom-target-marker', html: tgtIconHtml, iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(splitMapController);

    // スプリットマップのモード切り替えボタン
    let splitActiveMode = 'observer';
    const btnObsSplit = document.getElementById('btn-map-mode-obs-split');
    const btnTgtSplit = document.getElementById('btn-map-mode-tgt-split');
    if (btnObsSplit && btnTgtSplit) {
        btnObsSplit.addEventListener('click', () => {
            splitActiveMode = 'observer';
            btnObsSplit.classList.add('active');
            btnTgtSplit.classList.remove('active');
        });
        btnTgtSplit.addEventListener('click', () => {
            splitActiveMode = 'target';
            btnTgtSplit.classList.add('active');
            btnObsSplit.classList.remove('active');
        });
    }

    // スプリットマップクリック → 視点 or 目標更新
    splitMapController.on('click', (e) => {
        if (splitActiveMode === 'target') {
            splitTgtMarker.setLatLng(e.latlng);
            // メインのマップコントローラーと同期
            mapController.updateTargetMarker(e.latlng.lat, e.latlng.lng);
            if (mapController.onTargetChange) {
                mapController.onTargetChange(e.latlng.lat, e.latlng.lng);
            }
        } else {
            splitObsMarker.setLatLng(e.latlng);
            // 3Dパノラマの視点を即時更新（スムーズ移行の核心部分）
            triggerSyncFrom2Dto3D(e.latlng.lat, e.latlng.lng);
        }
    });

    // スプリットマップ 観測者ドラッグ → 3D同期
    let splitDragTimer = null;
    splitObsMarker.on('drag', (e) => {
        if (splitDragTimer) return;
        splitDragTimer = requestAnimationFrame(() => {
            splitDragTimer = null;
            const pos = e.target.getLatLng();
            triggerSyncFrom2Dto3D(pos.lat, pos.lng);
        });
    });

    // メインのmapControllerとスプリットマップを同期する関数を登録
    window._splitMapSync = {
        map: splitMapController,
        obsMarker: splitObsMarker,
        tgtMarker: splitTgtMarker,
        syncObserver: (lat, lng) => {
            splitObsMarker.setLatLng([lat, lng]);
            // パルスアニメーション
            const el = splitMapEl;
            el.classList.add('map-sync-pulse');
            setTimeout(() => el.classList.remove('map-sync-pulse'), 600);
        },
        syncTarget: (lat, lng) => {
            splitTgtMarker.setLatLng([lat, lng]);
        },
        flyTo: (lat, lng, zoom = 11) => {
            splitMapController.flyTo([lat, lng], zoom, { duration: 0.8 });
        },
        updateFovPolygon: (lat, lng, azimuth, fov, maxDistanceKm) => {
            if (window._splitFovPolygon) splitMapController.removeLayer(window._splitFovPolygon);
            const points = [[lat, lng]];
            const halfFov = fov / 2;
            const startAngle = azimuth - halfFov;
            const endAngle = azimuth + halfFov;
            const R = 6371;
            for (let i = 0; i <= 16; i++) {
                const angleDeg = startAngle + (endAngle - startAngle) * (i / 16);
                const brng = angleDeg * Math.PI / 180;
                const latRad = lat * Math.PI / 180;
                const lngRad = lng * Math.PI / 180;
                const distRad = ((maxDistanceKm || 40) * 0.4) / R;
                const destLatRad = Math.asin(Math.sin(latRad) * Math.cos(distRad) + Math.cos(latRad) * Math.sin(distRad) * Math.cos(brng));
                const destLngRad = lngRad + Math.atan2(Math.sin(brng) * Math.sin(distRad) * Math.cos(latRad), Math.cos(distRad) - Math.sin(latRad) * Math.sin(destLatRad));
                points.push([destLatRad * 180 / Math.PI, destLngRad * 180 / Math.PI]);
            }
            window._splitFovPolygon = L.polygon(points, { color: '#0284c7', fillColor: '#38bdf8', fillOpacity: 0.2, weight: 2 }).addTo(splitMapController);
        }
    };

    // 初期位置にFlyTo
    if (!isNaN(engine.camera.lat)) {
        splitMapController.flyTo([engine.camera.lat, engine.camera.lng], 11, { duration: 0 });
        splitObsMarker.setLatLng([engine.camera.lat, engine.camera.lng]);
    }
    if (currentTargetPeak) {
        splitTgtMarker.setLatLng([currentTargetPeak.lat, currentTargetPeak.lng]);
    }
}

// ミニマップ初期化
function initMiniMap() {
    if (miniMapInitialized) return;
    miniMapInitialized = true;

    const miniMapEl = document.getElementById('leaflet-map-mini');
    if (!miniMapEl || !window.L) return;

    const defaultLat = engine.camera.lat || 36.6236;
    const defaultLng = engine.camera.lng || 137.2113;

    miniMapController = L.map('leaflet-map-mini', {
        center: [defaultLat, defaultLng],
        zoom: 9,
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false
    });

    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        maxZoom: 18
    }).addTo(miniMapController);

    // ミニマップの視点マーカー（小さい）
    const miniObsIcon = L.divIcon({
        className: '',
        html: `<div style="background:#0284c7; width:10px; height:10px; border-radius:50%; border:2px solid white;"></div>`,
        iconSize: [12, 12], iconAnchor: [6, 6]
    });
    const miniTgtIcon = L.divIcon({
        className: '',
        html: `<div style="background:#00f5d4; width:10px; height:10px; border-radius:50%; border:2px solid #0f172a;"></div>`,
        iconSize: [12, 12], iconAnchor: [6, 6]
    });

    const miniObsMarker = L.marker([defaultLat, defaultLng], { icon: miniObsIcon }).addTo(miniMapController);
    const miniTgtMarker = L.marker([36.6236, 137.6169], { icon: miniTgtIcon }).addTo(miniMapController);

    window._miniMapSync = {
        map: miniMapController,
        obsMarker: miniObsMarker,
        tgtMarker: miniTgtMarker,
        syncObserver: (lat, lng) => {
            miniObsMarker.setLatLng([lat, lng]);
            miniMapController.setView([lat, lng], 9, { animate: false });
        },
        syncTarget: (lat, lng) => {
            miniTgtMarker.setLatLng([lat, lng]);
        }
    };

    if (!isNaN(engine.camera.lat)) {
        miniMapController.setView([engine.camera.lat, engine.camera.lng], 9, { animate: false });
        miniObsMarker.setLatLng([engine.camera.lat, engine.camera.lng]);
    }
    if (currentTargetPeak) {
        miniTgtMarker.setLatLng([currentTargetPeak.lat, currentTargetPeak.lng]);
    }
}

// 2D → 3D 同期トリガー（スムーズ移行の中核）
function triggerSyncFrom2Dto3D(lat, lng) {
    // 3Dエンジン視点更新
    engine.camera.lat = lat;
    engine.camera.lng = lng;
    engine.locationName = `マップ選択地点 (${lat.toFixed(3)}°, ${lng.toFixed(3)}°)`;

    updateLocationInputs(lat, lng, engine.camera.elev, engine.camera.eyeHeight, engine.locationName);
    updateLocationDisplay(lat, lng, engine.camera.elev, engine.camera.eyeHeight, engine.locationName);

    if (currentTargetPeak && !isNaN(currentTargetPeak.lat)) {
        const { bearing } = engine.calculateBearingAndDistance(lat, lng, currentTargetPeak.lat, currentTargetPeak.lng);
        engine.camera.azimuth = bearing;
        const sliderAz = document.getElementById('slider-azimuth');
        if (sliderAz) sliderAz.value = bearing;
        const valAz = document.getElementById('val-azimuth');
        if (valAz) valAz.textContent = `${Math.round(bearing)}°`;
    }

    // メイン2Dマップも同期
    mapController.updateCameraView(lat, lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
    mapController.flyTo(lat, lng, 12);

    // スプリットマップのFOVポリゴン更新
    if (window._splitMapSync) {
        window._splitMapSync.updateFovPolygon(lat, lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
    }

    // ミニマップ同期
    if (window._miniMapSync) {
        window._miniMapSync.syncObserver(lat, lng);
    }

    // 3D再レンダリング（スムーズ移行のキー部分）
    engine.render();
    recalculateAlignment();
}

// ビューモード切り替え関数
function switchViewMode(mode) {
    if (currentViewMode === mode && mode !== 'split') return;
    const prevMode = currentViewMode;
    currentViewMode = mode;

    // フラッシュアニメーション
    if (mainContent) {
        mainContent.classList.add('view-transition-flash');
        setTimeout(() => mainContent && mainContent.classList.remove('view-transition-flash'), 350);
    }

    // クラス付け替え
    if (mainContent) {
        mainContent.classList.remove('mode-3d', 'mode-split', 'mode-2d');
        mainContent.classList.add(`mode-${mode}`);
    }

    // ボタンアクティブ状態
    document.querySelectorAll('.view-mode-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`btn-view-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    // ミニマップの表示/非表示
    const miniMapOverlay = document.getElementById('mini-map-overlay');
    if (miniMapOverlay) {
        miniMapOverlay.style.display = (mode === '3d') ? 'block' : 'none';
    }

    // スプリット or 2D モード
    if (mode === 'split' || mode === '2d') {
        // スプリットマップ初期化（初回のみ）
        if (!splitMapInitialized) {
            initSplitMap();
        } else if (splitMapController) {
            // Leafletはdisplay:noneから復元した後にサイズ再計算が必要
            setTimeout(() => splitMapController.invalidateSize(), 100);
        }

        // スプリットマップを現在視点に同期
        if (window._splitMapSync) {
            if (!isNaN(engine.camera.lat)) {
                window._splitMapSync.flyTo(engine.camera.lat, engine.camera.lng, 11);
                window._splitMapSync.syncObserver(engine.camera.lat, engine.camera.lng);
            }
            if (currentTargetPeak) {
                window._splitMapSync.syncTarget(currentTargetPeak.lat, currentTargetPeak.lng);
            }
            window._splitMapSync.updateFovPolygon(engine.camera.lat, engine.camera.lng, engine.camera.azimuth, engine.camera.fov, engine.camera.maxDistance);
        }
    }

    // 3Dモードでミニマップ初期化
    if (mode === '3d') {
        if (!miniMapInitialized) {
            setTimeout(() => {
                if (miniMapOverlay && miniMapOverlay.style.display === 'block') {
                    initMiniMap();
                }
            }, 200);
        } else if (miniMapController) {
            setTimeout(() => miniMapController.invalidateSize(), 100);
            if (window._miniMapSync && !isNaN(engine.camera.lat)) {
                window._miniMapSync.syncObserver(engine.camera.lat, engine.camera.lng);
            }
        }
        // Canvas再描画
        resizeCanvas();
        showViewModeBadge('3D パノラマ');
    } else if (mode === 'split') {
        showViewModeBadge('スプリットビュー');
        resizeCanvas();
    } else if (mode === '2d') {
        showViewModeBadge('2D マップ');
    }
}

// ビューモードボタンのイベントリスナー
const btnView3d = document.getElementById('btn-view-3d');
const btnViewSplit = document.getElementById('btn-view-split');
const btnView2d = document.getElementById('btn-view-2d');

if (btnView3d) btnView3d.addEventListener('click', () => switchViewMode('3d'));
if (btnViewSplit) btnViewSplit.addEventListener('click', () => switchViewMode('split'));
if (btnView2d) btnView2d.addEventListener('click', () => switchViewMode('2d'));

// ミニマップクリック → スプリットビューへ
const miniMapOverlay = document.getElementById('mini-map-overlay');
if (miniMapOverlay) {
    miniMapOverlay.addEventListener('click', () => switchViewMode('split'));
}

// 初期状態: 3Dモードを適用
if (mainContent) {
    mainContent.classList.add('mode-3d');
}

// ==========================================
// 🔄 3Dドラッグ → 2Dマップ同期の強化
// (既存の handlePanMove に同期処理を追加)
// ==========================================

// mapController.updateCameraView が呼ばれるたびにスプリットマップも同期させる
// オリジナルのupdateCameraViewをラップ
const _origUpdateCameraView = mapController.updateCameraView.bind(mapController);
mapController.updateCameraView = function(lat, lng, azimuth, fov, maxDistanceKm) {
    _origUpdateCameraView(lat, lng, azimuth, fov, maxDistanceKm);
    // スプリットマップのFOVポリゴンも同期
    if (window._splitMapSync && (currentViewMode === 'split' || currentViewMode === '2d')) {
        window._splitMapSync.syncObserver(lat, lng);
        window._splitMapSync.updateFovPolygon(lat, lng, azimuth, fov, maxDistanceKm);
    }
    // ミニマップも同期
    if (window._miniMapSync && currentViewMode === '3d') {
        window._miniMapSync.syncObserver(lat, lng);
    }
};

// mapController.flyTo もラップ
const _origFlyTo = mapController.flyTo.bind(mapController);
mapController.flyTo = function(lat, lng, zoom) {
    _origFlyTo(lat, lng, zoom);
    if (window._splitMapSync && (currentViewMode === 'split' || currentViewMode === '2d')) {
        window._splitMapSync.flyTo(lat, lng, zoom);
    }
    if (window._miniMapSync && currentViewMode === '3d') {
        window._miniMapSync.syncObserver(lat, lng);
    }
};

// ==========================================
// 📱 Pixel 7 スワイプジェスチャーでビュー切り替え
// (3D Canvas 上で2本指上スワイプ → スプリット、下スワイプ → 3D)
// ==========================================
let swipeTouchStartY = 0;
let swipeTouchStartTime = 0;
let swipeTouches = 0;

canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        swipeTouchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        swipeTouchStartTime = Date.now();
        swipeTouches = 2;
    }
}, { passive: true, capture: true });

canvas.addEventListener('touchend', (e) => {
    if (swipeTouches !== 2 || e.changedTouches.length < 1) return;
    swipeTouches = 0;
    const elapsed = Date.now() - swipeTouchStartTime;
    if (elapsed > 500) return; // 長押しは無視

    // タッチ終了時のY位置
    const endY = (e.changedTouches[0].clientY + (e.changedTouches[1] ? e.changedTouches[1].clientY : e.changedTouches[0].clientY)) / 2;
    const dy = swipeTouchStartY - endY;

    // 2本指で50px以上の上スワイプ → スプリットビュー
    if (dy > 50 && currentViewMode === '3d') {
        switchViewMode('split');
    }
    // 2本指で50px以上の下スワイプ → 3Dモードに戻る
    else if (dy < -50 && currentViewMode === 'split') {
        switchViewMode('3d');
    }
}, { passive: true });


    resizeCanvas();
    syncPhotoWheelDisplay(new Date());
});
