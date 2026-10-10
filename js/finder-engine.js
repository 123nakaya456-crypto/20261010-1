/**
 * 太陽・月 ＆ 目標物 重なり視点逆引き計算エンジン (FinderEngine v4.0)
 * - 3点アライメント（視点 B ✕ 目標 A ✕ 天体 S）における「ダイヤモンド山頂重なり」厳密絞り込み
 * - 視点から見た山頂仰角 Alt_peak と天体高度 Alt_astro のピッタリ一致（ダイヤモンド現象）算定
 */

class FinderEngine {
    constructor() {
        this.astroEngine = new AstroEngine();
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

    /**
     * 視点 obsElev から目標物 targetPeak を見上げた時の見かけの仰角 (Alt_peak deg)
     * 地球曲率による降下量に、大気差(地表大気の屈折)による軽減係数を乗じて補正。
     * 係数は標準大気での地表大気差係数 k≈1/7 を用いた (1-k)=6/7≈0.857 を採用
     * (旧実装の 0.85 から標準値に微修正。効果はごく僅かだが理論値に整合)。
     */
    calculateApparentAltitude(obsElev, eyeHeight, targetElev, distanceKm) {
        const totalObsElev = obsElev + (eyeHeight || 0);
        const distMeters = distanceKm * 1000;
        const curvatureDrop = (distMeters * distMeters) / (2 * 6371000) * (6 / 7);
        const relativeElev = targetElev - (totalObsElev + curvatureDrop);
        const altRad = Math.atan2(relativeElev, distMeters);
        return altRad * 180 / Math.PI;
    }

    /**
     * アライメントビーム（逆引き直線）算出
     */
    calculateAlignmentBeam(targetPeak, date, celestialType = 'sun', obsElev = 100) {
        if (!targetPeak || isNaN(targetPeak.lat) || isNaN(targetPeak.lng)) return null;

        let astroPos;
        if (celestialType === 'sun') {
            astroPos = this.astroEngine.getSunPosition(date, targetPeak.lat, targetPeak.lng);
        } else {
            astroPos = this.astroEngine.getMoonPosition(date, targetPeak.lat, targetPeak.lng);
        }

        const isBelowHorizon = (astroPos.altitude < -6.0);
        const reverseBearing = (astroPos.azimuth + 180) % 360;
        const forwardBearing = astroPos.azimuth;

        let bestDistanceKm = null;
        let bestSpotPt = null;

        if (astroPos.altitude > 0.1 && astroPos.altitude < 45.0) {
            const altRad = astroPos.altitude * Math.PI / 180;
            const deltaElevMeters = Math.max(10, targetPeak.elev - obsElev);
            const approxDistKm = (deltaElevMeters / Math.tan(altRad)) / 1000;
            
            if (approxDistKm >= 0.5 && approxDistKm <= 200) {
                bestDistanceKm = approxDistKm;
                bestSpotPt = this.destinationPoint(targetPeak.lat, targetPeak.lng, bestDistanceKm, reverseBearing);
            }
        }

        const beamLinePoints = [];
        const maxDistKm = 220;
        const stepDistKm = 2;

        for (let d = 0; d <= maxDistKm; d += stepDistKm) {
            const pt = this.destinationPoint(targetPeak.lat, targetPeak.lng, d, reverseBearing);
            beamLinePoints.push({
                distKm: d,
                lat: pt.lat,
                lng: pt.lng
            });
        }

        const leftBearing = (reverseBearing - 1.5 + 360) % 360;
        const rightBearing = (reverseBearing + 1.5) % 360;

        const leftPoints = [];
        const rightPoints = [];

        for (let d = 1; d <= maxDistKm; d += 15) {
            leftPoints.push(this.destinationPoint(targetPeak.lat, targetPeak.lng, d, leftBearing));
            rightPoints.push(this.destinationPoint(targetPeak.lat, targetPeak.lng, d, rightBearing));
        }

        const polygonCoords = [
            [targetPeak.lat, targetPeak.lng],
            ...leftPoints.map(p => [p.lat, p.lng]),
            ...rightPoints.reverse().map(p => [p.lat, p.lng]),
            [targetPeak.lat, targetPeak.lng]
        ];

        return {
            targetPeak,
            date,
            celestialType,
            astroPos,
            isBelowHorizon,
            reverseBearing,
            forwardBearing,
            beamLinePoints,
            polygonCoords,
            bestDistanceKm,
            bestSpotPt
        };
    }

    /**
     * 💎 【3点直線アライメント（太陽 ✕ 剱岳 ✕ 新湊大橋）ダイヤモンド山頂重なり厳密絞り込み】
     * 視点 B から見た 目標 A (例: 剱岳) の山頂の高さ(仰角 Alt_peak) に、太陽/月がぴったり重なる「真のダイヤモンド現象の瞬間」のみを絞り出し抽出！
     */
    searchTripleAlignmentDates(obsLat, obsLng, targetPeak, celestialType = 'sun', startDate = new Date(), direction = 'future', obsElev = 50) {
        if (!targetPeak || isNaN(obsLat) || isNaN(obsLng)) return [];

        // 1. 視点 B から 目標 A への大円距離 D (km) ＆ 方位角 ReqAzimuth (°)
        const R = 6371;
        const dLat = (targetPeak.lat - obsLat) * Math.PI / 180;
        const dLon = (targetPeak.lng - obsLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(obsLat * Math.PI / 180) * Math.cos(targetPeak.lat * Math.PI / 180);
        const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        const y = Math.sin(dLon) * Math.cos(targetPeak.lat * Math.PI / 180);
        const x = Math.cos(obsLat * Math.PI / 180) * Math.sin(targetPeak.lat * Math.PI / 180) -
                  Math.sin(obsLat * Math.PI / 180) * Math.cos(targetPeak.lat * Math.PI / 180) * Math.cos(dLon);
        let reqAzimuth = Math.atan2(y, x) * 180 / Math.PI;
        if (reqAzimuth < 0) reqAzimuth += 360;

        // 2. 視点 B から見た 目標 A 山頂の「見かけの仰角 (Alt_peak °)」
        const peakApparentAlt = this.calculateApparentAltitude(obsElev, 1.5, targetPeak.elev, distKm);

        const results = [];
        const baseTime = (startDate instanceof Date && !isNaN(startDate.getTime())) ? startDate.getTime() : Date.now();
        const isFuture = (direction !== 'past');

        // 基準日から 1 年間 (365日分) を未来または過去へスキャン
        for (let day = 0; day < 365; day++) {
            const dayOffsetMs = day * 86400000;
            const dayBase = new Date(isFuture ? (baseTime + dayOffsetMs) : (baseTime - dayOffsetMs));
            dayBase.setHours(0, 0, 0, 0);

            let bestTimeDate = null;
            let minTotalDiff = 999;
            let bestPos = null;

            for (let m = 0; m < 1440; m += 2) { // 2分高精度ステップ
                const t = new Date(dayBase.getTime() + m * 60000);
                let pos;
                if (celestialType === 'sun') {
                    pos = this.astroEngine.getSunPosition(t, obsLat, obsLng);
                } else {
                    pos = this.astroEngine.getMoonPosition(t, obsLat, obsLng);
                }

                // 方位差 (Azimuth Diff)
                let azDiff = Math.abs(pos.azimuth - reqAzimuth);
                if (azDiff > 180) azDiff = 360 - azDiff;

                // 高度差 (Altitude Diff) ※ pos.altitude は大気差(＋月は視差)込みの見かけの高度
                const altDiff = Math.abs(pos.altitude - peakApparentAlt);

                // 💎 厳密絞り込み条件: 方位誤差 ±1.0° 以内 ＆ 高度誤差 ±1.4° 以内
                // 地平線判定は見かけの高度がその天体の視半径分だけ沈む直前まで(実際に見える範囲)を許容
                if (azDiff <= 1.0 && altDiff <= 1.4 && pos.altitude >= -pos.semiDiameter) {
                    const totalDiff = azDiff * 1.5 + altDiff;
                    if (totalDiff < minTotalDiff) {
                        minTotalDiff = totalDiff;
                        bestTimeDate = t;
                        bestPos = pos;
                    }
                }
            }

            // 🔬 精密化パス: 2分刻みで見つかった最良候補の前後を 10秒刻みで再スキャンし、
            // 実際の「重なりが最も近い瞬間」を秒単位まで絞り込む(タイミング精度を大幅改善)。
            if (bestTimeDate) {
                const coarseMs = bestTimeDate.getTime();
                for (let offsetSec = -150; offsetSec <= 150; offsetSec += 10) {
                    const t = new Date(coarseMs + offsetSec * 1000);
                    let pos;
                    if (celestialType === 'sun') {
                        pos = this.astroEngine.getSunPosition(t, obsLat, obsLng);
                    } else {
                        pos = this.astroEngine.getMoonPosition(t, obsLat, obsLng);
                    }

                    let azDiff = Math.abs(pos.azimuth - reqAzimuth);
                    if (azDiff > 180) azDiff = 360 - azDiff;
                    const altDiff = Math.abs(pos.altitude - peakApparentAlt);

                    if (pos.altitude >= -pos.semiDiameter) {
                        const totalDiff = azDiff * 1.5 + altDiff;
                        if (totalDiff < minTotalDiff) {
                            minTotalDiff = totalDiff;
                            bestTimeDate = t;
                            bestPos = pos;
                        }
                    }
                }
            }

            if (bestTimeDate && bestPos) {
                const matchPercent = Math.max(70, Math.min(99, Math.round(100 - minTotalDiff * 15)));

                let moonPhaseName = '';
                let moonEmoji = '';
                if (celestialType === 'moon') {
                    const age = bestPos.age;
                    if (age < 1.5) { moonPhaseName = '新月 (朔)'; moonEmoji = '🌑'; }
                    else if (age < 6.5) { moonPhaseName = '三日月'; moonEmoji = '🌙'; }
                    else if (age < 8.5) { moonPhaseName = '上弦の月'; moonEmoji = '🌓'; }
                    else if (age < 13.5) { moonPhaseName = '十三夜'; moonEmoji = '🌔'; }
                    else if (age < 16.5) { moonPhaseName = '満月 (望)'; moonEmoji = '🌕'; }
                    else if (age < 21.5) { moonPhaseName = '十六夜'; moonEmoji = '🌖'; }
                    else if (age < 23.5) { moonPhaseName = '下弦の月'; moonEmoji = '🌗'; }
                    else { moonPhaseName = '有明月'; moonEmoji = '🌘'; }
                }

                results.push({
                    date: bestTimeDate,
                    azimuth: bestPos.azimuth,
                    altitude: bestPos.altitude,
                    peakAlt: peakApparentAlt,
                    diffAz: Math.abs(bestPos.azimuth - reqAzimuth),
                    diffAlt: Math.abs(bestPos.altitude - peakApparentAlt),
                    matchPercent,
                    moonAge: bestPos.age,
                    moonPhaseName,
                    moonEmoji
                });
            }
        }

        // 日時が早い順 (時系列昇順) にソート
        return results.sort((a, b) => a.date - b.date);
    }

    getGoogleEarthUrl(targetPeak, obsLat, obsLng, cameraAzimuth = null, cameraPitch = null, cameraFov = null, obsElev = 50) {
        if (!targetPeak || isNaN(obsLat) || isNaN(obsLng)) return 'https://earth.google.com/web/';

        let heading = cameraAzimuth;
        if (heading === null || isNaN(heading)) {
            const y = Math.sin((targetPeak.lng - obsLng) * Math.PI / 180) * Math.cos(targetPeak.lat * Math.PI / 180);
            const x = Math.cos(obsLat * Math.PI / 180) * Math.sin(targetPeak.lat * Math.PI / 180) -
                      Math.sin(obsLat * Math.PI / 180) * Math.cos(targetPeak.lat * Math.PI / 180) * Math.cos((targetPeak.lng - obsLng) * Math.PI / 180);
            heading = Math.atan2(y, x) * 180 / Math.PI;
            if (heading < 0) heading += 360;
        }

        const R = 6371;
        const dLat = (targetPeak.lat - obsLat) * Math.PI / 180;
        const dLon = (targetPeak.lng - obsLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(obsLat * Math.PI / 180) * Math.cos(targetPeak.lat * Math.PI / 180);
        const distMeters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1000;

        let tilt = 80;
        if (cameraPitch !== null && !isNaN(cameraPitch)) {
            tilt = Math.max(1, Math.min(89, 90 - cameraPitch));
        }

        const altitude = (obsElev || 50) + 1.5;

        return `https://earth.google.com/web/@${obsLat.toFixed(5)},${obsLng.toFixed(5)},${altitude.toFixed(0)}a,${distMeters.toFixed(0)}d,35y,${heading.toFixed(0)}h,${tilt.toFixed(0)}t,0r`;
    }

    generateKML(beamResult, obsLat, obsLng) {
        if (!beamResult || !beamResult.beamLinePoints) return '';

        const target = beamResult.targetPeak;
        const isSun = (beamResult.celestialType === 'sun');
        const titleName = `ダイヤモンド${target.name}_${isSun ? '太陽' : '月'}_可視ライン`;
        const lineColorHex = isSun ? 'ff03b7ff' : 'fff8bd38';

        const coordsStr = beamResult.beamLinePoints.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)},${target.elev}`).join(' ');

        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${titleName}</name>
    <description>太陽・月が${target.name}に重なって見えるアライメントビーム線</description>
    <Style id="diamondBeamStyle">
      <LineStyle>
        <color>${lineColorHex}</color>
        <width>5</width>
      </LineStyle>
    </Style>

    <Placemark>
      <name>🎯 目標: ${target.name} (${target.elev}m)</name>
      <Point>
        <coordinates>${target.lng},${target.lat},${target.elev}</coordinates>
      </Point>
    </Placemark>

    <Placemark>
      <name>📍 推薦観察視点</name>
      <Point>
        <coordinates>${obsLng},${obsLat},0</coordinates>
      </Point>
    </Placemark>

    <Placemark>
      <name>💎 ダイヤモンドアライメントライン</name>
      <styleUrl>#diamondBeamStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <coordinates>
          ${coordsStr}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
    }
}

window.FinderEngine = FinderEngine;
