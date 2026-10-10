/**
 * 2Dインタラクティブ地図 ＆ ダイヤビーム描画コントローラー (MapController v2.0)
 * 天空全高度のダイヤモンド重なり射線 ＆ ベスト視点スターマーカープロット対応
 */

class MapController {
    constructor(mapContainerId, onCameraChange, onTargetChange) {
        this.containerId = mapContainerId;
        this.onCameraChange = onCameraChange;
        this.onTargetChange = onTargetChange;

        this.map = null;
        this.observerMarker = null;
        this.targetMarker = null;
        this.bestSpotMarker = null;
        this.beamPolyline = null;
        this.beamZonePolygon = null;
        this.fovPolygon = null;
        
        this.activeMode = 'observer';
        this.currentTileType = 'std'; // 'std' or 'photo'
        this.stdTileLayer = null;
        this.photoTileLayer = null;

        this.initMap();
    }

    initMap() {
        const defaultLat = 36.6236; // 初期: 剱岳周辺 (富山県)
        const defaultLng = 137.2113;

        this.map = L.map(this.containerId, {
            center: [defaultLat, defaultLng],
            zoom: 10,
            zoomControl: true
        });

        // 国土地理院 標準地図
        this.stdTileLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院 標準地図</a>'
        });

        // 国土地理院 航空写真 (シームレス写真)
        this.photoTileLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
            maxZoom: 18,
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院 航空写真</a>'
        });

        // 初期レイヤー追加 (標準地図)
        this.stdTileLayer.addTo(this.map);

        // 視点ピン (📍 青アイコン)
        const obsIcon = L.divIcon({
            className: 'custom-obs-marker',
            html: `<div style="background-color:#0284c7; width:22px; height:22px; border-radius:50%; border:3px solid white; box-shadow:0 0 12px rgba(2,132,199,0.9); display:flex; align-items:center; justify-content:center; color:white; font-size:11px;"><i class="fa-solid fa-eye"></i></div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        this.observerMarker = L.marker([defaultLat, defaultLng], {
            draggable: true,
            icon: obsIcon
        }).addTo(this.map);

        let dragObsTimer = null;
        this.observerMarker.on('drag', (e) => {
            if (dragObsTimer) return;
            dragObsTimer = requestAnimationFrame(() => {
                dragObsTimer = null;
                const pos = e.target.getLatLng();
                if (this.onCameraChange) {
                    this.onCameraChange(pos.lat, pos.lng);
                }
            });
        });

        // 目標物ターゲットピン (🎯 シアンアイコン)
        const targetIcon = L.divIcon({
            className: 'custom-target-marker',
            html: `<div style="background-color:#00f5d4; width:24px; height:24px; border-radius:50%; border:3px solid #0f172a; box-shadow:0 0 14px rgba(0,245,212,0.95); display:flex; align-items:center; justify-content:center; color:#0f172a; font-size:12px; font-weight:bold;"><i class="fa-solid fa-crosshairs"></i></div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        this.targetMarker = L.marker([36.6236, 137.6169], { // 剱岳
            draggable: true,
            icon: targetIcon
        }).addTo(this.map);

        let dragTgtTimer = null;
        this.targetMarker.on('drag', (e) => {
            if (dragTgtTimer) return;
            dragTgtTimer = requestAnimationFrame(() => {
                dragTgtTimer = null;
                const pos = e.target.getLatLng();
                if (this.onTargetChange) {
                    this.onTargetChange(pos.lat, pos.lng);
                }
            });
        });

        // マップクリック時：現在選択モード (視点指定 or 目標指定) に応じてピン移動
        this.map.on('click', (e) => {
            if (this.activeMode === 'target') {
                this.targetMarker.setLatLng(e.latlng);
                if (this.onTargetChange) {
                    this.onTargetChange(e.latlng.lat, e.latlng.lng);
                }
            } else {
                this.observerMarker.setLatLng(e.latlng);
                if (this.onCameraChange) {
                    this.onCameraChange(e.latlng.lat, e.latlng.lng);
                }
            }
        });

        this.addPeakMarkersToMap();
    }

    setTileType(type) {
        if (type === 'photo') {
            if (this.map.hasLayer(this.stdTileLayer)) this.map.removeLayer(this.stdTileLayer);
            this.photoTileLayer.addTo(this.map);
            this.currentTileType = 'photo';
        } else {
            if (this.map.hasLayer(this.photoTileLayer)) this.map.removeLayer(this.photoTileLayer);
            this.stdTileLayer.addTo(this.map);
            this.currentTileType = 'std';
        }
    }

    /**
     * 2D地図上に「太陽/月 ＋ 目標物」が重なって見えるダイヤビーム直線（アライメント線）＆ベスト重なりスポットをプロット
     */
    updateAlignmentBeamOnMap(beamResult) {
        if (!beamResult || !beamResult.beamLinePoints) return;

        const isSun = (beamResult.celestialType === 'sun');
        const beamColor = isSun ? '#ff9100' : '#38bdf8';
        const zoneColor = isSun ? '#ffb703' : '#7dd3fc';

        // 1. 既存レイヤー削除
        if (this.beamPolyline) this.map.removeLayer(this.beamPolyline);
        if (this.beamZonePolygon) this.map.removeLayer(this.beamZonePolygon);
        if (this.bestSpotMarker) this.map.removeLayer(this.bestSpotMarker);

        // 2. 可視推奨エリアポリゴンの描画
        if (beamResult.polygonCoords) {
            this.beamZonePolygon = L.polygon(beamResult.polygonCoords, {
                color: zoneColor,
                fillColor: zoneColor,
                fillOpacity: 0.15,
                weight: 1,
                dashArray: '4, 4'
            }).addTo(this.map);
        }

        // 3. ダイヤアライメント・ビーム直線の描画 (目標物から伸びる太いネオン直線)
        const latLngs = beamResult.beamLinePoints.map(p => [p.lat, p.lng]);
        this.beamPolyline = L.polyline(latLngs, {
            color: beamColor,
            weight: 4.5,
            opacity: 0.9,
            dashArray: '10, 6'
        }).addTo(this.map);

        const altDegStr = beamResult.astroPos.altitude.toFixed(1);
        this.beamPolyline.bindTooltip(
            `<b>🎯 ${beamResult.targetPeak.name} ✕ ${isSun ? '☀️ 太陽' : '🌙 月'} 重なりアライメント直線</b><br>現在の天体高度: ${altDegStr}° | 破線上のどこから見ても目標物と重ねて見えます！`, 
            { sticky: true }
        );

        // ビーム線クリックで即座にその場所へ視点を移動
        this.beamPolyline.on('click', (e) => {
            this.observerMarker.setLatLng(e.latlng);
            if (this.onCameraChange) {
                this.onCameraChange(e.latlng.lat, e.latlng.lng);
            }
        });

        // 4. 高度角に応じた「ベスト重なり観察スポット（⭐スターピン）」の描画
        if (beamResult.bestSpotPt) {
            const starIcon = L.divIcon({
                className: 'custom-star-marker',
                html: `<div style="background-color:#ffb703; width:26px; height:26px; border-radius:50%; border:3px solid #0f172a; box-shadow:0 0 16px rgba(255,183,3,1.0); display:flex; align-items:center; justify-content:center; color:#0f172a; font-size:14px; font-weight:bold;"><i class="fa-solid fa-star"></i></div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });

            this.bestSpotMarker = L.marker([beamResult.bestSpotPt.lat, beamResult.bestSpotPt.lng], {
                icon: starIcon
            }).addTo(this.map);

            this.bestSpotMarker.bindTooltip(
                `<b>⭐ 重なりジャスト視点スポット</b><br>${beamResult.targetPeak.name}山頂と${isSun ? '太陽' : '月'}がピッタリ高さ重なる一押し位置 (距離:${beamResult.bestDistanceKm.toFixed(1)}km)`,
                { sticky: true }
            );

            this.bestSpotMarker.on('click', () => {
                this.observerMarker.setLatLng([beamResult.bestSpotPt.lat, beamResult.bestSpotPt.lng]);
                if (this.onCameraChange) {
                    this.onCameraChange(beamResult.bestSpotPt.lat, beamResult.bestSpotPt.lng);
                }
            });
        }

        // 5. 2Dマップ上に天体 (☀️ 太陽 / 🌙 月) 位置方向マーカーを表示
        if (this.celestialMarker) this.map.removeLayer(this.celestialMarker);

        const celPt = this.calcDestinationPoint(beamResult.targetPeak.lat, beamResult.targetPeak.lng, 35, beamResult.astroPos.azimuth);
        const celHtml = isSun 
            ? `<div style="background:#ffb703; width:28px; height:28px; border-radius:50%; border:3px solid white; box-shadow:0 0 16px rgba(255,183,3,1); display:flex; align-items:center; justify-content:center; color:white; font-size:16px;"><i class="fa-solid fa-sun"></i></div>`
            : `<div style="background:#0284c7; width:28px; height:28px; border-radius:50%; border:3px solid white; box-shadow:0 0 16px rgba(56,189,248,1); display:flex; align-items:center; justify-content:center; color:white; font-size:16px;"><i class="fa-solid fa-moon"></i></div>`;

        const celIcon = L.divIcon({
            className: 'custom-celestial-marker',
            html: celHtml,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        this.celestialMarker = L.marker([celPt.lat, celPt.lng], {
            icon: celIcon
        }).addTo(this.map);

        this.celestialMarker.bindTooltip(
            `<b>${isSun ? '☀️ 太陽' : '🌙 月'} 位置方向</b><br>方位角: ${beamResult.astroPos.azimuth.toFixed(1)}° | 高度角: ${beamResult.astroPos.altitude.toFixed(1)}°`,
            { sticky: true }
        );
    }

    calcDestinationPoint(lat, lng, distKm, bearingDeg) {
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

    addPeakMarkersToMap() {
        if (!window.PEAKS_DATABASE) return;

        window.PEAKS_DATABASE.forEach(peak => {
            const peakIcon = L.divIcon({
                className: 'peak-map-pin',
                html: `<div style="background:#ef4444; width:10px; height:10px; border-radius:50%; border:2px solid white;"></div>`,
                iconSize: [14, 14]
            });

            const marker = L.marker([peak.lat, peak.lng], { icon: peakIcon }).addTo(this.map);
            marker.bindTooltip(`<b>${peak.name}</b> (${peak.elev}m)`, { direction: 'top', offset: [0, -8] });
            
            marker.on('click', () => {
                if (this.activeMode === 'target') {
                    this.targetMarker.setLatLng([peak.lat, peak.lng]);
                    if (this.onTargetChange) {
                        this.onTargetChange(peak.lat, peak.lng, peak.name, peak.elev);
                    }
                } else {
                    this.observerMarker.setLatLng([peak.lat, peak.lng]);
                    if (this.onCameraChange) {
                        this.onCameraChange(peak.lat, peak.lng);
                    }
                }
            });
        });
    }

    updateCameraView(lat, lng, azimuth, fov, maxDistanceKm = 40) {
        this.observerMarker.setLatLng([lat, lng]);

        const points = [[lat, lng]];
        const halfFov = fov / 2;
        const startAngle = azimuth - halfFov;
        const endAngle = azimuth + halfFov;

        const R = 6371;
        const numSteps = 16;

        for (let i = 0; i <= numSteps; i++) {
            const angleDeg = startAngle + (endAngle - startAngle) * (i / numSteps);
            const brng = angleDeg * Math.PI / 180;
            const latRad = lat * Math.PI / 180;
            const lngRad = lng * Math.PI / 180;

            const distRad = (maxDistanceKm * 0.4) / R;

            const destLatRad = Math.asin(
                Math.sin(latRad) * Math.cos(distRad) +
                Math.cos(latRad) * Math.sin(distRad) * Math.cos(brng)
            );
            const destLngRad = lngRad + Math.atan2(
                Math.sin(brng) * Math.sin(distRad) * Math.cos(latRad),
                Math.cos(distRad) - Math.sin(latRad) * Math.sin(destLatRad)
            );

            points.push([destLatRad * 180 / Math.PI, destLngRad * 180 / Math.PI]);
        }

        if (this.fovPolygon) {
            this.map.removeLayer(this.fovPolygon);
        }

        this.fovPolygon = L.polygon(points, {
            color: '#0284c7',
            fillColor: '#38bdf8',
            fillOpacity: 0.25,
            weight: 2
        }).addTo(this.map);
    }

    updateTargetMarker(lat, lng) {
        if (this.targetMarker && !isNaN(lat) && !isNaN(lng)) {
            this.targetMarker.setLatLng([lat, lng]);
        }
    }

    flyTo(lat, lng, zoom = 11) {
        this.map.flyTo([lat, lng], zoom, { duration: 1.2 });
        this.observerMarker.setLatLng([lat, lng]);
    }
}

window.MapController = MapController;
