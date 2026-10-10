/**
 * 高精度天体位置 ＆ 出没時刻計算エンジン (AstroEngine v2.0 - 精度改善版)
 *
 * 【v2.0 精度改善内容】
 * 1. 月位置計算: 従来は近点方程式(主要項1つ)のみで実装されており、太陽による摂動
 *    （出差 Evection・変差 Variation・年差 Annual Equation 等）が完全に欠落していた
 *    ため、実際の月位置との誤差が最大で数度に達するケースがあった。
 *    → Meeus "Astronomical Algorithms" 第47章の縮約周期項（黄経・黄緯・地心距離、
 *      各主要20項前後）を追加し、精度を大幅に向上（実用上 数分角～十数分角程度）。
 * 2. 大気差（大気による見かけの浮き上がり）を Bennett の実用式で計算し、太陽・月
 *    ともに「幾何学的高度」ではなく「見かけの高度(apparent altitude)」を返すように
 *    統一。ダイヤモンド現象は地平線付近（高度0〜数度）で起こるため、大気差
 *    （地平線付近で約 +0.5°前後）を無視すると判定時刻・判定可否に直接影響する。
 * 3. 月の視差（地心⇒観測地の座標変換）を計算に追加。月の水平視差は平均で約
 *    0.95°〜1.0°もあり、これを無視すると「ダイヤモンド富士/剱岳」のような高度誤差
 *    1〜2°を要求する判定には致命的な誤差要因となっていたため、実際の距離から
 *    動的に算出した視差を高度へ反映。
 * 4. 月の視半径を実距離から動的算出し、月の出/月の入り判定のしきい値に反映。
 */

class AstroEngine {
    constructor() {
        this.RAD = Math.PI / 180;
        this.DEG = 180 / Math.PI;
        this.EARTH_RADIUS_KM = 6378.14; // 赤道半径 (視差計算用)
    }

    getJulianDate(date) {
        return (date.getTime() / 86400000) + 2440587.5;
    }

    getDaysSinceJ2000(date) {
        return this.getJulianDate(date) - 2451545.0;
    }

    getLST(daysSinceJ2000, lng) {
        const gmst = 280.46061837 + 360.98564736629 * daysSinceJ2000;
        return (gmst + lng + 360) % 360;
    }

    norm360(deg) {
        return ((deg % 360) + 360) % 360;
    }

    /**
     * Bennett (1982) の実用大気差近似式。
     * h: 見かけの高度に近い高度(度)。地平線付近でおよそ 0.5°(=34分)程度の浮き上がり。
     * 標準大気(気圧1010hPa, 気温10℃)を仮定した簡易補正のみ(気圧・気温補正は省略)。
     * 戻り値: 大気差(度)。高度が低いほど大きく、高度が高いほぼ 0 に漸近する。
     */
    atmosphericRefractionDeg(hDeg) {
        // 極端に低い高度(地平線下深く)では式が発散するため -1.0° でクランプして計算
        const h = Math.max(hDeg, -1.0);
        const arcMin = 1.0 / Math.tan((h + 7.31 / (h + 4.4)) * this.RAD);
        return arcMin / 60;
    }

    /**
     * 地心（幾何学的）の赤経・赤緯から地平座標(方位・高度)を求める。
     * 戻り値の altitude はあくまで「幾何学的高度」であり、大気差・視差は含まない。
     */
    calculateHorizontalCoords(raRad, decRad, latDeg, lstDeg) {
        const latRad = latDeg * this.RAD;
        const H = (lstDeg * this.RAD) - raRad;

        const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(H);
        const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

        const y = -Math.cos(decRad) * Math.sin(H);
        const x = Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(H);
        let az = Math.atan2(y, x) * this.DEG;
        if (az < 0) az += 360;

        return {
            azimuth: az,
            altitude: alt * this.DEG,
            hourAngleDeg: this.norm360(H * this.DEG)
        };
    }

    /**
     * ☀️ 太陽の地平座標（見かけの高度＝大気差補正込み）を返す。
     * 黄経の近似式は低精度太陽位置式(誤差 約0.01°程度)を使用。
     * 太陽の視差は最大でも約8.8秒角と無視できるため地心座標をそのまま用いる。
     */
    getSunPosition(date, lat, lng) {
        const d = this.getDaysSinceJ2000(date);

        const L = this.norm360(280.460 + 0.9856474 * d);
        const M = this.norm360(357.528 + 0.9856003 * d) * this.RAD;

        const lambda = (L + 1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M)) * this.RAD;
        const e = (23.439 - 0.0000004 * d) * this.RAD;

        const sinDec = Math.sin(e) * Math.sin(lambda);
        const dec = Math.asin(sinDec);
        const ra = Math.atan2(Math.cos(e) * Math.sin(lambda), Math.cos(lambda));

        const lst = this.getLST(d, lng);
        const geo = this.calculateHorizontalCoords(ra, dec, lat, lst);

        // 太陽の視半径 (平均 0.2667°、近日点/遠日点で ±1.7%程度変動。ここでは平均値を使用)
        const sunSemiDiameterDeg = 0.2667;

        const refraction = this.atmosphericRefractionDeg(geo.altitude);
        const apparentAltitude = geo.altitude + refraction;

        return {
            azimuth: geo.azimuth,
            altitude: apparentAltitude,       // 見かけの高度 (大気差込み) — 描画・アライメント判定用
            geometricAltitude: geo.altitude,   // 幾何学的高度 (大気差なし)
            refraction,
            semiDiameter: sunSemiDiameterDeg
        };
    }

    /**
     * 🌙 月の地平座標（見かけの高度＝視差＋大気差補正込み）を返す。
     * Meeus "Astronomical Algorithms" Ch.47 の縮約周期項(主要項)を用いた
     * 月の黄経(λ)・黄緯(β)・地心距離(Δ)算出 + 地心⇒観測地への視差補正。
     */
    getMoonPosition(date, lat, lng) {
        const d = this.getDaysSinceJ2000(date);

        // --- 基本引数 (度) ---
        const Lp = this.norm360(218.3164477 + 13.17639648 * d); // 月の平均黄経
        const D  = this.norm360(297.8501921 + 12.19074912 * d); // 平均離角(太陽-月)
        const M  = this.norm360(357.5291092 + 0.98560028 * d);  // 太陽の平均近点角
        const Mp = this.norm360(134.9633964 + 13.06499295 * d); // 月の平均近点角
        const F  = this.norm360(93.2720950 + 13.22935024 * d);  // 月の平均緯度引数(昇交点からの角距離)

        const Dr = D * this.RAD, Mr = M * this.RAD, Mpr = Mp * this.RAD, Fr = F * this.RAD;

        // --- 黄経の摂動項 ΔL (度) : Meeus Table 47.A の主要項(振幅上位) ---
        const dL =
              6.288774 * Math.sin(Mpr)
            + 1.274027 * Math.sin(2 * Dr - Mpr)
            + 0.658314 * Math.sin(2 * Dr)
            + 0.213618 * Math.sin(2 * Mpr)
            - 0.185116 * Math.sin(Mr)
            - 0.114332 * Math.sin(2 * Fr)
            + 0.058793 * Math.sin(2 * Dr - 2 * Mpr)
            + 0.057066 * Math.sin(2 * Dr - Mr - Mpr)
            + 0.053322 * Math.sin(2 * Dr + Mpr)
            + 0.045758 * Math.sin(2 * Dr - Mr)
            - 0.040923 * Math.sin(Mr - Mpr)
            - 0.034720 * Math.sin(Dr)
            - 0.030383 * Math.sin(Mr + Mpr)
            + 0.015327 * Math.sin(2 * Dr - 2 * Fr)
            - 0.012528 * Math.sin(Mpr + 2 * Fr)
            + 0.010980 * Math.sin(Mpr - 2 * Fr)
            + 0.010675 * Math.sin(4 * Dr - Mpr)
            + 0.010034 * Math.sin(3 * Mpr)
            + 0.008548 * Math.sin(4 * Dr - 2 * Mpr)
            - 0.007888 * Math.sin(2 * Dr + Mr - Mpr)
            - 0.006766 * Math.sin(2 * Dr + Mr);

        // --- 黄緯 β (度) : Meeus Table 47.B の主要項 ---
        const beta =
              5.128122 * Math.sin(Fr)
            + 0.280602 * Math.sin(Mpr + Fr)
            + 0.277693 * Math.sin(Mpr - Fr)
            + 0.173237 * Math.sin(2 * Dr - Fr)
            + 0.055413 * Math.sin(2 * Dr + Fr - Mpr)
            + 0.046271 * Math.sin(2 * Dr - Fr - Mpr)
            + 0.032573 * Math.sin(2 * Dr + Fr)
            + 0.017198 * Math.sin(2 * Mpr + Fr)
            + 0.009266 * Math.sin(2 * Dr + Mpr - Fr)
            + 0.008822 * Math.sin(2 * Mpr - Fr)
            + 0.008216 * Math.sin(2 * Dr - Mr - Fr)
            + 0.004324 * Math.sin(2 * Dr - 2 * Mpr - Fr)
            + 0.004200 * Math.sin(2 * Dr + Fr + Mpr);

        // --- 地心距離 Δ (km) : Meeus Table 47.A 距離項の主要項 ---
        const distKm =
              385000.56
            - 20905.355 * Math.cos(Mpr)
            - 3699.111 * Math.cos(2 * Dr - Mpr)
            - 2955.968 * Math.cos(2 * Dr)
            - 569.925 * Math.cos(2 * Mpr)
            + 246.158 * Math.cos(2 * Dr - 2 * Mpr)
            - 204.586 * Math.cos(2 * Dr - Mr)
            - 170.733 * Math.cos(2 * Dr + Mpr)
            - 152.138 * Math.cos(Mr - Mpr)
            - 129.620 * Math.cos(2 * Dr + Mr)
            + 108.743 * Math.cos(Dr)
            - 104.755 * Math.cos(Mpr + Mr);

        const lambdaDeg = Lp + dL;
        const lambda = lambdaDeg * this.RAD; // 黄経
        const betaRad = beta * this.RAD;     // 黄緯
        const e = 23.439 * this.RAD;         // 黄道傾斜角(平均)

        // 黄道座標 → 赤道座標(地心)
        const sinDec = Math.sin(betaRad) * Math.cos(e) + Math.cos(betaRad) * Math.sin(e) * Math.sin(lambda);
        const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
        const y = Math.sin(lambda) * Math.cos(e) - Math.tan(betaRad) * Math.sin(e);
        const x = Math.cos(lambda);
        const ra = Math.atan2(y, x);

        const lst = this.getLST(d, lng);
        const geo = this.calculateHorizontalCoords(ra, dec, lat, lst);

        // --- 視差補正 (地心 → 観測地の見かけの高度) ---
        // 水平視差 π = asin(地球赤道半径 / 月までの距離)
        const horizontalParallaxDeg = Math.asin(this.EARTH_RADIUS_KM / distKm) * this.DEG;
        // 簡易補正式: Δalt ≈ -π・cos(高度)  (観測地が地球中心から見てズレている分、月は低く見える)
        const parallaxCorrection = horizontalParallaxDeg * Math.cos(geo.altitude * this.RAD);
        const topocentricAltitude = geo.altitude - parallaxCorrection;

        // 月の視半径 (実際の距離から動的算出。平均約0.25°)
        const moonSemiDiameterDeg = Math.asin(1737.4 / distKm) * this.DEG;

        const refraction = this.atmosphericRefractionDeg(topocentricAltitude);
        const apparentAltitude = topocentricAltitude + refraction;

        // --- 月齢・輝面比 (表示用。精密な位相計算ではなく実用近似) ---
        const sunLDeg = this.norm360(280.460 + 0.9856474 * d);
        const phaseAngle = this.norm360(lambdaDeg - sunLDeg) * this.RAD;
        const phaseIlluminated = (1 - Math.cos(phaseAngle)) / 2;
        const age = (phaseAngle / (Math.PI * 2)) * 29.530588853;

        return {
            azimuth: geo.azimuth,
            altitude: apparentAltitude,        // 見かけの高度 (視差＋大気差込み) — 描画・アライメント判定用
            geometricAltitude: geo.altitude,    // 地心・幾何学的高度
            topocentricAltitude,                // 視差補正のみ(大気差なし)
            refraction,
            horizontalParallax: horizontalParallaxDeg,
            distanceKm: distKm,
            semiDiameter: moonSemiDiameterDeg,
            phase: phaseIlluminated,
            age: age
        };
    }

    calculateSunMoonTimes(date, lat, lng) {
        const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);

        let sunrise = null;
        let sunset = null;
        let moonrise = null;
        let moonset = null;

        // 出没の定義: 見かけの高度(大気差込み)が上端で地平線に触れる瞬間。
        // altitude は既に大気差込みの見かけ高度を返すため、しきい値には視半径のみを使う。
        const prevSun = this.getSunPosition(startOfDay, lat, lng);
        const prevMoon = this.getMoonPosition(startOfDay, lat, lng);
        let prevSunAlt = prevSun.altitude;
        let prevMoonAlt = prevMoon.altitude;
        const sunThreshold = -prevSun.semiDiameter;

        for (let m = 5; m <= 1440; m += 5) {
            const curDate = new Date(startOfDay.getTime() + m * 60000);
            const sunPos = this.getSunPosition(curDate, lat, lng);
            const moonPos = this.getMoonPosition(curDate, lat, lng);
            const sunAlt = sunPos.altitude;
            const moonAlt = moonPos.altitude;
            const moonThreshold = -moonPos.semiDiameter;

            if (prevSunAlt < sunThreshold && sunAlt >= sunThreshold && !sunrise) {
                const fraction = (sunThreshold - prevSunAlt) / (sunAlt - prevSunAlt);
                sunrise = new Date(startOfDay.getTime() + (m - 5 + fraction * 5) * 60000);
            }
            if (prevSunAlt >= sunThreshold && sunAlt < sunThreshold && !sunset) {
                const fraction = (sunThreshold - prevSunAlt) / (sunAlt - prevSunAlt);
                sunset = new Date(startOfDay.getTime() + (m - 5 + fraction * 5) * 60000);
            }

            if (prevMoonAlt < moonThreshold && moonAlt >= moonThreshold && !moonrise) {
                const fraction = (moonThreshold - prevMoonAlt) / (moonAlt - prevMoonAlt);
                moonrise = new Date(startOfDay.getTime() + (m - 5 + fraction * 5) * 60000);
            }
            if (prevMoonAlt >= moonThreshold && moonAlt < moonThreshold && !moonset) {
                const fraction = (moonThreshold - prevMoonAlt) / (moonAlt - prevMoonAlt);
                moonset = new Date(startOfDay.getTime() + (m - 5 + fraction * 5) * 60000);
            }

            prevSunAlt = sunAlt;
            prevMoonAlt = moonAlt;
        }

        return { sunrise, sunset, moonrise, moonset };
    }

    getDailyTrack(date, lat, lng, objectType) {
        const points = [];
        const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);

        for (let m = 0; m <= 1440; m += 5) {
            const t = new Date(startOfDay.getTime() + m * 60000);
            let pos;
            if (objectType === 'sun') {
                pos = this.getSunPosition(t, lat, lng);
            } else {
                pos = this.getMoonPosition(t, lat, lng);
            }
            points.push({
                time: t,
                hour: t.getHours(),
                minute: t.getMinutes(),
                azimuth: pos.azimuth,
                altitude: pos.altitude
            });
        }
        return points;
    }
}

window.AstroEngine = AstroEngine;
