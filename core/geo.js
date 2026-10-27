// core/geo.js — 客户地理定位（GPS/经纬度 → 城市）
//
// 用途：记录访客、潜在线索、付费客户各自所在的地理位置与来源渠道，供后台做地域分布分析。
// 设计要点：
//   1) 只接收客户端主动上报的坐标，不做后台跟踪；未授权/未上报则不产生任何记录。
//   2) 逆地理编码走「离线城市表 + 可选在线服务」两级：默认离线（不外发坐标），
//      传 GEO_REVERSE_URL 环境变量才启用在线反查，避免把客户坐标泄露给第三方。
//   3) 精度如实记录（accuracy 米），低置信度（>2000m 或失败）标记 cityUnknown，前台可区分。
//   4) 落库到 db.geo = { visitors: {}, leads: {}, customers: {} }，按 id 索引，幂等更新。

const store = require('./store');

// —— 离线粗定位表：中国主要地级市 + 直辖市/省会（按经纬度包围盒就近匹配）——
// 精度为城市级，用于无外网时的基本地域归类；命不中则返回 null，由调用方标记未知。
const CN_CITIES = [
  // [名称, lat, lon, 包围盒半宽(度), 包围盒半高(度)]
  ['北京', 39.90, 116.41, 0.9, 0.6], ['上海', 31.23, 121.47, 0.9, 0.6],
  ['天津', 39.13, 117.20, 0.8, 0.5], ['重庆', 29.56, 106.55, 1.2, 0.8],
  ['广州', 23.13, 113.26, 1.0, 0.7], ['深圳', 22.54, 114.06, 0.8, 0.6],
  ['杭州', 30.27, 120.15, 1.0, 0.6], ['南京', 32.06, 118.80, 0.9, 0.6],
  ['苏州', 31.30, 120.58, 0.7, 0.5], ['武汉', 30.59, 114.31, 1.0, 0.7],
  ['成都', 30.57, 104.07, 1.0, 0.7], ['西安', 34.34, 108.94, 1.0, 0.7],
  ['长沙', 28.23, 112.94, 1.0, 0.7], ['郑州', 34.75, 113.63, 1.0, 0.7],
  ['青岛', 36.07, 120.38, 1.0, 0.7], ['济南', 36.65, 117.12, 1.0, 0.7],
  ['合肥', 31.82, 117.23, 0.9, 0.6], ['福州', 26.07, 119.30, 1.0, 0.7],
  ['厦门', 24.48, 118.09, 0.6, 0.5], ['南昌', 28.68, 115.89, 0.9, 0.6],
  ['太原', 37.87, 112.55, 0.9, 0.6], ['石家庄', 38.04, 114.51, 0.9, 0.6],
  ['哈尔滨', 45.80, 126.53, 1.2, 0.8], ['长春', 43.82, 125.32, 1.0, 0.7],
  ['沈阳', 41.81, 123.43, 1.0, 0.7], ['大连', 38.91, 121.61, 0.9, 0.6],
  ['昆明', 25.04, 102.71, 1.2, 0.8], ['贵阳', 26.65, 106.63, 0.9, 0.6],
  ['南宁', 22.82, 108.32, 1.0, 0.7], ['兰州', 36.06, 103.83, 1.2, 0.8],
  ['西宁', 36.62, 101.78, 1.0, 0.7], ['银川', 38.49, 106.23, 1.0, 0.7],
  ['乌鲁木齐', 43.83, 87.62, 1.5, 1.0], ['拉萨', 29.65, 91.14, 1.2, 0.8],
  ['呼和浩特', 40.84, 111.75, 1.0, 0.7], ['海口', 20.04, 110.20, 0.7, 0.5],
  ['三亚', 18.25, 109.51, 0.5, 0.4], ['香港', 22.32, 114.17, 0.4, 0.3],
  ['澳门', 22.20, 113.54, 0.3, 0.2], ['台北', 25.03, 121.57, 0.5, 0.4],
  ['苏州工业园', 31.32, 120.68, 0.2, 0.2], ['东莞', 23.02, 113.75, 0.6, 0.5],
  ['佛山', 23.02, 113.12, 0.6, 0.5], ['无锡', 31.49, 120.31, 0.6, 0.5],
  ['宁波', 29.87, 121.55, 0.8, 0.6], ['温州', 27.99, 120.70, 0.8, 0.6],
  ['泉州', 24.87, 118.68, 0.6, 0.5], ['徐州', 34.26, 117.19, 0.8, 0.6],
  ['唐山', 39.63, 118.18, 0.8, 0.6], ['潍坊', 36.71, 119.16, 0.9, 0.6],
  ['烟台', 37.46, 121.45, 0.8, 0.6], ['洛阳', 34.62, 112.45, 0.8, 0.6],
  ['南通', 31.98, 120.89, 0.6, 0.5], ['嘉兴', 30.75, 120.75, 0.5, 0.4],
  ['绍兴', 30.00, 120.58, 0.5, 0.4], ['台州', 28.66, 121.42, 0.7, 0.5],
  ['汕头', 23.35, 116.68, 0.6, 0.4], ['湛江', 21.27, 110.36, 0.8, 0.5],
  ['株洲', 27.83, 113.13, 0.7, 0.5], ['岳阳', 29.36, 113.13, 0.7, 0.5],
  ['宜昌', 30.69, 111.29, 0.8, 0.6], ['襄阳', 32.01, 112.12, 0.8, 0.6],
  ['赣州', 25.83, 114.94, 0.9, 0.6], ['九江', 29.71, 116.00, 0.7, 0.5],
  ['扬州', 32.39, 119.41, 0.6, 0.5], ['盐城', 33.35, 120.16, 0.9, 0.6],
  ['临沂', 35.10, 118.36, 0.9, 0.6], ['南阳', 32.99, 112.53, 0.9, 0.6],
  ['遵义', 27.73, 106.93, 0.9, 0.6], ['大理', 25.61, 100.27, 0.8, 0.6],
  ['丽江', 26.86, 100.23, 0.8, 0.6], ['敦煌', 40.14, 94.66, 1.0, 0.7],
  ['喀什', 39.47, 75.99, 1.5, 1.0], ['三亚', 18.25, 109.51, 0.5, 0.4]
];

// 精度阈值：超过则视为「城市级不确定」
const ACC_CITY = 2000; // 米

function nearCity(lat, lon) {
  let best = null, bestD = Infinity;
  for (const [name, clat, clon, dx, dy] of CN_CITIES) {
    const ddx = Math.abs(lon - clon), ddy = Math.abs(lat - clat);
    if (ddx <= dx && ddy <= dy) {
      const d = ddx * ddx + ddy * ddy;
      if (d < bestD) { bestD = d; best = name; }
    }
  }
  return best;
}

function validCoord(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    isFinite(lat) && isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

async function reverseOnline(lat, lon) {
  const base = process.env.GEO_REVERSE_URL;
  if (!base) return null;
  try {
    const url = String(base).replace('{lat}', lat).replace('{lon}', lon);
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tm);
    if (!r.ok) return null;
    const j = await r.json();
    return {
      city: j.city || j.town || j.county || j.state || null,
      province: j.province || j.state || null,
      country: j.country || j.country_code || null
    };
  } catch (e) { return null; }
}

// 主入口：上报一次定位
// kind: 'visitor' | 'lead' | 'customer'
// id:   对应实体的 id（访客则用 visitorOf 得到的裸 key）
async function report(kind, id, payload) {
  const p = payload || {};
  const lat = Number(p.lat), lon = Number(p.lon != null ? p.lon : p.lng);
  if (!validCoord(lat, lon)) return { ok: false, error: '坐标无效' };
  if (!['visitor', 'lead', 'customer'].includes(kind)) return { ok: false, error: 'kind 非法' };
  if (!id) return { ok: false, error: '缺少 id' };

  const accuracy = Number.isFinite(Number(p.accuracy)) ? Math.round(Number(p.accuracy)) : null;
  const online = await reverseOnline(lat, lon);
  const city = (online && online.city) || nearCity(lat, lon) || null;
  const rec = {
    id,
    kind,
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    accuracy,
    city,
    province: (online && online.province) || null,
    country: (online && online.country) || null,
    cityUnknown: !city || (accuracy != null && accuracy > ACC_CITY),
    source: (p.source || '').toString().slice(0, 40) || 'browser',
    at: Date.now()
  };

  const db = store.read();
  db.geo = db.geo || { visitors: {}, leads: {}, customers: {} };
  const bucket = kind === 'lead' ? 'leads' : kind === 'customer' ? 'customers' : 'visitors';
  db.geo[bucket] = db.geo[bucket] || {};
  db.geo[bucket][id] = rec; // 幂等：同一 id 覆盖为最新
  store.write(db);
  return { ok: true, city: rec.city, cityUnknown: rec.cityUnknown, accuracy: rec.accuracy };
}

// 查询：后台读取
// 返回：总数、按城市聚合明细、按来源聚合
function query(opts) {
  const o = opts || {};
  const db = store.read();
  const g = db.geo || { visitors: {}, leads: {}, customers: {} };
  const bucket = ['visitor', 'lead', 'customer'].includes(o.kind) ? o.kind : null;
  const all = [];
  const collect = (k) => {
    const src = k === 'lead' ? g.leads : k === 'customer' ? g.customers : g.visitors;
    Object.values(src || {}).forEach(r => all.push(r));
  };
  if (bucket) collect(bucket); else { collect('visitor'); collect('lead'); collect('customer'); }

  const byCity = {};
  for (const r of all) {
    const key = r.city || '未知地区';
    byCity[key] = byCity[key] || { city: key, count: 0, kinds: {} };
    byCity[key].count++;
    byCity[key].kinds[r.kind] = (byCity[key].kinds[r.kind] || 0) + 1;
  }
  const cities = Object.values(byCity).sort((a, b) => b.count - a.count);

  const bySource = {};
  all.forEach(r => { bySource[r.source || 'unknown'] = (bySource[r.source || 'unknown'] || 0) + 1; });

  const known = all.filter(r => !r.cityUnknown).length;
  return {
    ok: true,
    total: all.length,
    located: known,
    unknown: all.length - known,
    coverage: all.length ? Math.round(known / all.length * 100) : 0,
    cities,
    bySource,
    records: all.sort((a, b) => b.at - a.at).slice(0, o.limit || 200)
  };
}

module.exports = { report, query };
