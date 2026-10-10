/**
 * 全国名山 ＆ ランドマーク・ビューポイント データベース (PEAKS_DATABASE)
 * スタート初期目標: 剱岳, 岐阜城 (金華山) のみ
 */

window.PEAKS_DATABASE = [
    { id: 'tsurugi', name: '剱岳', elev: 2999, lat: 36.6236, lng: 137.6169, prefecture: '富山県', category: 'スタート目標' },
    { id: 'gifu_castle', name: '岐阜城 (金華山)', elev: 329, lat: 35.4339, lng: 136.7820, prefecture: '岐阜県', category: 'スタート目標' }
];

window.VIEWPOINTS_DATABASE = [
    { id: 'shinminato', name: '新湊大橋 (富山県)', lat: 36.7766, lng: 137.1086, elev: 47 },
    { id: 'toyama_city', name: '富山市役所展望塔 (富山県)', lat: 36.6953, lng: 137.2113, elev: 70 }
];

window.CELESTIAL_OBJECTS = [
    { id: 'sun', name: '太陽', type: 'sun', color: '#ffb703' },
    { id: 'moon', name: '月', type: 'moon', color: '#38bdf8' }
];
