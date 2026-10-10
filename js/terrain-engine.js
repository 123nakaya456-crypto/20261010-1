/**
 * Tile DEM Loader (GSIDEMProvider)
 */
class GSIDEMProvider {
    constructor(onTileLoaded) {
        this.tileCache = new Map();
        this.canvas = document.createElement('canvas');
        this.canvas.width = 256;
        this.canvas.height = 256;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.fetchingTiles = new Set();
        this.onTileLoaded = onTileLoaded;
        this.demSourceType = 'dem5a'; // 'dem5a' (5mレーザーDEM) or 'standard' (10m DEM)
        this.maxCacheTiles = 800; // LRUキャッシュ上限。望遠時のDEM解像度ブーストでタイル数が増えるため拡大。
    }

    latLngToTile(lat, lng, z = 12) {
        const n = Math.pow(2, z);
        const rad = lat * Math.PI / 180;
        const x = (lng + 180) / 360 * n;
        const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
        
        const tileX = Math.floor(x);
        const tileY = Math.floor(y);
        const pixelX = Math.floor((x - tileX) * 256);
        const pixelY = Math.floor((y - tileY) * 256);

        return { z, tileX, tileY, pixelX, pixelY };
    }

    decodeElevation(r, g, b) {
        const x = (r << 16) + (g << 8) + b;
        if (x === 8388608) return 0;
        return (x < 8388608) ? x * 0.01 : (x - 16777216) * 0.01;
    }

    async loadTile(z, x, y, sourceType = this.demSourceType) {
        const key = `${sourceType}/${z}/${x}/${y}`;
        if (this.tileCache.has(key)) {
            return this.tileCache.get(key);
        }
        if (this.fetchingTiles.has(key)) return null;

        this.fetchingTiles.add(key);

        const tilePath = (sourceType === 'dem5a') ? `dem5a_png/${z}/${x}/${y}.png` : `dem_png/${z}/${x}/${y}.png`;
        const primaryUrl = `https://cyberjapandata.gsi.go.jp/xyz/${tilePath}`;

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.src = primaryUrl;

            img.onload = () => {
                try {
                    this.ctx.clearRect(0, 0, 256, 256);
                    this.ctx.drawImage(img, 0, 0);
                    const imgData = this.ctx.getImageData(0, 0, 256, 256);
                    
                    // LRU キャッシュ制限
                    // 💡 旧:60タイルでは広角パノラマ1回の描画に必要なタイル数(遠景まで含めると
                    // 数百枚に及ぶことがある)を大幅に下回っており、1回の同期描画ループの最中に
                    // 既に読み込んだ遠景/近景タイルが次々追い出されてしまい、「山が表示されない/
                    // ちらつく」不具合の主因になっていた。最大 400 タイル(約100MB)まで保持して解消。
                    if (this.tileCache.size >= this.maxCacheTiles) {
                        const oldestKey = this.tileCache.keys().next().value;
                        if (oldestKey) this.tileCache.delete(oldestKey);
                    }
                    this.tileCache.set(key, imgData);
                    this.fetchingTiles.delete(key);

                    if (this.onTileLoaded) {
                        this.onTileLoaded();
                    }
                    resolve(imgData);
                } catch (e) {
                    this.tileCache.set(key, 'cors_restricted');
                    this.fetchingTiles.delete(key);
                    resolve(null);
                }
            };

            img.onerror = () => {
                // dem5aでエラー（海域・未計測エリア）の場合は標準 dem_png でフォールバック
                if (sourceType === 'dem5a') {
                    const fallbackImg = new Image();
                    fallbackImg.crossOrigin = 'Anonymous';
                    fallbackImg.src = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
                    fallbackImg.onload = () => {
                        try {
                            this.ctx.clearRect(0, 0, 256, 256);
                            this.ctx.drawImage(fallbackImg, 0, 0);
                            const imgData = this.ctx.getImageData(0, 0, 256, 256);

                            if (this.tileCache.size >= this.maxCacheTiles) {
                                const oldestKey = this.tileCache.keys().next().value;
                                if (oldestKey) this.tileCache.delete(oldestKey);
                            }
                            this.tileCache.set(key, imgData);
                            this.fetchingTiles.delete(key);
                            if (this.onTileLoaded) this.onTileLoaded();
                            resolve(imgData);
                        } catch(e) {
                            this.fetchingTiles.delete(key);
                            resolve(null);
                        }
                    };
                    fallbackImg.onerror = () => {
                        this.fetchingTiles.delete(key);
                        resolve(null);
                    };
                } else {
                    this.fetchingTiles.delete(key);
                    resolve(null);
                }
            };
        });
    }

    getBilinearElevationFromCache(lat, lng, z = 12) {
        const n = Math.pow(2, z);
        const rad = lat * Math.PI / 180;
        const x = (lng + 180) / 360 * n;
        const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
        
        const tileX = Math.floor(x);
        const tileY = Math.floor(y);
        const key = `${this.demSourceType}/${z}/${tileX}/${tileY}`;
        const imgData = this.tileCache.get(key);

        if (!imgData || imgData === 'cors_restricted') {
            if (!imgData) this.loadTile(z, tileX, tileY, this.demSourceType);
            return null;
        }

        const px = (x - tileX) * 256;
        const py = (y - tileY) * 256;

        const x1 = Math.floor(px);
        const y1 = Math.floor(py);
        const x2 = Math.min(255, x1 + 1);
        const y2 = Math.min(255, y1 + 1);

        const fx = px - x1;
        const fy = py - y1;

        const getElevAt = (xIndex, yIndex) => {
            const idx = (yIndex * 256 + xIndex) * 4;
            return this.decodeElevation(imgData.data[idx], imgData.data[idx + 1], imgData.data[idx + 2]);
        };

        const e11 = getElevAt(x1, y1);
        const e21 = getElevAt(x2, y1);
        const e12 = getElevAt(x1, y2);
        const e22 = getElevAt(x2, y2);

        // バイリニア補間（周辺4ピクセルから連続的に滑らか補間）
        const top = e11 + (e21 - e11) * fx;
        const bottom = e12 + (e22 - e12) * fx;
        return top + (bottom - top) * fy;
    }

    getElevationFromCache(lat, lng, z = 12) {
        return this.getBilinearElevationFromCache(lat, lng, z);
    }

    async fetchElevation(lat, lng, z = 12) {
        const t = this.latLngToTile(lat, lng, z);
        const imgData = await this.loadTile(t.z, t.tileX, t.tileY, this.demSourceType);
        if (!imgData || imgData === 'cors_restricted') return 0;
        const idx = (t.pixelY * 256 + t.pixelX) * 4;
        return this.decodeElevation(imgData.data[idx], imgData.data[idx + 1], imgData.data[idx + 2]);
    }
}

/**
 * 📷 実写パノラマ写真調 3D地形・天体描画エンジン (TerrainEngine Photo-Pro v2.1)
 * - 選択した目標物以外の余分な山名タグ非表示
 * - 山肌遮蔽時の目標物ネオンタグ半透明（薄く表示）対応
 */
class TerrainEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        this.camera = {
            lat: 35.6250,
            lng: 139.2437,
            elev: 0,
            eyeHeight: 1.5,
            azimuth: 270,
            fov: 90,
            pitch: 0,
            elevScale: 1.0,
            maxDistance: 180
        };

        this.styleMode = '3d-gradient';
        this.showPeakTags = true;
        this.showCelestial = true;
        this.showTrack = true;
        this.showContours = true;

        this.astroEngine = new AstroEngine();
        
        let renderTimer = null;
        this.gsiDemProvider = new GSIDEMProvider(() => {
            if (renderTimer) clearTimeout(renderTimer);
            renderTimer = setTimeout(() => this.render(), 250);
        });

        this.peaks = [];
        this.activeDate = new Date();
        this.visiblePeaksInScreen = [];
        this.locationName = '未選択';
        
        this.selectedTargetPeakId = null;
        this.renderedTagBoxes = [];

        this.horizonYMap = [];
        this.resMode = 'fast'; // 初期設定: 'fast' (爆速・軽量モード) で処理速度とメモリを最適化
        this.isHighResMode = false;
        this.gsiDemProvider.demSourceType = 'standard';
    }

    setResMode(mode) {
        this.resMode = mode;
        this.isHighResMode = (mode === 'high');
        this.gsiDemProvider.demSourceType = (mode === 'high') ? 'dem5a' : 'standard';
        this.render();
    }

    setHighResMode(enabled) {
        this.setResMode(enabled ? 'high' : 'std');
    }

    calculateBearingAndDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;

        const phi1 = lat1 * Math.PI / 180;
        const phi2 = lat2 * Math.PI / 180;

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(phi1) * Math.cos(phi2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        const y = Math.sin(dLon) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) -
                  Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        bearing = (bearing + 360) % 360;

        return { bearing, distance };
    }

    destinationPoint(lat, lng, distKm, bearingDeg) {
        const R = 6371;
        const brng = bearingDeg * Math.PI / 180;
        const latRad = lat * Math.PI / 180;
        const lngRad = lng * Math.PI / 180;
        const distRad = distKm / R;

        const destLatRad = Math.asin(
            Math.sin(latRad) * Math.cos(distRad) +
            Math.cos(latRad) * Math.sin(distRad) * Math.cos(brng)
        );
        const destLngRad = lngRad + Math.atan2(
            Math.sin(brng) * Math.sin(distRad) * Math.cos(latRad),
            Math.cos(distRad) - Math.sin(latRad) * Math.sin(destLatRad)
        );

        return {
            lat: destLatRad * 180 / Math.PI,
            lng: destLngRad * 180 / Math.PI
        };
    }

    calculateApparentAltitude(obsElev, eyeHeight, targetElev, distanceKm) {
        const totalObsElev = obsElev + (eyeHeight || 0);
        const distMeters = distanceKm * 1000;
        const curvatureDrop = (distMeters * distMeters) / (2 * 6371000) * 0.85;
        const relativeElev = targetElev - (totalObsElev + curvatureDrop);
        const altRad = Math.atan2(relativeElev, distMeters);
        return altRad * 180 / Math.PI;
    }

    /**
     * 🌄 ヒルシェード(陰影段彩): 指定地点の局所的な傾斜方向と太陽方向から
     * 疑似的な陰影強度(0=完全に陰, 1=完全に順光)を算出する。
     * DEMタイルから東西・南北方向に1タイルピクセル分だけずらした標高を追加サンプルし、
     * 標高の勾配(dz/dx, dz/dy)から地表法線ベクトルを求め、太陽方向ベクトルとの内積
     * (ランバート反射モデル)で明暗をつける。真の3Dメッシュではないため近似だが、
     * 「太陽に面した斜面は明るく、陰になった斜面は暗く」という写真的な立体感を
     * 安価な計算量で再現できる。
     */
    getHillshadeFactor(lat, lng, zoom, sunAzimuthRad, sunAltRad) {
        const degPerPixel = (360 / Math.pow(2, zoom)) / 256;
        const elevC = this.gsiDemProvider.getElevationFromCache(lat, lng, zoom);
        if (elevC === null) return null;

        const elevE = this.gsiDemProvider.getElevationFromCache(lat, lng + degPerPixel, zoom);
        const elevN = this.gsiDemProvider.getElevationFromCache(lat + degPerPixel, lng, zoom);
        if (elevE === null || elevN === null) return null;

        const metersPerDegLat = 111320;
        const metersPerDegLng = 111320 * Math.cos(lat * (Math.PI / 180));
        const dx = degPerPixel * metersPerDegLng;
        const dy = degPerPixel * metersPerDegLat;
        if (dx === 0 || dy === 0) return null;

        const dzdx = (elevE - elevC) / dx;
        const dzdy = (elevN - elevC) / dy;

        const nx = -dzdx, ny = -dzdy, nz = 1;
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);

        const sx = Math.sin(sunAzimuthRad) * Math.cos(sunAltRad);
        const sy = Math.cos(sunAzimuthRad) * Math.cos(sunAltRad);
        const sz = Math.sin(sunAltRad);

        const dot = (nx * sx + ny * sy + nz * sz) / nlen;
        return Math.max(0, Math.min(1, dot));
    }

    /**
     * 方位角・高度角(度) → 画面座標(px) 変換。
     * 💡 以前は「角度に比例して直線的にピクセル位置が決まる」円筒(パノラマ)的な投影
     * (角度=ピクセルの単純な線形写像)だったが、実際のカメラのレンズは正射影ではなく
     * 透視投影(レクチリニア)で、画角の端に近づくほど tan() の効果で像が引き伸ばされる。
     * 実写真(特に望遠で圧縮された遠景の山)と正確に重ね合わせるには、この透視投影の
     * 数式 x = f・tan(Δaz), y = f・tan(Δalt) で画面位置を求める必要があるため変更した。
     * (画角が数度〜十数度程度の望遠域では線形近似との差はごく僅かだが、広角側で誤差が
     * 大きくなるため、常に正しい透視投影で統一している)
     */
    azAltToScreen(az, alt, w, h) {
        let diffAz = az - this.camera.azimuth;
        while (diffAz > 180) diffAz -= 360;
        while (diffAz < -180) diffAz += 360;

        const halfFov = this.camera.fov / 2;
        const RAD = Math.PI / 180;

        // 透視投影では ±90° で tan が発散するため、画角の端より手前で「背面」扱いにする
        if (Math.abs(diffAz) >= 89.5) {
            return { visible: false, isBehind: true, x: -9999, y: -9999 };
        }

        const tanHalfFov = Math.tan(halfFov * RAD);
        const x = (w / 2) + (w / 2) * (Math.tan(diffAz * RAD) / tanHalfFov);

        const effectivePitch = this.camera.pitch;
        const diffAlt = alt - effectivePitch;

        if (Math.abs(diffAlt) >= 89.5) {
            return { visible: false, isBehind: true, x: -9999, y: -9999 };
        }

        // 垂直画角は「水平画角とアスペクト比(h/w)」から透視投影として正しい関係式で導出:
        // tan(垂直半画角) = tan(水平半画角) × (h/w)  ※焦点距離が水平・垂直で共通という前提
        const halfVerticalFovRad = Math.atan(tanHalfFov * (h / w));
        const y = (h / 2) - (h / 2) * (Math.tan(diffAlt * RAD) / Math.tan(halfVerticalFovRad));

        const marginX = w * 3;
        const marginY = h * 3;
        const visible = (x >= -marginX && x <= w + marginX && y >= -marginY && y <= h + marginY);
        return { visible, isBehind: false, x, y };
    }

    render() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width === 0 || height === 0) return;

        this.ctx.clearRect(0, 0, width, height);

        const sunPos = this.astroEngine.getSunPosition(this.activeDate, this.camera.lat, this.camera.lng);
        this.renderSkyBackground(width, height, sunPos.altitude);

        // 1. 地形・山肌プロファイル描画
        this.renderGSISweepTerrainProfileWithDepthColors(width, height, sunPos);

        // 2. 天体（太陽・月・星）およびリアルレンズフレア
        if (this.showCelestial) {
            this.renderCelestialObjects(width, height, sunPos);
        }

        // 3. 山名・目標タグ描画 (目標物のみ抽出大画面化)
        if (this.showPeakTags) {
            this.renderPeakTags(width, height, sunPos);
        }

        // 4. パノラマ写真調 ビネット効果
        this.renderVignetteEffect(width, height);

        // 5. 方位コンパスバー
        this.renderCompassBar(width, height);
    }

    renderSkyBackground(w, h, sunAltitude) {
        const grad = this.ctx.createLinearGradient(0, 0, 0, h);

        if (sunAltitude > 8) {
            grad.addColorStop(0, '#0284c7');
            grad.addColorStop(0.4, '#38bdf8');
            grad.addColorStop(0.75, '#7dd3fc');
            grad.addColorStop(1, '#e0f2fe');
        } else if (sunAltitude > -4) {
            grad.addColorStop(0, '#0f172a');
            grad.addColorStop(0.2, '#3b0764');
            grad.addColorStop(0.45, '#86198f');
            grad.addColorStop(0.7, '#d946ef');
            grad.addColorStop(0.88, '#f97316');
            grad.addColorStop(1, '#fde047');
        } else if (sunAltitude > -16) {
            grad.addColorStop(0, '#020617');
            grad.addColorStop(0.5, '#0f172a');
            grad.addColorStop(1, '#3b0764');
        } else {
            grad.addColorStop(0, '#020617');
            grad.addColorStop(0.7, '#090d16');
            grad.addColorStop(1, '#0f172a');
        }

        this.ctx.fillStyle = grad;
        this.ctx.fillRect(0, 0, w, h);

        if (sunAltitude < 0) {
            this.renderBackgroundStars(w, h, Math.min(1, (-sunAltitude) / 12));
        }
    }

    renderBackgroundStars(w, h, opacity) {
        this.ctx.save();
        this.ctx.fillStyle = `rgba(255, 255, 255, ${opacity * 0.9})`;
        for (let i = 0; i < 180; i++) {
            const sx = (Math.sin(i * 999) * 0.5 + 0.5) * w;
            const sy = (Math.cos(i * 333) * 0.5 + 0.5) * (h * 0.65);
            const size = (i % 5 === 0) ? 2.2 : 1.2;
            this.ctx.beginPath();
            this.ctx.arc(sx, sy, size, 0, Math.PI * 2);
            this.ctx.fill();
        }
        this.ctx.restore();
    }

    isOccludedByTerrain(x, y) {
        if (!this.horizonYMap || this.horizonYMap.length === 0) return false;
        const ix = Math.floor(Math.max(0, Math.min(this.horizonYMap.length - 1, x)));
        const horizonY = this.horizonYMap[ix];
        return y > horizonY + 2;
    }

    renderCelestialObjects(w, h, sunPos) {
        const moonPos = this.astroEngine.getMoonPosition(this.activeDate, this.camera.lat, this.camera.lng);

        if (this.showTrack) {
            this.renderBodyTrack(w, h, 'sun', '#ffb703');
            this.renderBodyTrack(w, h, 'moon', '#38bdf8');
        }

        // ☀️ 太陽
        const sunScreen = this.azAltToScreen(sunPos.azimuth, sunPos.altitude, w, h);
        if (sunScreen.visible && !sunScreen.isBehind) {
            const isBehindMountain = this.isOccludedByTerrain(sunScreen.x, sunScreen.y);
            this.ctx.save();
            if (isBehindMountain) this.ctx.globalAlpha = 0.35;

            const sunGlow = this.ctx.createRadialGradient(sunScreen.x, sunScreen.y, 4, sunScreen.x, sunScreen.y, 70);
            sunGlow.addColorStop(0, 'rgba(255, 255, 255, 1)');
            sunGlow.addColorStop(0.2, 'rgba(254, 240, 138, 0.95)');
            sunGlow.addColorStop(0.5, 'rgba(249, 115, 22, 0.5)');
            sunGlow.addColorStop(1, 'rgba(255, 183, 3, 0)');
            this.ctx.fillStyle = sunGlow;
            this.ctx.beginPath();
            this.ctx.arc(sunScreen.x, sunScreen.y, 70, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.strokeStyle = 'rgba(255, 254, 235, 0.6)';
            this.ctx.lineWidth = 1.5;
            for (let a = 0; a < 8; a++) {
                const angle = (a * Math.PI / 4);
                this.ctx.beginPath();
                this.ctx.moveTo(sunScreen.x - Math.cos(angle) * 90, sunScreen.y - Math.sin(angle) * 90);
                this.ctx.lineTo(sunScreen.x + Math.cos(angle) * 90, sunScreen.y + Math.sin(angle) * 90);
                this.ctx.stroke();
            }

            this.ctx.fillStyle = '#ffffff';
            this.ctx.beginPath();
            this.ctx.arc(sunScreen.x, sunScreen.y, 16, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();

            this.drawCelestialLabel(sunScreen.x, sunScreen.y - 28, `太陽 (高度:${sunPos.altitude.toFixed(1)}°)`, '#ffb703', isBehindMountain);
        }

        // 🌙 月
        const moonScreen = this.azAltToScreen(moonPos.azimuth, moonPos.altitude, w, h);
        if (moonScreen.visible && !moonScreen.isBehind) {
            const isBehindMountain = this.isOccludedByTerrain(moonScreen.x, moonScreen.y);
            this.ctx.save();
            if (isBehindMountain) this.ctx.globalAlpha = 0.35;

            const moonRadius = 15;
            const moonGlow = this.ctx.createRadialGradient(moonScreen.x, moonScreen.y, 4, moonScreen.x, moonScreen.y, 45);
            moonGlow.addColorStop(0, 'rgba(248, 250, 252, 0.95)');
            moonGlow.addColorStop(0.5, 'rgba(56, 189, 248, 0.4)');
            moonGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
            this.ctx.fillStyle = moonGlow;
            this.ctx.beginPath();
            this.ctx.arc(moonScreen.x, moonScreen.y, 45, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.fillStyle = '#0f172a';
            this.ctx.beginPath();
            this.ctx.arc(moonScreen.x, moonScreen.y, moonRadius, 0, Math.PI * 2);
            this.ctx.fill();

            const age = moonPos.age;
            this.ctx.fillStyle = '#f8fafc';
            this.ctx.shadowColor = '#38bdf8';
            this.ctx.shadowBlur = 12;

            this.ctx.beginPath();
            if (age < 14.76) {
                const k = (age / 14.76) * 2 - 1;
                this.ctx.arc(moonScreen.x, moonScreen.y, moonRadius, -Math.PI / 2, Math.PI / 2, false);
                this.ctx.ellipse(moonScreen.x, moonScreen.y, Math.abs(k) * moonRadius, moonRadius, 0, Math.PI / 2, -Math.PI / 2, k < 0);
            } else {
                const k = ((age - 14.76) / 14.76) * 2 - 1;
                this.ctx.arc(moonScreen.x, moonScreen.y, moonRadius, Math.PI / 2, -Math.PI / 2, false);
                this.ctx.ellipse(moonScreen.x, moonScreen.y, Math.abs(k) * moonRadius, moonRadius, 0, -Math.PI / 2, Math.PI / 2, k > 0);
            }
            this.ctx.fill();
            this.ctx.restore();

            this.drawCelestialLabel(moonScreen.x, moonScreen.y - 26, `月 (高度:${moonPos.altitude.toFixed(1)}°)`, '#38bdf8', isBehindMountain);
        }
    }

    renderBodyTrack(w, h, objectType, baseColor) {
        const trackPoints = this.astroEngine.getDailyTrack(this.activeDate, this.camera.lat, this.camera.lng, objectType);
        if (!trackPoints || trackPoints.length === 0) return;

        const isSun = (objectType === 'sun');
        const mainLineColor = isSun ? '#ff9100' : '#38bdf8';
        const glowColor = isSun ? 'rgba(255, 183, 3, 0.9)' : 'rgba(56, 189, 248, 0.9)';
        const zoomLineWidth = Math.max(2.4, 2.4 * Math.sqrt(90 / Math.max(3, this.camera.fov)));

        for (let pass = 0; pass < 2; pass++) {
            const isOccludedPass = (pass === 1);

            this.ctx.save();
            if (isOccludedPass) {
                this.ctx.globalAlpha = 0.25;
                this.ctx.strokeStyle = isSun ? '#ffb703' : '#94a3b8';
                this.ctx.lineWidth = Math.max(1.8, zoomLineWidth * 0.7);
                this.ctx.setLineDash([6, 6]);
            } else {
                this.ctx.globalAlpha = 0.9;
                this.ctx.strokeStyle = mainLineColor;
                this.ctx.lineWidth = zoomLineWidth;
                this.ctx.setLineDash([10, 6]);
                this.ctx.shadowColor = glowColor;
                this.ctx.shadowBlur = 10;
            }

            this.ctx.beginPath();
            let isDrawing = false;

            for (let i = 0; i < trackPoints.length - 1; i++) {
                const p1 = trackPoints[i];
                const p2 = trackPoints[i + 1];

                const s1 = this.azAltToScreen(p1.azimuth, p1.altitude, w, h);
                const s2 = this.azAltToScreen(p2.azimuth, p2.altitude, w, h);

                if (s1.isBehind || s2.isBehind) {
                    isDrawing = false;
                    continue;
                }

                const occluded1 = this.isOccludedByTerrain(s1.x, s1.y);
                const occluded2 = this.isOccludedByTerrain(s2.x, s2.y);

                if ((isOccludedPass && (occluded1 || occluded2)) || (!isOccludedPass && (!occluded1 && !occluded2))) {
                    if (!isDrawing) {
                        this.ctx.moveTo(s1.x, s1.y);
                        isDrawing = true;
                    }
                    this.ctx.lineTo(s2.x, s2.y);
                } else {
                    isDrawing = false;
                }
            }

            this.ctx.stroke();
            this.ctx.restore();
        }

        // 時刻ノード
        this.ctx.save();
        trackPoints.forEach((p) => {
            if (p.minute === 0 && p.hour % 3 === 0) {
                const screen = this.azAltToScreen(p.azimuth, p.altitude, w, h);
                if (screen.visible && !screen.isBehind) {
                    const isBehindMountain = this.isOccludedByTerrain(screen.x, screen.y);
                    this.ctx.save();
                    if (isBehindMountain) this.ctx.globalAlpha = 0.3;

                    const timeStr = `${String(p.hour).padStart(2, '0')}:00`;
                    this.ctx.fillStyle = isSun ? '#ffb703' : '#7dd3fc';
                    this.ctx.beginPath();
                    this.ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2);
                    this.ctx.fill();

                    this.ctx.font = 'bold 16px Inter, sans-serif';
                    this.ctx.fillStyle = isSun ? '#ffe066' : '#bae6fd';
                    this.ctx.textAlign = 'center';
                    this.ctx.shadowColor = 'rgba(0,0,0,0.9)';
                    this.ctx.shadowBlur = 6;
                    this.ctx.fillText(timeStr, screen.x, screen.y + 18);
                    this.ctx.restore();
                }
            }
        });
        this.ctx.restore();
    }

    drawCelestialLabel(x, y, text, color, isBehindMountain = false) {
        this.ctx.save();
        if (isBehindMountain) this.ctx.globalAlpha = 0.35;
        this.ctx.font = 'bold 16px "Inter", "Hiragino Kaku Gothic ProN", sans-serif';
        this.ctx.fillStyle = color;
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        this.ctx.shadowBlur = 6;
        this.ctx.fillText(text, x, y);
        this.ctx.restore();
    }

    renderGSISweepTerrainProfileWithDepthColors(w, h, sunPos) {
        this.visiblePeaksInScreen = [];
        this.horizonYMap = new Array(w).fill(h);

        const calculatedPeaks = [];
        this.peaks.forEach(peak => {
            const { bearing, distance } = this.calculateBearingAndDistance(
                this.camera.lat, this.camera.lng, peak.lat, peak.lng
            );

            if (distance <= this.camera.maxDistance && distance >= 0.1) {
                const alt = this.calculateApparentAltitude(this.camera.elev, this.camera.eyeHeight, peak.elev || 0, distance);
                const screen = this.azAltToScreen(bearing, alt * this.camera.elevScale, w, h);

                if (screen.visible && !screen.isBehind) {
                    const peakData = {
                        ...peak,
                        bearing,
                        distance,
                        apparentAlt: alt,
                        screenX: screen.x,
                        screenY: screen.y
                    };
                    calculatedPeaks.push(peakData);
                    this.visiblePeaksInScreen.push(peakData);
                }
            }
        });

        const isDaytime = sunPos.altitude > 0;
        const isSunset = sunPos.altitude <= 0 && sunPos.altitude > -12;

        // 🏔️ 深度レイヤー定義: 遠景(奥の稜線)→近景(手前の稜線)の順。
        // 各レイヤーに DEM ズームレベル(zoom)を個別指定。
        // 💡 稜線の「形」の正確さを最優先するため、剱岳のような遠景の主要ターゲット
        // (概ね40〜80km帯に入ることが多い)でも尖った岩峰がなだらかに潰れないよう、
        // 中距離帯のズームレベルを大幅に引き上げた(旧: 11/12 → 新: 13/13)。
        const layers = [
            {
                minD: 80,  maxD: 180, zoom: 11,
                dayTop: '#78c7ff', dayBottom: '#2b5288',
                sunsetTop: '#a255b8', sunsetBottom: '#421d5c',
                nightTop: '#2d2b69', nightBottom: '#0e1224',
                stroke: isDaytime ? '#cce7ff' : (isSunset ? '#fbbfe0' : '#82b4ff'),
                strokeWidth: 2.2, hazeAlpha: 0.22
            },
            {
                minD: 40,  maxD: 80, zoom: 13,
                dayTop: '#38a5e8', dayBottom: '#182b47',
                sunsetTop: '#8c259c', sunsetBottom: '#281b4b',
                nightTop: '#1e306e', nightBottom: '#0a0d1e',
                stroke: isDaytime ? '#9be1ff' : (isSunset ? '#f49bf9' : '#5995f9'),
                strokeWidth: 1.8, hazeAlpha: 0.14
            },
            {
                minD: 20,  maxD: 40, zoom: 13,
                dayTop: '#1080c2', dayBottom: '#0d1829',
                sunsetTop: '#6e1d94', sunsetBottom: '#191c33',
                nightTop: '#13214c', nightBottom: '#060a17',
                stroke: isDaytime ? '#56ccff' : (isSunset ? '#d946ef' : '#3b82f6'),
                strokeWidth: 1.5, hazeAlpha: 0.08
            },
            {
                minD: 8,   maxD: 20, zoom: 14,
                dayTop: '#066299', dayBottom: '#060d17',
                sunsetTop: '#4a1175', sunsetBottom: '#101322',
                nightTop: '#0b1433', nightBottom: '#03050d',
                stroke: isDaytime ? '#0284c7' : (isSunset ? '#b51bbd' : '#2563eb'),
                strokeWidth: 1.3, hazeAlpha: 0.03
            },
            {
                minD: 0.2, maxD: 8, zoom: 14,
                dayTop: '#074266', dayBottom: '#02050c',
                sunsetTop: '#320b57', sunsetBottom: '#050711',
                nightTop: '#050a1a', nightBottom: '#000000',
                stroke: isDaytime ? '#38bdf8' : (isSunset ? '#f472b6' : '#38bdf8'),
                strokeWidth: 2.5, hazeAlpha: 0
            }
        ];

        // 🔭 ズーム連動DEM解像度ブースト:
        // 距離帯ごとの基準ズーム(上記layer.zoom)は「引き(広角)で見た時」を基準に設定しているため、
        // 望遠側(fov小)にズームするほど、画面1pxが表す実距離が縮み、DEMタイルの格子(数m〜十数m)
        // そのものの粗さが目に見えるようになってしまう(=10xでは滑らかなのに30xでは荒く見える原因)。
        // → 画角(fov)が狭いほど、実際に取得するDEMズームレベルを引き上げて、
        // 「何倍で見ても、同じ現実解像度が画面に対して同じ密度で映る」状態に近づける。
        // 国土地理院DEMタイルの実用上限が z14 前後のため、そこで頭打ちにしている。
        const GSI_MAX_SAFE_ZOOM = 14;
        let fovZoomBoost = 0;
        if (this.camera.fov <= 6) fovZoomBoost = 2;       // 概ね15倍相当以上の超望遠
        else if (this.camera.fov <= 15) fovZoomBoost = 1;  // 概ね6〜15倍相当の望遠

        layers.forEach(layer => {
            layer.zoom = Math.min(GSI_MAX_SAFE_ZOOM, layer.zoom + fovZoomBoost);
        });

        const zoomBoost = Math.max(1.0, 45.0 / Math.max(3.0, this.camera.fov));
        // 💡 稜線の「形」の正確さを優先し、各モードのサンプリング密度を引き上げ。
        // 特に距離ステップ数(baseDistSteps)は、尖った岩峰と隣の岩峰の間の「切れ込み」を
        // 拾えるかどうかに直結するため、fast/stdでも十分な値を確保する。
        let rayDensityMult = 0.9;   // 従来 0.7
        let baseDistSteps = 16;     // 従来 12
        if (this.resMode === 'high') {
            rayDensityMult = 3.2;   // 従来 2.8
            baseDistSteps = 40;     // 従来 32
        } else if (this.resMode === 'std') {
            rayDensityMult = 1.8;   // 従来 1.5
            baseDistSteps = 26;     // 従来 20
        } else { // 'fast'
            rayDensityMult = 0.9;
            baseDistSteps = 16;
        }

        const numRays = Math.floor(w * rayDensityMult * Math.min(2.5, zoomBoost));
        const rayStepAz = this.camera.fov / numRays;
        const startAz = this.camera.azimuth - this.camera.fov / 2;

        // 🔭 事前一括タイルリクエスト: 各レイヤー×各レイの必要タイル座標を先に列挙し、
        // 重複を除いてまとめてロード要求を出す。従来はサンプリングループの途中で
        // 初めて「未キャッシュ」に気づいてロード開始していたため、同一フレーム内で
        // 後発の要求が先発のキャッシュを圧迫し合う「タイル取り合い」が起きやすかった。
        const neededTileKeys = new Set();
        layers.forEach(layer => {
            const layerMaxD = Math.min(layer.maxD, this.camera.maxDistance);
            if (layerMaxD <= layer.minD) return;
            const distSteps = Math.max(2, Math.floor(baseDistSteps * Math.min(2.0, zoomBoost) * 0.5));
            const stepDistKm = (layerMaxD - layer.minD) / distSteps;
            const azSampleStep = Math.max(1, Math.floor(numRays / 60)); // 間引いて代表タイルのみ先読み
            for (let i = 0; i <= numRays; i += azSampleStep) {
                const currentAz = startAz + i * rayStepAz;
                for (let s = 0; s <= distSteps; s++) {
                    const distKm = layer.minD + s * stepDistKm;
                    const pt = this.destinationPoint(this.camera.lat, this.camera.lng, distKm, currentAz);
                    const t = this.gsiDemProvider.latLngToTile(pt.lat, pt.lng, layer.zoom);
                    neededTileKeys.add(`${layer.zoom}/${t.tileX}/${t.tileY}`);
                }
            }
        });
        neededTileKeys.forEach(k => {
            const [z, x, y] = k.split('/').map(Number);
            this.gsiDemProvider.loadTile(z, x, y);
        });

        // 🌄 ヒルシェード有効フラグ ＆ 太陽方向ベクトル用ラジアン値を事前計算
        // (深夜など太陽が沈み切っている時間帯は方向性のある陰影を付けても不自然なため無効化)
        const enableHillshade = sunPos.altitude > -6;
        const sunAzimuthRad = sunPos.azimuth * (Math.PI / 180);
        const sunAltRad = Math.max(-6, sunPos.altitude) * (Math.PI / 180);
        const HILLSHADE_MIN_LAYER_IDX = 2; // 20km以内の3レイヤーのみ陰影計算(遠景は空気遠近法のかすみで十分)

        layers.forEach((layer, layerIdx) => {
            // 📏 カメラの表示上限距離(maxDistance)より奥のレイヤーは丸ごとスキップし、
            // 節約できた分をより近いレイヤーの精細度に還元する。
            if (layer.minD >= this.camera.maxDistance) return;
            const layerMaxD = Math.min(layer.maxD, this.camera.maxDistance);

            const rayData = [];
            const layerHasShade = enableHillshade && layerIdx >= HILLSHADE_MIN_LAYER_IDX;

            for (let i = 0; i <= numRays; i++) {
                const currentAz = startAz + i * rayStepAz;

                let maxAltInRay = 0;
                let bestPt = null;
                const distSteps = Math.floor(baseDistSteps * Math.min(2.0, zoomBoost));
                const stepDistKm = (layerMaxD - layer.minD) / distSteps;

                for (let s = 0; s <= distSteps; s++) {
                    const distKm = layer.minD + s * stepDistKm;
                    const samplePt = this.destinationPoint(this.camera.lat, this.camera.lng, distKm, currentAz);

                    const gsiElev = this.gsiDemProvider.getElevationFromCache(samplePt.lat, samplePt.lng, layer.zoom);
                    if (gsiElev !== null && gsiElev > 0) {
                        const gsiAlt = this.calculateApparentAltitude(this.camera.elev, this.camera.eyeHeight, gsiElev, distKm) * this.camera.elevScale;
                        if (gsiAlt > maxAltInRay) {
                            maxAltInRay = gsiAlt;
                            bestPt = samplePt;
                        }
                    }
                }

                let peakBoosted = false;
                calculatedPeaks.forEach(pk => {
                    if (pk.distance >= layer.minD && pk.distance <= layerMaxD) {
                        let azDiff = Math.abs(currentAz - pk.bearing);
                        if (azDiff > 180) azDiff = 360 - azDiff;

                        const isTarget = (pk.id === this.selectedTargetPeakId);
                        const peakWidth = Math.max(0.6, (pk.elev / 1000) / (pk.distance * 0.15));

                        if (azDiff < peakWidth) {
                            const factor = Math.cos((azDiff / peakWidth) * (Math.PI / 2));
                            const pkAlt = pk.apparentAlt * this.camera.elevScale * factor;
                            if (pkAlt > maxAltInRay || isTarget) {
                                maxAltInRay = Math.max(maxAltInRay, pkAlt);
                                peakBoosted = true;
                            }
                        }
                    }
                });

                // 陰影計算: DEM実測点由来の稜線点についてのみ、局所傾斜と太陽方向から明暗係数を算出
                let shade = null;
                if (layerHasShade && !peakBoosted && bestPt && maxAltInRay > 0) {
                    shade = this.getHillshadeFactor(bestPt.lat, bestPt.lng, layer.zoom, sunAzimuthRad, sunAltRad);
                }

                const screen = this.azAltToScreen(currentAz, maxAltInRay, w, h);
                // 💡 x座標も同じ透視投影の azAltToScreen から取得することで、稜線と
                // 太陽・月・ピーク注記などの重畳オブジェクトの水平位置を完全に一致させる。
                const x = screen.x;
                const screenY = Math.min(h, Math.max(h * 0.05, screen.y));
                rayData.push({ x, y: screenY, alt: maxAltInRay, shade });

                const ix = Math.floor(Math.max(0, Math.min(w - 1, x)));
                if (screenY < this.horizonYMap[ix]) {
                    this.horizonYMap[ix] = screenY;
                }
            }

            // 📐 稜線の描画: 直線セグメント接続(lineTo)で DEM が持つ実際の凹凸をそのまま描く。
            // 💡 以前はベジェ曲線(quadraticCurveTo)で各点間を滑らかに補間していたが、
            // 剱岳の八ツ峰のような鋭く切れ込んだ岩峰の連なりは、実際には滑らかな曲線ではなく
            // 角ばった鋭いギザギザである。曲線補間はこの「切れ込み」を丸めてぼかしてしまい、
            // 実写と比べて山が団子状に見える原因になっていた。直線接続＋高いサンプリング密度
            // (上のray/dist密度引き上げ)の組み合わせにより、DEMが捉えた鋭い稜線をそのまま再現する。
            this.ctx.beginPath();
            this.ctx.moveTo(0, h);

            if (rayData.length > 0) {
                this.ctx.lineTo(rayData[0].x, rayData[0].y);
                for (let i = 1; i < rayData.length; i++) {
                    this.ctx.lineTo(rayData[i].x, rayData[i].y);
                }
            }

            this.ctx.lineTo(w, h);
            this.ctx.closePath();

            this.ctx.save();
            this.ctx.lineJoin = 'round';
            this.ctx.lineCap = 'round';

            if (this.styleMode === 'wireframe') {
                this.ctx.strokeStyle = layer.stroke;
                this.ctx.lineWidth = layer.strokeWidth;
                this.ctx.stroke();
            } else if (this.styleMode === 'silhouette') {
                this.ctx.fillStyle = `rgba(0, 0, 0, ${0.92 + layerIdx * 0.015})`;
                this.ctx.fill();
                this.ctx.strokeStyle = '#475569';
                this.ctx.lineWidth = 1.0;
                this.ctx.stroke();
            } else {
                const terrainGrad = this.ctx.createLinearGradient(0, h * 0.2, 0, h);
                
                if (isDaytime) {
                    terrainGrad.addColorStop(0, layer.dayTop);
                    terrainGrad.addColorStop(1, layer.dayBottom);
                } else if (isSunset) {
                    terrainGrad.addColorStop(0, layer.sunsetTop);
                    terrainGrad.addColorStop(1, layer.sunsetBottom);
                } else {
                    terrainGrad.addColorStop(0, layer.nightTop);
                    terrainGrad.addColorStop(1, layer.nightBottom);
                }

                this.ctx.fillStyle = terrainGrad;
                this.ctx.fill();

                this.ctx.save();
                this.ctx.strokeStyle = layer.stroke;
                this.ctx.lineWidth = layer.strokeWidth;
                this.ctx.shadowColor = layer.stroke;
                this.ctx.shadowBlur = layerIdx === 0 ? 10 : 4;
                this.ctx.stroke();
                this.ctx.restore();

                // 🌫️ 大気遠近法(空気遠近法)のかすみ: 遠い稜線ほど大気中の水蒸気・塵で
                // コントラストが下がり白っぽく霞んで見える現象を薄い白レイヤーで表現。
                // 実写パノラマで「奥の山ほど霞んで淡く、手前ほどくっきり濃い」実際の見え方に近づける。
                if (isDaytime && layer.hazeAlpha > 0) {
                    this.ctx.save();
                    this.ctx.fillStyle = `rgba(224, 242, 254, ${layer.hazeAlpha})`;
                    this.ctx.fill();
                    this.ctx.restore();
                }

                // 🌄 ヒルシェード陰影パス: 太陽に面した斜面を明るく、陰になった斜面を暗くして
                // 山肌に立体感を出す。セグメントごとに fill() を呼ぶと描画コストが跳ね上がるため、
                // 明暗を少数のバケットに量子化し、同じ明るさのセグメントを1つの Path2D にまとめて
                // バケット数ぶんの fill() 呼び出しに抑えている(パン操作中も滑らかに動く軽さを維持)。
                if (layerHasShade) {
                    const ambient = isSunset ? 0.5 : (isDaytime ? 0.55 : 0.62);
                    /** @type {Map<number, Path2D>} */
                    const bucketPaths = new Map();

                    for (let i = 0; i < rayData.length - 1; i++) {
                        const p1 = rayData[i];
                        const p2 = rayData[i + 1];
                        if (p1.shade === null || p2.shade === null) continue;

                        const avgShade = (p1.shade + p2.shade) / 2;
                        const lit = ambient + (1 - ambient) * avgShade;
                        const bucketKey = Math.round(lit * 10); // 0(最暗)〜10(最も順光)の11段階に量子化
                        if (bucketKey === 5) continue; // ほぼ中立(=陰影なし)は描画省略

                        let path = bucketPaths.get(bucketKey);
                        if (!path) {
                            path = new Path2D();
                            bucketPaths.set(bucketKey, path);
                        }
                        path.moveTo(p1.x, p1.y);
                        path.lineTo(p2.x, p2.y);
                        path.lineTo(p2.x, h);
                        path.lineTo(p1.x, h);
                        path.closePath();
                    }

                    if (bucketPaths.size > 0) {
                        this.ctx.save();
                        const litTint = isSunset ? '255, 196, 130' : '255, 250, 230';
                        bucketPaths.forEach((path, bucketKey) => {
                            const lit = bucketKey / 10;
                            if (lit < 0.5) {
                                this.ctx.globalCompositeOperation = 'multiply';
                                this.ctx.fillStyle = `rgba(8, 10, 18, ${Math.min(0.65, (0.5 - lit) * 1.5)})`;
                            } else {
                                this.ctx.globalCompositeOperation = 'screen';
                                this.ctx.fillStyle = `rgba(${litTint}, ${Math.min(0.55, (lit - 0.5) * 1.1)})`;
                            }
                            this.ctx.fill(path);
                        });
                        this.ctx.restore();
                    }
                }
            }

            this.ctx.restore();
        });
    }

    // 🎯 目標物（ターゲット）のみを浮き上がらせる大画面描画 ＆ 山肌遮蔽時の半透明化
    renderPeakTags(w, h, sunPos) {
        if (this.visiblePeaksInScreen.length === 0) return;

        this.renderedTagBoxes = [];
        const sunScreen = sunPos ? this.azAltToScreen(sunPos.azimuth, sunPos.altitude, w, h) : { visible: false };

        this.visiblePeaksInScreen.forEach((pk) => {
            const isTarget = (pk.id === this.selectedTargetPeakId);
            
            // 💡【ユーザーご要望1】目標物以外の山などの名前・タグ表示を完全に消去！
            if (!isTarget) return;

            const px = pk.screenX;
            const py = pk.screenY;

            // 💡【ユーザーご要望3】目標物が手前の山などに隠れている場合は薄く半透明表示！
            const isOccluded = this.isOccludedByTerrain(px, py);

            let labelY = py - 75;
            if (sunScreen.visible && Math.abs(sunScreen.x - px) < 120 && Math.abs(sunScreen.y - labelY) < 60) {
                labelY = sunScreen.y - 65;
            }

            this.ctx.save();
            if (isOccluded) {
                this.ctx.globalAlpha = 0.35; // 隠れている場合は薄く半透明化！
            } else {
                this.ctx.globalAlpha = 1.0;
            }

            // 🎯 ターゲットの垂直ガイドレーザーライン
            this.ctx.save();
            const lineGrad = this.ctx.createLinearGradient(px, 0, px, h);
            lineGrad.addColorStop(0, 'rgba(0, 245, 212, 0.95)');
            lineGrad.addColorStop(0.5, 'rgba(0, 245, 212, 0.5)');
            lineGrad.addColorStop(1, 'rgba(0, 245, 212, 0.08)');

            this.ctx.strokeStyle = lineGrad;
            this.ctx.lineWidth = 3.0;
            this.ctx.setLineDash(isOccluded ? [4, 4] : [8, 5]);
            this.ctx.beginPath();
            this.ctx.moveTo(px, 0);
            this.ctx.lineTo(px, h);
            this.ctx.stroke();

            // ターゲット照準リング
            this.ctx.setLineDash([]);
            this.ctx.strokeStyle = '#00f5d4';
            this.ctx.lineWidth = 3.5;
            this.ctx.shadowColor = 'rgba(0, 245, 212, 1.0)';
            this.ctx.shadowBlur = isOccluded ? 6 : 18;

            this.ctx.beginPath();
            this.ctx.arc(px, py, 22, 0, Math.PI * 2);
            this.ctx.stroke();

            // 十字照準線
            this.ctx.lineWidth = 2.5;
            this.ctx.beginPath();
            this.ctx.moveTo(px - 30, py); this.ctx.lineTo(px - 14, py);
            this.ctx.moveTo(px + 14, py); this.ctx.lineTo(px + 30, py);
            this.ctx.moveTo(px, py - 30); this.ctx.lineTo(px, py - 14);
            this.ctx.moveTo(px, py + 14); this.ctx.lineTo(px, py + 30);
            this.ctx.stroke();
            this.ctx.restore();

            // タグ線
            this.ctx.strokeStyle = '#00f5d4';
            this.ctx.lineWidth = 3.5;
            this.ctx.beginPath();
            this.ctx.moveTo(px, py);
            this.ctx.lineTo(px, labelY + 20);
            this.ctx.stroke();

            // 山頂中心ドット
            this.ctx.fillStyle = '#00f5d4';
            this.ctx.shadowColor = 'rgba(0, 245, 212, 1.0)';
            this.ctx.shadowBlur = 20;
            this.ctx.beginPath();
            this.ctx.arc(px, py, 9.0, 0, Math.PI * 2);
            this.ctx.fill();

            // ネームタグボックス
            const altSign = pk.apparentAlt >= 0 ? '+' : '';
            const occludedBadge = isOccluded ? ' (山肌の裏側)' : '';
            const labelText = `🎯 目標: ${pk.name} (${pk.elev}m)${occludedBadge}`;
            const distText = `${pk.distance.toFixed(1)}km / 方位${pk.bearing.toFixed(0)}° / 仰角${altSign}${pk.apparentAlt.toFixed(1)}°`;

            this.ctx.font = 'bold 22px "Inter", "Hiragino Kaku Gothic ProN", sans-serif';
            const w1 = this.ctx.measureText(labelText).width;
            
            this.ctx.font = '16px "Inter", sans-serif';
            const w2 = this.ctx.measureText(distText).width;

            const textWidth = Math.max(w1, w2);
            const boxWidth = textWidth + 28;
            const boxHeight = 62;
            const boxX = px - boxWidth / 2;
            const boxY = labelY - boxHeight + 12;

            this.renderedTagBoxes.push({
                peakId: pk.id,
                peakName: pk.name,
                boxX, boxY, boxWidth, boxHeight
            });

            this.ctx.fillStyle = isOccluded ? 'rgba(6, 78, 59, 0.65)' : 'rgba(6, 78, 59, 0.96)';
            this.ctx.strokeStyle = '#00f5d4';
            this.ctx.lineWidth = 3.0;
            this.ctx.shadowColor = 'rgba(0, 245, 212, 0.9)';
            this.ctx.shadowBlur = isOccluded ? 6 : 16;
            
            this.roundRect(this.ctx, boxX, boxY, boxWidth, boxHeight, 10, true, true);

            this.ctx.font = 'bold 22px "Inter", "Hiragino Kaku Gothic ProN", sans-serif';
            this.ctx.fillStyle = '#00f5d4';
            this.ctx.textAlign = 'center';
            this.ctx.shadowBlur = 0;
            this.ctx.fillText(labelText, px, boxY + 26);

            this.ctx.font = '16px "Inter", sans-serif';
            this.ctx.fillStyle = '#a7f3d0';
            this.ctx.fillText(distText, px, boxY + 48);

            this.ctx.restore();
        });
    }

    renderVignetteEffect(w, h) {
        this.ctx.save();
        const vignetteGrad = this.ctx.createRadialGradient(w / 2, h / 2, Math.max(w, h) * 0.4, w / 2, h / 2, Math.max(w, h) * 0.75);
        vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vignetteGrad.addColorStop(1, 'rgba(0,0,0,0.42)');
        this.ctx.fillStyle = vignetteGrad;
        this.ctx.fillRect(0, 0, w, h);
        this.ctx.restore();
    }

    hitTestPeak(mouseX, mouseY) {
        for (let i = this.renderedTagBoxes.length - 1; i >= 0; i--) {
            const b = this.renderedTagBoxes[i];
            if (mouseX >= b.boxX && mouseX <= b.boxX + b.boxWidth &&
                mouseY >= b.boxY && mouseY <= b.boxY + b.boxHeight) {
                return b;
            }
        }
        return null;
    }

    roundRect(ctx, x, y, width, height, radius, fill, stroke) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        if (fill) ctx.fill();
        if (stroke) ctx.stroke();
    }

    renderCompassBar(w, h) {
        this.ctx.save();
        const barGrad = this.ctx.createLinearGradient(0, 0, 0, 36);
        barGrad.addColorStop(0, 'rgba(15, 23, 42, 0.9)');
        barGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
        this.ctx.fillStyle = barGrad;
        this.ctx.fillRect(0, 0, w, 36);

        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, 36);
        this.ctx.lineTo(w, 36);
        this.ctx.stroke();

        const halfFov = this.camera.fov / 2;
        const startAz = this.camera.azimuth - halfFov;
        const endAz = this.camera.azimuth + halfFov;

        for (let az = Math.floor(startAz / 5) * 5; az <= endAz; az += 5) {
            let normAz = (az + 360) % 360;
            const screen = this.azAltToScreen(normAz, 0, w, h);

            if (screen.x >= 0 && screen.x <= w && !screen.isBehind) {
                const isMajor = (normAz % 15 === 0);
                const isCardinal = (normAz % 90 === 0);
                const tickHeight = isCardinal ? 14 : (isMajor ? 10 : 6);

                this.ctx.strokeStyle = isCardinal ? '#38bdf8' : (isMajor ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)');
                this.ctx.lineWidth = isCardinal ? 2 : 1;
                this.ctx.beginPath();
                this.ctx.moveTo(screen.x, 36);
                this.ctx.lineTo(screen.x, 36 - tickHeight);
                this.ctx.stroke();

                if (isMajor || isCardinal) {
                    let label = `${Math.round(normAz)}°`;
                    if (normAz === 0) label = '北 (N)';
                    else if (normAz === 90) label = '東 (E)';
                    else if (normAz === 180) label = '南 (S)';
                    else if (normAz === 270) label = '西 (W)';

                    this.ctx.font = isCardinal ? 'bold 13px Inter, sans-serif' : '11px Inter, sans-serif';
                    this.ctx.fillStyle = isCardinal ? '#38bdf8' : '#cbd5e1';
                    this.ctx.textAlign = 'center';
                    this.ctx.fillText(label, screen.x, 16);
                }
            }
        }

        this.ctx.strokeStyle = '#38bdf8';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(w / 2, 30);
        this.ctx.lineTo(w / 2, 40);
        this.ctx.stroke();

        this.ctx.restore();
    }
}

window.TerrainEngine = TerrainEngine;
